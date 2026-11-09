/**
 * dsh-git-bash — 在 Windows 上把 DSH 的原生 bash 工具接到 Git Bash。
 *
 * 设计：不自己写工具，复用上游两个现成件——
 *   - @deepseek-ai/dsh-bash-local 的进程机制（超时、输出上限、spill、后台句柄）；
 *   - @deepseek-ai/dsh-tool-bash 的完整工具 schema、渲染与退出码标记。
 * 本插件只做四件事：解析 Git for Windows 里 bash.exe 的绝对路径；保证上游最终
 * spawn 的就是它；给模型补一段系统提示词，说明这个是 MSYS 的 bash；在会话文件
 * 策略不是完全权限时，于 spawn 之前拒绝 `bash` 调用。
 *
 * 替换点为什么放在 spawnSpec：dsh-bash-local 的子类入口换过名字
 * （<=0.1.6 的 run/start + runArgv/startArgv → >=0.1.7-rc.1 的 execute/executeArgv），
 * 但每一条执行路径最后都要经过 spawnSpec(spec, argv, …) 把 argv 落成 spawn 配置。
 * 只依赖这个收口点，就不必跟随上游的入口命名；入口再改，也不会退回裸 bash
 * （在 Windows 上即 System32\bash.exe，一个已经废掉的 WSL 启动器）。
 * execute / run / start 这三个入口也覆盖一层，把解析好的绝对路径直接交给上游的
 * executeArgv / runArgv / startArgv：入口名没变、但 spawnSpec 被改名或绕过时，
 * 仍然是对的 argv。两层覆盖各自盯着对方被改名的情况。
 *
 * 为什么要解析而不是写死路径：Git for Windows 的安装位置取决于安装方式与用户习惯
 * （机器级 / 用户级 / scoop / chocolatey），而且 git 安装器默认只把 Git\cmd 放进 PATH，
 * 从不放 Git\bin —— 所以裸 bash 在 Windows 上要么找不到，要么撞上 WSL 的启动器。
 *
 * 解析优先级：行 config 的 bashPath → 环境变量 DSH_GIT_BASH → 注册表 InstallPath
 *   → 常见安装位置 → PATH 反推（git.exe 同级的 ..\bin）。
 * 全程只读：不改 PATH、不改注册表、不改 DSH 自身，升级后不需要任何额外配置。
 *
 * @module dsh-git-bash
 */
import { execFileSync } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local';
import { FULL_ACCESS_MODE, installBashGuard } from './guard.js';
import { installGitBashPrompt } from './prompt.js';

/** 加载器读取的插件元数据。 */
export const name = '@idlercloud/dsh-git-bash';
export const inject = ['subprocess'];
export const Config = LocalBashExecutor.Config;
// 暴露给测试：离线 harness 用它验证解析链与报错质量。
export { candidateBashPaths, resolveBashPath };

/** WSL 的 bash 启动器：路径形如 C:\Windows\System32\bash.exe —— 语义不对，必须跳过。 */
const WSL_LAUNCHER = /[\\/]System32[\\/]bash\.exe$/i;

/** 显式配置（行 config 的 bashPath），优先级最高。 */
let configuredPath;

/**
 * Git for Windows 在注册表里登记自己的安装目录，这是唯一与安装位置无关的权威来源。
 * 机器级安装写 HKLM，用户级安装写 HKCU。
 * @returns 安装目录，未登记时 undefined。
 */
