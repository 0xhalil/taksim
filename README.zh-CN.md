<p align="center"><img src="native/Resources/AppIcon.png" width="128" alt="taksim"></p>

<h1 align="center">taksim</h1>

<p align="center">一块实时画布，让编程智能体直接用上你已有的订阅。</p>

<p align="center">
  <a href="https://github.com/0xhalil/taksim/releases/latest"><img alt="最新版本" src="https://img.shields.io/github/v/release/0xhalil/taksim?style=flat-square&color=3574F0"></a>
  <a href="https://github.com/0xhalil/taksim/actions/workflows/test.yml"><img alt="测试" src="https://img.shields.io/github/actions/workflow/status/0xhalil/taksim/test.yml?branch=main&style=flat-square&label=tests"></a>
  <a href="LICENSE"><img alt="许可证：PolyForm Shield" src="https://img.shields.io/badge/license-PolyForm%20Shield-3574F0?style=flat-square"></a>
  <img alt="macOS、Windows 和 Linux" src="https://img.shields.io/badge/runs%20on-macOS%20%C2%B7%20Windows%20%C2%B7%20Linux-1E1F22?style=flat-square">
</p>

<p align="center">
  <a href="https://taksim.dev">官网</a> ·
  <a href="https://taksim.dev/download/">下载</a> ·
  <a href="https://github.com/0xhalil/taksim/releases">版本发布</a> ·
  <a href="docs/">文档</a> ·
  <a href="CONTRIBUTING.md">参与贡献</a> ·
  <a href="SECURITY.md">安全</a>
</p>

<p align="center"><a href="README.md">English</a> · <b>简体中文</b></p>

---

taksim 是一款适用于 macOS、Windows 和 Linux 的应用，它把你已经登录的智能体 CLI——**Claude Code、Codex、Gemini CLI、opencode 和
GitHub Copilot**——变成画布上的一张张卡片。你可以和其中任何一个对话；它们之间会互相提问、移交工作、创建帮手，
还会搭建小型的实时工具，这一切都发生在你看得见的地方。无需 API key：每个智能体都使用你自己的账号，
在你自己的电脑上运行，引擎只监听 `127.0.0.1`。

## 安装

