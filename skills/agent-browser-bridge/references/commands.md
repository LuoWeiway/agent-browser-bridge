# Agent Browser Bridge — 命令与工具参考

所有 CLI 命令均在任意工作目录下可执行，`server.js` 内部用 `__dirname` 定位自身。

```bash
BRIDGE="E:/work/2026v/codex-browser-bridge/server.js"
```

## CLI 命令详解

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

## HTTP API（直接调用）

守护进程对外暴露两个端点，仅监听 `127.0.0.1:18888`：

```bash
curl http://127.0.0.1:18888/ping          # 健康检查，返回 { status, clients, pid }
```

```bash
curl -X POST http://127.0.0.1:18888/api \
  -H "Content-Type: application/json" \
  -d '{"action":"read","params":{"query":"看板"},"timeout":20000}'
```

`action` 取值：`list` / `read` / `click` / `fill` / `scroll` / `shot` / `eval` / `navigate` / `open` / `close` / `clean`。

响应：`{ success: true, result: ... }` 或 `{ success: false, error: "..." }`。

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
