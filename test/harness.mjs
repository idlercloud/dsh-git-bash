/**
 * 离线验证脚本：用真实 cordis + 真实 dsh-bash-local 驱动本插件，不需要启动 DSH。
 *
 * 运行前提：仓库根目录已执行 npm install（devDependencies 里有 cordis 与
 *   dsh-bash-local@0.2.2-rc.1），再从仓库根目录运行：
 *     node test/harness.mjs
 * 检查点：宿主 shell 未被顶替 / 隔离作用域内是本执行器 / settings 段零注册 /
 *         真实 Git Bash 身份 / 交给 spawn 的 argv0 是解析结果 / workdir 归一化 /
 *         glob 与 $( ) 展开 / 退出码透传 / stderr 分离 / 非完全权限拒绝在 spawn 之前生效。
 */

import assert from 'node:assert/strict';
import { spawn as nodeSpawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import * as plugin from '@idlercloud/dsh-git-bash';

it('真实 Git Bash 执行与插件隔离', async (t) => {
  assert.equal(process.platform, 'win32', '此测试需要 Windows 和 Git Bash');
  const fixture = await mkdtemp(join(tmpdir(), 'dsh-git-bash-test-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  await writeFile(join(fixture, 'a.txt'), 'a');
  await writeFile(join(fixture, 'b.txt'), 'b');
  const missingBash = join(fixture, 'missing', 'bash.exe');
  const children = new Set();
  t.after(() => {
    for (const child of children) child.kill();
  });
  const CONFIG = {
    cwd: process.cwd(),
    timeoutMs: 30000,
    maxTimeoutMs: 60000,
    maxOutputBytes: 64000,
    maxSpillBytes: 1048576,
    graceMs: 3000,
  };

  /** 每次 spawn 的 argv，C 段用来核对 execute 交给上游的 shell。 */
  const spawned = [];

  function makeSubprocess() {
    return {
      spawn(spec) {
        spawned.push(spec.argv);
        const child = nodeSpawn(spec.argv[0], spec.argv.slice(1), {
          cwd: spec.cwd,
          env: Object.assign({}, process.env, spec.env || {}),
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '';
        let err = '';
        child.stdout.on('data', (d) => {
          out += d.toString('utf8');
        });
        child.stderr.on('data', (d) => {
          err += d.toString('utf8');
        });
        children.add(child);
        child.once('close', () => children.delete(child));
        const done = new Promise((resolve, reject) => {
          child.once('error', reject);
          child.on('close', (code, signal) => {
            resolve({ exitCode: code, signal: signal || null });
          });
        });
        const reader = (get) => ({
          readFrom: (offset) => ({ text: get().slice(offset), nextOffset: get().length, lossy: false }),
        });
        return {
          done: done,
          collected: { stdout: reader(() => out), stderr: reader(() => err) },
          terminate: () => {
            child.kill();
          },
        };
      },
    };
  }

  const rows = [];
  const record = (label, value) => {
    rows.push(`${String(label).padEnd(38)} : ${String(value)}`);
  };

  const root = new Context();
  t.after(() => root.fiber.dispose());
  root.provide('subprocess', makeSubprocess());
  let installs = 0;
  root.provide('settings', {
    installSection: () => {
      installs += 1;
      throw new Error('settings namespace "shell" is already registered');
    },
  });
  root.provide('shell', 'PWSH-EXECUTOR-PLACEHOLDER');

  // 工具服务的最小实现：`get` 用于核对调用归属，`guard` 收集插件注册的守卫，
  // `checkGuards` 复刻宿主在 pre-execute 之后逐个求值守卫的行为。
  const bashDefinition = { name: 'bash' };
  const guards = [];
  const toolsService = {
    get: () => bashDefinition,
    guard(fn) {
      guards.push(fn);
      return () => {
        const index = guards.indexOf(fn);
        if (index >= 0) guards.splice(index, 1);
      };
    },
    checkGuards(exec) {
      for (const fn of guards) {
        const reason = fn(exec);
        if (reason !== undefined) return reason;
      }
      return undefined;
    },
  };
  root.provide('tools', toolsService);

  // 权限闸门要读的 sandboxPolicy 最小实现：模式可切换，默认完全权限，C 段的真实命令才不会被挡下。
  const sandbox = { mode: 'danger-full-access' };
  root.provide('sandboxPolicy', {
    resolve: (request) => ({ mode: sandbox.mode, workspaceRoot: process.cwd(), sessionId: request?.session?.id }),
  });

  // ---- A) 插件路径：通过真实 cordis plugin 挂载（有 fiber） ----
  const realm = root.isolate('shell');
  await realm.plugin(plugin, CONFIG);
  assert.equal(root.shell, 'PWSH-EXECUTOR-PLACEHOLDER');
  assert.equal(realm.shell?.constructor.name, 'GitBashExecutor');
  assert.equal(installs, 0);
  record('A1 宿主 root.shell 未变', root.shell === 'PWSH-EXECUTOR-PLACEHOLDER');
  record('A2 realm.shell 是本插件执行器', realm.shell?.constructor.name);
  record('A3 settings.installSection 次数(期望0)', installs);

  // ---- C) 真跑命令 ----
  const run = async (command, workdir) => {
    const spec = realm.shell.resolve({ command: command, workdir: workdir });
    const proc = await realm.shell.execute(spec);
    return proc.result();
  };

  const r1 = await run('echo "argv0=$0"; uname -s; echo "bash=$BASH_VERSION"');
  assert.equal(r1.exitCode, 0);
  assert.match(r1.stdout.text, /(?:MINGW|MSYS)[^\r\n]*/);
  assert.match(r1.stdout.text, /bash=\d+\./);
  assert.equal(spawned[0][0], new plugin.BashResolver().resolve());
  record('C1 shell 身份', JSON.stringify(r1.stdout.text.trim()));
  record('C1b 交给 spawn 的 argv0', spawned[0][0]);

  const r2 = await run(
    `printf '%s|' *.txt; printf '\nsub=%s\n' "$(printf expanded)"; printf '%s\n' '$notvar'`,
    fixture,
  );
  assert.equal(r2.exitCode, 0);
  assert.equal(r2.stdout.text.replaceAll('\r\n', '\n'), 'a.txt|b.txt|\nsub=expanded\n$notvar\n');
  record('C2 glob+子命令+单引号变量', JSON.stringify(r2.stdout.text));

  const r3 = await run('exit 7');
  assert.equal(r3.exitCode, 7);
  record('C3 非零退出码透传', r3.exitCode);

  const r5 = await run('echo out; echo err >&2');
  assert.equal(r5.exitCode, 0);
  assert.equal(r5.stdout.text.trim(), 'out');
  assert.equal(r5.stderr.text.trim(), 'err');
  record('C4 stderr 文本', JSON.stringify(r5.stderr.text.trim().slice(0, 90)));

  const fixtureMsys = fixture.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`);
  const r6 = await run('pwd -W', fixtureMsys);
  assert.equal(r6.exitCode, 0);
  assert.equal(r6.stdout.text.trim().toLowerCase(), fixture.replaceAll('\\', '/').toLowerCase());
  record('C5 workdir MSYS 归一化', r6.stdout.text.trim());
  await assert.rejects(() => run('pwd', '/tmp'), { code: 'GIT_BASH_INVALID_WORKDIR' });
  record('C6 无盘符 workdir 报错', 'PASS');

  // ---- D) 解析链与报错质量 ----

  const probe = new plugin.BashResolver();
  record('D1 自动解析结果', probe.resolve());
  assert.ok(probe.candidates().length > 0);
  record('D2 候选数量', probe.candidates().length);
  record('D3 候选前两条', probe.candidates().slice(0, 2).join('  |  '));
  const savedBash = process.env.DSH_GIT_BASH;
  process.env.DSH_GIT_BASH = missingBash;
  try {
    assert.throws(() => new plugin.BashResolver().resolve(), { code: 'GIT_BASH_NOT_FOUND' });
    record('D4 显式指向不存在', 'PASS');
  } finally {
    if (savedBash === undefined) delete process.env.DSH_GIT_BASH;
    else process.env.DSH_GIT_BASH = savedBash;
  }

  // ---- I) 权限闸门：工具层 guard 在 pre-execute 之后强制拒绝 ----
  // 宿主流水线在 pre-execute 得到 allow 后调用 checkGuards；guard 只能拒绝，
  // 其他监听器返回什么都无法把它改回放行。
  const checkGuards = (exec) => toolsService.checkGuards(exec);
  const bashCall = (agent) => (agent === undefined ? { name: 'bash' } : { name: 'bash', agent });
  const guardAgent = { session: { id: 'harness-session' } };
  const verdict = (exec) => (checkGuards(exec) === undefined ? 'allow' : 'deny');

  sandbox.mode = 'danger-full-access';
  assert.equal(verdict(bashCall(guardAgent)), 'allow');
  record('I1 完全权限放行', verdict(bashCall(guardAgent)));

  sandbox.mode = 'workspace-write';
  assert.equal(verdict(bashCall(guardAgent)), 'deny');
  record('I2 workspace-write 拒绝', `deny / ${String(checkGuards(bashCall(guardAgent))).slice(0, 48)}`);
  assert.equal(verdict({ name: 'pwsh', agent: guardAgent }), 'allow');
  record('I3 非 bash 调用不受影响', verdict({ name: 'pwsh', agent: guardAgent }));

  sandbox.mode = 'danger-full-access';
  assert.equal(verdict(bashCall(undefined)), 'allow');
  record('I4 无会话按实例默认模式放行', verdict(bashCall(undefined)));

  sandbox.mode = 'workspace-write';
  assert.equal(verdict(bashCall(undefined)), 'deny');
  record('I5 无会话且实例默认模式受限时拒绝', verdict(bashCall(undefined)));

  // I6：pre-execute 监听器把调用放行后，guard 仍然拒绝。
  sandbox.mode = 'read-only';
  const listenerVerdict = (
    await root.waterfall('tools/pre-execute', bashCall(guardAgent), () => Promise.resolve({ kind: 'allow' }))
  ).kind;
  assert.equal(listenerVerdict, 'allow');
  assert.equal(verdict(bashCall(guardAgent)), 'deny');
  record('I6 监听器放行后仍被 guard 拒绝', `${listenerVerdict} -> ${verdict(bashCall(guardAgent))}`);

  // ---- H) config 的 bashPath 覆盖（每次挂载独立解析器，放在最后） ----
  const realm3 = root.isolate('shell');
  await realm3.plugin(plugin, { ...CONFIG, bashPath: missingBash });
  await assert.rejects(
    async () => {
      const specH = realm3.shell.resolve({ command: 'echo hi' });
      await realm3.shell.execute(specH);
    },
    { code: 'GIT_BASH_NOT_FOUND' },
  );
  record('H1 bashPath 覆盖生效', 'PASS');
  console.log(rows.join('\n'));
});
