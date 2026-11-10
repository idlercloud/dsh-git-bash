import assert from 'node:assert/strict';
import { it } from 'node:test';
import { apply } from '../lib/index.js';

for (const platform of ['linux', 'darwin']) {
  it(`直接加载插件时在 ${platform} 上不访问或注册宿主服务`, () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    const ctx = new Proxy(
      {},
      {
        get(_target, key) {
          assert.fail(`非 Windows 平台不应访问宿主服务：${String(key)}`);
        },
      },
    );
    // 当前测试文件在独立进程中执行，并在同步调用后恢复平台属性。
    try {
      Object.defineProperty(process, 'platform', { ...descriptor, value: platform });
      apply(ctx, {});
    } finally {
      Object.defineProperty(process, 'platform', descriptor);
    }
  });
}
