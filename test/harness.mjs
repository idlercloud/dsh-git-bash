/**
 * 离线验证脚本：用真实 cordis + 真实 dsh-bash-local 驱动本插件，不需要启动 DSH。
 *
 * 运行前提：本包已位于某个 profile 的解析链上（例如 staged 到
 *   $DSH_HOME/profiles/web/node_modules/dsh-git-bash），并从该 profile 目录运行：
 *     node <此文件路径>
 * 检查点：宿主 shell 未被顶替 / 隔离作用域内是本执行器 / settings 段零注册 /
 *         真实 Git Bash 身份 / glob 与 $( ) 展开 / 退出码透传 / stderr 分离 /
 *         非完全权限拒绝在 spawn 之前生效。
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { Context } from '@deepseek-ai/cordis';
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local';
import * as plugin from '@idlercloud/dsh-git-bash';

const CONFIG = {
  cwd: process.cwd(),
  timeoutMs: 30000,
  maxTimeoutMs: 60000,
  maxOutputBytes: 64000,
  maxSpillBytes: 1048576,
  graceMs: 3000,
};

function makeSubprocess() {
  return {
    spawn(spec) {
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
// 兼容两代入口：新版走 resolve() + execute() -> ShellProcess.result()；
// 旧版走 resolve() + run() -> { result }。
const run = async (command) => {
  const spec = realm.shell.resolve({ command: command });
  if (typeof realm.shell.execute === 'function') {
    const proc = await realm.shell.execute(spec);
    return await proc.result();
  }
  return realm.shell.run(spec);
};

const r1 = await run('echo "argv0=$0"; uname -s; echo "bash=$BASH_VERSION"');
record('C1 shell 身份', JSON.stringify(r1.stdout.text.trim()));

const r2 = await run('printf "%s|" *.ts; echo; echo "sub=$(pwd | tr / -)"; echo "single=$notvar"');
record('C2 glob+子命令+单引号变量', JSON.stringify(r2.stdout.text.trim().slice(0, 160)));

const r3 = await run('exit 7');
record('C3 非零退出码透传', r3.exitCode);

const r5 = await run('echo out; ls /nonexistent-xyz >/dev/null');
record('C4 stderr 文本', JSON.stringify(r5.stderr.text.trim().slice(0, 90)));

// ---- D) 解析链与报错质量 ----
import { candidateBashPaths as probeCandidates, resolveBashPath as probeResolve } from '@idlercloud/dsh-git-bash';

try {
  record('D1 自动解析结果', probeResolve());
} catch (e) {
  record('D1 自动解析结果', `FAIL ${e.message.split(String.fromCharCode(10))[0]}`);
}
record('D2 候选数量', probeCandidates().length);
record('D3 候选前两条', probeCandidates().slice(0, 2).join('  |  '));
const savedBash = process.env.DSH_GIT_BASH;
process.env.DSH_GIT_BASH = 'C:\\nope\\bash.exe';
try {
  probeResolve();
  record('D4 显式指向不存在', '未抛错(意外)');
} catch (e) {
  record('D4 显式指向不存在', e.message.slice(0, 95));
}
if (savedBash === undefined) delete process.env.DSH_GIT_BASH;
else process.env.DSH_GIT_BASH = savedBash;

// ---- E) 回归：上游内部方法改名/消失后，替换点仍然生效 ----
// 直接调用基类的 execute —— 它写死了裸 "bash"，等于模拟"某个未来版本又换掉了
// executeArgv，或干脆走回基类实现"：subprocess 包装必须仍然把它换成 Git Bash。
const specBase = realm.shell.resolve({ command: 'echo "base=$0"; uname -s' });
const procBase = await LocalBashExecutor.prototype.execute.call(realm.shell, specBase);
const rBase = await procBase.result();
record('E1 基类裸 bash 仍走 Git Bash', JSON.stringify(rBase.stdout.text.trim()));
record('E2 走基类时的退出码', rBase.exitCode);

// ---- F) 收口点：spawnSpec 只换裸 bash，其余 argv 原样 ----
const specF = realm.shell.resolve({ command: 'echo hi' });
const cfgF1 = realm.shell.spawnSpec(specF, ['bash', '-c', 'echo hi'], 64000, undefined);
record('F1 裸 bash 换成解析结果', cfgF1.argv[0]);
const cfgF2 = realm.shell.spawnSpec(specF, ['git', 'status'], 64000, undefined);
record('F2 非 bash 原样透传', JSON.stringify(cfgF2.argv));
const cfgF3 = realm.shell.spawnSpec(
  specF,
  ['C:\\Program Files\\Git\\bin\\bash.exe', '-c', 'echo hi'],
  64000,
  undefined,
);
record('F3 绝对路径不被动', cfgF3.argv[0]);
record('F4 spawn 配置其余字段仍在', JSON.stringify([typeof cfgF1.cwd, typeof cfgF1.stdio, cfgF1.graceMs]));

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

// ---- H) 行 config 的 bashPath 覆盖（模块级配置，放在最后） ----
const realm3 = root.isolate('shell');
realm3.plugin(plugin, Object.assign({}, CONFIG, { bashPath: 'C:\\nope\\explicit\\bash.exe' }));
await tick();
try {
  record('H1 bashPath 覆盖生效', `未抛错(意外): ${probeResolve()}`);
} catch (e) {
  record('H1 bashPath 覆盖生效', e.message.slice(0, 88));
}

console.log(rows.join(String.fromCharCode(10)));
