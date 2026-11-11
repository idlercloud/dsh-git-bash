# Changelog

## 0.2.0 (2026-11-12)

首个公开版本。基于 [Fishquito7/dsh-gitbash](https://github.com/Fishquito7/dsh-gitbash) v0.1.3。

- 在 Windows 上通过独立隔离作用域复用 DSH 官方 `bash` 工具，执行器改用 Git for Windows Git Bash。
- 自动发现 Git Bash，支持 `bashPath`、`DSH_GIT_BASH`、`GIT_INSTALL_ROOT` 与 PATH 中 `git.exe` 反推。
- 归一化 `/c/...` 形式的 `workdir`，拒绝没有盘符的 MSYS 路径。
- 文件策略不是 `danger-full-access` 时在 spawn 前拒绝 `bash`。
- 注册 Git Bash 补充系统提示词，保留 `pwsh` 工具。
