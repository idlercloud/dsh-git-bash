/**
 * 真实 bash 工具的权限边界：受限策略拒绝、单次提权放行、审批拒绝拦截。
 */

import assert from 'node:assert/strict';
import { it } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import * as bashTool from '@deepseek-ai/dsh-tool-bash';
import ToolsService from '@deepseek-ai/dsh-tools';
import { ToolExecutionPipeline } from '@deepseek-ai/dsh-tools/pipeline';
import * as plugin from '../lib/index.js';

const BASE_ARGS = { command: 'echo test', description: '验证调用策略的权限边界' };

/**
 * 装好真实的 bash 工具、本插件执行器、策略与（可选的）审批服务。
 *
 * spawn 只记录到达次数后抛错，用来证明调用确实越过了执行器的策略检查。
 */
async function createHarness(t, { mode = 'read-only', approval = true } = {}) {
  const root = new Context();
  t.after(() => root.fiber.dispose());
  const state = { mode, outcome: 'allowed-once', spawns: 0, probes: 0, approvals: [] };

  root.provide('subprocess', {
    spawn() {
      state.spawns += 1;
      throw new Error('已到达进程启动边界');
    },
  });
  await root.plugin(SystemPrompt, {});
  await root.plugin(ToolsService, {});
  root.provide('shellEnv', { collect: () => ({}) });
  root.provide('workingDirectory', { ensure: async () => process.cwd() });
  root.provide('sandboxPolicy', {
    resolve: () => ({ mode: state.mode, workspaceRoot: process.cwd() }),
  });
  if (approval) {
    root.provide('approval', {
      async request(request) {
        state.approvals.push(request);
        return state.outcome;
      },
    });
  }
  root.provide('shell', 'host-shell');

  const realm = root.isolate('shell');
  await realm.plugin(plugin, {});
  realm.shell.gitBashResolver = {
    resolve() {
      state.probes += 1;
      return 'C:/test/bash.exe';
    },
  };
  await realm.plugin(bashTool, { enableRunInBackground: false });

  const agent = { session: { id: 'escalation-test' } };
  const pipeline = new ToolExecutionPipeline(root);
  const run = async (args) => {
    const prepared = await pipeline.prepare({
      name: 'bash',
      arguments: args,
      agent,
      signal: new AbortController().signal,
    });
    const outcome = prepared.kind === 'dispatch' ? await pipeline.dispatch(prepared.exec) : prepared;
    return pipeline.complete(prepared.exec, outcome);
  };
  return { state, run };
}

it('真实 bash 工具：read-only 下拒绝，批准后只放行这一次', { skip: process.platform !== 'win32' }, async (t) => {
  const { state, run } = await createHarness(t);

  let result = await run(BASE_ARGS);
  assert.equal(result.isError, true);
  assert.match(result.error.message, /The file policy is `read-only`/);
  assert.match(result.error.message, /sandbox_permissions: "danger-full-access"/);
  assert.equal(state.spawns, 0);
  assert.equal(state.probes, 0);
  assert.equal(state.approvals.length, 0);

  state.outcome = 'rejected';
  result = await run({ ...BASE_ARGS, sandbox_permissions: 'danger-full-access', justification: '需要 Git Bash' });
  assert.equal(result.isError, true);
  assert.match(result.error.message, /rejected/);
  assert.equal(state.spawns, 0);
  assert.equal(state.probes, 0);
  assert.equal(state.approvals.length, 1);
  assert.match(state.approvals[0].reason, /danger-full-access.*需要 Git Bash/);

  state.outcome = 'allowed-once';
  result = await run({ ...BASE_ARGS, sandbox_permissions: 'danger-full-access', justification: '需要 Git Bash' });
  assert.match(result.error.message, /已到达进程启动边界/);
  assert.equal(state.spawns, 1);
  assert.equal(state.probes, 1);
  assert.equal(state.approvals.length, 2);

  result = await run(BASE_ARGS);
  assert.equal(result.isError, true);
  assert.match(result.error.message, /The file policy is `read-only`/);
  assert.equal(state.spawns, 1);
});

it('真实 bash 工具：workspace-write 同样升到 danger-full-access', { skip: process.platform !== 'win32' }, async (t) => {
  const { state, run } = await createHarness(t, { mode: 'workspace-write' });

  let result = await run(BASE_ARGS);
  assert.equal(result.isError, true);
  assert.match(result.error.message, /The file policy is `workspace-write`/);
  assert.match(result.error.message, /sandbox_permissions/);
  assert.equal(state.spawns, 0);

  result = await run({ ...BASE_ARGS, sandbox_permissions: 'danger-full-access', justification: '需要 Git Bash' });
  assert.match(result.error.message, /已到达进程启动边界/);
  assert.equal(state.spawns, 1);
  assert.equal(state.approvals.length, 1);
});

it('真实 bash 工具：没有审批服务时不提示提权，带提权参数也不会执行', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const { state, run } = await createHarness(t, { approval: false });

  let result = await run(BASE_ARGS);
  assert.equal(result.isError, true);
  assert.doesNotMatch(result.error.message, /sandbox_permissions/);
  assert.match(result.error.message, /switch the session access mode/);

  result = await run({ ...BASE_ARGS, sandbox_permissions: 'danger-full-access', justification: '需要 Git Bash' });
  assert.equal(result.isError, true);
  assert.match(result.error.message, /no approval service is composed/);
  assert.equal(state.spawns, 0);
});
