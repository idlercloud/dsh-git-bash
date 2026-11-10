/**
 * dsh-git-bash — 系统提示词。
 *
 * 官方 bash 工具的提示词默认背后是 POSIX bash，所以只交代"每次调用都是新 shell"
 * 和退出码标记。在 Windows 上这个前提不成立：命令实际跑在 Git for Windows 的
 * Git Bash（MSYS2）里，路径方言、会话持久化语义、以及"哪些活该交给 pwsh"都和模型
 * 对 bash 的默认印象不同。这里把差异补成一段独立 section。
 *
 * 注册成独立 section 而不是改官方文本：官方 `tool:bash` 的文本由
 * @deepseek-ai/dsh-tool-bash 拥有，改它要 fork 整个工具；同一 order 下 section 按
 * 名字的 code-unit 顺序排，"tool:bash" 是 "tool:bash:git-bash" 的前缀，所以这段
 * 稳定落在官方那段之后。
 *
 * 只在 win32 注册：其他平台上这个插件本身没有意义，多出来的一段提示词只会误导模型。
 *
 * @module dsh-git-bash/prompt
 */

/** 注册用的 section 名：与官方 `tool:bash` 不同名，二者共存。 */
export const SECTION_NAME = 'tool:bash:git-bash';

/**
 * 模型可见的补充说明。
 *
 * 只写官方工具描述里没有的：bash 跑在哪个 shell、路径方言、不支持文件沙箱、与 pwsh 的分工。
 */
export const GIT_BASH_PROMPT =
  'The `bash` tool runs commands in Git for Windows Git Bash, an MSYS2 shell. ' +
  'In this shell `/c/...`, `~`, and `/tmp` are MSYS paths, and an unquoted `C:\\...` drops its backslashes, ' +
  'so write drive paths as `/c/...` or quoted `C:/...`; paths handed to other file tools (such as `read` and ' +
  '`write`) usually stay Windows paths. ' +
  'Pass `workdir` as a Windows path (for example `C:/...`); MSYS paths only work inside the command string. ' +
  'This tool does not support a file sandbox, so it is available only under `danger-full-access`. ' +
  'Prefer `bash` for command-line work. Use `pwsh` only when the task is Windows-native, such as cmdlets, ' +
  'the registry, services, and WMI, or when `bash` is unavailable.';

/**
 * `SECTION_ORDERS.TOOL_BASH` 一直是 1000。宿主哪天改了分区表的键名或删了这张表，
 * 用它兜底：位置可能和其他工具段落挨得不理想，但这段说明不会消失。
 */
const FALLBACK_ORDER = 1000;

/**
 * 注册系统提示词 section。
 *
 * @param ctx - 插件 context，宿主需已提供 systemPrompt。
 * @param options - 测试用：platform、prompt、logger 可注入。
 * @returns effect disposer；不注册时 undefined。
 */
export function installGitBashPrompt(ctx, options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') return undefined;

  const prompt = options.prompt ?? ctx.get('systemPrompt');
  if (!prompt) return undefined;

  const hostOrder = prompt.getSectionOrder('TOOL_BASH');
  const order = Number.isFinite(hostOrder) ? hostOrder : FALLBACK_ORDER;
  if (!Number.isFinite(hostOrder)) {
    (options.logger ?? ctx.logger)?.warn?.(
      'dsh-git-bash: systemPrompt.getSectionOrder("TOOL_BASH") is not a finite number — the host probably ' +
        `renamed its section order table; placing the Git Bash prompt at the historical order ${FALLBACK_ORDER}.`,
    );
  }

  return ctx.effect(
    () => prompt.section({ name: SECTION_NAME, order, text: GIT_BASH_PROMPT }),
    'dsh-git-bash: system prompt',
  );
}
