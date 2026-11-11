import assert from 'node:assert/strict';
import { it } from 'node:test';
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local';
import { Config } from '../lib/index.js';

it('未配置 bashPath 时保留上游配置字段及默认值', () => {
  const config = Config({});
  assert.equal(config.bashPath, undefined);
  for (const key of Object.keys(LocalBashExecutor.Config.dict)) {
    assert.equal(Config.dict[key], LocalBashExecutor.Config.dict[key]);
    assert.deepEqual(config[key].get(), LocalBashExecutor.Config({})[key].get());
  }
});

it('配置表单可见的 schema 中包含可选字符串 bashPath', () => {
  assert.equal(Config.dict.bashPath.type, 'string');
  assert.ok(!Config.dict.bashPath.meta.required);
  assert.ok(!Config.dict.bashPath.meta.hidden);
});

for (const bashPath of ['C:\\中文目录\\Git\\bin\\bash.exe', '.\\Git\\bin\\bash.exe', 'bash.exe']) {
  it(`配置简化并重新加载后保留 bashPath：${bashPath}`, () => {
    const raw = { bashPath, cwd: 'C:/workspace', timeoutMs: 4321 };
    const config = Config(raw);
    assert.equal(config.bashPath, bashPath);
    const saved = Config.simplify(config);
    assert.deepEqual(saved, raw);
    const reloaded = Config(saved);
    assert.equal(reloaded.bashPath, bashPath);
    assert.equal(reloaded.cwd.get(), raw.cwd);
    assert.equal(reloaded.timeoutMs.get(), raw.timeoutMs);
  });
}

for (const bashPath of [42, true, {}, []]) {
  it(`配置加载时拒绝非字符串 bashPath：${JSON.stringify(bashPath)}`, () => {
    assert.throws(() => Config({ bashPath }), /bashPath/);
  });
}
