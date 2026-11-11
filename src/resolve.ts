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
 * 每个候选先判断是否存在；`%SystemRoot%\System32\bash.exe` 与
 * `%LOCALAPPDATA%\Microsoft\WindowsApps\bash.exe` 是 WSL 启动器，直接跳过。
 * 显式配置里的裸名字先经 `where` 解析成 PATH 上的绝对路径。
 *
 * 解析结果会缓存。缓存命中时只复核文件是否还在，不再探测。配置变化时由新的解析器接管。
 *
 * @module dsh-git-bash/resolve
 */
import { execFileSync } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** 构造选项；env、lstat、run 可在单测里换成假实现。 */
export interface BashResolverOptions {
  bashPath?: string;
  env?: NodeJS.ProcessEnv;
  lstat?: typeof lstatSync;
  run?: typeof execFileSync;
}

/** 比较路径用的归一化：统一分隔符，忽略大小写。 */
const canonicalPath = (path: string): string => path.replaceAll('/', '\\').toLowerCase();

/** 显式配置不合法时的错误。 */
function invalidExplicit(value: string, detail: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(
    `dsh-git-bash: bashPath / DSH_GIT_BASH points at ${value}, but ${detail}.`,
  );
  error.code = 'GIT_BASH_NOT_FOUND';
  return error;
}

/** 值里是否带路径分隔符：带的是路径，不带的是交给 PATH 的裸名字。 */
const hasSeparator = (value: string): boolean => value.includes('\\') || value.includes('/');

export class BashResolver {
  private readonly env: NodeJS.ProcessEnv;
  private readonly lstat: typeof lstatSync;
  private readonly run: typeof execFileSync;
  private readonly configuredPath: string | undefined;
  private cached: string | undefined;

  /** 配置与环境在创建时固定；配置变化时由新的解析器接管。 */
  constructor({ bashPath, env = process.env, lstat = lstatSync, run = execFileSync }: BashResolverOptions = {}) {
    this.env = env;
    this.configuredPath = bashPath || this.env.DSH_GIT_BASH;
    this.lstat = lstat;
    this.run = run;
  }

  /**
   * 按可靠性排序列出候选 bash.exe，未做存在性检查。
   * @returns 候选路径（已去重）。
   */
  candidates(): string[] {
    const env = this.env;
    const list: string[] = [];
    const add = (candidate: string): void => {
      if (list.some((existing) => existing.toLowerCase() === candidate.toLowerCase())) return;
      list.push(candidate);
    };
    const addRoot = (root: string): void => {
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
      const output = this.runText('reg.exe', ['query', key, '/v', 'InstallPath']);
      const install = /InstallPath\s+REG_SZ\s+(.+?)\s*$/m.exec(output)?.[1]?.trim();
      if (install) addRoot(install);
    }

    // 4. 常见安装位置
    add(join(env.ProgramFiles ?? 'C:\\Program Files', 'Git\\bin\\bash.exe'));
    for (const key of ['ProgramFiles(x86)', 'ProgramW6432']) {
      const value = env[key];
      if (value) add(join(value, 'Git\\bin\\bash.exe'));
    }
    if (env.LOCALAPPDATA) add(join(env.LOCALAPPDATA, 'Programs\\Git\\bin\\bash.exe'));
    if (env.USERPROFILE) add(join(env.USERPROFILE, 'scoop\\apps\\git\\current\\bin\\bash.exe'));
    if (env.ProgramData) add(join(env.ProgramData, 'chocolatey\\lib\\git\\tools\\bin\\bash.exe'));

    // 5. where git 的命中反推安装根
    for (const git of this.wherePaths('git')) {
      const dir = dirname(git);
      add(join(dir, '..\\bin\\bash.exe'));
      add(join(dir, '..\\usr\\bin\\bash.exe'));
    }

    // 6. where bash 的直接命中
    for (const bash of this.wherePaths('bash')) add(bash);

    return list;
  }

