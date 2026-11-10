/**
 * Git Bash 的发现与选择。
 *
 * 顺序：
 *   1. config 里的 bashPath / 环境变量 DSH_GIT_BASH
 *   2. GIT_INSTALL_ROOT
 *   3. 注册表 InstallPath（HKCU、HKLM、WOW6432Node）
 *   4. 常见安装位置
 *   5. where git 反推安装根
 *   6. where bash
 *
 * 每个候选先判断是否存在，再跑 `uname -s` 确认是 MINGW / MSYS；
 * `%SystemRoot%\System32\bash.exe` 与 `%LOCALAPPDATA%\Microsoft\WindowsApps\bash.exe`
 * 是 WSL 启动器，直接跳过。显式配置里的裸名字先经 `where` 解析成 PATH 上的绝对路径。
 *
 * 解析结果会缓存。缓存命中时只复核文件是否还在，不再探测；configure 改配置会重置缓存。
 *
 * @module dsh-git-bash/resolve
 */
import { execFileSync } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** 比较路径用的归一化：统一分隔符，忽略大小写。 */
const canonicalPath = (path) => path.replaceAll('/', '\\').toLowerCase();

/** Git Bash 的 `uname -s` 值：MINGW64_NT-10.0-… 或 MSYS_NT-…。 */
const GIT_BASH_IDENTITY = /^(MINGW|MSYS)/i;

/** 显式配置不合法时的错误。 */
function invalidExplicit(value, detail) {
  const error = new Error(`dsh-git-bash: bashPath / DSH_GIT_BASH points at ${value}, but ${detail}.`);
  error.code = 'GIT_BASH_NOT_FOUND';
  return error;
}

/** 值里是否带路径分隔符：带的是路径，不带的是交给 PATH 的裸名字。 */
const hasSeparator = (value) => value.includes('\\') || value.includes('/');

export class BashResolver {
  #env;
  #lstat;
  #run;
  #configuredPath;
  #cached;

  /**
   * @param options - 可选的 env、lstat、run，单测用假实现。
   */
  constructor({ env = process.env, lstat = lstatSync, run = execFileSync } = {}) {
    this.#env = env;
    this.#lstat = lstat;
    this.#run = run;
  }

  /** config 里的 bashPath；未设置时回退到 DSH_GIT_BASH。改配置会重置缓存。 */
  configure(path) {
    this.#configuredPath = path || undefined;
    this.#cached = undefined;
  }

