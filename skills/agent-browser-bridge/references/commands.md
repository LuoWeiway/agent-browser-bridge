# Agent Browser Bridge — 命令与工具参考 (v2.2.0)

所有 CLI 命令均在任意工作目录下可执行，`server.js` 内部用 `__dirname` 定位自身。

```bash
BRIDGE="server.js"
```

## 一键安装与系统自检命令

### `doctor [--fix]`

执行 5 级全链路自检（Node 环境、端口与守护进程、Chrome 扩展连接状态、浏览器实时页面提取能力、各 AI Agent 配置文件注册合规性）。

```bash
node "$BRIDGE" doctor
node "$BRIDGE" doctor --fix    # 诊断并自动尝试拉起服务、补全 Agent 配置
```

### `install [all|agent] [--dry-run]`

自动将 `agent-browser-bridge` 的绝对路径与启动参数注册至指定的 AI Agent 配置文件，并自动生成 `.bak` 备份。

```bash
node "$BRIDGE" install all             # 扫描并注册至所有已检测到的 Agent
node "$BRIDGE" install workbuddy       # 仅注册至 WorkBuddy
node "$BRIDGE" install claude          # 仅注册至 Claude Code
node "$BRIDGE" install cursor          # 仅注册至 Cursor
node "$BRIDGE" install desktop         # 仅注册至 Claude Desktop
node "$BRIDGE" install windsurf        # 仅注册至 Windsurf
```

### `open-ext`

快捷调起系统浏览器打开 `chrome://extensions`，并在终端高亮输出本机 `extension/` 的绝对路径供快速加载。

```bash
node "$BRIDGE" open-ext
```

## CLI 日常控制命令详解

### `list`

列出所有 Chrome 窗口中打开的标签页。

```bash
node "$BRIDGE" list
```

输出：序号、激活标记（🟢 [激活] / ⚪）、标题、URL、Tab ID、Window ID。

### `read [关键词]`

模糊匹配目标标签页，提取结构化 Markdown。匹配范围：URL、页面标题、分词。

```bash
node "$BRIDGE" read "看板"
node "$BRIDGE" read "prd"
node "$BRIDGE" read "localhost:8080"
node "$BRIDGE" read ""            # 留空 = 当前聚焦的活动标签页
```

提取内容包含：

- 页面大纲与正文
- 数据表格 → 自动转为 Markdown 表格
- 输入控件、按钮清单
- 关键导航链接
- **递归穿透同源与跨域 iframe**（`allFrames: true`，针对工单系统这类嵌套子框架页面）

返回字段：`markdown` 优先，其次 `text`，读取失败时返回 `error`。

### `open <URL> [关键词]`

在专属 `Agent 任务` 标签组中**新建**标签页，`active: false` 后台静默加载。

```bash
node "$BRIDGE" open "https://jira.example.com/browse/PROJ-123"
```

⚠️ 与 README 描述不同：实现上**永远是新建**，不会复用/跳转已存在的标签页。别指望用它"导航"一个已打开的页面。

### `click <选择器或text=文本> [关键词]`

```bash
node "$BRIDGE" click "text=保存" "看板"
node "$BRIDGE" click "#submit-btn"
```

- CSS 选择器：`#id`、`.class`、`input[placeholder=搜索]`
- 文本匹配：`text=确定`、`text=编辑`
- 事件派发为 PointerEvent + MouseEvent 复合，兼容现代 UI 框架

返回 `{ success, ... }`；失败时 `success: false`。

### `fill <选择器> <值> [关键词]`（别名 `type`）

```bash
node "$BRIDGE" fill "#keyword" "关键词" "看板"
```

使用原生 input value setter + `input` / `change` 事件派发，兼容 React 16/17/18+ 受控组件。

### `scroll [down|up|top|bottom] [关键词]`

```bash
node "$BRIDGE" scroll bottom "看板"
```

### `shot [关键词] [输出路径]`

```bash
node "$BRIDGE" shot "看板" ./screenshot.png
```

- 截取可视区域
- 未指定输出路径时存到 `process.cwd()/screenshot_<timestamp>.png`
- 返回目标页面标题与 URL，便于确认截的是不是你要的页面

### `eval <JS表达式> [关键词]`

```bash
node "$BRIDGE" eval "document.title" "看板"
node "$BRIDGE" eval "window.__INITIAL_STATE__" "看板"
```

以用户身份在页面上下文执行。可用于跳转已有页面：`eval "location.href='https://...'"`。

### `close <关键词或URL>`

```bash
node "$BRIDGE" close "PROJ-123"
```

### `clean`

一键关闭 `Agent 任务` 分组下的所有后台临时标签页。

```bash
node "$BRIDGE" clean
```

### `--server` / `server`

前台启动守护进程并查看实时日志（调试用）。

```bash
node "$BRIDGE" --server
```

## MCP 工具对照表

| MCP 工具 | 等价 CLI | 必填参数 |
|---|---|---|
| `browser_read` | `read` | — （`query` 可选） |
| `browser_list_tabs` | `list` | — |
| `browser_click` | `click` | `selector` |
| `browser_fill` | `fill` | `selector`, `value` |
| `browser_scroll` | `scroll` | — （`direction` 默认 down） |
| `browser_screenshot` | `shot` | — （`outputPath` 可选） |
| `browser_navigate` | `open` | `url` |
| `browser_eval` | `eval` | `expression` |
| `browser_close_tab` | `close` | `query` |
| `browser_clean_group` | `clean` | — |

所有工具均支持可选参数 `query` 用于定位目标标签页。

## HTTP REST & SSE 接口 (v2.2.0 多 Agent 通用接入)

守护进程在 `127.0.0.1:18888` 上提供多种通用接入协议：

### 1. 健康检查与状态

```bash
curl http://127.0.0.1:18888/ping          # 返回 { status, clients, pid, version }
```

### 2. OpenAI Function Calling 规范工具列表

```bash
curl http://127.0.0.1:18888/v1/tools      # 返回 standard MCP tools 与 openai_tools 两种结构
```

### 3. HTTP REST 工具直接调用 (Python / Dify / LangChain)

```bash
curl -X POST http://127.0.0.1:18888/v1/tools/call \
  -H "Content-Type: application/json" \
  -d '{"name":"browser_read","arguments":{"query":"看板"}}'
```

### 4. 标准 MCP SSE 传输通道

```bash
# 挂载端点: http://127.0.0.1:18888/sse
# 接收端点: http://127.0.0.1:18888/message?sessionId=<sessionId>
```

### 5. 内部 JSON API 通道

```bash
curl -X POST http://127.0.0.1:18888/api \
  -H "Content-Type: application/json" \
  -d '{"action":"read","params":{"query":"看板"},"timeout":20000}'
```

`action` 取值：`list` / `read` / `click` / `fill` / `scroll` / `shot` / `eval` / `navigate` / `open` / `close` / `clean`。

## 典型组合

**读取内网系统的某个工单详情**

```bash
node "$BRIDGE" list
node "$BRIDGE" open "https://jira.example.com/browse/PROJ-123"
node "$BRIDGE" read "PROJ-123"
```

**在管理后台查询并截图留证**

```bash
node "$BRIDGE" fill "#search-input" "关键词" "管理后台"
node "$BRIDGE" click "text=查询" "管理后台"
node "$BRIDGE" shot "管理后台" ./evidence.png
node "$BRIDGE" clean
```

**提取页面内的结构化数据**

```bash
node "$BRIDGE" eval "JSON.stringify(Array.from(document.querySelectorAll('table tbody tr')).map(tr=>Array.from(tr.cells).map(td=>td.innerText.trim())))" "看板"
```