  /**
   * 解析要执行的 bash.exe。缓存命中时只复核文件是否还在。
   * @returns bash.exe 的绝对路径。
   * @throws 显式配置不合法或找不到 Git Bash 时抛出带完整排查信息的错误（不静默回退到 WSL）。
   */
  resolve(): string {
    // 缓存优先：上次解析成功的路径还在就直接用。
    let stale: string | undefined;
    if (this.cached) {
      if (this.exists(this.cached)) return this.cached;
      stale = this.cached;
      this.cached = undefined;
    }

    // 1. config 里的 bashPath / DSH_GIT_BASH：显式指定，经同样的校验后缓存。
    const explicit = this.configuredPath;
    if (explicit) {
      this.cached = this.validateExplicit(explicit);
      return this.cached;
    }

    const tried: string[] = [];
    if (stale) tried.push(`${stale}   [used earlier, no longer exists]`);

    for (const candidate of this.candidates()) {
      if (this.isWslLauncher(candidate)) {
        tried.push(`${candidate}   [skipped: WSL launcher]`);
        continue;
      }
      if (!this.exists(candidate)) {
        tried.push(candidate);
        continue;
      }
      this.cached = candidate;
      return candidate;
    }

    const error: NodeJS.ErrnoException = new Error(
      'dsh-git-bash: no Git Bash found on this machine. Tried:\n' +
        tried.map((line) => `  - ${line}`).join('\n') +
        '\nInstall Git for Windows, or point this plugin at bash.exe explicitly — set the ' +
        'DSH_GIT_BASH environment variable, or write bashPath into the plugin row config.',
    );
    error.code = 'GIT_BASH_NOT_FOUND';
    throw error;
  }

  /**
   * 校验显式指定的 bash：路径必须存在且不是 WSL 启动器。
   * 裸名字先经 `where` 解析成 PATH 上的第一个 Git Bash，返回其绝对路径。
   */
  private validateExplicit(value: string): string {
    if (hasSeparator(value)) {
      if (!this.exists(value)) throw invalidExplicit(value, 'no such file exists');
      if (this.isWslLauncher(value)) throw invalidExplicit(value, 'it is the WSL launcher, not Git Bash');
      return value;
    }

    for (const candidate of this.wherePaths(value)) {
      if (this.isWslLauncher(candidate) || !this.exists(candidate)) continue;
      return candidate;
    }
    throw invalidExplicit(value, 'no Git Bash with that name is on PATH');
  }

  /**
   * 是否为 WSL 的 bash 启动器：`%SystemRoot%\System32\bash.exe`，或当前用户的
   * `%LOCALAPPDATA%\Microsoft\WindowsApps\bash.exe`。
   */
  private isWslLauncher(path: string): boolean {
    const env = this.env;
    const target = canonicalPath(path);
    if (env.SystemRoot && canonicalPath(join(env.SystemRoot, 'System32\\bash.exe')) === target) return true;
    if (env.windir && canonicalPath(join(env.windir, 'System32\\bash.exe')) === target) return true;
    if (env.LOCALAPPDATA && canonicalPath(join(env.LOCALAPPDATA, 'Microsoft\\WindowsApps\\bash.exe')) === target) {
      return true;
    }
    return false;
  }

  /** 该路径是否能 spawn。用 lstat 而不是 stat：Store 版应用别名是 reparse point。 */
  private exists(path: string): boolean {
    try {
      const stat = this.lstat(path);
      return stat.isFile() || stat.isSymbolicLink();
    } catch {
      return false;
    }
  }

  /** 跑一条只读命令，失败时返回空串。注册表与 where 都走这里。 */
  private runText(file: string, args: string[]): string {
    try {
      return this.run(file, args, { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return '';
    }
  }

  private wherePaths(name: string): string[] {
    return this.runText('where.exe', [name])
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  }
}
