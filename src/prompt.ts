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
 * 插件入口只在 win32 调用本函数：其他平台上这段提示词只会误导模型。
 *
 * @module dsh-git-bash/prompt
 */
import type { Context, Disposable } from '@deepseek-ai/cordis';
import type { SystemPrompt } from '@deepseek-ai/dsh-system-prompt';

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
  '`workdir` accepts Windows paths (`C:/...`) and MSYS drive paths (`/c/...`, normalized to `C:/...`); ' +
  'drive-less MSYS paths such as `/tmp` are rejected. `workdir` is not shell-expanded, so `~` and `$VAR` ' +
  'are taken literally. ' +
  'This tool has no file sandbox: under a narrower policy, widen this call directly to ' +
  '`danger-full-access`; `workspace-write` does not make Git Bash runnable. ' +
  'Prefer `bash` for command-line work. Use `pwsh` only when the task is Windows-native, such as cmdlets, ' +
  'the registry, services, and WMI, or when `bash` is unavailable.';

/** 可注入的选项，测试用来替换 prompt 服务。 */
export interface GitBashPromptOptions {
  prompt?: SystemPrompt;
}

/**
 * 注册系统提示词 section。
 *
 * @param ctx - 插件 context，宿主需已提供 systemPrompt。
 * @param options - 测试用：prompt 可注入。
 * @returns effect disposer；不注册时 undefined。
 */
export function installGitBashPrompt(
  ctx: Context,
  options: GitBashPromptOptions = {},
): Disposable<Promise<void>> | undefined {
  const prompt = options.prompt ?? ctx.get('systemPrompt');
  if (!prompt) return undefined;

  return ctx.effect(
    () => prompt.section({ name: SECTION_NAME, order: prompt.getSectionOrder('TOOL_BASH'), text: GIT_BASH_PROMPT }),
    'dsh-git-bash: system prompt',
  );
}
