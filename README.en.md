# @idlercloud/dsh-git-bash

Make DSH prefer Git Bash on Windows.

<p align="center">
  <b>English</b> · <a href="README.md">中文</a>
</p>

<p align="center">
  <img alt="platform" src="https://img.shields.io/badge/platform-Windows-0078D6?style=flat-square">
  <img alt="harness" src="https://img.shields.io/badge/DSH-plugin-4B6BFB?style=flat-square">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-3DA639?style=flat-square">
</p>

This repository is a fork of [`Fishquito7/dsh-gitbash`](https://github.com/Fishquito7/dsh-gitbash) v0.1.3.

---

## Why

Existing models' Bash training corpora are generally far larger than those for PowerShell, so their ability with Bash is also far stronger than with PowerShell. PowerShell itself is hardly well designed either, and even top models often end up wrestling with it.

**On Windows, DSH hard-wires the shell to PowerShell only.** There is no bash tool in the tool list at all, even though Git Bash is actually available (which is exactly what Claude Code does on Windows).

---

## How it works

Reuse the official bash tool: mount it into a separate isolation scope, then attach the Git Bash executor. A system prompt requires the model to prefer Bash.

The benefit is a simple implementation and stable behavior: timeouts, argument validation, output truncation and spill files, PTC support and other logic all reuse the official bash tool.

In addition, the existing pwsh tool is still kept, because cases such as the registry, services, process handles and native Windows paths are obviously better handled with PowerShell.

## Limitations

Currently verified only with DSH `0.2.2-rc.1`. Both the compatibility declaration and DSH peer dependencies are restricted to that version. Revalidate the plugin before upgrading DSH.

**It does not go through a file sandbox, so it runs only under full access.**

Git Bash is an MSYS2 process. Under the Windows restricted token it needs fork, pipes and a private temp directory, and behaves unreliably, so this plugin has no usable sandbox backend. The plugin checks the file policy before invoking the tool and refuses non-full-access calls outright.

## Non-goals

- Providing a separate bash tool: that would mean copying the official code and rewriting a lot of logic such as timeouts and argument validation.
- Disabling the pwsh tool: there are still many cases where using PowerShell is simpler.
- Capabilities beyond Bash: this plugin deliberately stays simple and auditable; other features should live in a separate plugin.

---

## Install, upgrade, and uninstall

**Not available yet.** This fork has not been publicly released and has not been published to npm; install, upgrade and uninstall commands will be added here after release.

---

## Configuration

```yaml
- id: git-bash-executor
  name: '@idlercloud/dsh-git-bash'
  config:
    bashPath: 'C:\Program Files\Git\bin\bash.exe'
```

| Item | Meaning |
|---|---|
| `bashPath` | Explicitly specifies `bash.exe`; highest priority. Accepts absolute paths, relative paths, and bare names. Relative paths are resolved against the DSH working directory when the plugin mounts; bare names are looked up on `PATH` |
| `DSH_GIT_BASH` | Same as above, via the environment variable |
| Other fields | All upstream `dsh-bash-local` fields are accepted: `cwd`, `timeoutMs`, `maxOutputBytes`, etc. |

**The plugin looks for an available Git Bash automatically.** Git's install location varies from machine to machine, so the plugin tries, in order:

1. `bashPath` in `config`, or the `DSH_GIT_BASH` environment variable
2. `GIT_INSTALL_ROOT` (set by Scoop's git package)
3. `InstallPath` under `SOFTWARE\GitForWindows`, checking `HKCU`, `HKLM`, then `HKLM\SOFTWARE\WOW6432Node`
4. well-known locations: `%ProgramFiles%\Git\bin`, `%ProgramFiles(x86)%`, `%ProgramW6432%`, `%LOCALAPPDATA%\Programs\Git\bin`, `%USERPROFILE%\scoop`, Chocolatey
5. the install root inferred from each `git.exe` found on PATH

Each candidate is checked for existence; the first existing candidate that is not a WSL launcher is used. `%SystemRoot%\System32\bash.exe` is the legacy WSL launcher and `%LOCALAPPDATA%\Microsoft\WindowsApps\bash.exe` is the Store app execution alias for WSL; both are skipped outright. If no candidate fits, the plugin reports an error listing every path it tried.

The resolved result is cached. When the cached file no longer exists, or the configuration changes, the plugin resolves again.

---

## Development

Sources live in `src/`; `tsc` compiles them to `lib/`, which is a build artifact and is not committed.

```bash
npm install
npm run build
npm test
npm run test:git-bash
```

`npm test` builds and runs unit tests plus a real tool-service integration test. The integration test asserts permission enforcement through the real `ToolsService` and execution pipeline, without Git Bash or a running DSH instance. It explicitly skips non-Windows platforms because the plugin only registers its guard on Windows.

`npm run test:git-bash` separately builds and runs `test/harness.mjs`, requiring Windows and an available Git Bash installation. It executes commands through real cordis and dsh-bash-local and asserts the results, returning a nonzero exit code on failure. It is excluded from the default test suite and does not require starting DSH.

---

## License

[MIT](LICENSE)