function registryInstallPath() {
  for (const hive of ['HKLM', 'HKCU']) {
    try {
      const out = execFileSync('reg.exe', ['query', `${hive}\\SOFTWARE\\GitForWindows`, '/v', 'InstallPath'], {
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const matched = /InstallPath\s+REG_SZ\s+(.+?)\s*$/m.exec(out);
      if (matched?.[1]) return matched[1].trim();
    } catch {}
  }
  return undefined;
}

/**
 * 按可靠性排序列出候选 bash.exe 路径。
 * @param env - 用于探测的环境变量，默认进程环境。
 * @returns 候选路径（已去重，未做存在性检查）。
 */
function candidateBashPaths(env = process.env) {
  const list = [];
  const push = (candidate) => {
    if (candidate && !list.includes(candidate)) list.push(candidate);
  };

  const install = registryInstallPath();
  if (install) {
    push(join(install, 'bin', 'bash.exe'));
    push(join(install, 'usr', 'bin', 'bash.exe'));
  }

  const programFiles = env.ProgramFiles ?? 'C:\\Program Files';
  push(join(programFiles, 'Git', 'bin', 'bash.exe'));
  for (const key of ['ProgramFiles(x86)', 'ProgramW6432']) {
    const base = env[key];
    if (base) push(join(base, 'Git', 'bin', 'bash.exe'));
  }
  if (env.LOCALAPPDATA) push(join(env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe'));
  if (env.USERPROFILE) push(join(env.USERPROFILE, 'scoop', 'apps', 'git', 'current', 'bin', 'bash.exe'));
  if (env.ProgramData) push(join(env.ProgramData, 'chocolatey', 'lib', 'git', 'tools', 'bin', 'bash.exe'));

  // PATH：直接命中 bash.exe；以及从 git.exe 所在目录反推 —— Git 默认把 Git\cmd 放进 PATH。
  for (const entry of (env.PATH ?? '').split(';')) {
    const dir = entry.trim().replace(/^"|"$/g, '');
    if (!dir) continue;
    push(join(dir, 'bash.exe'));
    push(join(dir, '..', 'bin', 'bash.exe'));
  }
  return list;
}

/**
 * 该路径是否可以被 spawn。用 lstat 而不是 stat：Store 版应用别名是 reparse point，
 * stat 会跟到目标上，而 CreateProcess 两种形态都能启动。
 * @param path - 待检查的绝对路径。
 * @returns 是否可启动。
 */
function spawnable(path) {
  try {
    const stat = lstatSync(path);
    return stat.isFile() || stat.isSymbolicLink();
  } catch {
    return false;
  }
}

/** 解析结果缓存：避免每条命令都探一次注册表；命中后仍会复核，失效即重新解析。 */
let resolved;

/**
 * 解析要执行的 bash.exe。
 * @returns 绝对路径。
 * @throws 找不到时抛出带完整排查信息的错误（不静默回退到 WSL）。
 */
function resolveBashPath() {
  const explicit = configuredPath || process.env.DSH_GIT_BASH;
  if (explicit) {
    // 显式指定优先；是路径就顺便校验一下，给出可操作的报错而不是裸 ENOENT。
    if ((explicit.includes('\\') || explicit.includes('/')) && !spawnable(explicit)) {
      const error = new Error(`dsh-git-bash: bashPath / DSH_GIT_BASH points at ${explicit} but no such file exists.`);
      error.code = 'GIT_BASH_NOT_FOUND';
      throw error;
    }
    return explicit;
  }
  // 缓存命中也要复核：Git 被卸载或搬走后自动重新解析，而不是拿着旧路径一直失败。
  let stale;
  if (resolved) {
    if (spawnable(resolved)) return resolved;
    stale = resolved;
    resolved = undefined;
  }

  const tried = [];
  if (stale) tried.push(`${stale}   [used earlier, no longer exists]`);
  for (const candidate of candidateBashPaths()) {
    if (WSL_LAUNCHER.test(candidate)) {
      tried.push(`${candidate}   [skipped: WSL launcher]`);
      continue;
    }
    tried.push(candidate);
    if (spawnable(candidate)) {
      resolved = candidate;
      return candidate;
    }
  }

  const error = new Error(
    'dsh-git-bash: no Git Bash found on this machine. Tried:\n' +
      tried.map((line) => `  - ${line}`).join('\n') +
      '\nInstall Git for Windows, or point this plugin at bash.exe explicitly — set the ' +
      'DSH_GIT_BASH environment variable, or write bashPath into the plugin row config.',
  );
  error.code = 'GIT_BASH_NOT_FOUND';
  throw error;
}

/** 裸 bash 名字（不含路径分隔符）。带路径的 argv 一律不动：那是调用方自己选定的 shell。 */
const BARE_BASH = /^bash(\.exe)?$/i;

/** 日志句柄在 apply() 里设。 */
let logger;

/**
 * 把 argv 里的裸 bash 换成解析出来的 Git Bash 绝对路径；带路径的 argv 一律不动
 * （那是调用方自己选定的 shell），其余 argv 原样返回。
 * @param argv - 上游准备好的 argv。
 * @returns 可能替换了 argv[0] 的 argv。
 */
function gitBashArgv(argv) {
  if (!Array.isArray(argv) || typeof argv[0] !== 'string' || !BARE_BASH.test(argv[0])) return argv;
  return [resolveBashPath(), ...argv.slice(1)];
}

/**
 * 本地 bash 执行器。
 *
 * 主替换点是 spawnSpec：无论上游走新版（execute → executeArgv）还是旧版
 * （run/start → runArgv/startArgv），argv 最后都在这里落成 spawn 配置，
 * 所以只在这里把裸 bash 换成 Git Bash，就不必跟随上游的入口命名。
 *
 * 入口方法（execute / run / start）仍然覆盖一层，作为第二道保险：
 * 它们存在时直接把 Git Bash 的绝对路径递进去，spawnSpec 那层就成了空操作；
 * 哪天入口改名，基类实现照样会走到 spawnSpec，仍然命中 Git Bash。
 */
// TODO: 只支持最新 DSH 后收掉兼容层——按当时的宿主确认官方子类入口（execute → executeArgv），
// 去掉 run / start 与 spawnSpec 的兜底，并删掉 harness 的 E 段。上游再改名时直接跟改。
class GitBashExecutor extends LocalBashExecutor {
  /**
   * 收口点：把上游准备好的 argv 里的裸 bash 换成 Git Bash。
   * @param spec - resolve() 产出的执行规格。
   * @param argv - 上游准备的 argv。
   * @param stdoutMaxBytes - stdout 上限。
   * @param signal - 取消 / 超时信号。
   * @returns 完整 spawn 配置。
   */
  spawnSpec(spec, argv, stdoutMaxBytes, signal) {
    return super.spawnSpec(spec, gitBashArgv(argv), stdoutMaxBytes, signal);
  }

  /**
   * 新入口（dsh >= 0.1.7-rc.1）：工具层调用 `ctx.shell.resolve()` 后
   * `ctx.shell.execute(spec)`，execute 必须返回 ShellProcess 句柄。
   * 基类的 execute 写死了裸 `bash`（在 Windows 上会命中 System32 的 WSL 启动器）。
   * @param spec - resolve() 产出的执行规格。
   * @returns ShellProcess 句柄。
   */
  async execute(spec) {
    if (typeof this.executeArgv === 'function') {
      return this.executeArgv(spec, [resolveBashPath(), '-c', spec.command]);
    }
    return super.execute(spec);
  }

  /**
   * 旧入口（dsh <= 0.1.6）：run 返回 `{ result }`。
   * 保留以兼容仍走 run/start 的上游版本；新版本不会调用到。
   * @param spec - 执行规格。
   * @returns 带 result 的对象。
   */
  async run(spec) {
    if (typeof this.runArgv === 'function') {
      const { result } = await this.runArgv(spec, [resolveBashPath(), '-c', spec.command]);
      return result;
    }
    return super.run(spec);
  }

  /**
   * 旧入口（dsh <= 0.1.6）：start 返回后台句柄。
   * @param spec - 执行规格。
   * @returns ShellProcess 句柄。
   */
  async start(spec) {
    if (typeof this.startArgv === 'function') {
      return this.startArgv(spec, [resolveBashPath(), '-c', spec.command]);
    }
    return super.start(spec);
  }
}

/**
 * 挂载执行器与权限闸门。
 *
 * @param ctx - 挂载点 context（位于 isolate 隔离作用域内）。
 * @param config - 组合条目配置，可含 bashPath / cwd / timeoutMs 等。
 */
export function apply(ctx, config) {
  configuredPath = config?.bashPath ? config.bashPath : undefined;
  logger = ctx.logger;
  installGitBashPrompt(ctx);
  if (installBashGuard(ctx) !== undefined) {
    logger?.info?.(
      'dsh-git-bash: `bash` is denied before spawn unless the session file policy is `%s`.',
      FULL_ACCESS_MODE,
    );
  }
  // 上游原版称 LocalBashExecutor 构造时会 ctx.inject([settings], ...) 注册名为 shell 的
  // 设置段，与宿主 pwsh 执行器已注册的同名段冲突，所以这里把 inject 换成空函数。
  // TODO: 换宿主版本后核查是否仍需要。当前 0.2.1-rc.5 的 LocalBashExecutor /
  // ShellExecutor 构造函数里没有这个调用，屏蔽是空操作。
  const executorCtx = ctx.extend({ inject: () => {} });
  new GitBashExecutor(executorCtx, config);
  try {
    logger?.info?.('dsh-git-bash: bash.exe -> %s', resolveBashPath());
  } catch (error) {
    logger?.warn?.('dsh-git-bash: %s', error.message);
  }
}
