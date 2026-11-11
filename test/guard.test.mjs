/**
 * lib/guard.js 的单测：只验证决策与工具守卫注册行为。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BASH_TOOL_NAME, bashDenialReason, FULL_ACCESS_MODE, installBashGuard } from '../lib/guard.js';

/** 所有权检查用的工具定义：两次查询返回同一个对象，等同于本插件挂的那个。 */
const BASH_DEFINITION = { name: BASH_TOOL_NAME };

/**
 * 工具服务的最小实现：`get` 用于核对调用归属，`guard` 记录注册的守卫，
 * `check` 复刻宿主在 pre-execute 之后逐个求值守卫的行为。
 */
function fakeTools({ get = () => BASH_DEFINITION } = {}) {
  const state = { guards: [] };
  state.service = {
    get,
    guard(fn) {
      state.guards.push(fn);
      return () => {
        const index = state.guards.indexOf(fn);
        if (index >= 0) state.guards.splice(index, 1);
      };
    },
    check(exec) {
      for (const fn of state.guards) {
        const reason = fn(exec);
        if (reason !== undefined) return reason;
      }
      return undefined;
    },
  };
  return state;
}

/** 插件 context 的最小实现：只提供 guard 用到的 `tools` / `logger` / `get`。 */
function fakeCtx({ policy, tools }) {
  return {
    tools: tools.service,
    logger: { info() {} },
    get(name) {
      return name === 'sandboxPolicy' ? policy : undefined;
    },
  };
}

/** 装好 guard，返回它注册的守卫集合与事后检查入口。 */
function install({ policy, tools = fakeTools() } = {}) {
  const ctx = fakeCtx({ policy, tools });
  const dispose = installBashGuard(ctx);
  return { tools, dispose, check: (exec) => tools.service.check(exec) };
}

/** 策略服务的最小实现：按设定返回模式或抛错，并记录收到的 session。 */
function fakePolicy({ mode = FULL_ACCESS_MODE, failure } = {}) {
  const state = { requests: [] };
  state.service = {
    resolve(request) {
      state.requests.push(request);
      if (failure !== undefined) throw failure;
      return { mode, workspaceRoot: 'C:\\work' };
    },
  };
  return state;
}

describe('bashDenialReason', () => {
  it('只有精确的 danger-full-access 放行', () => {
    assert.equal(bashDenialReason({ mode: FULL_ACCESS_MODE }), undefined);

    for (const mode of ['read-only', 'workspace-write', undefined]) {
      const reason = bashDenialReason({ mode });
      assert.equal(typeof reason, 'string', `mode ${String(mode)} 不应放行`);
      assert.ok(reason.length > 0);
    }
  });

  it('宿主没有 sandboxPolicy 服务时拒绝', () => {
    assert.equal(typeof bashDenialReason({ hasPolicy: false }), 'string');
  });

  it('解析策略抛错时拒绝', () => {
    const reason = bashDenialReason({ mode: FULL_ACCESS_MODE, error: new Error('projection unavailable') });
    assert.equal(typeof reason, 'string');
  });
});

describe('installBashGuard', () => {
  it('注册一个工具守卫', () => {
    const { tools, dispose } = install({ policy: fakePolicy().service });

    assert.equal(tools.guards.length, 1);
    assert.equal(typeof dispose, 'function');
  });

  it('非 bash 调用不读取策略', () => {
    const policy = fakePolicy({ failure: new Error('must not be consulted') });
    const { check } = install({ policy: policy.service });

    assert.equal(check({ name: 'pwsh' }), undefined);
    assert.deepEqual(policy.requests, []);
  });

  it('被同名 agent 作用域工具遮蔽时不接管', () => {
    // 别的插件可以在 agent 作用域注册自己的 bash，其优先级比本插件高
    const registered = { name: BASH_TOOL_NAME };
    const shadowing = { name: BASH_TOOL_NAME, description: 'another plugin' };
    const tools = fakeTools({ get: (_name, scope) => (scope === undefined ? registered : shadowing) });
    const policy = fakePolicy({ failure: new Error('must not be consulted') });
    const { check } = install({ policy: policy.service, tools });

    assert.equal(check({ name: BASH_TOOL_NAME, agent: { session: {} } }), undefined);
    assert.deepEqual(policy.requests, []);
  });

  it('完全权限下放行', () => {
    const policy = fakePolicy({ mode: FULL_ACCESS_MODE });
    const { check } = install({ policy: policy.service });
    const session = { id: 'session-1' };

    assert.equal(check({ name: BASH_TOOL_NAME, agent: { session } }), undefined);
    // 判定必须读这一条会话的模式，不能拿实例默认模式顶替。
    assert.equal(policy.requests.length, 1);
    assert.equal(policy.requests[0].session, session);
  });

  it('策略服务缺失或解析失败时拒绝', () => {
    const missing = install({});
    assert.equal(typeof missing.check({ name: BASH_TOOL_NAME, agent: { session: {} } }), 'string');

    const failing = install({ policy: fakePolicy({ failure: new Error('no projection') }).service });
    assert.equal(typeof failing.check({ name: BASH_TOOL_NAME, agent: { session: {} } }), 'string');
  });

  it('没有 agent 时用实例默认模式判定', () => {
    const policy = fakePolicy({ mode: FULL_ACCESS_MODE });
    const { check } = install({ policy: policy.service });

    assert.equal(check({ name: BASH_TOOL_NAME }), undefined);
    // 无会话时 resolve 收到的 session 是 undefined，按实例默认模式解析。
    assert.equal(policy.requests.length, 1);
    assert.equal(policy.requests[0].session, undefined);
  });
});
