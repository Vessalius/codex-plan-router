# Codex Plan Router

本机运行的 Codex 账号管理与额度查看工具。使用官方 Sign in with ChatGPT（SIWC）连接个人账号，可以添加 A、B、C 等多个账号，各自授权和查看额度。桌面登录切换由用户在 Codex 中完成。

这是独立开源项目。OpenAI 未参与维护或签署发行包。订阅授权、模型能力和用量均由 OpenAI 服务决定。请遵守 [OpenAI 使用条款](https://openai.com/policies/terms-of-use/) 和 [SIWC 接入文档](https://developers.openai.com/siwc/token-sharing-open-source)。

## 下载和启动

Release 提供以下架构。所有便携包附带 Node.js 运行时及其许可文件。

| 平台 | 架构 | 发行包与启动方法 |
| --- | --- | --- |
| macOS 13 或更新 | Apple Silicon（arm64）、Intel（x64） | ZIP。解压后运行 `Install.command`，从菜单栏进入原生设置 |
| Windows | x64、arm64 | ZIP。运行 `Start.cmd` 启动，再运行 `Settings.cmd` 打开本机设置页 |
| Linux | x64、arm64 | TAR.GZ。运行 `./router serve`，在另一终端运行 `./router dashboard` 打开本机设置页 |

macOS 安装及修改桌面代理配置需要 Python 3.11 或更新版本。Windows 使用 Python Launcher（`py -3`）。若 Python 不在默认位置，可将 `CODEX_ROUTER_PYTHON` 指向 Python 可执行文件。有图形界面的 Linux 需要 `xdg-open`。

macOS 包采用临时签名，未公证。可以从源码构建，或在核对发行包的 SHA-256 后按 macOS 的提示授权打开。Windows 和 Linux 便携版目前没有原生托盘，也不会自动设为开机运行。

## 账号与额度

1. 在设置中添加账号，并在 OpenAI 官方页面完成授权。
2. macOS 在账号卡片上点「授权额度查询」以独立查看五小时及每周额度。在其他平台，从解压目录用自带的 Node 运行 `quota-native.mjs login <账号编号>`，然后运行 `quota.mjs --all` 查看数据。
3. 独立额度查询需要官方 Codex CLI。Windows 需让 `codex.exe` 可用，Linux 需让 `codex` 可用。若 CLI 不在 PATH 或 macOS 客户端装在自定义目录，把 `CODEX_ROUTER_CODEX_BIN` 设为其可执行文件路径后从同一环境运行命令。

工具的凭证保存在当前用户的数据目录。macOS 使用 `~/Library/Application Support/Codex Plan Router`，Windows 使用 `%LOCALAPPDATA%\Codex Plan Router`，Linux 使用 `${XDG_STATE_HOME:-~/.local/state}/codex-plan-router`。请勿分享运行目录或 `state.json`。额度缓存不包含令牌。

桌面代理属于可选功能。账号验证会发送一条真实模型请求。启用后，兼容的请求按官方额度和重置时间调度。SIWC 对部分桌面工具及上下文有兼容限制。设置中的「恢复官方直连」会撤销工具写入的配置。修改连接方式后等任务结束再重新打开 Codex。

## 从源码运行

需要 Node.js 24、Python 3.11 或更新版本。无 npm 运行时依赖。

```sh
node cli.mjs serve
```

另开终端执行 `node cli.mjs dashboard`。运行测试用 `npm test`，测试只使用临时目录、回环接口与模拟上游。

打包命令为 `python3 scripts/package_release.py <macos|windows|linux> <x64|arm64>`，输出目录为 `dist/`。macOS 构建需要 Xcode。GitHub Actions 在版本标签触发时构建发行包并附上校验文件。

## 许可证

项目源码采用 MIT 许可证。包内的 Node.js 运行时使用其附带的许可。
