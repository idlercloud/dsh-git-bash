/**
 * dsh-git-bash — 非完全权限拒绝。
 *
 * 本插件的 `bash` 工具运行在 Git Bash（MSYS2）上。MSYS2 进程在 Windows 受限令牌下
 * 需要 fork、创建管道、写入私有临时目录，无法可靠运行，因此没有可用的沙箱后端。
 * 工具只在文件策略解析为 `danger-full-access` 时执行：有会话时读该会话的策略，
 * 无会话时读实例默认模式；`read-only`、`workspace-write`、策略缺失或解析失败时，
 * 调用在 spawn 之前返回拒绝。
 *
 * 拒绝点放在 `tools/pre-execute`：`@deepseek-ai/dsh-bash-local` 的模块注释把执行策略
 * 归到 `tools/pre-execute` 或自带沙箱的执行器；官方 `bash` 工具只在 `ctx.shell` 声明
 * `sandboxMode` 时解析策略，本插件不声明，工具就不会把 `sandbox_permissions` /
 * `justification` 加进 schema。
 *
 * 只在 win32 注册。
 *
 * @module dsh-git-bash/guard
 */

export const BASH_TOOL_NAME = 'bash';

export const FULL_ACCESS_MODE = 'danger-full-access';

/**
 * 拒绝决策携带的 `info`。
 *
 * 与 `@deepseek-ai/dsh-sandbox` 的 `SandboxUnavailableError` / `SANDBOX_UNAVAILABLE`
 * 同名同码，语义是：请求的模式没有可用的沙箱后端，拒绝在没有沙箱约束的情况下执行。
 */
export const DENY_INFO = Object.freeze({ name: 'SandboxUnavailableError', code: 'SANDBOX_UNAVAILABLE' });

/**
 * 拒绝文案的前后缀：原因之后给两条出路
 */
const WHY =
  '`bash` runs in Git for Windows Git Bash, which cannot enforce the DSH file sandbox, ' +
  'so it runs only while the file policy is `danger-full-access`. ';
const NEXT =
  ' Use the `pwsh` tool for commands this policy governs, or ask the user to switch the session access mode.';

/**
 * 把原因接在 {@link WHY} 之后，拼成一条拒绝决策。
 * @param detail - 本次拒绝的具体原因。
 */
function denyDecision(detail) {
  return { kind: 'deny', reason: WHY + detail + NEXT, info: DENY_INFO };
}

/**
 * 纯决策函数，不做 IO。只有精确的 `danger-full-access` 放行；有异常、缺服务、
 * 模式未知都返回拒绝。
 *
 * @param facts - 调用事实。
 * @param facts.mode - 解析出来的沙箱模式，未解析时省略。
 * @param facts.hasPolicy - 宿主是否提供 sandboxPolicy 服务，默认 true。
 * @param facts.error - 取服务或解析策略时的异常，没有时省略。
 * @returns `{ kind: 'allow' }` 或 `{ kind: 'deny', reason, info }`。
 */
export function decideBashAccess({ mode, hasPolicy = true, error } = {}) {
  // 服务取值抛错时 hasPolicy 也会是 false；先报异常比报服务缺失准确。
  if (error !== undefined) {
    return denyDecision(`Resolving the file policy failed (${String(error?.message || error)}).`);
  }
  if (hasPolicy === false) {
    return denyDecision('This host exposes no sandbox policy service, so the file policy cannot be verified.');
  }
  if (mode !== FULL_ACCESS_MODE) {
    const actual = typeof mode === 'string' && mode.length > 0 ? `\`${mode}\`` : 'an unknown mode';
    return denyDecision(`The file policy is ${actual}.`);
  }
  return { kind: 'allow' };
}

/**
 * 收集一次调用的事实：sandboxPolicy 服务、解析出的模式。
 *
 * 所有异常都转成 facts，不向工具层抛出：抛出的异常会成为普通工具错误，模型无法
 * 区分这是权限拒绝。
 *
 * @param ctx - 插件 context。
 * @param agent - 发起调用的 agent。
 * @returns `{ hasPolicy, mode?, error? }`。
 */
function collectFacts(ctx, agent) {
  let policy;
  try {
    policy = ctx.get('sandboxPolicy');
  } catch (error) {
    return { hasPolicy: false, error };
  }
  // 服务不存在与解析失败分开报告。
  if (policy === undefined || policy === null) return { hasPolicy: false };
  const session = agent?.session;
  const request = session === undefined ? {} : { session };
  try {
    return { hasPolicy: true, mode: policy.resolve(request)?.mode };
  } catch (error) {
    return { hasPolicy: true, error };
  }
}

/**
 * 这次 `bash` 调用是否属于本插件注册的工具。
 *
 * 工具层允许 agent 作用域的同名定义遮蔽全局工具。其他插件可能注册自己的 `bash`，
 * 策略与本插件不同；只按名字拦截会拒绝这些工具。因此比较调用方看到的定义与全局
 * 定义：两者都存在且是同一个对象时才由本插件裁决。
 *
 * @param ctx - 插件 context。
 * @param exec - 待执行的工具调用。
 * @returns 该调用是否由本插件裁决。
 */
function ownsBashCall(ctx, exec) {
  const tools = ctx.get('tools');
  const visible = tools.get(BASH_TOOL_NAME, exec.agent);
  const registered = tools.get(BASH_TOOL_NAME);
  return visible !== undefined && visible === registered;
}

/**
 * 注册 `tools/pre-execute` 监听器。
 *
 * 只处理名为 `bash` 的调用，其余调用直接 `next()`，不读取策略。
 *
 * @param ctx - 插件 context，宿主工具层需派发 `tools/pre-execute`。
 * @param options - 测试用：platform 可注入。
 * @returns 撤销器；非 win32 时为 undefined。
 */
export function installBashGuard(ctx, options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') return undefined;

  const logger = ctx.logger;

  return ctx.on('tools/pre-execute', (exec, next) => {
    if (exec?.name !== BASH_TOOL_NAME) return next();
    if (!ownsBashCall(ctx, exec)) return next();
    const decision = decideBashAccess(collectFacts(ctx, exec.agent));
    if (decision.kind === 'allow') return next();
    logger?.info?.('dsh-git-bash: denied `bash` before spawn — %s', decision.reason);
    return decision;
  });
}
