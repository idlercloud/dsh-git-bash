/**
 * lib/guard.js 的单测：只验证决策与注册行为。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BASH_TOOL_NAME, DENY_INFO, decideBashAccess, FULL_ACCESS_MODE, installBashGuard } from '../lib/guard.js';

/** 所有权检查用的工具定义：两次查询返回同一个对象，等同于本插件挂的那个。 */
const BASH_DEFINITION = { name: BASH_TOOL_NAME };
const DEFAULT_TOOLS = { get: () => BASH_DEFINITION };

/**
 * 插件 context 的最小实现：只提供 guard 用到的 `get` / `on`。
 *
 * `on` 把监听器记下来，测试再手动派发，等价于宿主在工具调用前跑一遍
 * `tools/pre-execute` waterfall。
 */
function fakeCtx({ policy, tools = DEFAULT_TOOLS } = {}) {
  const listeners = new Map();
  return {
    get(name) {
      if (name === 'sandboxPolicy') return policy;
      if (name === 'tools') return tools;
      return undefined;
    },
    on(name, listener) {
      listeners.set(name, listener);
      return () => listeners.delete(name);
    },
    listener(name) {
      return listeners.get(name);
    },
  };
}

/** 装好 guard，返回它注册的那个监听器。 */
function guardFor({ policy, tools } = {}) {
  const ctx = fakeCtx({ policy, tools });
  const dispose = installBashGuard(ctx, { platform: 'win32' });
  return { ctx, dispose, guard: ctx.listener('tools/pre-execute') };
}

