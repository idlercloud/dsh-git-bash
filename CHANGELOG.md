# Changelog

## 0.3.1 (2026-11-12)

- 兼容 DSH `0.2.2-rc.2`

## 0.3.0 (2026-11-12)

- 受限会话可以带 `sandbox_permissions: "danger-full-access"` 和 `justification` 重试；审批通过后只对当次调用生效，会话策略不变。
- 权限检查从 `tools.guard` 移到执行器的 `resolve`/`execute`，按调用级 `sandboxPolicy` 判定。
- 未提权或审批未通过的调用仍在 spawn 前拒绝；宿主没有审批服务时不提示提权。
- 系统提示词与中英文 README 说明 `workspace-write` 不够，需要直接申请 `danger-full-access`。

## 0.2.0 (2026-11-12)

首个公开版本。基于 [Fishquito7/dsh-gitbash](https://github.com/Fishquito7/dsh-gitbash) v0.1.3。

- 在 Windows 上通过独立隔离作用域复用 DSH 官方 `bash` 工具，执行器改用 Git for Windows Git Bash。
- 自动发现 Git Bash，支持 `bashPath`、`DSH_GIT_BASH`、`GIT_INSTALL_ROOT` 与 PATH 中 `git.exe` 反推。
- 归一化 `/c/...` 形式的 `workdir`，拒绝没有盘符的 MSYS 路径。
- 文件策略不是 `danger-full-access` 时在 spawn 前拒绝 `bash`。
- 注册 Git Bash 补充系统提示词，保留 `pwsh` 工具。
