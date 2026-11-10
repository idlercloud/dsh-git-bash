/**
 * lib/resolve.js 的单测：用假的文件系统与子进程覆盖发现链与选择规则。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BashResolver } from '../lib/resolve.js';

const ENV = {
  SystemRoot: 'C:\\Windows',
  ProgramFiles: 'C:\\Program Files',
  LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
  USERPROFILE: 'C:\\Users\\me',
  ProgramData: 'C:\\ProgramData',
};

const normalize = (path) => String(path).replaceAll('/', '\\').toLowerCase();

/**
 * 解析器的假依赖：files 决定 lstat 的结果，registryInstallPaths / whereHits / unameOutputs
 * 决定 reg.exe、where.exe 与 `uname -s` 的输出；recordedCalls 记录所有跑过的命令。
 */
class MockRunner {
  recordedCalls = [];

  constructor({ files = [], registryInstallPaths = {}, whereHits = {}, unameOutputs = {} } = {}) {
    this.files = new Set(files.map(normalize));
    this.registryInstallPaths = registryInstallPaths;
    this.whereHits = whereHits;
    this.unameOutputs = unameOutputs;
  }

  lstat = (path) => {
    if (!this.files.has(normalize(path))) throw new Error('ENOENT');
    return { isFile: () => true, isSymbolicLink: () => false };
  };

  run = (file, args) => {
    this.recordedCalls.push([file, ...args]);
    if (file === 'reg.exe') {
      const install = this.registryInstallPaths[args[1]];
      if (!install) throw new Error('registry key not found');
      return `    InstallPath    REG_SZ    ${install}\n`;
    }
    if (file === 'where.exe') {
      const hits = this.whereHits[args[0]];
      if (!hits?.length) throw new Error('not found');
      return hits.join('\r\n');
    }
    const output = this.unameOutputs[normalize(file)];
    if (output === undefined) throw new Error(`unexpected probe: ${file}`);
    return output;
  };
}

function resolverFor(runner, env = ENV) {
  return new BashResolver({ env, lstat: runner.lstat, run: runner.run });
}

