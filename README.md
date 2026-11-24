# Codex Plan Router

本机运行的 Codex 账号管理与额度查看工具。使用官方 Sign in with ChatGPT（SIWC）连接个人账号，可以添加 A、B、C 等多个账号，各自授权和查看额度。桌面登录切换由用户在 Codex 中完成。

这是独立开源项目。OpenAI 未参与维护或签署发行包。订阅授权、模型能力和用量均由 OpenAI 服务决定。请遵守 [OpenAI 使用条款](https://openai.com/policies/terms-of-use/) 和 [SIWC 接入文档](https://developers.openai.com/siwc/token-sharing-open-source)。

## 下载和启动

在 GitHub Releases 选择与你的系统和 CPU 架构相符的安装文件。所有安装包附带 Node.js 及其许可。

| 平台 | 架构 | 安装与启动 |
| --- | --- | --- |
| macOS 13 或更新 | Apple Silicon（arm64）、Intel（x64） | 打开 `.dmg`，把 App 拖进「应用程序」。从菜单栏打开原生设置 |
| Windows | x64、arm64 | 运行 `-setup.exe`，从开始菜单打开 Codex Plan Router |
| Linux（Debian / Ubuntu） | amd64、arm64 | 运行 `sudo apt install ./codex-plan-router-*.deb`，从应用菜单打开，或运行 `codex-plan-router launch` |

macOS App 自带后台，状态栏菜单可选「登录时启动」。Windows、Linux 使用本机设置页。需要停止后台时，可用开始菜单或应用菜单中的停止入口。Linux 卸载前，如已启用桌面代理，可用 `codex-plan-router stop --restore-direct` 恢复桌面配置，再用系统包管理器卸载。

Windows 和 macOS 安装包未做发行者签名或 Apple 公证。下载后可用 Release 中的 `SHA256SUMS.txt` 校验。配置桌面代理需要 Python 3.11 或更新版本。Windows 默认使用 Python Launcher（`py -3`），也可将 `CODEX_ROUTER_PYTHON` 指向 Python 可执行文件。

## 账号与额度

1. 在设置中添加账号，并在 OpenAI 官方页面完成授权。
2. macOS 在账号卡片上点「授权额度查询」以独立查看五小时及每周额度。在其他平台，可用安装目录中的 Node 运行 `quota-native.mjs login <账号编号>`，然后运行 `quota.mjs --all` 查看数据。
3. 独立额度查询需要官方 Codex CLI。Windows 需让 `codex.exe` 可用，Linux 需让 `codex` 可用。若 CLI 不在 PATH 或 macOS 客户端装在自定义目录，把 `CODEX_ROUTER_CODEX_BIN` 设为其可执行文件路径后从同一环境运行命令。

工具的凭证保存在当前用户的数据目录。macOS 使用 `~/Library/Application Support/Codex Plan Router`，Windows 使用 `%LOCALAPPDATA%\Codex Plan Router`，Linux 使用 `${XDG_STATE_HOME:-~/.local/state}/codex-plan-router`。请勿分享运行目录或 `state.json`。额度缓存不包含令牌。

桌面代理属于可选功能。账号验证会发送一条真实模型请求。启用后，兼容的请求按官方额度和重置时间调度。SIWC 对部分桌面工具及上下文有兼容限制。设置中的「恢复官方直连」会撤销工具写入的配置。修改连接方式后等任务结束再重新打开 Codex。

## 从源码运行

需要 Node.js 24、Python 3.11 或更新版本。无 npm 运行时依赖。

```sh
node cli.mjs serve
```

另开终端执行 `node cli.mjs dashboard`。运行测试用 `npm test`，测试只使用临时目录、回环接口与模拟上游。

打包命令为 `python3 scripts/package_release.py <macos|windows|linux> <x64|arm64>`，输出目录为 `dist/`。macOS 构建需要 Xcode，Windows 构建需要 NSIS，Linux 构建需要 dpkg-deb。GitHub Actions 由版本标签触发，在相应系统验证安装文件，生成 SHA-256 清单并发布。验证使用空账号目录和离线后台，禁止访问 OpenAI 上游。

## 许可证

项目源码采用 MIT 许可证。包内的 Node.js 运行时使用其附带的许可。
