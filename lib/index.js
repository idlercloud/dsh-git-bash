/**
 * dsh-git-bash — 在 Windows 上把 DSH 的原生 bash 工具接到 Git Bash。
 *
 * 设计：不自己写工具，复用上游两个现成件——
 *   - @deepseek-ai/dsh-bash-local 的进程机制（超时、输出上限、spill、后台句柄）；
 *   - @deepseek-ai/dsh-tool-bash 的完整工具 schema、渲染与退出码标记。
 * 本插件只做三件事：
 * - 解析 Git for Windows 里 bash.exe 的绝对路径并调用
 * - 给模型补一段系统提示词，说明这个是 MSYS 的 bash；
 * - 在会话文件策略不是完全权限时，于 spawn 之前拒绝 `bash` 调用。
 *
 * 解析优先级：
 * - config 里的 bashPath
 * - 环境变量 DSH_GIT_BASH
 * - GIT_INSTALL_ROOT
 * - 注册表 InstallPath
 * - 常见安装位置
 * - where git / where bash。
 *
 * @module dsh-git-bash
 */
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local';
import { FULL_ACCESS_MODE, installBashGuard } from './guard.js';
import { installGitBashPrompt } from './prompt.js';
import { BashResolver } from './resolve.js';

/** 加载器读取的插件元数据。 */
export const name = '@idlercloud/dsh-git-bash';
export const inject = ['subprocess'];
export const Config = LocalBashExecutor.Config;
// 暴露给测试：harness 用它按真实环境解析与列出候选。
export { BashResolver };

/** 日志句柄在 apply() 里设。 */
let logger;

/**
 * 本地 bash 执行器。
 *
 * 覆盖公开入口 `execute`：把 shell 换成解析到的 Git Bash，执行语义仍交给基类的 `executeArgv`。
 */
class GitBashExecutor extends LocalBashExecutor {
  /**
   * @param ctx - 执行器 context。
   * @param config - 插件配置对象。
   * @param resolver - 本次挂载专用的 Git Bash 发现器。
   */
  constructor(ctx, config, resolver) {
    super(ctx, config);
    // 宿主把服务包成 Proxy，私有字段读不到；普通属性可以穿透。
    this.gitBashResolver = resolver;
  }

  /**
   * 把公开入口的 `bash -c <command>` 换成解析到的 Git Bash。
   *
   * 基类的 execute 只做 executeArgv(spec, ['bash', '-c', spec.command])；
   * 这里填入绝对路径，超时、输出上限、后台句柄等仍由 executeArgv 负责。
   * @param spec - resolve() 产出的执行规格。
   * @returns ShellExecution 句柄。
   */
  async execute(spec) {
    return this.executeArgv(spec, [this.gitBashResolver.resolve(), '-c', spec.command]);
  }
}

/**
 * 挂载执行器与权限闸门。
 *
 * @param ctx - 挂载点 context（位于 isolate 隔离作用域内）。
 * @param config - 组合条目配置，可含 bashPath / cwd / timeoutMs 等。
 */
export function apply(ctx, config) {
  const resolver = new BashResolver();
  resolver.configure(config?.bashPath);
  logger = ctx.logger;
  installGitBashPrompt(ctx);
  if (installBashGuard(ctx) !== undefined) {
    logger?.info?.(
      'dsh-git-bash: `bash` is denied before spawn unless the session file policy is `%s`.',
      FULL_ACCESS_MODE,
    );
  }
  // 构造即注册：构造函数把执行器挂到隔离作用域的 ctx.shell 上，实例由 context 持有。
  new GitBashExecutor(ctx, config, resolver);
  try {
    logger?.info?.('dsh-git-bash: bash.exe -> %s', resolver.resolve());
  } catch (error) {
    logger?.warn?.('dsh-git-bash: %s', error.message);
  }
}
