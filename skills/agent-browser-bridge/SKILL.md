---
name: agent-browser-bridge
description: 通过本地桥接控制用户「正在使用的真实 Chrome 浏览器」——复用全部登录态与内网权限，后台静默操作、不抢焦点。当任务涉及读取已登录的内网系统页面（OA、工单系统、Jira、看板、各类管理后台）、列出或操作浏览器标签页、抓取需要登录才能看到的页面内容、点击页面按钮、填写表单、网页截图、在页面上下文执行 JS 时使用本 skill。触发词：浏览器、标签页、读取网页、抓取页面、看板、内网系统、OA、管理后台、登录态、网页截图、点击按钮、填表、自动化操作页面。
version: 2.2.0
homepage: https://github.com/LuoWeiway/agent-browser-bridge
---

# Agent Browser Bridge

控制用户**当前日常使用的真实 Chrome**。扩展寄宿在用户的 Chrome 里，因此内网系统、Cookie、SSO 登录态**天然保留**——不需要重新登录，不需要关掉浏览器。

## 何时用 / 何时不用

| 场景 | 选它 |
|---|---|
| 需要登录态才能看的页面（OA、工单、内网看板、管理后台） | ✅ 本 skill |
| 读取用户「已经打开的」标签页内容 | ✅ 本 skill |
| 全新建一个隔离环境跑端到端测试、要干净 Cookie | ❌ 用 `playwright-cli` / `agent-browser` |
| 需要 CDP 级深度控制、网络拦截、多浏览器 profile | ❌ 用 `playwright-cli` |

**核心差异**：传统自动化（Puppeteer / Playwright / `--remote-debugging-port=9222`）每次冷启动都是无痕环境，拿不到登录态，还会抢走用户焦点、覆盖用户正在看的页面。本 skill 借宿真实 Chrome，新开的页面统一进 `Agent 任务` 标签组，`active: false` 后台静默加载。

## 前置条件与一键集成 (v2.2.0)

1. **Chrome 加载扩展**：终端运行 `node server.js open-ext` 快速打开扩展页并加载。
2. **多 Agent 自动配置**：终端运行 `node server.js install all` 一键完成 WorkBuddy, Claude, Cursor 等 Agent 注册。
3. **全链路自检诊断**：运行 `node server.js doctor`，全绿灯即代表所有链路畅通。
4. 守护进程在首次调用时自动后台拉起，监听 `127.0.0.1:18888`，无需手动管理。

## 使用方式

**方式 A — CLI（推荐，可控性最好）**

```bash
BRIDGE="server.js"
node "$BRIDGE" list                    # 先看有什么
node "$BRIDGE" read "看板"              # 再读内容
```

**方式 B — MCP 工具**（已注册，工具名 `browser_*`）
`browser_read` / `browser_list_tabs` / `browser_click` / `browser_fill` / `browser_scroll` / `browser_screenshot` / `browser_navigate` / `browser_eval` / `browser_close_tab` / `browser_clean_group`

两种方式底层走同一个守护进程，可混用。

## 标准工作流

```
1. node server.js list               → 确认目标页面是否已打开，拿到 Tab ID
2. node server.js read "<关键词>"     → 确认真实内容（别猜，页面要登录态）
3. node server.js click/fill/eval    → 执行交互
4. node server.js shot "<关键词>"     → 回读截图验证结果
5. node server.js clean              → 收尾，关掉本次产生的后台标签组
```

## 命令速查

| 命令 | 说明 |
|---|---|
| `doctor [--fix]` | 🩺 全链路健康诊断与自愈修复 |
| `install [all\|agent]` | 🚀 一键自动集成至 AI Agent (WorkBuddy/Claude/Cursor等) |
| `open-ext` | 🧩 快捷打开 Chrome 扩展管理页与路径指引 |
| `list` | 列出全部窗口的标签页（Tab ID / 标题 / URL / 激活状态） |
| `read [关键词]` | 模糊匹配标签页并提取结构化 Markdown（递归穿透 iframe、表格转 Markdown）；留空=当前激活页 |
| `open <URL> [关键词]` | **始终新建**标签页并归入 `Agent 任务` 组，`active:false` 不抢焦点 |
| `click <选择器或text=文本> [关键词]` | 点击元素，如 `text=保存`、`#submit-btn` |
| `fill <选择器> <值> [关键词]` | 填表单，自动派发 input/change 事件（适配 React/Vue 受控组件） |
| `scroll [down\|up\|top\|bottom] [关键词]` | 滚动页面 |
| `shot [关键词] [输出路径]` | 截图存 PNG，默认存当前工作目录 |
| `eval <JS表达式> [关键词]` | 在页面上下文执行 JS |
| `close <关键词或URL>` | 关闭匹配的标签页 |
| `clean` | 关闭 `Agent 任务` 分组里的全部临时标签页 |

`[关键词]` 支持 URL 片段、中文标题或自然语言描述（如 `"看板"`、`"localhost:8080"`），留空则作用于当前激活标签页。
| `click <选择器或text=文本> [关键词]` | 点击元素，如 `text=保存`、`#submit-btn` |
| `fill <选择器> <值> [关键词]` | 填表单，自动派发 input/change 事件（适配 React/Vue 受控组件） |
| `scroll [down\|up\|top\|bottom] [关键词]` | 滚动页面 |
| `shot [关键词] [输出路径]` | 截图存 PNG，默认存当前工作目录 |
| `eval <JS表达式> [关键词]` | 在页面上下文执行 JS |
| `close <关键词或URL>` | 关闭匹配的标签页 |
| `clean` | 关闭 `Agent 任务` 分组里的全部临时标签页 |

`[关键词]` 支持 URL 片段、中文标题或自然语言描述（如 `"看板"`、`"localhost:8080"`），留空则作用于当前激活标签页。

## 硬性规则

- **先 `list` 再操作**。不要假设页面已打开；不要假设页面内容是什么——用 `read` 拿真实渲染后的结果。
- **`open` 不跳转已有页面**，它永远新建。想跳转已有页面，用 `eval "location.href='...'"` 或先 `close`。
- **提交类操作（保存 / 审核 / 删除 / 发布）前必须先 `read` 或 `shot` 确认当前页面状态**，操作后再次 `shot` 回读确认结果，不要凭返回值就断言成功。
- **`eval` 会以用户身份执行任意 JS**，只执行明确需要的表达式，不要用它跑不确定的批量脚本。
- **用完 `clean`**，别把 `Agent 任务` 组里的临时标签页留在用户浏览器里。
- 不要尝试绕过登录：本 skill 的价值就在于复用用户已有登录态，遇到未登录页面应直接告知用户。

## 参考文档

- `references/commands.md` — 全部 CLI 命令与 MCP 工具的参数细节、输出格式、典型组合
- `references/troubleshooting.md` — 扩展未连接、端口占用、模糊匹配失败、超时等故障排查