/** 记录调用次数的 `next()`，返回宿主放行时的哨兵值。 */
function nextRecorder() {
  const state = { calls: 0 };
  state.next = () => {
    state.calls += 1;
    return Promise.resolve({ kind: 'allow', fromNext: true });
  };
  return state;
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

describe('decideBashAccess', () => {
  it('只有精确的 danger-full-access 放行', () => {
    assert.deepEqual(decideBashAccess({ mode: FULL_ACCESS_MODE }), { kind: 'allow' });

    for (const mode of ['read-only', 'workspace-write', 'DANGER-FULL-ACCESS', 'full', '', null, undefined]) {
      const decision = decideBashAccess({ mode });
      assert.equal(decision.kind, 'deny', `mode ${String(mode)} 不应放行`);
      assert.equal(decision.info, DENY_INFO);
      assert.ok(decision.reason.length > 0);
    }
  });

  it('宿主没有 sandboxPolicy 服务时拒绝', () => {
    const decision = decideBashAccess({ hasPolicy: false });
    assert.equal(decision.kind, 'deny');
    assert.equal(decision.info, DENY_INFO);
  });

  it('解析策略抛错时拒绝', () => {
    const decision = decideBashAccess({
      mode: FULL_ACCESS_MODE,
      error: new Error('projection unavailable'),
    });
    assert.equal(decision.kind, 'deny');
    assert.equal(decision.info, DENY_INFO);
  });
});

describe('installBashGuard', () => {
  it('在 win32 上注册一个 tools/pre-execute 监听器', () => {
    const { ctx, dispose } = guardFor({ policy: fakePolicy().service });

    assert.equal(typeof ctx.listener('tools/pre-execute'), 'function');
    assert.equal(typeof dispose, 'function');
  });

  it('非 win32 平台不注册', () => {
    for (const platform of ['linux', 'darwin', 'freebsd', 'android']) {
      const ctx = fakeCtx({ policy: fakePolicy().service });

      assert.equal(installBashGuard(ctx, { platform }), undefined);
      assert.equal(ctx.listener('tools/pre-execute'), undefined);
    }
  });

  it('非 bash 调用原样交给 next()，不解析策略', async () => {
    const policy = fakePolicy({ failure: new Error('must not be consulted') });
    const { guard } = guardFor({ policy: policy.service });
    const next = nextRecorder();

    const decision = await guard({ name: 'pwsh' }, next.next);

    assert.equal(next.calls, 1);
    assert.equal(decision.fromNext, true);
    assert.deepEqual(policy.requests, []);
  });

  it('被同名 agent 作用域工具遮蔽时不接管', async () => {
    // 别的插件可以在 agent 作用域注册自己的 bash，其优先级比本插件高
    const registered = { name: BASH_TOOL_NAME };
    const shadowing = { name: BASH_TOOL_NAME, description: 'another plugin' };
    const tools = { get: (_name, scope) => (scope === undefined ? registered : shadowing) };
    const policy = fakePolicy({ failure: new Error('must not be consulted') });
    const { guard } = guardFor({ policy: policy.service, tools });
    const next = nextRecorder();

    const decision = await guard({ name: BASH_TOOL_NAME, agent: { session: {} } }, next.next);

    assert.equal(next.calls, 1);
    assert.equal(decision.fromNext, true);
    assert.deepEqual(policy.requests, []);
  });

  it('完全权限下放行', async () => {
    const policy = fakePolicy({ mode: FULL_ACCESS_MODE });
    const { guard } = guardFor({ policy: policy.service });
    const next = nextRecorder();
    const session = { id: 'session-1' };

    const decision = await guard({ name: BASH_TOOL_NAME, agent: { session } }, next.next);

    assert.equal(next.calls, 1);
    assert.equal(decision.fromNext, true);
    // 判定必须读这一条会话的模式，不能拿实例默认模式顶替。
    assert.equal(policy.requests.length, 1);
    assert.equal(policy.requests[0].session, session);
  });

  it('workspace-write 下拒绝，且不调用 next()', async () => {
    const { guard } = guardFor({ policy: fakePolicy({ mode: 'workspace-write' }).service });
    const next = nextRecorder();

    const decision = await guard({ name: BASH_TOOL_NAME, agent: { session: {} } }, next.next);

    assert.equal(next.calls, 0);
    assert.equal(decision.kind, 'deny');
    assert.equal(decision.info, DENY_INFO);
  });

  it('宿主没有 sandboxPolicy 服务时拒绝', async () => {
    const { guard } = guardFor({});
    const next = nextRecorder();

    const decision = await guard({ name: BASH_TOOL_NAME, agent: { session: {} } }, next.next);

    assert.equal(next.calls, 0);
    assert.equal(decision.kind, 'deny');
  });

  it('取服务本身抛错时拒绝', async () => {
    const ctx = fakeCtx({});
    ctx.get = (name) => {
      if (name === 'sandboxPolicy') throw new Error('service factory failed');
      if (name === 'tools') return DEFAULT_TOOLS;
      return undefined;
    };
    installBashGuard(ctx, { platform: 'win32' });
    const next = nextRecorder();

    const decision = await ctx.listener('tools/pre-execute')(
      { name: BASH_TOOL_NAME, agent: { session: {} } },
      next.next,
    );

    assert.equal(next.calls, 0);
    assert.equal(decision.kind, 'deny');
  });

  it('策略解析抛错时拒绝', async () => {
    const { guard } = guardFor({ policy: fakePolicy({ failure: new Error('no projection') }).service });
    const next = nextRecorder();

    const decision = await guard({ name: BASH_TOOL_NAME, agent: { session: {} } }, next.next);

    assert.equal(next.calls, 0);
    assert.equal(decision.kind, 'deny');
  });

  it('没有 agent 时用实例默认模式判定', async () => {
    const policy = fakePolicy({ mode: FULL_ACCESS_MODE });
    const { guard } = guardFor({ policy: policy.service });
    const next = nextRecorder();

    const decision = await guard({ name: BASH_TOOL_NAME }, next.next);

    assert.equal(next.calls, 1);
    assert.equal(decision.fromNext, true);
    // 无会话时不把 session 传给 resolve，按实例默认模式解析。
    assert.deepEqual(policy.requests, [{}]);
  });

  it('没有 agent 且实例默认模式受限时拒绝', async () => {
    const { guard } = guardFor({ policy: fakePolicy({ mode: 'read-only' }).service });
    const next = nextRecorder();

    const decision = await guard({ name: BASH_TOOL_NAME }, next.next);

    assert.equal(next.calls, 0);
    assert.equal(decision.kind, 'deny');
    assert.equal(decision.info, DENY_INFO);
  });
});
