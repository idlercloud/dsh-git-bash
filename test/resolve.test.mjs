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
 * 解析器的假依赖：files 决定 lstat 的结果，registryInstallPaths / whereHits
 * 决定 reg.exe 与 where.exe 的输出；recordedCalls 记录所有跑过的命令。
 */
class MockRunner {
  recordedCalls = [];

  constructor({ files = [], registryInstallPaths = {}, whereHits = {} } = {}) {
    this.files = new Set(files.map(normalize));
    this.registryInstallPaths = registryInstallPaths;
    this.whereHits = whereHits;
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
    throw new Error(`unexpected probe: ${file}`);
  };
}

function resolverFor(runner, env = ENV, bashPath) {
  return new BashResolver({ bashPath, env, lstat: runner.lstat, run: runner.run });
}

describe('BashResolver', () => {
  it('显式配置存在时直接采用，不查注册表或 where', () => {
    const expected = 'C:\\Git\\bin\\bash.exe';
    const runner = new MockRunner({ files: [expected] });
    const resolver = resolverFor(runner, { ...ENV, DSH_GIT_BASH: 'C:\\other\\bash.exe' }, expected);

    assert.equal(resolver.resolve(), expected);
    assert.deepEqual(runner.recordedCalls, []);
  });

  it('config 里没有 bashPath 时回退到 DSH_GIT_BASH', () => {
    const expected = 'C:\\other\\bash.exe';
    const runner = new MockRunner({ files: [expected] });
    const resolver = resolverFor(runner, { ...ENV, DSH_GIT_BASH: expected });

    assert.equal(resolver.resolve(), expected);
  });

  it('显式配置的路径不存在时抛错', () => {
    const resolver = resolverFor(new MockRunner(), ENV, 'C:\\nope\\bash.exe');

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
    });
    const resolver = resolverFor(runner, ENV, 'bash');

    assert.equal(resolver.resolve(), expected);
    assert.equal(resolver.resolve(), expected);
    assert.deepEqual(runner.recordedCalls, [['where.exe', 'bash']]);
  });

  it('裸名字跳过 PATH 上的 WSL 启动器', () => {
    const wsl = 'C:\\Windows\\System32\\bash.exe';
    const alias = 'C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\bash.exe';
    const expected = 'C:\\Tools\\bash.exe';
    const runner = new MockRunner({
      files: [wsl, alias, expected],
      whereHits: { bash: [wsl, alias, expected] },
    });
    const resolver = resolverFor(runner, ENV, 'bash');

    assert.equal(resolver.resolve(), expected);
  });

  it('裸名字在 PATH 上找不到 Git Bash 时拒绝', () => {
    const wsl = 'C:\\Windows\\System32\\bash.exe';
    const resolver = resolverFor(new MockRunner({ files: [wsl], whereHits: { bash: [wsl] } }), ENV, 'bash');

    assert.throws(
      () => resolver.resolve(),
      (error) => error.code === 'GIT_BASH_NOT_FOUND' && error.message.includes('on PATH'),
    );
  });

  it('显式配置指向 WSL 启动器时拒绝', () => {
    const wslBash = 'C:\\Windows\\System32\\bash.exe';
    const resolver = resolverFor(new MockRunner({ files: [wslBash] }), ENV, wslBash);

    assert.throws(
      () => resolver.resolve(),
      (error) => error.code === 'GIT_BASH_NOT_FOUND' && error.message.includes('WSL'),
    );
  });

  it('显式配置指向 WindowsApps 的商店别名时拒绝', () => {
    const alias = 'C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\bash.exe';
    const resolver = resolverFor(new MockRunner({ files: [alias] }), ENV, alias);

    assert.throws(
      () => resolver.resolve(),
      (error) => error.code === 'GIT_BASH_NOT_FOUND' && error.message.includes('WSL'),
    );
  });

  it('构造时传入的 bashPath 优先于自动发现', () => {
    const root = 'C:\\Scoop\\apps\\git\\current';
    const auto = `${root}\\bin\\bash.exe`;
    const configured = 'C:\\Git\\bin\\bash.exe';
    const runner = new MockRunner({ files: [auto, configured] });
    const resolver = resolverFor(runner, { ...ENV, GIT_INSTALL_ROOT: root }, configured);

    assert.equal(resolver.resolve(), configured);
  });

  it('缓存优先于环境变量', () => {
    const root = 'C:\\Scoop\\apps\\git\\current';
    const auto = `${root}\\bin\\bash.exe`;
    const env = { ...ENV, GIT_INSTALL_ROOT: root };
    const runner = new MockRunner({ files: [auto] });
    const resolver = resolverFor(runner, env);

    assert.equal(resolver.resolve(), auto);
    env.DSH_GIT_BASH = 'C:\\Nope\\bash.exe';
    assert.equal(resolver.resolve(), auto);
  });

  it('GIT_INSTALL_ROOT 命中 usr\\bin 下的 bash.exe', () => {
    const root = 'C:\\Scoop\\apps\\git\\current';
    const gitBash = `${root}\\usr\\bin\\bash.exe`;
    const runner = new MockRunner({ files: [gitBash] });
    const resolver = resolverFor(runner, { ...ENV, GIT_INSTALL_ROOT: root });

    assert.equal(resolver.resolve(), gitBash);
  });

  it('注册表按 HKCU、HKLM、WOW6432Node 的顺序查找', () => {
    const root = 'C:\\Program Files (x86)\\Git';
    const gitBash = `${root}\\bin\\bash.exe`;
    const runner = new MockRunner({
      files: [gitBash],
      registryInstallPaths: { 'HKLM\\SOFTWARE\\WOW6432Node\\GitForWindows': root },
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
    });

    assert.equal(resolverFor(runner).resolve(), gitBash);
  });

  it('where bash 的直接命中', () => {
    const gitBash = 'C:\\Tools\\bash.exe';
    const runner = new MockRunner({
      files: [gitBash],
      whereHits: { bash: [gitBash] },
    });

    assert.equal(resolverFor(runner).resolve(), gitBash);
  });

  it('跳过 System32\\bash.exe', () => {
    const wslBash = 'C:\\Windows\\System32\\bash.exe';
    const gitBash = 'C:\\Tools\\bash.exe';
    const runner = new MockRunner({
      files: [wslBash, gitBash],
      whereHits: { bash: [wslBash, gitBash] },
    });

    assert.equal(resolverFor(runner).resolve(), gitBash);
  });

  it('跳过 WindowsApps 下的商店别名', () => {
    const alias = 'C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\bash.exe';
    const gitBash = 'C:\\Tools\\bash.exe';
    const runner = new MockRunner({
      files: [alias, gitBash],
      whereHits: { bash: [alias, gitBash] },
    });

    assert.equal(resolverFor(runner).resolve(), gitBash);
  });

  it('路径里带 System32 但不是系统目录时照常采用', () => {
    const gitBash = 'C:\\Tools\\System32\\bash.exe';
    const runner = new MockRunner({
      files: [gitBash],
      whereHits: { bash: [gitBash] },
    });

    assert.equal(resolverFor(runner).resolve(), gitBash);
  });

  it('路径里带 WindowsApps 但不是商店别名时照常采用', () => {
    const gitBash = 'C:\\Tools\\WindowsApps\\bash.exe';
    const runner = new MockRunner({
      files: [gitBash],
      whereHits: { bash: [gitBash] },
    });

    assert.equal(resolverFor(runner).resolve(), gitBash);
  });

  it('SystemRoot 不在 C: 时按完整路径跳过启动器', () => {
    const launcher = 'D:\\Windows\\System32\\bash.exe';
    const gitBash = 'D:\\Tools\\bash.exe';
    const runner = new MockRunner({
      files: [launcher, gitBash],
      whereHits: { bash: [launcher, gitBash] },
    });
    const resolver = resolverFor(runner, { ...ENV, SystemRoot: 'D:\\Windows' });

    assert.equal(resolver.resolve(), gitBash);
  });

  it('一个候选都没通过时抛错并列出原因', () => {
    const wsl = 'C:\\Windows\\System32\\bash.exe';
    const runner = new MockRunner({
      files: [wsl],
      whereHits: { bash: [wsl] },
    });

    assert.throws(
      () => resolverFor(runner).resolve(),
      (error) =>
        error.code === 'GIT_BASH_NOT_FOUND' &&
        error.message.includes('C:\\Program Files\\Git\\bin\\bash.exe') &&
        error.message.includes('[skipped: WSL launcher]'),
    );
  });

  it('解析结果被缓存，后续调用不再探测', () => {
    const root = 'C:\\Scoop\\apps\\git\\current';
    const gitBash = `${root}\\bin\\bash.exe`;
    const runner = new MockRunner({ files: [gitBash] });
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
