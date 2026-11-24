# Codex Plan Router

在一台电脑上管理多个 ChatGPT 账号，查看每个账号的 Codex 剩余额度。需要时，可以让本地代理根据已授权账号的额度，为兼容的 Codex 请求选择账号。即使只想看额度，也可以保持 Codex 官方直连。

[下载安装包](https://github.com/Vessalius/codex-plan-router/releases/latest) · [上手指南](#上手指南) · [请求怎么分配](#请求怎么分配)

## 主要功能

| 功能 | 能做什么 |
| --- | --- |
| 管理多个账号 | 通过 OpenAI 官方 **Sign in with ChatGPT** 添加 A、B、C 等个人账号。每个账号独立授权，可单独重新授权或撤销。 |
| 查看各账号额度 | 查看官方提供的 **五小时剩余、每周剩余和重置时间**。为账号完成独立额度授权后，即使 Codex 桌面端改登另一个账号，也能继续查看该账号。 |
| 按额度分配请求 | 启用本地代理后，兼容且未绑定账号的 Codex 请求可以分配给已通过验证的账号。优先参考官方剩余额度和重置时间。 |
| 辅助切换桌面登录 | macOS 设置里可选目标账号并打开 Codex。你在 Codex 完成登录后，工具核对本机账号并更新统计主号。 |
| macOS 菜单栏 | 顶部直接显示 A、B 的额度。更多账号可以在「全部账号与额度」或原生设置里查看。需要时可勾选「登录时启动」。 |

## 上手指南

1. 从 [GitHub Releases](https://github.com/Vessalius/codex-plan-router/releases/latest) 下载对应平台的安装文件，安装并打开设置。
2. 点击 **「添加账号」**，在 OpenAI 官方页面登录并授权。添加第二个或更多账号时，重复这一步。
3. 在 macOS 中，从账号卡片点 **「授权额度查询」**，给需要长期查看额度的账号分别完成授权。额度未取到时显示 `--`，带星号的是上次查询值。
4. 如需使用代理，将至少两个账号分别点 **「验证订阅」**，再点 **「启用桌面代理」**。每次验证会发送一条真实模型请求。等当前任务结束后重新打开 Codex，桌面连接配置才会生效。

订阅授权用于模型请求，额度查询授权用于读取官方用量，两项各自管理。只看额度时，可以完成前 3 步并继续使用官方直连。

### 请求怎么分配

- **可分配的新请求**优先比较各可用账号的官方五小时和每周剩余，以及各自的重置时间。官方数据缺失或过旧时，参考工具观察到的近期用量。
- **已有上下文的请求**通常沿用原账号。SIWC 支持的模型和工具范围与桌面客户端不同，部分请求会回到官方直连通道，无法安全转发的请求会报错。响应开始后，代理不会自动换账号重发。
- **恢复官方直连**可在设置里完成。这个操作只移除工具写入的代理配置，等当前任务结束后重新打开 Codex 即可生效。

每个账号仍使用自己的订阅额度。桌面登录、云会话和订阅额度不会在账号之间同步。请遵守 [OpenAI 使用条款](https://openai.com/policies/terms-of-use/) 和 [SIWC 接入说明](https://developers.openai.com/siwc/token-sharing-open-source)。

## 各平台安装

| 平台 | 架构 | 安装与启动 |
| --- | --- | --- |
| macOS 13 或更新 | Apple Silicon（arm64）、Intel（x64） | 打开 `.dmg`，把 App 拖进「应用程序」。从菜单栏打开原生设置。 |
| Windows | x64、ARM64 | 运行 `-setup.exe`，从开始菜单打开 Codex Plan Router 的本机设置页。 |
| Linux（Debian / Ubuntu） | amd64、ARM64 | 用 `sudo apt install ./文件名.deb` 安装，从应用菜单打开本机设置页，或运行 `codex-plan-router launch`。 |

安装包附带 Node.js。macOS 内置后台随 App 启停；Windows 和 Linux 可从应用菜单停止后台。在 Linux 卸载前，如已启用桌面代理，先运行 `codex-plan-router stop --restore-direct`，再用系统包管理器卸载。

Windows 和 Linux 的独立额度授权可用安装目录的 Node 执行 `quota-native.mjs login <账号编号>`，用 `quota.mjs --all` 查看查询结果。独立查询需要官方 Codex CLI。CLI 不在默认路径时，可以在同一终端将 `CODEX_ROUTER_CODEX_BIN` 指向其可执行文件。修改桌面代理配置需要 Python 3.11 或更新版本，Windows 默认使用 `py -3`，也可用 `CODEX_ROUTER_PYTHON` 指向 Python。

Windows 安装包未做发行者签名，macOS App 未做 Apple 公证。可用 Release 中的 `SHA256SUMS.txt` 校验下载。

## 本机数据

工具仅在本机回环端口提供设置和代理服务。授权保存在当前用户的数据目录，额度缓存不含令牌。请勿分享数据目录或 `state.json`。

- macOS 使用 `~/Library/Application Support/Codex Plan Router`。
- Windows 使用 `%LOCALAPPDATA%\Codex Plan Router`。
- Linux 使用 `${XDG_STATE_HOME:-~/.local/state}/codex-plan-router`。

## 从源码运行和构建

需要 Node.js 24，修改桌面配置需要 Python 3.11 或更新版本。无 npm 运行时依赖。

```sh
node cli.mjs serve
```

另开终端运行 `node cli.mjs dashboard`。运行测试用 `npm test`，测试使用临时目录、回环接口与模拟上游。

打包命令为 `python3 scripts/package_release.py <macos|windows|linux> <x64|arm64>`，输出目录为 `dist/`。macOS 构建需要 Xcode，Windows 需要 NSIS，Linux 需要 dpkg-deb。GitHub Actions 由版本标签触发，在相应系统验证安装文件后发布。构建验证使用空账号目录和离线后台，不调用 OpenAI。

## 许可证

这是独立开源项目，采用 [MIT 许可证](LICENSE)。包内的 Node.js 运行时使用其附带的许可。
