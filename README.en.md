# Codex Plan Router

[简体中文](README.md) · **English**

**Route compatible Codex requests across multiple authorized ChatGPT accounts based on their available quota.** Keep your current Codex desktop login. The local proxy selects an account for each eligible request, and that account uses its own subscription quota.

[Download an installer](https://github.com/Vessalius/codex-plan-router/releases/latest) · [Quick start](#quick-start) · [Install by platform](#install-by-platform)

## How requests are routed

1. **Find eligible accounts.** Accounts must be authorized and verified. Paused accounts and accounts known to have exhausted either quota window are excluded from new requests.
2. **Compare remaining quota and reset times.** Both the 5-hour and weekly windows affect priority. If official data is incomplete or stale, routing uses recent observed usage and requests in progress.
3. **Preserve conversation ownership.** Requests with account-bound context normally stay with the original account. Some features unsupported by Sign in with ChatGPT fall back to the direct connection. If a request cannot be forwarded safely, the app reports an error. Once a response starts streaming, the proxy does not retry it with another account.

For example, account A has **80%** of its 5-hour quota and **10%** of its weekly quota left. Account B has **55%** and **65%**, respectively. With similar reset times and active request counts, a new unbound request goes to B because A is closer to its weekly limit. An existing conversation bound to A normally stays on A.

Each account uses its own quota. Desktop logins, cloud conversations, and quotas stay separate across accounts. Follow the [OpenAI Terms of Use](https://openai.com/policies/terms-of-use/) and [Sign in with ChatGPT documentation](https://developers.openai.com/siwc/token-sharing-open-source).

## Accounts and quota

- **Connect multiple accounts.** Add personal accounts through official Sign in with ChatGPT. Reauthorize or revoke each account separately.
- **View official quota.** See the remaining 5-hour and weekly quota and reset times for each account. Independent quota authorization keeps that account visible after you change the desktop login.
- **macOS menu bar.** See quota for A and B at a glance, and open **All accounts and quotas** for the rest. Native Settings can help you switch the desktop login, and the menu offers **Open at login**.

## Quick start

1. Download the installer for your system and open the app.
2. Select **Add account** and authorize on the official OpenAI page. Repeat for any other accounts you want to connect.
3. On macOS, select **Authorize quota** on each account card you want to monitor independently. `--` means data is unavailable. An asterisk marks a cached value.
4. To use routing, verify at least two accounts and select **Enable desktop proxy**. Each verification sends a short model request and uses some subscription quota. Enabling or disabling the proxy shows a Restart Codex prompt. Finish your tasks, then quit and reopen Codex to apply the change.

Subscription authorization is for model requests, and quota authorization is for reading usage. You can use quota monitoring with a direct Codex connection. To stop routing, choose **Restore direct connection**, finish running tasks, and reopen Codex.

## Interface languages

The app follows the system language on macOS and the browser language on Windows and Linux by default. On macOS, select **Language / 语言** in the menu bar, or change the language in Settings. On Windows and Linux, use the dashboard language selector. You can also follow the system or browser language. Your selection is saved locally. Set `CODEX_ROUTER_LANGUAGE=zh` for Chinese command-line output.

## Install by platform

| Platform | Architecture | Installation |
| --- | --- | --- |
| macOS 13 or later | Apple Silicon (arm64), Intel (x64) | Open the `.dmg` and drag the app into Applications. Open native Settings from the menu bar. |
| Windows | x64, ARM64 | Run `-setup.exe`, then open Codex Plan Router from the Start menu. |
| Linux (Debian / Ubuntu) | amd64, ARM64 | Run `sudo apt install ./installer.deb` with the downloaded filename. Open from the application menu or run `codex-plan-router launch`. |

All installers include Node.js. On macOS the built-in backend follows the app lifecycle. On Windows and Linux, use the application menu to stop the backend. Before uninstalling on Linux, run `codex-plan-router stop --restore-direct` if the desktop proxy is enabled.

For independent quota access on Windows and Linux, run `quota-native.mjs login <account-slot>` with the installed Node binary, then run `quota.mjs --all`. This requires the official Codex CLI. Set `CODEX_ROUTER_CODEX_BIN` to its executable path in the same terminal if necessary. Python 3.11 or later is needed to edit the Codex desktop proxy configuration. Windows uses `py -3` by default. Set `CODEX_ROUTER_PYTHON` to override the executable.

The Windows installer is unsigned and the macOS app is not notarized. Download hashes are available in `SHA256SUMS.txt` on the Release page.

## Local data

The settings page and proxy listen only on loopback. Account credentials stay in your user data directory. Quota caches contain no tokens. Keep the data directory and `state.json` private.

- macOS: `~/Library/Application Support/Codex Plan Router`
- Windows: `%LOCALAPPDATA%\Codex Plan Router`
- Linux: `${XDG_STATE_HOME:-~/.local/state}/codex-plan-router`

## Run and build from source

Requires Node.js 24. Changing desktop settings also requires Python 3.11 or later. There are no npm runtime dependencies.

```sh
node cli.mjs serve
```

Run `node cli.mjs dashboard` in a separate terminal. Run `npm test` for tests with temporary directories, loopback, and mocked upstreams.

Build with `python3 scripts/package_release.py <macos|windows|linux> <x64|arm64>`. Installers are written to `dist/`. Builds require Xcode on macOS, NSIS on Windows, or dpkg-deb on Linux. GitHub Actions builds and checks installers on the target platforms when a version tag is pushed. Packaging checks use an empty account directory and an offline backend.

## License

This independent open-source project is distributed under the [MIT License](LICENSE). Bundled Node.js is distributed under its included license.
