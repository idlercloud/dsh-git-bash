/**
 * dsh-git-bash — 文件策略判定。
 *
 * 本插件的 `bash` 工具运行在 Git Bash（MSYS2）上，没有可用的沙箱后端：MSYS2 进程在
 * Windows 受限令牌下需要 fork、创建管道、写入私有临时目录，无法可靠运行。因此执行器
 * 只接受 `danger-full-access` 的调用。
 *
 * 受限会话里的调用在 spawn 之前拒绝。宿主装配了审批服务时，错误文本提示模型带
 * `sandbox_permissions: "danger-full-access"` 和 `justification` 申请这一次调用的
 * 提权；审批通过后工具把调用级 policy 换成 `danger-full-access`，执行器的检查随之放行。
 *
 * @module dsh-git-bash/policy
 */
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox';

/** 本执行器唯一接受的模式。 */
export const FULL_ACCESS_MODE: SandboxMode = 'danger-full-access';

/** 拒绝文案的固定前缀：说明 Git Bash 与文件沙箱的关系。 */
const WHY =
  '`bash` runs in Git for Windows Git Bash, which cannot enforce the DSH file sandbox, ' +
  'so it runs only under `danger-full-access`. ';

/** 有审批服务时给出的单次提权路径。 */
const ESCALATION =
  'Retry the same command with `sandbox_permissions: "danger-full-access"` and a `justification` ' +
  'to request one-time approval for this call. ';

/** 其余情况给出的退路。 */
const NEXT = 'Use the `pwsh` tool for commands this policy governs, or ask the user to switch the session access mode.';

/** 收集到的调用事实。 */
export interface BashAccessFacts {
  mode?: SandboxMode;
  hasPolicy?: boolean;
  error?: unknown;
  /** 宿主是否装配了审批服务。 */
  escalationAvailable?: boolean;
}

/** 把任意抛出物转成一段可读的原因。 */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 把具体原因接在 {@link WHY} 之后，拼成一条拒绝文案。
 * @param detail - 本次拒绝的具体原因。
 * @param escalation - 是否附上单次提权路径。
 */
function denyReason(detail: string, escalation = false): string {
  return WHY + detail + (escalation ? ESCALATION : '') + NEXT;
}

/**
 * 纯函数，不做 IO。只有精确的 `danger-full-access` 放行；有异常、缺服务、
 * 模式未知都返回拒绝文案。
 *
 * @param facts - 调用事实。
 * @param facts.mode - 解析出来的沙箱模式，未解析时省略。
 * @param facts.hasPolicy - 宿主是否提供 sandboxPolicy 服务，默认 true。
 * @param facts.error - 解析策略时的异常，没有时省略。
 * @param facts.escalationAvailable - 宿主是否提供审批服务，默认 false。
 * @returns 拒绝原因；undefined 表示放行。
 */
export function bashDenialReason({
  mode,
  hasPolicy = true,
  error,
  escalationAvailable = false,
}: BashAccessFacts = {}): string | undefined {
  if (error !== undefined) {
    return denyReason(`Resolving the file policy failed (${describeError(error)}). `);
  }
  if (hasPolicy === false) {
    return denyReason('This host exposes no sandbox policy service, so the file policy cannot be verified. ');
  }
  if (mode === FULL_ACCESS_MODE) return undefined;

  const actual = mode === undefined ? 'unknown' : `\`${mode}\``;
  return denyReason(`The file policy is ${actual}. `, escalationAvailable && mode !== undefined);
}
