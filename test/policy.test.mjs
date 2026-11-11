/**
 * lib/policy.js 的单测：只验证拒绝文案与决策，不启动 DSH。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { bashDenialReason, FULL_ACCESS_MODE } from '../lib/policy.js';

describe('bashDenialReason', () => {
  it('只有精确的 danger-full-access 放行', () => {
    assert.equal(bashDenialReason({ mode: FULL_ACCESS_MODE }), undefined);

    for (const mode of ['read-only', 'workspace-write', undefined]) {
      const reason = bashDenialReason({ mode });
      assert.equal(typeof reason, 'string', `mode ${String(mode)} 不应放行`);
      assert.match(reason, /file policy/);
    }
  });

  it('宿主有审批服务时给出单次提权路径', () => {
    for (const mode of ['read-only', 'workspace-write']) {
      const reason = bashDenialReason({ mode, escalationAvailable: true });
      assert.match(reason, /sandbox_permissions: "danger-full-access"/);
      assert.match(reason, /justification/);
    }
  });

  it('宿主没有审批服务时不承诺提权', () => {
    const reason = bashDenialReason({ mode: 'read-only' });
    assert.doesNotMatch(reason, /sandbox_permissions/);
    assert.match(reason, /switch the session access mode/);
  });

  it('模式未知时不引导提权', () => {
    const reason = bashDenialReason({ escalationAvailable: true });
    assert.doesNotMatch(reason, /sandbox_permissions/);
  });

  it('宿主没有 sandboxPolicy 服务时拒绝', () => {
    const reason = bashDenialReason({ hasPolicy: false, escalationAvailable: true });
    assert.equal(typeof reason, 'string');
    assert.doesNotMatch(reason, /sandbox_permissions/);
  });

  it('解析策略抛错时拒绝', () => {
    const reason = bashDenialReason({
      mode: FULL_ACCESS_MODE,
      error: new Error('projection unavailable'),
      escalationAvailable: true,
    });
    assert.equal(typeof reason, 'string');
    assert.match(reason, /projection unavailable/);
    assert.doesNotMatch(reason, /sandbox_permissions/);
  });
});