  /**
   * 按可靠性排序列出候选 bash.exe，未做存在性与身份检查。
   * @returns 候选路径（已去重）。
   */
  candidates() {
    const env = this.#env;
    const list = [];
    const add = (candidate) => {
      if (!candidate) return;
      if (list.some((existing) => existing.toLowerCase() === candidate.toLowerCase())) return;
      list.push(candidate);
    };
    const addRoot = (root) => {
      add(join(root, 'bin\\bash.exe'));
      add(join(root, 'usr\\bin\\bash.exe'));
    };

    // 2. GIT_INSTALL_ROOT（Scoop 的 git 包会设）
    if (env.GIT_INSTALL_ROOT) addRoot(env.GIT_INSTALL_ROOT);

    // 3. 注册表 InstallPath（HKCU → HKLM → WOW6432Node）。32 位安装器会写 WOW6432Node。
    const registryKeys = [
      'HKCU\\SOFTWARE\\GitForWindows',
      'HKLM\\SOFTWARE\\GitForWindows',
      'HKLM\\SOFTWARE\\WOW6432Node\\GitForWindows',
    ];
    for (const key of registryKeys) {
      const output = this.#runText('reg.exe', ['query', key, '/v', 'InstallPath']);
      const install = /InstallPath\s+REG_SZ\s+(.+?)\s*$/m.exec(output)?.[1]?.trim();
      if (install) addRoot(install);
    }

    // 4. 常见安装位置
    add(join(env.ProgramFiles ?? 'C:\\Program Files', 'Git\\bin\\bash.exe'));
    for (const key of ['ProgramFiles(x86)', 'ProgramW6432']) {
      if (env[key]) add(join(env[key], 'Git\\bin\\bash.exe'));
    }
    if (env.LOCALAPPDATA) add(join(env.LOCALAPPDATA, 'Programs\\Git\\bin\\bash.exe'));
    if (env.USERPROFILE) add(join(env.USERPROFILE, 'scoop\\apps\\git\\current\\bin\\bash.exe'));
    if (env.ProgramData) add(join(env.ProgramData, 'chocolatey\\lib\\git\\tools\\bin\\bash.exe'));

    // 5. where git 的命中反推安装根
    for (const git of this.#wherePaths('git')) {
      const dir = dirname(git);
      add(join(dir, '..\\bin\\bash.exe'));
      add(join(dir, '..\\usr\\bin\\bash.exe'));
    }

    // 6. where bash 的直接命中
    for (const bash of this.#wherePaths('bash')) add(bash);

    return list;
  }

  /**
   * 解析要执行的 bash.exe。缓存命中时只复核文件是否还在。
   * @returns bash.exe 的绝对路径。
   * @throws 显式配置不合法或找不到 Git Bash 时抛出带完整排查信息的错误（不静默回退到 WSL）。
   */
  resolve() {
    // 缓存优先：上次解析成功的路径还在就直接用。显式配置变更由 configure 重置缓存。
    let stale;
    if (this.#cached) {
      if (this.#exists(this.#cached)) return this.#cached;
      stale = this.#cached;
      this.#cached = undefined;
    }

    // 1. config 里的 bashPath / DSH_GIT_BASH：显式指定，经同样的校验后缓存。
    const explicit = this.#configuredPath || this.#env.DSH_GIT_BASH;
    if (explicit) {
      this.#cached = this.#validateExplicit(explicit);
      return this.#cached;
    }

    const tried = [];
    if (stale) tried.push(`${stale}   [used earlier, no longer exists]`);

    for (const candidate of this.candidates()) {
      if (this.#isWslLauncher(candidate)) {
        tried.push(`${candidate}   [skipped: WSL launcher]`);
        continue;
      }
      if (!this.#exists(candidate)) {
        tried.push(candidate);
        continue;
      }
      const identity = this.#identityOf(candidate);
      if (!GIT_BASH_IDENTITY.test(identity)) {
        tried.push(`${candidate}   [rejected: ${identity || 'uname -s failed'}]`);
        continue;
      }
      this.#cached = candidate;
      return candidate;
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

  /**
   * 校验显式指定的 bash：路径必须存在且不是 WSL 启动器，然后跑一次 `uname -s`。
   * 裸名字先经 `where` 解析成 PATH 上的第一个 Git Bash，返回其绝对路径。
   */
  #validateExplicit(value) {
    if (hasSeparator(value)) {
      if (!this.#exists(value)) throw invalidExplicit(value, 'no such file exists');
      if (this.#isWslLauncher(value)) throw invalidExplicit(value, 'it is the WSL launcher, not Git Bash');
      const identity = this.#identityOf(value);
      if (!GIT_BASH_IDENTITY.test(identity)) {
        if (identity) throw invalidExplicit(value, `it reports "${identity}", not MINGW/MSYS`);
        throw invalidExplicit(value, 'running `uname -s` failed');
      }
      return value;
    }

    for (const candidate of this.#wherePaths(value)) {
      if (this.#isWslLauncher(candidate) || !this.#exists(candidate)) continue;
      if (GIT_BASH_IDENTITY.test(this.#identityOf(candidate))) return candidate;
    }
    throw invalidExplicit(value, 'no Git Bash with that name is on PATH');
  }

  /**
   * 是否为 WSL 的 bash 启动器：`%SystemRoot%\System32\bash.exe`，或当前用户的
   * `%LOCALAPPDATA%\Microsoft\WindowsApps\bash.exe`。
   */
  #isWslLauncher(path) {
    const env = this.#env;
    const target = canonicalPath(path);
    if (env.SystemRoot && canonicalPath(join(env.SystemRoot, 'System32\\bash.exe')) === target) return true;
    if (env.windir && canonicalPath(join(env.windir, 'System32\\bash.exe')) === target) return true;
    if (env.LOCALAPPDATA && canonicalPath(join(env.LOCALAPPDATA, 'Microsoft\\WindowsApps\\bash.exe')) === target) {
      return true;
    }
    return false;
  }

  /** 该路径是否能 spawn。用 lstat 而不是 stat：Store 版应用别名是 reparse point。 */
  #exists(path) {
    try {
      const stat = this.#lstat(path);
      return stat.isFile() || stat.isSymbolicLink();
    } catch {
      return false;
    }
  }

  /** 跑一条只读命令，失败时返回空串。注册表与 where 都走这里。 */
  #runText(file, args) {
    try {
      return String(
        this.#run(file, args, { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }),
      );
    } catch {
      return '';
    }
  }

  /** 问候选它是不是 Git Bash；超时或启动失败都算否。 */
  #identityOf(file) {
    try {
      return String(
        this.#run(file, ['-c', 'uname -s'], {
          encoding: 'utf8',
          timeout: 5000,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'ignore'],
        }),
      ).trim();
    } catch {
      return '';
    }
  }

  #wherePaths(name) {
    return this.#runText('where.exe', [name])
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  }
}
