/**
 * lib/resolve.js 的单测：用假的文件系统覆盖发现链与选择规则。
 */

import assert from 'node:assert/strict';
import { win32 } from 'node:path';
import { describe, it } from 'node:test';

import { BashResolver } from '../lib/resolve.js';

const ENV = {
  SystemRoot: 'C:\\Windows',
  ProgramFiles: 'C:\\Program Files',
  LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
  USERPROFILE: 'C:\\Users\\me',
};

const normalize = (path) => String(path).replaceAll('/', '\\').toLowerCase();

/**
 * 解析器的假依赖：files 决定 stat 的结果；pathFiles 提供 PATH 中的文件。
 */
class MockRunner {
  statCalls = [];

  constructor({ files = [], pathFiles = [] } = {}) {
    this.files = new Set([...files, ...pathFiles].map(normalize));
    this.path = pathFiles.map((file) => win32.dirname(file)).join(';');
  }

  stat = (path) => {
    this.statCalls.push(normalize(path));
    if (!this.files.has(normalize(path))) throw new Error('ENOENT');
    return { isFile: () => true, isSymbolicLink: () => false };
  };
}

function resolverFor(runner, env = ENV, bashPath) {
  return new BashResolver({ bashPath, env: { PATH: runner.path, ...env }, stat: runner.stat });
}