describe('BashResolver', () => {
  it('显式配置存在时先校验身份，不查注册表或 where', () => {
    const expected = 'C:\\Git\\bin\\bash.exe';
    const runner = new MockRunner({
      files: [expected],
      unameOutputs: { [normalize(expected)]: 'MINGW64_NT-10.0-26300' },
    });
    const resolver = resolverFor(runner, { ...ENV, DSH_GIT_BASH: 'C:\\other\\bash.exe' });
    resolver.configure(expected);

    assert.equal(resolver.resolve(), expected);
    assert.deepEqual(runner.recordedCalls, [[expected, '-c', 'uname -s']]);
  });

  it('config 里没有 bashPath 时回退到 DSH_GIT_BASH', () => {
    const expected = 'C:\\other\\bash.exe';
    const runner = new MockRunner({
      files: [expected],
      unameOutputs: { [normalize(expected)]: 'MINGW64_NT-10.0-26300' },
    });
    const resolver = resolverFor(runner, { ...ENV, DSH_GIT_BASH: expected });

    assert.equal(resolver.resolve(), expected);
  });

  it('显式配置的路径不存在时抛错', () => {
    const resolver = resolverFor(new MockRunner());
    resolver.configure('C:\\nope\\bash.exe');

    assert.throws(
      () => resolver.resolve(),
      (error) => error.code === 'GIT_BASH_NOT_FOUND' && error.message.includes('C:\\nope\\bash.exe'),
    );
  });

  it('裸名字解析成 PATH 上的完整路径并缓存', () => {
    const expected = 'C:\\Tools\\bash.exe';
    const runner = new MockRunner({
      files: [expected],
      whereHits: { bash: [expected] },
      unameOutputs: { [normalize(expected)]: 'MINGW64_NT-10.0-26300' },
    });
    const resolver = resolverFor(runner);
    resolver.configure('bash');

    assert.equal(resolver.resolve(), expected);
    assert.equal(resolver.resolve(), expected);
    assert.deepEqual(runner.recordedCalls, [
      ['where.exe', 'bash'],
      [expected, '-c', 'uname -s'],
    ]);
  });

  it('裸名字跳过 PATH 上的 WSL 启动器', () => {
    const wsl = 'C:\\Windows\\System32\\bash.exe';
    const alias = 'C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\bash.exe';
    const expected = 'C:\\Tools\\bash.exe';
    const runner = new MockRunner({
      files: [wsl, alias, expected],
      whereHits: { bash: [wsl, alias, expected] },
      unameOutputs: { [normalize(expected)]: 'MINGW64_NT-10.0-26300' },
    });
    const resolver = resolverFor(runner);
    resolver.configure('bash');

    assert.equal(resolver.resolve(), expected);
  });

  it('裸名字在 PATH 上找不到 Git Bash 时拒绝', () => {
    const wsl = 'C:\\Windows\\System32\\bash.exe';
    const resolver = resolverFor(new MockRunner({ files: [wsl], whereHits: { bash: [wsl] } }));
    resolver.configure('bash');

    assert.throws(
      () => resolver.resolve(),
      (error) => error.code === 'GIT_BASH_NOT_FOUND' && error.message.includes('on PATH'),
    );
  });

  it('显式配置指向 WSL 启动器时拒绝', () => {
    const wslBash = 'C:\\Windows\\System32\\bash.exe';
    const resolver = resolverFor(new MockRunner({ files: [wslBash] }));
    resolver.configure(wslBash);

    assert.throws(
      () => resolver.resolve(),
      (error) => error.code === 'GIT_BASH_NOT_FOUND' && error.message.includes('WSL'),
    );
  });

  it('显式配置指向 WindowsApps 的商店别名时拒绝', () => {
    const alias = 'C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\bash.exe';
    const resolver = resolverFor(new MockRunner({ files: [alias] }));
    resolver.configure(alias);

    assert.throws(
      () => resolver.resolve(),
      (error) => error.code === 'GIT_BASH_NOT_FOUND' && error.message.includes('WSL'),
    );
  });

  it('显式配置的身份不是 MINGW / MSYS 时拒绝', () => {
    const path = 'C:\\Tools\\bash.exe';
    const runner = new MockRunner({ files: [path], unameOutputs: { [normalize(path)]: 'Linux' } });
    const resolver = resolverFor(runner);
    resolver.configure(path);

    assert.throws(
      () => resolver.resolve(),
      (error) => error.code === 'GIT_BASH_NOT_FOUND' && error.message.includes('Linux'),
    );
  });

  it('显式配置跑不出 uname -s 时拒绝', () => {
    const path = 'C:\\Tools\\bash.exe';
    const runner = new MockRunner({ files: [path] });
    const resolver = resolverFor(runner);
    resolver.configure(path);

    assert.throws(
      () => resolver.resolve(),
      (error) => error.code === 'GIT_BASH_NOT_FOUND' && error.message.includes('uname -s'),
    );
  });

  it('configure 重置缓存', () => {
    const root = 'C:\\Scoop\\apps\\git\\current';
    const auto = `${root}\\bin\\bash.exe`;
    const configured = 'C:\\Git\\bin\\bash.exe';
    const runner = new MockRunner({
      files: [auto, configured],
      unameOutputs: {
        [normalize(auto)]: 'MINGW64_NT-10.0-26300',
        [normalize(configured)]: 'MINGW64_NT-10.0-26300',
      },
    });
    const resolver = resolverFor(runner, { ...ENV, GIT_INSTALL_ROOT: root });

    assert.equal(resolver.resolve(), auto);
    resolver.configure(configured);
    assert.equal(resolver.resolve(), configured);
  });

  it('缓存优先于环境变量', () => {
    const root = 'C:\\Scoop\\apps\\git\\current';
    const auto = `${root}\\bin\\bash.exe`;
    const env = { ...ENV, GIT_INSTALL_ROOT: root };
    const runner = new MockRunner({
      files: [auto],
      unameOutputs: { [normalize(auto)]: 'MINGW64_NT-10.0-26300' },
    });
    const resolver = resolverFor(runner, env);

    assert.equal(resolver.resolve(), auto);
    env.DSH_GIT_BASH = 'C:\\Nope\\bash.exe';
    assert.equal(resolver.resolve(), auto);
  });

  it('GIT_INSTALL_ROOT 命中 usr\\bin 下的 bash.exe', () => {
    const root = 'C:\\Scoop\\apps\\git\\current';
    const gitBash = `${root}\\usr\\bin\\bash.exe`;
    const runner = new MockRunner({
      files: [gitBash],
      unameOutputs: { [normalize(gitBash)]: 'MINGW64_NT-10.0-26300' },
    });
    const resolver = resolverFor(runner, { ...ENV, GIT_INSTALL_ROOT: root });

    assert.equal(resolver.resolve(), gitBash);
  });

  it('注册表按 HKCU、HKLM、WOW6432Node 的顺序查找', () => {
    const root = 'C:\\Program Files (x86)\\Git';
    const gitBash = `${root}\\bin\\bash.exe`;
    const runner = new MockRunner({
      files: [gitBash],
      registryInstallPaths: { 'HKLM\\SOFTWARE\\WOW6432Node\\GitForWindows': root },
      unameOutputs: { [normalize(gitBash)]: 'MINGW64_NT-10.0-26300' },
    });
    const resolver = resolverFor(runner);

    assert.equal(resolver.resolve(), gitBash);
    const registryQueries = runner.recordedCalls.filter(([file]) => file === 'reg.exe').map(([, , key]) => key);
    assert.deepEqual(registryQueries, [
      'HKCU\\SOFTWARE\\GitForWindows',
      'HKLM\\SOFTWARE\\GitForWindows',
      'HKLM\\SOFTWARE\\WOW6432Node\\GitForWindows',
    ]);
  });

  it('where git 的命中反推安装根', () => {
    const gitBash = 'C:\\Tools\\Git\\bin\\bash.exe';
    const runner = new MockRunner({
      files: [gitBash],
      whereHits: { git: ['C:\\Tools\\Git\\cmd\\git.exe'] },
      unameOutputs: { [normalize(gitBash)]: 'MINGW64_NT-10.0-26300' },
    });

    assert.equal(resolverFor(runner).resolve(), gitBash);
  });

  it('where bash 的直接命中', () => {
    const gitBash = 'C:\\Tools\\bash.exe';
    const runner = new MockRunner({
      files: [gitBash],
      whereHits: { bash: [gitBash] },
      unameOutputs: { [normalize(gitBash)]: 'MSYS_NT-10.0-26300' },
    });

    assert.equal(resolverFor(runner).resolve(), gitBash);
  });

  it('跳过 System32\\bash.exe，不做身份探测', () => {
    const wslBash = 'C:\\Windows\\System32\\bash.exe';
    const gitBash = 'C:\\Tools\\bash.exe';
    const runner = new MockRunner({
      files: [wslBash, gitBash],
      whereHits: { bash: [wslBash, gitBash] },
      unameOutputs: { [normalize(gitBash)]: 'MINGW64_NT-10.0-26300' },
    });

    assert.equal(resolverFor(runner).resolve(), gitBash);
    assert.equal(
      runner.recordedCalls.some(([file]) => normalize(file) === normalize(wslBash)),
      false,
    );
  });

  it('跳过 WindowsApps 下的商店别名，不做身份探测', () => {
    const alias = 'C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\bash.exe';
    const gitBash = 'C:\\Tools\\bash.exe';
    const runner = new MockRunner({
      files: [alias, gitBash],
      whereHits: { bash: [alias, gitBash] },
      unameOutputs: { [normalize(gitBash)]: 'MINGW64_NT-10.0-26300' },
    });

    assert.equal(resolverFor(runner).resolve(), gitBash);
    assert.equal(
      runner.recordedCalls.some(([file]) => normalize(file) === normalize(alias)),
      false,
    );
  });

  it('路径里带 System32 但不是系统目录时照常探测', () => {
    const gitBash = 'C:\\Tools\\System32\\bash.exe';
    const runner = new MockRunner({
      files: [gitBash],
      whereHits: { bash: [gitBash] },
      unameOutputs: { [normalize(gitBash)]: 'MINGW64_NT-10.0-26300' },
    });

    assert.equal(resolverFor(runner).resolve(), gitBash);
  });

  it('路径里带 WindowsApps 但不是商店别名时照常探测', () => {
    const gitBash = 'C:\\Tools\\WindowsApps\\bash.exe';
    const runner = new MockRunner({
      files: [gitBash],
      whereHits: { bash: [gitBash] },
      unameOutputs: { [normalize(gitBash)]: 'MINGW64_NT-10.0-26300' },
    });

    assert.equal(resolverFor(runner).resolve(), gitBash);
  });

  it('SystemRoot 不在 C: 时按完整路径跳过启动器', () => {
    const launcher = 'D:\\Windows\\System32\\bash.exe';
    const gitBash = 'D:\\Tools\\bash.exe';
    const runner = new MockRunner({
      files: [launcher, gitBash],
      whereHits: { bash: [launcher, gitBash] },
      unameOutputs: { [normalize(gitBash)]: 'MINGW64_NT-10.0-26300' },
    });
    const resolver = resolverFor(runner, { ...ENV, SystemRoot: 'D:\\Windows' });

    assert.equal(resolver.resolve(), gitBash);
    assert.equal(
      runner.recordedCalls.some(([file]) => normalize(file) === normalize(launcher)),
      false,
    );
  });

  it('身份不是 MINGW / MSYS 时继续找下一个', () => {
    const programFiles = 'C:\\Program Files\\Git\\bin\\bash.exe';
    const tools = 'C:\\Tools\\bash.exe';
    const runner = new MockRunner({
      files: [programFiles, tools],
      whereHits: { bash: [tools] },
      unameOutputs: { [normalize(programFiles)]: 'Linux', [normalize(tools)]: 'MINGW64_NT-10.0-26300' },
    });

    assert.equal(resolverFor(runner).resolve(), tools);
  });

  it('一个候选都没通过时抛错并列出原因', () => {
    const programFiles = 'C:\\Program Files\\Git\\bin\\bash.exe';
    const wsl = 'C:\\Windows\\System32\\bash.exe';
    const runner = new MockRunner({
      files: [programFiles, wsl],
      whereHits: { bash: [wsl] },
      unameOutputs: { [normalize(programFiles)]: 'Linux' },
    });

    assert.throws(
      () => resolverFor(runner).resolve(),
      (error) =>
        error.code === 'GIT_BASH_NOT_FOUND' &&
        error.message.includes('[rejected: Linux]') &&
        error.message.includes('[skipped: WSL launcher]'),
    );
  });

  it('解析结果被缓存，后续调用不再探测', () => {
    const root = 'C:\\Scoop\\apps\\git\\current';
    const gitBash = `${root}\\bin\\bash.exe`;
    const runner = new MockRunner({
      files: [gitBash],
      unameOutputs: { [normalize(gitBash)]: 'MINGW64_NT-10.0-26300' },
    });
    const resolver = resolverFor(runner, { ...ENV, GIT_INSTALL_ROOT: root });

    assert.equal(resolver.resolve(), gitBash);
    const countAfterFirst = runner.recordedCalls.length;
    assert.equal(resolver.resolve(), gitBash);
    assert.equal(runner.recordedCalls.length, countAfterFirst);
  });

  it('缓存的文件消失后重新解析', () => {
    const gitBash = 'C:\\Tools\\bash.exe';
    const runner = new MockRunner({
      files: [gitBash],
      whereHits: { bash: [gitBash] },
      unameOutputs: { [normalize(gitBash)]: 'MINGW64_NT-10.0-26300' },
    });
    const resolver = resolverFor(runner);

    assert.equal(resolver.resolve(), gitBash);
    runner.files.delete(normalize(gitBash));
    assert.throws(
      () => resolver.resolve(),
      (error) => error.code === 'GIT_BASH_NOT_FOUND' && error.message.includes('[used earlier, no longer exists]'),
    );
  });
});
