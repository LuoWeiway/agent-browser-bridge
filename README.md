# Agent Browser Bridge 🌐

> 基于 Chrome Manifest V3 扩展与本地 WebSocket/HTTP 守护进程桥接。  
> 让各类 **AI Agent (Claude Code, WorkBuddy, Cursor 等)** 与本地终端 CLI 能够**直接控制并读取您当前日常使用的真实 Chrome 浏览器**。

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
- 🟢 **标签任务分组隔离 (Tab Groups)**：所有 Agent 打开的新页面自动归纳进专属的 **`[Agent 任务]`** 分组，并在后台静默加载（`active: false`），**绝对不抢夺焦点、绝对不覆盖您当前操作的页面**。
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

## 🚀 极简三步上手指南 (v2.3.0)

### 第一步：在 Chrome 中加载扩展

1. 在终端运行快捷命令（会自动打开 Chrome 扩展页并打印本地绝对路径）：
   ```bash
   node server.js open-ext
   ```
2. 开启右上角的 **「开发者模式」** 开关。
3. 点击左上角 **「加载已解压的扩展程序」**，选择打印出的 `extension` 目录。
4. Chrome 工具栏将出现 `Agent Browser Bridge` 扩展图标。

---

### 第二步：一键自动集成至您的 AI Agent

**不再需要手动查目录或修改 JSON 配置文件！** 运行内置的一键安装器：

```bash
# 一键自动扫描并注册至本机所有已安装的 Agent (WorkBuddy, Claude, Cursor, Windsurf等)
node server.js install all

# 或按需单独注册：
node server.js install workbuddy       # 接入 WorkBuddy AI
node server.js install claude          # 接入 Claude Code
node server.js install cursor          # 接入 Cursor
node server.js install desktop         # 接入 Claude Desktop
node server.js install windsurf        # 接入 Windsurf
```

> 安装器会自动检测路径、备份原配置文件（`.bak`）并将标准化绝对路径规范写入。

---

### 第三步：全链路自检诊断 (Doctor)

安装完成后，随时执行诊断命令验证全链路是否通畅（内置 CSRF 安全策略检验）：

```bash
node server.js doctor

# 支持一键自愈修复（自动拉起后台进程、自动补全配置）：
node server.js doctor --fix
```

---

## 🌐 多协议支持：接入更多 Agent 与自动化流程

除了 Stdio MCP，本项目还原生提供 HTTP REST 与 SSE 接口，零依赖开箱即用：

### 1. OpenAI Function Calling 格式工具规范
- **获取工具定义清单**：`GET http://127.0.0.1:18888/v1/tools`
- **执行工具调用**：`POST http://127.0.0.1:18888/v1/tools/call`（支持携带本地 Token）
  ```bash
  TOKEN=$(cat .bridge_token)
  curl -X POST http://127.0.0.1:18888/v1/tools/call \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"name":"browser_read","arguments":{"query":"Jira"}}'
  ```
  *任何 Python、LangChain、Dify 或自动化脚本均可直接发起 HTTP 请求调用，无需构建 MCP 客户端。*

### 2. 标准 MCP Server-Sent Events (SSE) 通道
- **SSE 挂载端点**：`http://127.0.0.1:18888/sse`
- 适用于不支持本机构建子进程、但支持网络 MCP 的远程或 Web 智能体。

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

# 5. 模拟鼠标悬停 (触发下拉列表、Tooltip 或悬浮卡片)
node server.js hover ".nav-dropdown" "Jira"
node server.js hover "text=用户中心"

# 6. 表单输入（自动触发 React/Vue 的 input 与 change 事件）
node server.js fill "#keyword" "BugFix" "Jira"

# 7. 模拟按键（回车、Esc、Tab、方向键等）
node server.js press Enter "#keyword" "Jira"
node server.js press Escape

# 8. 原生 <select> 下拉选项选择
node server.js select "#status-select" "resolved" "Jira"

# 9. 显式异步等待元素出现或变为可见
node server.js wait ".issue-list" 5000 "Jira"

# 10. 查看页面控制台错误与异常日志 (协助排查操作无响应)
node server.js logs "Jira" error

# 11. 网页滚动 (down / up / top / bottom)
node server.js scroll down "Jira"

# 12. 截取网页视口快照保存为本地 PNG 图片
node server.js shot "Jira" ./screenshot.png

# 13. 在目标页面上下文中执行自定义 JavaScript
node server.js eval "document.title" "Jira"

# 14. 关闭指定的标签页
node server.js close "trending"

# 15. 一键清理并关闭所有 Agent 任务分组中的后台临时标签页
node server.js clean
```

---

## 🤖 在 Claude Code 中自然语言使用

完成 MCP 注册后，您无需敲任何命令行，直接在 Claude 对话框中吩咐：

- 🗣️ *“帮我看一眼我当前浏览器打开的工单页面，有哪些待办任务？”*
- 🗣️ *“把鼠标悬停在用户头像上，展开下拉菜单并点击‘个人设置’”*
- 🗣️ *“在搜索框输入关键词并按 Enter 回车键提交”*
- 🗣️ *“查看一下当前页面的控制台有没有报错日志”*
- 🗣️ *“读取一下监控看板当前展示的核心指标数据”*
- 🗣️ *“把刚才打开的 Agent 任务页面全部清理关闭”*

Claude 会智能调用背后的 15 项工具集：
- `browser_read`：模糊定位并结构化提取网页数据（含子 iframe、表格与关键链接）
- `browser_list_tabs`：获取当前所有标签页清单
- `browser_click`：点击指定选择器或文本按钮（支持 Pointer/Mouse 复合事件）
- `browser_hover`：悬停鼠标触发浮层菜单
- `browser_fill`：输入表单项（深度适配 React/Vue 受控组件）
- `browser_press_key`：模拟键盘物理按键（Enter/Escape/Tab/快捷键）
- `browser_select`：原生下拉选择
- `browser_wait_for`：异步显式等待元素加载
- `browser_get_console_logs`：获取控制台报错日志
- `browser_screenshot`：网页截图存盘
- `browser_navigate`：在专属「Agent 任务」分组中后台静默打开新链接
- `browser_close_tab`：关闭指定标签页
- `browser_clean_group`：一键关闭清理所有 Agent 任务标签
- `browser_eval`：执行页面控制台脚本

---

## 🛠️ 常见问题 (FAQ)

### 1. 扩展图标显示“🔴 未连接服务”？
只需在终端运行一次 `node server.js list` 或 `node server.js doctor --fix`，本地守护进程会自动在后台启动并监听 `127.0.0.1:18888`。然后点击扩展图标中的「🔄 重新连接 Bridge 服务」按钮即可。

### 2. 本地通信安全吗？会有跨站攻击或 Cookie 泄露风险吗？
* **Origin 来源守门 (Anti-CSRF)**：守护进程对所有通信均校验 `Origin`。仅允许本地 CLI/MCP 及 `chrome-extension://` 扩展内部访问；任何第三方网站发起的跨站请求会被即时拦截并拒绝（403 Forbidden）。
* **会话令牌保护**：HTTP API 受本地生成的 `.bridge_token` 保护，彻底防御跨站代码执行。
* **本地闭环**：所有数据均只在您本地回环地址 `127.0.0.1:18888` 流转，没有任何外部公网数据上报逻辑，安全可控。

---

## 📄 开源许可证

本项目基于 [MIT License](LICENSE) 协议开源。
