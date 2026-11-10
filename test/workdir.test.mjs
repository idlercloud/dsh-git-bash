/**
 * lib/workdir.js 的单测：workdir 的 MSYS 路径归一化与拒绝。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { normalizeWorkdir } from '../lib/workdir.js';

describe('normalizeWorkdir', () => {
  it('把 /c/... 转成 C:/...', () => {
    assert.equal(normalizeWorkdir('/c/Idler/Code'), 'C:/Idler/Code');
  });

  it('盘符大小写都接受，统一转成大写', () => {
    assert.equal(normalizeWorkdir('/C/Idler'), 'C:/Idler');
    assert.equal(normalizeWorkdir('/d/data'), 'D:/data');
  });

  it('/c 与 /c/ 转成 C:/', () => {
    assert.equal(normalizeWorkdir('/c'), 'C:/');
    assert.equal(normalizeWorkdir('/c/'), 'C:/');
  });

  it('Windows 路径原样返回', () => {
    for (const value of ['C:/Idler/Code', 'C:\\Idler\\Code', '\\\\server\\share\\dir']) {
      assert.equal(normalizeWorkdir(value), value);
    }
  });

  it('相对路径原样返回', () => {
    assert.equal(normalizeWorkdir('sub/dir'), 'sub/dir');
  });

  it('UNC 路径 //server/share 原样返回', () => {
    assert.equal(normalizeWorkdir('//server/share/dir'), '//server/share/dir');
  });

  it('/tmp 这类没有盘符的 MSYS 路径报错', () => {
    for (const value of ['/tmp', '/tmp/work', '/usr/bin']) {
      assert.throws(
        () => normalizeWorkdir(value),
        (error) => {
          assert.equal(error.code, 'GIT_BASH_INVALID_WORKDIR');
          assert.match(error.message, /no Windows equivalent/);
          assert.match(error.message, /Windows path/);
          return true;
        },
      );
    }
  });
});
