# @idlercloud/dsh-git-bash

让 DSH 在 Windows 上优先使用 Git Bash。

<p align="center">
  <a href="README.en.md">English</a> · <b>中文</b>
</p>

<p align="center">
  <img alt="platform" src="https://img.shields.io/badge/platform-Windows-0078D6?style=flat-square">
  <img alt="harness" src="https://img.shields.io/badge/DSH-plugin-4B6BFB?style=flat-square">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-3DA639?style=flat-square">
</p>

本仓库是 [`Fishquito7/dsh-gitbash`](https://github.com/Fishquito7/dsh-gitbash) v0.1.3 的 fork。

---

## 为什么

现有模型的 Bash 训练语料一般远多于 PowerShell，因此其使用 Bash 的能力也远强于使用 PowerShell。PowerShell 本身也算不上良好设计，哪怕是顶尖模型也经常与其搏斗。

**DSH 在 Windows 上把 shell 写死了只能用 PowerShell。** 工具列表里根本没有 bash 这个工具，即使实际上可以使用 Git Bash（Claude Code 在 Windows 上就是这么做的）。

---

## 如何实现

复用官方原有的 bash 工具，把它挂进独立的隔离作用域，再接上 Git Bash 执行器。通过系统提示词要求模型优先使用 Bash。

好处是实现简单、行为稳定：超时、参数校验、输出截断与落盘、PTC 适配等逻辑都复用官方 bash 工具。

另外，原有的 pwsh 工具仍然保留，因为注册表、服务、进程句柄、Windows 原生路径等情况显然用 PowerShell 来完成更合适。

## 限制

已在 DSH `0.2.2-rc.1` 和 `0.2.2-rc.2` 上验证，兼容性声明与 DSH peer 依赖覆盖这两个版本。升级到其他 DSH 版本前需要重新验证本插件。

**不经过文件沙箱，只在 `danger-full-access` 下运行。**

Git Bash 是 MSYS2 进程，在 Windows 受限令牌下需要 fork、管道与私有临时目录，行为不可靠，所以本插件没有可用的沙箱后端。插件在 spawn 之前检查这次调用的文件策略，不是 `danger-full-access` 就拒绝。

受限会话里，模型可以带 `sandbox_permissions: "danger-full-access"` 和 `justification` 重试同一条命令，由宿主弹出审批；批准只对这一次调用生效，会话策略不变。宿主没有装配审批服务时，这条路径不可用，只能切换会话策略或改用 `pwsh`。

## 非目标

- 提供单独的 bash 工具：那样要抄官方代码，重写超时、参数校验等大量逻辑。
- 禁用 pwsh 工具：仍有很多场景使用 PowerShell 更简单。
- 除 Bash 以外的其他能力：本插件刻意保持简单、可审计，其他功能应当另开插件。

---

## 安装、升级与卸载

**要求**

- Windows 10/11。
- 已安装 Git for Windows（含 `bash.exe`）。
- DSH `0.2.2-rc.1` 或 `0.2.2-rc.2`。

桌面端是特殊的，一般通过内置的插件管理器安装，输入包名 `@idlercloud/dsh-git-bash` 即可安装，如需安装特定版本，可以输入 `@idlercloud/dsh-git-bash@0.3.1`。

其他情况下，把插件安装到目标 profile：

```bash
dsh plugin --profile <profile> add @idlercloud/dsh-git-bash
```

`<profile>` 是 profile 名称，例如 `web`。

升级到最新版本：

```bash
dsh plugin --profile <profile> add @idlercloud/dsh-git-bash@latest
```

卸载：

```bash
dsh plugin --profile <profile> remove @idlercloud/dsh-git-bash
```

---

## 配置

插件自带的 bundle patch 已插入 `git-bash-executor` 和 `git-bash-tool` 两行；只有需要覆盖默认配置时才写下面的 `config`。

```yaml
- id: git-bash-executor
  name: '@idlercloud/dsh-git-bash'
  config:
    bashPath: 'C:\Program Files\Git\bin\bash.exe'
```

| 项 | 说明 |
|---|---|
| `bashPath` | 显式指定 `bash.exe`，优先级最高；支持绝对路径、相对路径及裸名字。相对路径以插件挂载时 DSH 的当前目录为基准，裸名字会在 PATH 中查找 |
| `DSH_GIT_BASH` | 同上，走环境变量 |
| 其它字段 | 沿用上游 `dsh-bash-local` 的全部字段：`cwd`、`timeoutMs`、`maxOutputBytes` 等 |

**插件会自动寻找环境中可用的 Git Bash。** Git 的安装位置因人而异，插件会尝试按顺序找：

1. `config` 里的 `bashPath`，或环境变量 `DSH_GIT_BASH`
2. `GIT_INSTALL_ROOT`（Scoop 的 git 包会设）
3. PATH 中 `git.exe` 的每个命中反推安装根
4. 常见安装位置：`%ProgramFiles%\Git\bin`、`%ProgramFiles(x86)%`、`%ProgramW6432%`、`%LOCALAPPDATA%\Programs\Git\bin`、`%USERPROFILE%\scoop`

每个候选项都会检查其路径是否存在，存在且不是 WSL 启动器的第一个候选会被采用。`%SystemRoot%\System32\bash.exe` 是遗留的 WSL 启动器，`%LOCALAPPDATA%\Microsoft\WindowsApps\bash.exe` 是 WSL 的商店应用执行别名，两者都直接跳过。无合适候选项时报错，错误中列出尝试过的每条路径。

解析结果会缓存。缓存的文件不存在了，或者配置变了，就会重新解析。

---

## 开发

源码在 `src/`，`tsc` 编译到 `lib/`；`lib/` 是构建产物，不入库。

```bash
npm install
npm run build
npm test
npm run test:git-bash
```

`npm test` 会先构建，再运行单元测试和真实工具服务集成测试。集成测试通过真实 `ToolsService` 与工具执行流水线断言权限拦截与单次提权流程，无需安装 Git Bash 或启动 DSH；由于插件只在 Windows 执行该检查，该用例在非 Windows 平台明确跳过。

`npm run test:git-bash` 单独构建并运行 `test/harness.mjs`，需要 Windows 和可用的 Git Bash。它使用真实 cordis 与 dsh-bash-local 执行命令并断言检查结果，失败时返回非零退出码，不属于默认测试集，也不需要启动 DSH。

变更记录见 [CHANGELOG.md](https://github.com/idlercloud/dsh-git-bash/blob/main/CHANGELOG.md)。

---

## 许可

[MIT](LICENSE)
