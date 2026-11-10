/** Real Cordis/DSH pipeline regression tests; no Git Bash or DSH process needed. */
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { createScope } from '@deepseek-ai/dsh-scope';
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';
import ToolsService from '@deepseek-ai/dsh-tools';
import { ToolExecutionPipeline } from '@deepseek-ai/dsh-tools/pipeline';
import * as plugin from '@idlercloud/dsh-git-bash';

it('真实工具流水线：完全权限执行，受限模式不被 pre-execute 放行覆盖', {
  skip: process.platform !== 'win32' && '插件仅在 Windows 注册权限守卫',
}, async (t) => {
  const root = new Context();
  t.after(() => root.fiber.dispose());
  root.provide('subprocess', {
    spawn() {
      throw new Error('test must not spawn');
    },
  });
  await root.plugin(SystemPrompt, {});
  await root.plugin(ToolsService, {});
  const policy = { mode: 'read-only' };
  root.provide('sandboxPolicy', { resolve: () => ({ mode: policy.mode, workspaceRoot: process.cwd() }) });
  root.provide('shell', 'host-shell');
  const realm = root.isolate('shell');
  await realm.plugin(plugin, {});
  assert.equal(root.shell, 'host-shell');
  assert.ok(realm.shell, 'plugin must mount successfully');

  let calls = 0;
  for (const name of ['bash', 'pwsh']) {
    root.tools.register({
      name,
      description: 'pipeline probe',
      parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'string' }, render: (text) => [{ type: 'text', text }] },
      execute: () => {
        calls += 1;
        return 'executed';
      },
    });
  }
  let overrides = 0;
  root.on(
    'tools/pre-execute',
    async (_exec, next) => {
      await next();
      overrides += 1;
      return { kind: 'allow' };
    },
    { prepend: true },
  );
  const pipeline = new ToolExecutionPipeline(root);
  const run = async (name) => {
    const prepared = await pipeline.prepare({ name, arguments: {}, signal: new AbortController().signal });
    const outcome = prepared.kind === 'dispatch' ? await pipeline.dispatch(prepared.exec) : prepared;
    return pipeline.complete(prepared.exec, outcome);
  };

  for (const mode of ['read-only', 'workspace-write', 'danger-full-access']) {
    policy.mode = mode;
    const before = calls;
    const result = await run('bash');
    if (mode === 'danger-full-access') {
      assert.equal(result.isError, false);
      assert.equal(result.value, 'executed');
      assert.equal(calls, before + 1);
    } else {
      assert.equal(result.isError, true);
      assert.match(result.error.message, /file policy/);
      assert.equal(calls, before, 'denied call must not enter the tool body');
    }
  }
  policy.mode = 'read-only';
  const before = calls;
  assert.equal((await run('pwsh')).isError, false);
  assert.equal(calls, before + 1);
  assert.equal(overrides, 4);
});

it('真实工具流水线：preset scope 中受限模式拒绝本插件 bash', {
  skip: process.platform !== 'win32' && '插件仅在 Windows 注册权限守卫',
}, async (t) => {
  const root = new Context();
  t.after(() => root.fiber.dispose());
  root.provide('subprocess', {
    spawn() {
      throw new Error('test must not spawn');
    },
  });
  await root.plugin(SystemPrompt, {});
  await root.plugin(ToolsService, {});
  const policy = { mode: 'read-only' };
  root.provide('sandboxPolicy', { resolve: () => ({ mode: policy.mode, workspaceRoot: process.cwd() }) });
  root.provide('shell', 'host-shell');

  const preset = {};
  const agent = { session: { id: 'scoped-session' } };
  const presetScope = createScope(root, preset);
  createScope(root, agent, { parent: preset });
  const realm = presetScope.ctx.isolate('shell');
  await realm.plugin(plugin, {});

  let calls = 0;
  await presetScope.ctx.plugin(
    {
      name: 'scoped-bash-probe',
      inject: ['tools'],
      apply(ctx) {
        ctx.tools.register({
          name: 'bash',
          description: 'scoped pipeline probe',
          parameters: { type: 'object', properties: {} },
          output: { schema: { type: 'string' }, render: (text) => [{ type: 'text', text }] },
          execute: () => {
            calls += 1;
            return 'executed';
          },
        });
      },
    },
    {},
  );

  const pipeline = new ToolExecutionPipeline(root);
  const run = async () => {
    const prepared = await pipeline.prepare({
      name: 'bash',
      arguments: {},
      agent,
      signal: new AbortController().signal,
    });
    const outcome = prepared.kind === 'dispatch' ? await pipeline.dispatch(prepared.exec) : prepared;
    return pipeline.complete(prepared.exec, outcome);
  };

  for (const mode of ['read-only', 'workspace-write', 'danger-full-access']) {
    policy.mode = mode;
    const before = calls;
    const result = await run();
    if (mode === 'danger-full-access') {
      assert.equal(result.isError, false);
      assert.equal(result.value, 'executed');
      assert.equal(calls, before + 1);
    } else {
      assert.equal(result.isError, true);
      assert.match(result.error.message, /file policy/);
      assert.equal(calls, before, 'denied scoped call must not enter the tool body');
    }
  }
});
