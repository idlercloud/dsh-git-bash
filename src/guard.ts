/**
 * dsh-git-bash — 非完全权限拒绝。
 *
 * 本插件的 `bash` 工具运行在 Git Bash（MSYS2）上。MSYS2 进程在 Windows 受限令牌下
 * 需要 fork、创建管道、写入私有临时目录，无法可靠运行，因此没有可用的沙箱后端。
 * 工具只在文件策略解析为 `danger-full-access` 时执行：有会话时读该会话的策略，
 * 无会话时读实例默认模式；`read-only`、`workspace-write`、策略缺失或解析失败时，
 * 调用在 spawn 之前返回拒绝。
 *
 * 拒绝点用 `ctx.tools.guard()`：guard 在每个 `tools/pre-execute` 监听器之后、
 * 工具体执行之前求值，只能拒绝、不能放行。把检查放在 pre-execute 监听器里会被
 * 其他策略或审批插件的 allow 覆盖，guard 不会。
 *
 * 只在 win32 注册。
 *
 * @module dsh-git-bash/guard
 */
import type { Context } from '@deepseek-ai/cordis';
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox';
import type { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy';
import type { ToolExecution } from '@deepseek-ai/dsh-tools';

export const BASH_TOOL_NAME = 'bash';

export const FULL_ACCESS_MODE: SandboxMode = 'danger-full-access';

/** 拒绝文案的前后缀：原因之后给两条出路 */
const WHY =
  '`bash` runs in Git for Windows Git Bash, which cannot enforce the DSH file sandbox, ' +
  'so it runs only while the file policy is `danger-full-access`. ';
const NEXT =
  ' Use the `pwsh` tool for commands this policy governs, or ask the user to switch the session access mode.';

/** 收集到的调用事实。 */
export interface BashAccessFacts {
  mode?: SandboxMode;
  hasPolicy?: boolean;
  error?: unknown;
}

/** 把任意抛出物转成一段可读的原因。 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 把原因接在 {@link WHY} 之后，拼成一条拒绝文案。
 * @param detail - 本次拒绝的具体原因。
 */
function denyReason(detail: string): string {
  return WHY + detail + NEXT;
}

/**
 * 纯函数，不做 IO。只有精确的 `danger-full-access` 放行；有异常、缺服务、
 * 模式未知都返回拒绝文案。
 *
 * @param facts - 调用事实。
 * @param facts.mode - 解析出来的沙箱模式，未解析时省略。
 * @param facts.hasPolicy - 宿主是否提供 sandboxPolicy 服务，默认 true。
 * @param facts.error - 解析策略时的异常，没有时省略。
 * @returns 拒绝原因；undefined 表示放行。
 */
export function bashDenialReason({ mode, hasPolicy = true, error }: BashAccessFacts = {}): string | undefined {
  if (error !== undefined) {
    return denyReason(`Resolving the file policy failed (${describeError(error)}).`);
  }
  if (hasPolicy === false) {
    return denyReason('This host exposes no sandbox policy service, so the file policy cannot be verified.');
  }
  if (mode !== FULL_ACCESS_MODE) {
    const actual = mode === undefined ? 'an unknown mode' : `\`${mode}\``;
    return denyReason(`The file policy is ${actual}.`);
  }
  return undefined;
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
function collectFacts(ctx: Context, agent: ToolExecution['agent']): BashAccessFacts {
  const service: SandboxPolicyService | undefined = ctx.get('sandboxPolicy');
  if (service === undefined) return { hasPolicy: false };

  try {
    const { mode } = service.resolve({ session: agent?.session });
    return { hasPolicy: true, mode };
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
function ownsBashCall(ctx: Context, exec: ToolExecution): boolean {
  const visible = ctx.tools.get(BASH_TOOL_NAME, exec.agent);
  const registered = ctx.tools.get(BASH_TOOL_NAME);
  return visible !== undefined && visible === registered;
}

/** 注册可注入的选项。 */
export interface BashGuardOptions {
  platform?: NodeJS.Platform;
}

/**
 * 注册工具层守卫。
 *
 * 只处理名为 `bash` 的调用，其余调用直接放行，不读取策略。
 *
 * @param ctx - 插件 context，需已注入 tools 服务。
 * @param options - 测试用：platform 可注入。
 * @returns 撤销器；非 win32 时为 undefined。
 */
export function installBashGuard(ctx: Context, options: BashGuardOptions = {}): (() => void) | undefined {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') return undefined;

  return ctx.tools.guard((exec) => {
    if (exec.name !== BASH_TOOL_NAME) return undefined;
    if (!ownsBashCall(ctx, exec)) return undefined;
    const reason = bashDenialReason(collectFacts(ctx, exec.agent));
    if (reason === undefined) return undefined;
    ctx.logger.info('dsh-git-bash: denied `bash` before spawn — %s', reason);
    return reason;
  });
}
