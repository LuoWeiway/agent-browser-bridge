# Agent Browser Bridge 🌐

> 仿照 **OpenAI Codex** 浏览器控制机制设计，基于 Chrome Manifest V3 扩展与本地 WebSocket/HTTP 守护进程桥接。  
> 让本地终端 CLI 与 **Claude Code (MCP)** 大模型能够**直接控制并读取您当前日常使用的真实 Chrome 浏览器**。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey.svg)]()
[![MCP Compatible](https://img.shields.io/badge/MCP-Compatible-success.svg)]()

---

## 🌟 为什么选择 Agent Browser Bridge？

传统自动化工具（如原生 Puppeteer、Playwright 或 `--remote-debugging-port=9222`）在日常 AI 协作中有三大硬伤：
1. **丢失登录态**：每次冷启动都是全新的无痕/隔离环境，无法访问公司内网、Jira、Confluence、各类业务后台与看板等已登录系统。
2. **强制重启浏览器**：必须先关掉所有正在运行的 Chrome 窗口，严重打断工作流。
3. **抢夺焦点与页面覆盖**：传统脚本一旦跳转页面，会直接把用户当前正在阅读或输入的屏幕视窗覆盖抢占。

### ✨ 本项目的核心突破与设计哲学：
- 🟢 **100% 保持真实登录态**：扩展直接寄宿在您日常使用的 Chrome 中，所有 Session、Cookie、内网权限完美保留。
- 🟢 **标签任务分组隔离 (Tab Groups)**：采用与 Codex 一致的设计，所有 Agent 打开的新页面自动归纳进专属的 **`[Agent 任务]`** 分组，并在后台静默加载（`active: false`），**绝对不抢夺焦点、绝对不覆盖您当前操作的页面**。
- 🟢 **深度 DOM 与跨域 Iframe 穿透**：针对复杂单页及多层嵌套子框架系统（SPA / Iframe 架构），使用 `allFrames: true` 递归提取页面大纲、数据表格（自动转为 Markdown 表格）、输入控件与按钮。
- 🟢 **双模交互支持**：既支持在终端通过 CLI 命令行调用，又作为标准 **MCP Server** 挂载至 Claude Code。
- 🟢 **零第三方依赖 (Zero-Dependency)**：纯原生 Node.js 实现，无需运行庞大的 `npm install`，开箱即用。

---

## 🏗️ 架构图解

```text
┌──────────────────────────────────────────────────────────────┐
│  AI 交互层 (Claude Code MCP)      │  终端交互层 (Shell / 脚本)  │
│  Tools: browser_read 等          │  CLI: node server.js read  │
└──────────────┬───────────────────┴──────────────┬────────────┘
               │ (stdio MCP Protocol)             │ (Child process / HTTP)
               └───────────────────┬──────────────┘
                                   ▼
┌──────────────────────────────────────────────────────────────┐
│  本地 Bridge 核心守护服务 (server.js 监听 127.0.0.1:18888)     │
│  - 纯原生 Node.js（零第三方依赖）                             │
│  - 自动后台拉起（Auto-spawn，无需手动开窗口常驻启动）          │
└──────────────────────────────────▲───────────────────────────┘
                                   │ (WebSocket 双向通道 + Offscreen 防休眠)
┌──────────────────────────────────▼───────────────────────────┐
│  Chrome MV3 扩展 (extension/ 目录)                           │
│  - 标签任务分组 (Tab Groups) 隔离管理                        │
│  - 智能多窗口模糊检索打分 (URL/标题/分词匹配)                 │
│  - 深度穿透：递归抽取主窗口及所有子 iframe                   │
│  - 真实交互驱动：click(支持CSS/文本)、fill(事件派发)、截图等    │
└──────────────────────────────────▲───────────────────────────┘
                                   │ (寄宿在用户常用 Chrome 中)
┌──────────────────────────────────▼───────────────────────────┐
│  用户当前 Chrome 实例 (已登录各种系统，保留全部 Cookie 与状态)   │
└──────────────────────────────────────────────────────────────┘
```

---

## 🚀 极简安装指南（2 步完成）

### 第一步：在 Chrome 中加载扩展

1. 打开 Google Chrome，访问：
   ```text
   chrome://extensions
   ```
2. 开启右上角的 **「开发者模式」** 开关。
3. 点击左上角 **「加载已解压的扩展程序」**。
4. 选择克隆到本地的 `extension` 文件夹（例如：`/path/to/agent-browser-bridge/extension`）。
5. Chrome 工具栏将出现 `Agent Browser Bridge` 扩展图标。

---

### 第二步：将 MCP Server 挂载至 Claude Code（可选，开箱即用）

在终端中执行以下命令（将路径替换为您本地的 `mcp.js` 绝对路径）：

```bash
claude mcp add --scope user agent-browser-bridge node "/path/to/agent-browser-bridge/mcp.js"
```

> 命令会自动将 `agent-browser-bridge` 注册进 `~/.claude.json`。后续每次打开 Claude Code 都会自动建立连接。

---

## 💻 命令行 (CLI) 使用指南

进入项目目录后，服务在首次调用时会**自动后台静默拉起**，无需手动启动：

```bash
# 1. 列出当前所有打开的标签页（包含 Tab ID、激活状态与 URL）
node server.js list

# 2. 智能模糊匹配并提取页面内容（支持 URL 关键词或中文标题，输出结构化 Markdown）
node server.js read "Jira"
node server.js read "prd"              # 匹配原型系统
node server.js read "Jenkins"          # 匹配自动化构建页
node server.js read ""                 # 默认读取当前正激活的页面

# 3. 在专属「Agent 任务」分组中打开或跳转页面（后台静默打开，不干扰当前视窗）
node server.js open "https://github.com/trending"

# 4. 模拟元素点击（支持 CSS 选择器 或 text= 文本匹配）
node server.js click "text=保存" "Jira"
node server.js click "#submit-btn"

# 5. 表单输入（自动触发 React/Vue 的 input 与 change 事件）
node server.js fill "#keyword" "BugFix" "Jira"

# 6. 网页滚动 (down / up / top / bottom)
node server.js scroll down "Jira"

# 7. 截取网页视口快照保存为本地 PNG 图片
node server.js shot "Jira" ./screenshot.png

# 8. 在目标页面上下文中执行自定义 JavaScript
node server.js eval "document.title" "Jira"

# 9. 关闭指定的标签页
node server.js close "trending"

# 10. 一键清理并关闭所有 Agent 任务分组中的后台临时标签页
node server.js clean
```

---

## 🤖 在 Claude Code 中自然语言使用

完成 MCP 注册后，您无需敲任何命令行，直接在 Claude 对话框中吩咐：

- 🗣️ *“帮我看一眼我当前浏览器打开的工单页面，有哪些待办任务？”*
- 🗣️ *“读取一下监控看板当前展示的核心指标数据”*
- 🗣️ *“帮我在打开的工单页面点击‘审核通过’按钮，把操作结果截个图给我”*
- 🗣️ *“帮我查一下当前浏览器打开了哪些标签页”*
- 🗣️ *“把刚才打开的 Agent 任务页面全部清理关闭”*

Claude 会智能调用背后的工具集：
- `browser_read`：模糊定位并结构化提取网页数据（含子 iframe、表格与关键链接）
- `browser_list_tabs`：获取当前所有标签页清单
- `browser_click`：点击指定选择器或文本按钮（支持 Pointer/Mouse 复合事件）
- `browser_fill`：输入表单项（深度适配 React/Vue 受控组件）
- `browser_screenshot`：网页截图存盘
- `browser_navigate`：在专属「Agent 任务」分组中后台静默打开新链接
- `browser_close_tab`：关闭指定标签页
- `browser_clean_group`：一键关闭清理所有 Agent 任务标签
- `browser_eval`：执行页面控制台脚本

---

## 🛠️ 常见问题 (FAQ)

### 1. 扩展图标显示“🔴 未连接服务”？
只需在终端运行一次 `node server.js list`，本地守护进程会自动在后台启动并监听 `127.0.0.1:18888`。然后点击扩展图标中的「🔄 重新连接 Bridge 服务」按钮即可。

### 2. 修改扩展源码后如何生效？
Chrome 不会自动热重载本地未打包的扩展。若修改了 `extension/` 下的文件，请在 `chrome://extensions` 页面点击该扩展卡片右下角的 **「🔄 重新加载」** 按钮。

### 3. 会泄露我的 Cookie 或隐私数据吗？
本系统的 WebSocket 与 HTTP API **仅监听在本地回环地址 `127.0.0.1:18888`**，没有任何外部服务器或第三方数据收集逻辑，所有通信均在您本机的进程之间流转，安全可控。

---

## 📄 开源许可证

本项目基于 [MIT License](LICENSE) 协议开源。