| | |
|---|---|
| **Homebrew** | `brew install --cask 0xhalil/taksim/taksim` |
| **磁盘映像（DMG）** | 从[版本发布页](https://github.com/0xhalil/taksim/releases/latest)下载 `Taksim-<version>-arm64.dmg`，拖入“应用程序” |
| **ZIP** | 同一页面上的 `Taksim-<version>.zip` |
| **Windows** | `Taksim-<version>-Setup.exe`（x64 与 Arm），仅为当前用户安装，无需管理员权限 |
| **Linux** | `Taksim-<version>-<arch>.AppImage`，或 Debian/Ubuntu 的 `.deb`（x64 与 arm64） |

也可以在 [taksim.dev/download](https://taksim.dev/download/) 获取适合你电脑的文件。应用之后会自动更新，
每个文件旁边都有对应的 `.sha256` 校验文件。Mac 版是原生应用，使用 Developer ID 签名并经过 Apple 公证。
Windows 和 Linux 版自带引擎和 Node，无需另外安装；Windows 安装程序暂未签名，SmartScreen 会询问一次
（更多信息 › 仍要运行）。

需要 **macOS 15 或更高版本（Apple 芯片）、Windows 10 或更高版本，或 glibc 2.28 及以上的 Linux**，以及至少一个
智能体 CLI（见[支持的 CLI](#支持的-cli)）。

## 快速上手

1. **打开 taksim。** 欢迎界面会帮你登录各个智能体 CLI。
2. **添加智能体**（`+ Agent`），在它的卡片里直接对话。
3. **打开“创建智能体”。** 交给它一项更大的任务，它会组建团队：它创建的智能体会出现在它旁边并带一条箭头，
   智能体之间的消息沿虚线传递。
4. **想用原生 CLI 时，打开卡片的终端**：同一个会话，斜杠命令照常可用。

## 支持的 CLI

[Claude Code](https://docs.anthropic.com/en/docs/claude-code) · [Codex](https://github.com/openai/codex) ·
[Gemini CLI](https://github.com/google-gemini/gemini-cli) · [opencode](https://opencode.ai) ·
[GitHub Copilot CLI](https://github.com/github/copilot-cli)

每个 CLI 都使用你自己的登录账号。taksim 覆盖了各家哪些原生功能、还有哪些没做，公开记录在
[docs/provider-support.md](docs/provider-support.md)（英文）。

## 功能

- **画布。** 每个智能体是一张卡片：显示它所用 CLI 的标志、名称和正在做的事。可以拖动、从任意一角调整大小，
  双击标题栏把卡片折叠成一条。智能体创建的智能体会带着箭头出现在它旁边；智能体之间的消息沿虚线传递。
  多个标签页对应多个独立画布。
- **卡片内聊天。** Agent、Ask 和 Plan 三种模式，用 `@` 引用文件、文件夹、选中内容和历史对话，工作时仍可编辑的排队队列，
  每一轮之前自动建立检查点，按轮次查看改动差异，一键撤销。
- **CLI 本身。** 打开卡片的终端，进入的就是真正的 Claude Code 或 Codex TUI：同一个会话，斜杠命令照常可用。
  关掉终端后，智能体在后台继续工作。
- **智能体协作。** 通过 taksim 的 MCP 服务器，每个智能体都可以使用 `list_agents`、`ask_agent`、`tell_agent` 和
  `create_agent`，跨 CLI、跨你的各个账号。死锁会被拒绝，层级深度和数量都有上限。
- **面板。** 智能体可以用现成的组件——表格、日志、统计、图表——在自己的卡片旁搭建实时面板，数据来自命令、文件、
  URL 或它自己的数据。命令和对外读取只有在你批准之后才会执行；存放凭据的文件永远不会被读取。好用的面板可以存成工具并分享。
- **每个智能体一个 IDE。** 类似 PyCharm 的停靠面板，显示该智能体的文件夹：项目树、编辑器、支持提交和推送的 Git、
  搜索、终端、运行，以及智能体可以读取的 Python 调试器。
- **浏览器。** 智能体拥有 `browser_*` 工具：打开页面、把页面读成控件列表、点击、悬停、拖拽、输入、选择、上传、
  应对对话框、在 iframe 内和多个标签页之间操作，还能查看截图。它是 taksim 专用配置文件下的一个可见 Chrome 窗口，
  所以你能亲眼看到它们在做什么。
- **分组。** 画布上的分组框与框内的智能体共享一份笔记（目标、决定、规则）。
- **账号。** 同一个 CLI 的多个登录并排使用（工作账号和个人账号），各自拥有独立的配置目录，
  顶部栏显示每个登录的套餐用量。

## 工作原理

```
 taksim.app  ──  原生 macOS 界面（Swift、SwiftUI、AppKit）
     │  HTTP + SSE + WebSocket，仅限 127.0.0.1
     ▼
   engine    ──  Node 服务器：画布、智能体、面板、IDE、浏览器、账号、MCP 工具
     │  启动并与之通信
     ▼
 claude · codex · gemini · opencode · copilot     （你自己的登录，在你自己的电脑上）
```

应用是唯一的界面；引擎是它的服务器，同时把你的订阅暴露为兼容 OpenAI 和 Anthropic 的 API（见下文）。
智能体之间以及与画布的交互都通过 taksim 的 MCP 服务器完成。

## 文档

文档目前只有英文。

| | |
|---|---|
| [卡片内聊天](docs/chat.md) | 模式、队列、检查点、按轮次差异与撤销 |
| [面板](docs/panels.md) | 智能体用组件搭建自己的工具 |
| [各家支持情况](docs/provider-support.md) | 每个 CLI 能做什么，taksim 覆盖了多少 |
| [设计语言](docs/design-language.md) | 界面应有的外观与行为 |
| [发布流程](docs/releasing.md) | 版本如何签名、公证和发布 |
| [编排值得吗？](eval/README.md) | 用实测比较“创建智能体”与单个智能体 |

## 从源码构建

```bash
git clone https://github.com/0xhalil/taksim && cd taksim
npm install                    # 引擎的依赖（Node 20+）
native/scripts/build-app.sh    # 构建 native/build/Taksim.app
open native/build/Taksim.app
```

应用会从构建它的这份代码目录启动引擎（`bin/taksim.mjs serve`），或者连接已在 8787 端口运行的引擎。
构建应用需要带 Swift 6 的 Xcode 命令行工具。

| | |
|---|---|
| `npm test` | 引擎测试（`node:test`，使用模拟 CLI 后端，不需要订阅） |
| `cd native && swift test` | 应用测试 |
| `npm start` | 单独启动引擎，地址 `http://127.0.0.1:8787` |
| `TAKSIM_URL=http://127.0.0.1:8790 native/build/Taksim.app/Contents/MacOS/Taksim` | 让应用连接另一个引擎 |
| `TAKSIM_FAKE=1 npm start` | 带确定性测试智能体的引擎 |

## 引擎与 API

<details>
<summary>接口、请求头和环境变量</summary>

引擎是一个 Node 服务器；应用是它唯一的界面。它同时把你的订阅暴露为兼容 OpenAI 和 Anthropic 的 API，
由模型名称决定使用哪个 CLI：

```bash
curl -s 127.0.0.1:8787/v1/chat/completions -H 'content-type: application/json' \
  -d '{"model":"sonnet","messages":[{"role":"user","content":"Hello"}]}'
```

| 接口 | |
|---|---|
| `POST /v1/chat/completions` | OpenAI 格式，支持流式 |
| `POST /v1/messages` | Anthropic 格式，支持流式 |
| `GET /v1/models`、`GET /health` | 已安装 CLI 的模型；健康检查 |
| `/v1/canvases/…` | 画布、智能体、消息、面板、IDE、分组（见 `src/routes/`） |
| `/v1/accounts/…`、`/v1/usage` | 登录账号与套餐用量 |

通过请求头可以让请求进入智能体模式：`x-agent-cwd: /path/to/project` 让 CLI 在该目录读取、写入并运行命令；
`x-agent-session`、`x-agent-effort`、`x-agent-permission`（Claude）和 `x-agent-sandbox`（Codex、opencode）用于微调。
除非设置 `TAKSIM_ALLOW_DANGEROUS=1`，否则 `bypassPermissions` 和 `danger-full-access` 会被拒绝。

| 变量 | 默认值 |
|---|---|
| `TAKSIM_PORT`、`TAKSIM_HOST` | `8787`、`127.0.0.1` |
| `TAKSIM_TOKEN` | 无；设置后，请求必须以 `Authorization: Bearer` 或 `x-api-key` 携带它 |
| `TAKSIM_HOME` | `~/.taksim`（画布、账号、浏览器配置文件） |
| `TAKSIM_TIMEOUT_MS` | 30 分钟 |
| `TAKSIM_<CLI>_CONCURRENCY`、`TAKSIM_<CLI>_MODEL`、`TAKSIM_<CLI>_BIN` | 按 CLI 分别设置 |

</details>

## 安全

- 引擎只监听 `127.0.0.1`。要监听其他地址，需要同时设置 `TAKSIM_ALLOW_REMOTE=1` 和 `TAKSIM_TOKEN`，并且会关闭终端功能。
- 带有外来 `Host` 或来自其他站点的浏览器 `Origin` 的请求会被拒绝，网页无法驱动你的智能体。
  终端 WebSocket 只接受本地应用的连接。
- 面板和 IDE 只能在智能体的文件夹内活动；`~/.ssh`、`~/.aws` 等凭据存放位置永远不会被读取。
- 每个订阅都只属于你自己：taksim 不是与他人共享账号的工具。

如需报告漏洞，请见 [SECURITY.md](SECURITY.md)。

## 目录结构

```
native/          macOS 应用（Swift、SwiftUI、AppKit）；Sources/TaksimKit 是可测试的核心
src/             引擎：服务器、CLI 后端、画布与智能体、MCP 工具、面板、IDE、浏览器、账号
ui/              应用在 Web 视图中显示的 IDE 页面（IDE 原生化之前）
toolbox/         智能体可以用来启动面板的内置工具
test/            引擎测试
docs/            设计语言与功能说明
site/            官网
eval/            衡量智能体编排在真实任务上是否值得
```

欢迎参与贡献，请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

[PolyForm Shield 1.0.0](LICENSE)：无论在家还是在公司，都可以自由使用、修改和分享 taksim。
不得出售它，也不得提供与之竞争的产品。`native/Vendor` 和 `ui/vendor` 下的第三方代码沿用各自的许可证。
