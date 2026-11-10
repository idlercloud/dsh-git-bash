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

import { spawn as nodeSpawn } from 'node:child_process';
import { Context } from '@deepseek-ai/cordis';
import * as plugin from '@idlercloud/dsh-git-bash';

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
      const done = new Promise((resolve) => {
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
        kill: () => {
          child.kill();
        },
      };
    },
  };
}

const tick = () =>
  new Promise((r) => {
    setTimeout(r, 60);
  });
const rows = [];
const record = (label, value) => {
  rows.push(`${String(label).padEnd(38)} : ${String(value)}`);
};

const root = new Context();
root.provide('subprocess', makeSubprocess());
let installs = 0;
root.provide('settings', {
  installSection: () => {
    installs += 1;
    throw new Error('settings namespace "shell" is already registered');
  },
});
root.provide('shell', 'PWSH-EXECUTOR-PLACEHOLDER');

// 工具服务的最小实现：guard 用它核对调用归属，两次查询返回同一个定义即视为本插件挂的 bash。
const bashDefinition = { name: 'bash' };
root.provide('tools', { get: () => bashDefinition });

// 权限闸门要读的 sandboxPolicy 最小实现：模式可切换，默认完全权限，C 段的真实命令才不会被挡下。
const sandbox = { mode: 'danger-full-access' };
root.provide('sandboxPolicy', {
  resolve: (request) => ({ mode: sandbox.mode, workspaceRoot: process.cwd(), sessionId: request?.session?.id }),
});

// ---- A) 插件路径：通过真实 cordis plugin 挂载（有 fiber） ----
const realm = root.isolate('shell');
realm.plugin(plugin, CONFIG);
await tick();
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
record('C1 shell 身份', JSON.stringify(r1.stdout.text.trim()));
record('C1b 交给 spawn 的 argv0', spawned[0][0]);

const r2 = await run('printf "%s|" *.ts; echo; echo "sub=$(pwd | tr / -)"; echo "single=$notvar"');
record('C2 glob+子命令+单引号变量', JSON.stringify(r2.stdout.text.trim().slice(0, 160)));

const r3 = await run('exit 7');
record('C3 非零退出码透传', r3.exitCode);

const r5 = await run('echo out; ls /nonexistent-xyz >/dev/null');
record('C4 stderr 文本', JSON.stringify(r5.stderr.text.trim().slice(0, 90)));

const r6 = await run('pwd', '/c/Windows');
record('C5 workdir /c/... 归一化', r6.stdout.text.trim());
try {
  await run('pwd', '/tmp');
  record('C6 无盘符 workdir 报错', '未抛错(意外)');
} catch (e) {
  record('C6 无盘符 workdir 报错', e.message.slice(0, 90));
}

// ---- D) 解析链与报错质量 ----
import { BashResolver as ProbeResolver } from '@idlercloud/dsh-git-bash';

const probe = new ProbeResolver();
try {
  record('D1 自动解析结果', probe.resolve());
} catch (e) {
  record('D1 自动解析结果', `FAIL ${e.message.split(String.fromCharCode(10))[0]}`);
}
record('D2 候选数量', probe.candidates().length);
record('D3 候选前两条', probe.candidates().slice(0, 2).join('  |  '));
const savedBash = process.env.DSH_GIT_BASH;
process.env.DSH_GIT_BASH = 'C:\\nope\\bash.exe';
try {
  // 新解析器，避免命中 D1 的缓存；显式配置会重新校验。
  new ProbeResolver().resolve();
  record('D4 显式指向不存在', '未抛错(意外)');
} catch (e) {
  record('D4 显式指向不存在', e.message.slice(0, 95));
}
if (savedBash === undefined) delete process.env.DSH_GIT_BASH;
else process.env.DSH_GIT_BASH = savedBash;

// ---- I) 权限闸门：非完全权限在 pre-execute 阶段被拒绝 ----
// 这里派发的是宿主真实的 tools/pre-execute waterfall，监听器是插件在 apply 里注册的。
const preExecute = (exec) => root.waterfall('tools/pre-execute', exec, () => Promise.resolve({ kind: 'allow' }));
const bashCall = (agent) => (agent === undefined ? { name: 'bash' } : { name: 'bash', agent });
const guardAgent = { session: { id: 'harness-session' } };

sandbox.mode = 'danger-full-access';
record('I1 完全权限放行', (await preExecute(bashCall(guardAgent))).kind);

sandbox.mode = 'workspace-write';
const deniedWrite = await preExecute(bashCall(guardAgent));
record('I2 workspace-write 拒绝', `${deniedWrite.kind} / ${deniedWrite.info?.code}`);
record('I3 非 bash 调用不受影响', (await preExecute({ name: 'pwsh', agent: guardAgent })).kind);

sandbox.mode = 'danger-full-access';
record('I4 无会话按实例默认模式放行', (await preExecute(bashCall(undefined))).kind);

sandbox.mode = 'workspace-write';
record('I5 无会话且实例默认模式受限时拒绝', (await preExecute(bashCall(undefined))).kind);

// ---- H) config 的 bashPath 覆盖（每次挂载独立解析器，放在最后） ----
const realm3 = root.isolate('shell');
realm3.plugin(plugin, Object.assign({}, CONFIG, { bashPath: 'C:\\nope\\explicit\\bash.exe' }));
await tick();
try {
  const specH = realm3.shell.resolve({ command: 'echo hi' });
  await realm3.shell.execute(specH);
  record('H1 bashPath 覆盖生效', '未抛错(意外)');
} catch (e) {
  record('H1 bashPath 覆盖生效', e.message.slice(0, 88));
}

console.log(rows.join(String.fromCharCode(10)));
