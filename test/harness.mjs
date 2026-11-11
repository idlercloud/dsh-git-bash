/**
 * 离线验证脚本：用真实 cordis + 真实 dsh-bash-local 驱动本插件，不需要启动 DSH。
 *
 * 运行前提：仓库根目录已执行 npm install（devDependencies 里有 cordis 与
 *   dsh-bash-local@0.2.2-rc.1），再从仓库根目录运行：
 *     node test/harness.mjs
 * 检查点：宿主 shell 未被顶替 / 隔离作用域内是本执行器 /
 *         真实 bash 执行 / 交给 spawn 的 argv0 是解析结果 / workdir 归一化 /
 *         相对 bashPath / bashPath 覆盖。
 */

import assert from 'node:assert/strict';
import { spawn as nodeSpawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { it } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import * as plugin from '@idlercloud/dsh-git-bash';

it('真实 Git Bash 执行与插件隔离', async (t) => {
  assert.equal(process.platform, 'win32', '此测试需要 Windows 和 Git Bash');
  const fixture = await mkdtemp(join(tmpdir(), 'dsh-git-bash-test-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
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
  root.provide('shell', 'PWSH-EXECUTOR-PLACEHOLDER');
  root.provide('tools', {
    get: () => ({ name: 'bash' }),
    guard: () => () => {},
  });

  // ---- A) 插件路径：通过真实 cordis plugin 挂载（有 fiber） ----
  const realm = root.isolate('shell');
  await realm.plugin(plugin, CONFIG);
  assert.equal(root.shell, 'PWSH-EXECUTOR-PLACEHOLDER');
  assert.equal(realm.shell?.constructor.name, 'GitBashExecutor');
  record('A1 宿主 root.shell 未变', root.shell === 'PWSH-EXECUTOR-PLACEHOLDER');
  record('A2 realm.shell 是本插件执行器', realm.shell?.constructor.name);

  // ---- C) 真跑命令 ----
  const run = async (command, workdir) => {
    const spec = realm.shell.resolve({
      command: command,
      workdir: workdir,
      sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: process.cwd() },
    });
    const proc = await realm.shell.execute(spec);
    return proc.result();
  };

  const r1 = await run('echo "argv0=$0"; echo "bash=$BASH_VERSION"');
  assert.equal(r1.exitCode, 0);
  assert.match(r1.stdout.text, /bash=\d+\./);
  assert.equal(spawned[0][0], new plugin.BashResolver().resolve());
  record('C1 shell 运行', JSON.stringify(r1.stdout.text.trim()));
  record('C1b 交给 spawn 的 argv0', spawned[0][0]);

  const fixtureMsys = fixture.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`);
  const r6 = await run('pwd -W', fixtureMsys);
  assert.equal(r6.exitCode, 0);
  assert.equal(r6.stdout.text.trim().toLowerCase(), fixture.replaceAll('\\', '/').toLowerCase());
  record('C5 workdir MSYS 归一化', r6.stdout.text.trim());

  // 相对 bashPath 的定位不能受命令 workdir 影响。
  const relativeRealm = root.isolate('shell');
  const absoluteBash = new plugin.BashResolver().resolve();
  await relativeRealm.plugin(plugin, { ...CONFIG, bashPath: relative(process.cwd(), absoluteBash) });
  const relativeSpec = relativeRealm.shell.resolve({
    command: 'printf relative-path-ok',
    workdir: fixture,
    sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: fixture },
  });
  const relativeResult = await (await relativeRealm.shell.execute(relativeSpec)).result();
  assert.equal(relativeResult.exitCode, 0);
  assert.equal(relativeResult.stdout.text, 'relative-path-ok');
  assert.equal(spawned.at(-1)[0], absoluteBash);
  record('H0 相对 bashPath 切换工作目录后可执行', 'PASS');

  // ---- H) config 的 bashPath 覆盖（每次挂载独立解析器，放在最后） ----
  const realm3 = root.isolate('shell');
  await realm3.plugin(plugin, { ...CONFIG, bashPath: missingBash });
  await assert.rejects(
    async () => {
      const specH = realm3.shell.resolve({
        command: 'echo hi',
        sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: process.cwd() },
      });
      await realm3.shell.execute(specH);
    },
    { code: 'GIT_BASH_NOT_FOUND' },
  );
  record('H1 bashPath 覆盖生效', 'PASS');
  console.log(rows.join('\n'));
});