describe('BashResolver', () => {
  it('显式相对路径在构造时转成绝对路径，校验与返回使用同一路径', () => {
    const relative = '.\\Git\\bin\\bash.exe';
    const expected = win32.resolve(relative);
    const runner = new MockRunner({ files: [expected] });
    for (const resolver of [
      resolverFor(runner, ENV, relative),
      resolverFor(runner, { ...ENV, DSH_GIT_BASH: relative }),
    ]) {
      assert.equal(resolver.resolve(), expected);
      assert.equal(resolver.resolve(), expected);
    }
  });

  for (const [title, statResult, code, entry, accepted, fallback] of [
    ['普通文件', true, undefined, undefined, true, false],
    ['目录', false, undefined, 'directory', false, false],
    ['断开的链接', undefined, 'ENOENT', 'link', false, false],
    ['访问受限的应用别名', undefined, 'EACCES', 'link', true, true],
    ['访问受限的普通文件', undefined, 'EACCES', 'file', true, true],
    ['访问受限的目录', undefined, 'EACCES', 'directory', false, true],
    ['回退检查也失败', undefined, 'EACCES', undefined, false, true],
  ]) {
    it(`文件检查：${title}`, () => {
      let usedFallback = false;
      const resolver = new BashResolver({
        bashPath: 'C:\\Git\\bash.exe',
        env: ENV,
        stat() {
          if (code) {
            const error = new Error('模拟文件检查失败');
            error.code = code;
            throw error;
          }
          return { isFile: () => statResult };
        },
        lstat() {
          usedFallback = true;
          if (!entry) throw new Error('模拟回退检查失败');
          return { isFile: () => entry === 'file', isSymbolicLink: () => entry === 'link' };
        },
      });
      if (accepted) assert.equal(resolver.resolve(), 'C:\\Git\\bash.exe');
      else assert.throws(() => resolver.resolve(), { code: 'GIT_BASH_NOT_FOUND' });
      assert.equal(usedFallback, fallback);
    });
  }

  it('PATH 保留中文和空格，忽略空项，并按目录顺序选择', () => {
    const first = 'C:\\中文 工具\\bash.exe';
    const second = 'D:\\Git\\bash.exe';
    const runner = new MockRunner({ files: [first, second] });
    const resolver = resolverFor(runner, { ...ENV, PATH: ' ; "C:\\中文 工具" ;;D:\\Git; ' }, 'bash');
    assert.equal(resolver.resolve(), first);
  });

  it('支持 Path 环境变量拼写和带 exe 后缀的裸名字', () => {
    const expected = 'C:\\Git\\bash.exe';
    const runner = new MockRunner({ files: [expected] });
    const resolver = new BashResolver({
      bashPath: 'bash.exe',
      env: { ...ENV, Path: 'C:\\Git' },
      stat: runner.stat,
    });
    assert.equal(resolver.resolve(), expected);
  });

  it('显式名字带非 exe 扩展名时不按 PATH 解析', () => {
    const runner = new MockRunner({
      files: ['C:\\Tools\\bash.cmd'],
      pathFiles: ['C:\\Tools\\bash.cmd'],
    });
    const resolver = resolverFor(runner, ENV, 'bash.cmd');

    assert.throws(
      () => resolver.resolve(),
      (error) => error.code === 'GIT_BASH_NOT_FOUND' && error.message.includes('on PATH'),
    );
  });

  it('环境变量没有 PATH 时裸名字报找不到', () => {
    const env = { ...ENV };
    delete env.PATH;
    const runner = new MockRunner();

    const resolver = new BashResolver({ bashPath: 'bash', env, stat: runner.stat });
    assert.throws(
      () => resolver.resolve(),
      (error) => error.code === 'GIT_BASH_NOT_FOUND' && error.message.includes('on PATH'),
    );
  });

  it('PATH 键存在但值为空时按空 PATH 处理', () => {
    const runner = new MockRunner();
    const resolver = new BashResolver({
      bashPath: 'bash',
      env: { ...ENV, PATH: undefined },
      stat: runner.stat,
    });

    assert.throws(() => resolver.resolve(), { code: 'GIT_BASH_NOT_FOUND' });
  });

  it('不按 PATHEXT 选择批处理文件，也不隐式搜索当前目录', () => {
    const runner = new MockRunner({ files: ['C:\\Git\\bash.cmd', win32.resolve('bash.exe')] });
    const resolver = resolverFor(runner, { ...ENV, PATH: 'C:\\Git;;', PATHEXT: '.CMD;.EXE' }, 'bash');
    assert.throws(() => resolver.resolve(), { code: 'GIT_BASH_NOT_FOUND' });
  });

  it('显式配置存在时直接采用', () => {
    const expected = 'C:\\Git\\bin\\bash.exe';
    const runner = new MockRunner({ files: [expected] });
    const resolver = resolverFor(runner, { ...ENV, DSH_GIT_BASH: 'C:\\other\\bash.exe' }, expected);

    assert.equal(resolver.resolve(), expected);
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
      pathFiles: [expected],
    });
    const resolver = resolverFor(runner, ENV, 'bash');

    assert.equal(resolver.resolve(), expected);
    assert.equal(resolver.resolve(), expected);
  });

  it('裸名字跳过 PATH 上的 WSL 启动器', () => {
    const wsl = 'C:\\Windows\\System32\\bash.exe';
    const alias = 'C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\bash.exe';
    const expected = 'C:\\Tools\\bash.exe';
    const runner = new MockRunner({
      files: [wsl, alias, expected],
      pathFiles: [wsl, alias, expected],
    });
    const resolver = resolverFor(runner, ENV, 'bash');

    assert.equal(resolver.resolve(), expected);
  });

  it('SystemRoot 与 windir 不同时仍按 windir 跳过 WSL 启动器', () => {
    const wsl = 'C:\\Windows\\System32\\bash.exe';
    const gitBash = 'C:\\Tools\\bash.exe';
    const runner = new MockRunner({
      files: [wsl, gitBash],
      pathFiles: [wsl, gitBash],
    });
    const resolver = resolverFor(runner, { ...ENV, SystemRoot: 'D:\\Windows', windir: 'C:\\Windows' }, 'bash');

    assert.equal(resolver.resolve(), gitBash);
  });

  it('裸名字在 PATH 上找不到 Git Bash 时拒绝', () => {
    const wsl = 'C:\\Windows\\System32\\bash.exe';
    const resolver = resolverFor(new MockRunner({ files: [wsl], pathFiles: [wsl] }), ENV, 'bash');

    assert.throws(
      () => resolver.resolve(),
      (error) => error.code === 'GIT_BASH_NOT_FOUND' && error.message.includes('on PATH'),
    );
  });

  it('显式配置指向 WSL 启动器时拒绝', () => {
    for (const launcher of [
      'C:\\Windows\\System32\\bash.exe',
      'C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\bash.exe',
    ]) {
      const resolver = resolverFor(new MockRunner({ files: [launcher] }), ENV, launcher);

      assert.throws(
        () => resolver.resolve(),
        (error) => error.code === 'GIT_BASH_NOT_FOUND' && error.message.includes('WSL'),
      );
    }
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

  it('PATH 中 git.exe 的命中反推安装根', () => {
    const gitBash = 'C:\\Tools\\Git\\bin\\bash.exe';
    const runner = new MockRunner({
      files: [gitBash],
      pathFiles: ['C:\\Tools\\Git\\cmd\\git.exe'],
    });

    assert.equal(resolverFor(runner).resolve(), gitBash);
  });

  it('PATH 中的 git.exe 优先于常见安装位置', () => {
    const gitBash = 'C:\\Tools\\Git\\bin\\bash.exe';
    const commonBash = 'C:\\Program Files\\Git\\bin\\bash.exe';
    const runner = new MockRunner({
      files: [gitBash, commonBash],
      pathFiles: ['C:\\Tools\\Git\\cmd\\git.exe'],
    });

    assert.equal(resolverFor(runner).resolve(), gitBash);
  });

  it('常见安装位置包含 ProgramFiles(x86) 与 ProgramW6432，并去重重复候选', () => {
    const env = {
      ...ENV,
      'ProgramFiles(x86)': 'C:\\Program Files (x86)',
      ProgramW6432: 'C:\\Program Files',
    };
    const runner = new MockRunner({
      files: ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe'],
    });
    const resolver = resolverFor(runner, env);

    assert.equal(resolver.resolve(), 'C:\\Program Files\\Git\\bin\\bash.exe');
    const candidates = resolver.candidates().map((candidate) => candidate.toLowerCase());
    assert.ok(candidates.includes('c:\\program files (x86)\\git\\bin\\bash.exe'));
    assert.equal(new Set(candidates).size, candidates.length);
  });

  it('ProgramFiles 缺失时回退到默认安装路径', () => {
    const env = { ...ENV };
    delete env.ProgramFiles;
    const runner = new MockRunner({ files: ['C:\\Program Files\\Git\\bin\\bash.exe'] });
    const resolver = resolverFor(runner, env);

    assert.equal(resolver.resolve(), 'C:\\Program Files\\Git\\bin\\bash.exe');
  });

  it('自动发现不采用 PATH 中独立的 bash.exe', () => {
    const gitBash = 'C:\\Tools\\bash.exe';
    const runner = new MockRunner({
      files: [gitBash],
      pathFiles: [gitBash],
    });

    assert.throws(() => resolverFor(runner).resolve(), { code: 'GIT_BASH_NOT_FOUND' });
  });

  it('路径里带 System32 或 WindowsApps 但不是启动器时照常采用', () => {
    for (const gitBash of ['C:\\Tools\\System32\\bash.exe', 'C:\\Tools\\WindowsApps\\bash.exe']) {
      const runner = new MockRunner({
        files: [gitBash],
        pathFiles: [gitBash],
      });

      assert.equal(resolverFor(runner, ENV, 'bash').resolve(), gitBash);
    }
  });

  it('一个候选都没通过时抛错并列出原因', () => {
    const wsl = 'C:\\Windows\\System32\\bash.exe';
    const runner = new MockRunner({
      files: [wsl],
      pathFiles: [wsl],
    });

    assert.throws(
      () => resolverFor(runner).resolve(),
      (error) => error.code === 'GIT_BASH_NOT_FOUND' && error.message.includes('C:\\Program Files\\Git\\bin\\bash.exe'),
    );
  });

  it('解析结果被缓存，后续调用只复核缓存文件', () => {
    const root = 'C:\\Scoop\\apps\\git\\current';
    const gitBash = `${root}\\bin\\bash.exe`;
    const runner = new MockRunner({ files: [gitBash] });
    const resolver = resolverFor(runner, { ...ENV, GIT_INSTALL_ROOT: root });

    assert.equal(resolver.resolve(), gitBash);
    const checked = runner.statCalls.length;
    assert.equal(resolver.resolve(), gitBash);
    assert.deepEqual(runner.statCalls.slice(checked), [normalize(gitBash)]);
  });

  it('缓存的文件消失后重新解析', () => {
    const gitBash = 'C:\\Tools\\Git\\bin\\bash.exe';
    const runner = new MockRunner({
      files: [gitBash],
      pathFiles: ['C:\\Tools\\Git\\cmd\\git.exe'],
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
