/**
 * `workdir` 的路径方言。
 *
 * 模型在 bash 输出里看到的是 `/c/...` 这类 MSYS 路径，把它填进 `workdir` 时，
 * Windows 会把 `/c/...` 当成当前盘根目录下的 `c`，spawn 直接 ENOENT；`/tmp`
 * 更糟，它会被当成 `C:\tmp`，命令静默跑到另一个目录。
 *
 * 这里只转换有唯一 Windows 对应物的形式：`/c/...` → `C:/...`。`/tmp`、`/usr`
 * 这类路径取决于 MSYS 的挂载表，没有固定答案，直接报错交给模型改。
 *
 * @module dsh-git-bash/workdir
 */

/** MSYS 盘符路径：`/c`、`/c/foo`。 */
const MSYS_DRIVE = /^\/([A-Za-z])(?=\/|$)/;

/**
 * 把 `workdir` 归一成 Windows 路径。非 MSYS 路径原样返回。
 * @param value - `workdir` 原值。
 * @returns Windows 路径，或原值。
 * @throws `workdir` 是 `/tmp` 这类没有盘符的 MSYS 绝对路径时抛出。
 */
export function normalizeWorkdir(value) {
  if (typeof value !== 'string' || !value.startsWith('/')) return value;
  // UNC 路径 `//server/share` 在 Windows 上有效，不按 MSYS 路径处理。
  if (value.startsWith('//')) return value;

  const match = MSYS_DRIVE.exec(value);
  if (!match) {
    const error = new Error(
      `dsh-git-bash: workdir "${value}" is an MSYS path with no Windows equivalent; ` +
        'pass a Windows path such as `C:/...`, and use MSYS paths only inside the command string.',
    );
    error.code = 'GIT_BASH_INVALID_WORKDIR';
    throw error;
  }
  return `${match[1].toUpperCase()}:${value.slice(2) || '/'}`;
}
