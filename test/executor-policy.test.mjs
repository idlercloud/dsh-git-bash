import assert from 'node:assert/strict';
import { it } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { createScope } from '@deepseek-ai/dsh-scope';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import * as bashTool from '@deepseek-ai/dsh-tool-bash';
import ToolsService from '@deepseek-ai/dsh-tools';
import { ToolExecutionPipeline } from '@deepseek-ai/dsh-tools/pipeline';
import * as plugin from '../lib/index.js';

for (const [layout, title] of [
  ['same', '工具与执行器同作用域'],
  ['executor-root', '执行器在根作用域，工具在预设作用域'],
  ['executor-preset', '执行器在预设作用域，工具在根作用域'],
]) {
  it(`真实 bash 工具权限边界：${title}`, { skip: process.platform !== 'win32' }, async (t) => {
    const root = new Context();
    t.after(() => root.fiber.dispose());
    let spawns = 0;
    root.provide('subprocess', {
      spawn() {
        spawns++;
        // 用明确的错误标记到达启动边界，无需启动真实进程。
        throw new Error('已到达进程启动边界');
      },
    });
    await root.plugin(SystemPrompt, {});
    await root.plugin(ToolsService, {});
    root.provide('shellEnv', { collect: () => ({}) });
    root.provide('workingDirectory', { ensure: async () => process.cwd() });
    const preset = {},
      agent = { session: { id: 'policy-test' } };
    const scoped = createScope(root, preset);
    createScope(root, agent, { parent: preset });
    let mode = 'read-only';
    root.provide('sandboxPolicy', {
      resolve: ({ session }) => {
        assert.equal(session, agent.session);
        return { mode, workspaceRoot: process.cwd() };
      },
    });
    const label = Symbol('shared-shell');
    const executorCtx = (layout === 'executor-preset' ? scoped.ctx : root).isolate('shell', label);
    const toolCtx = (layout === 'executor-root' ? scoped.ctx : root).isolate('shell', label);
    await executorCtx.plugin(plugin, {});
    let shell;
    await toolCtx.plugin(
      {
        inject: ['shell'],
        apply(ctx) {
          shell = ctx.shell;
        },
      },
      {},
    );
    let probes = 0;
    shell.gitBashResolver = {
      resolve() {
        probes++;
        return 'C:/test/bash.exe';
      },
    };
    await toolCtx.plugin(bashTool, { enableRunInBackground: false });
    const caller = layout === 'executor-preset' ? { session: agent.session } : agent;
    const pipeline = new ToolExecutionPipeline(root);
    for (const current of ['read-only', 'workspace-write', 'danger-full-access']) {
      mode = current;
      const prepared = await pipeline.prepare({
        name: 'bash',
        arguments: { command: 'echo test', description: '验证调用策略的权限边界' },
        agent: caller,
        signal: new AbortController().signal,
      });
      const outcome = prepared.kind === 'dispatch' ? await pipeline.dispatch(prepared.exec) : prepared;
      const result = await pipeline.complete(prepared.exec, outcome);
      assert.equal(result.isError, true);
      if (mode === 'danger-full-access') {
        assert.match(result.error.message, /已到达进程启动边界/);
        assert.equal(spawns, 1);
      } else {
        assert.match(result.error.message, /file policy/);
        assert.equal(spawns, 0);
        assert.equal(probes, 0);
      }
    }
    assert.throws(() => shell.resolve({ command: 'test' }), { code: 'GIT_BASH_POLICY_DENIED' });
    const spec = shell.resolve({
      command: 'test',
      sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: process.cwd() },
    });
    for (const policy of [undefined, { mode: 'read-only' }, { mode: 'workspace-write' }]) {
      await assert.rejects(shell.execute({ ...spec, sandboxPolicy: policy }), { code: 'GIT_BASH_POLICY_DENIED' });
    }
    assert.equal(spawns, 1);
    assert.equal(probes, 1);
    const workdirSpec = shell.resolve({
      command: 'pwd',
      workdir: '/c/tmp',
      sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: process.cwd() },
    });
    assert.equal(workdirSpec.workdir, 'C:/tmp');
    assert.throws(
      () =>
        shell.resolve({
          command: 'pwd',
          workdir: '/tmp',
          sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: process.cwd() },
        }),
      { code: 'GIT_BASH_INVALID_WORKDIR' },
    );
  });
}
