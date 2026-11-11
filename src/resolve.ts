/**
 * Git Bash 的发现与选择。
 *
 * 顺序：
 *   1. config 里的 bashPath / 环境变量 DSH_GIT_BASH
 *   2. GIT_INSTALL_ROOT
 *   3. PATH 中 git.exe 反推安装根
 *   4. 常见安装位置
 *
 * 每个候选先判断是否存在；`%SystemRoot%\System32\bash.exe` 与
 * `%LOCALAPPDATA%\Microsoft\WindowsApps\bash.exe` 是 WSL 启动器，直接跳过。
 * 显式配置里的裸名字直接从 PATH 解析成绝对路径。
 *
 * 解析结果会缓存。缓存命中时只复核文件是否还在，不再探测。配置变化时由新的解析器接管。
 *
 * @module dsh-git-bash/resolve
 */
import { lstatSync, statSync } from 'node:fs';
import { dirname, join, win32 } from 'node:path';

/** 构造选项；env、stat、lstat 可在单测里换成假实现。 */
export interface BashResolverOptions {
  bashPath?: string;
  env?: NodeJS.ProcessEnv;
  stat?: typeof statSync;
  lstat?: typeof lstatSync;
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
  private readonly stat: typeof statSync;
  private readonly lstat: typeof lstatSync;
  private readonly configuredPath: string | undefined;
  private cached: string | undefined;

  /** 配置与环境在创建时固定；配置变化时由新的解析器接管。 */
  constructor({ bashPath, env = process.env, stat = statSync, lstat = lstatSync }: BashResolverOptions = {}) {
    this.env = env;
    const explicit = bashPath || this.env.DSH_GIT_BASH;
    // 在创建时固定路径基准，避免执行命令的 workdir 或后续 cwd 变化影响程序位置。
    this.configuredPath = explicit && hasSeparator(explicit) ? win32.resolve(explicit) : explicit;
    this.stat = stat;
    this.lstat = lstat;
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

    // 3. PATH 中 git.exe 的命中反推安装根
    for (const git of this.findExecutables('git')) {
      const dir = dirname(git);
      add(join(dir, '..\\bin\\bash.exe'));
      add(join(dir, '..\\usr\\bin\\bash.exe'));
    }

    // 4. 常见安装位置
    add(join(env.ProgramFiles ?? 'C:\\Program Files', 'Git\\bin\\bash.exe'));
    for (const key of ['ProgramFiles(x86)', 'ProgramW6432']) {
      const value = env[key];
      if (value) add(join(value, 'Git\\bin\\bash.exe'));
    }
    if (env.LOCALAPPDATA) add(join(env.LOCALAPPDATA, 'Programs\\Git\\bin\\bash.exe'));
    if (env.USERPROFILE) add(join(env.USERPROFILE, 'scoop\\apps\\git\\current\\bin\\bash.exe'));

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
   * 裸名字从 PATH 选择第一个非 WSL 的 bash，返回其绝对路径。
   */
  private validateExplicit(value: string): string {
    if (hasSeparator(value)) {
      if (!this.exists(value)) throw invalidExplicit(value, 'no such file exists');
      if (this.isWslLauncher(value)) throw invalidExplicit(value, 'it is the WSL launcher, not Git Bash');
      return value;
    }

    for (const candidate of this.findExecutables(value)) {
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

  private exists(path: string): boolean {
    try {
      return this.stat(path).isFile();
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'EACCES') return false;
    }
    try {
      const entry = this.lstat(path);
      return entry.isFile() || entry.isSymbolicLink();
    } catch {
      return false;
    }
  }

  private findExecutables(name: string): string[] {
    const pathKey = Object.keys(this.env).find((key) => key.toUpperCase() === 'PATH');
    const path = pathKey === undefined ? '' : (this.env[pathKey] ?? '');
    if (win32.extname(name) && win32.extname(name).toLowerCase() !== '.exe') return [];
    const executable = win32.extname(name) ? name : `${name}.exe`;
    const hits: string[] = [];
    for (const entry of path.split(';')) {
      const directory = entry.trim().replace(/^"|"$/g, '');
      if (!directory) continue;
      const candidate = win32.resolve(directory, executable);
      if (this.exists(candidate)) hits.push(candidate);
    }
    return hits;
  }
}
