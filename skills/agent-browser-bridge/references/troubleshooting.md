# 故障排查 (v2.3.0)

## 0. 首选：全链路一键诊断与自愈

遇到任何问题，优先在项目根目录下执行：

```bash
node server.js doctor
```

若提示守护进程未启动或配置缺失，直接运行带自动修复参数：

```bash
node server.js doctor --fix
```

诊断工具会自动测试 Node 版本、安全令牌与 Origin 策略、端口占用、进程状态、扩展连接与已注册 Agent 配置，并给出明确指令。

---

## 1. 提示「Chrome 扩展未连接」

错误信息：

```
Chrome 扩展未连接。请确认：
1. 已在 Chrome 打开并在 chrome://extensions 载入了扩展
2. 检查扩展图标弹出窗口是否显示为绿色已连接
```

排查顺序：

1. **守护进程是否真的在跑**

   ```bash
   curl http://127.0.0.1:18888/ping
   ```

   返回 `{"status":"ok","clients":N,"pid":...}` 说明进程正常。注意 `clients` 为 `0` 时表示扩展没连上来。

2. **唤醒守护进程 + 重连扩展**

   ```bash
   node server.js list
   ```

   然后点扩展图标里的「🔄 重新连接 Bridge 服务」。

3. **扩展是否已加载**：
   运行快捷命令自动调出扩展管理页：
   ```bash
   node server.js open-ext
   ```
   确认 `Agent Browser Bridge` 已启用，且「加载已解压的扩展程序」指向的是当前项目的 `extension` 目录。

4. 改了 `extension/` 下任何文件后，必须到 `chrome://extensions` 点该扩展卡片的「🔄 重新加载」——Chrome 不会热重载未打包扩展。

## 2. 端口 18888 被占用

```bash
netstat -ano | grep 18888
```

找到 PID 后结束进程，再重新调用一次命令让守护进程自启：

```bash
taskkill //PID <PID> //F
```

如需更换端口，可指定环境变量启动：
```bash
BRIDGE_PORT=18890 node server.js --server
```
同时同步修改 `extension/offscreen.js` 与 `extension/background.js` 中连接端口，然后重新加载扩展。

## 3. `.bridge_daemon.pid` 是残留文件

PID 文件只是记录，不是锁。判断守护进程是否活着**只看 `/ping` 是否响应**，不要只看 pid 文件。进程被强杀后 pid 文件会残留，不影响下次自动拉起。

## 4. 模糊匹配找不到目标标签页

`read` / `click` 等命令的 `query` 支持 URL 片段、标题关键词、分词匹配。

匹配不到时：

1. 先 `list` 看真实标题和 URL 长什么样，用其中的片段作为关键词
2. 中文标题匹配失败时，改用 URL 片段（如工单号 `PROJ-123`）
3. 确实要操作某页但没打开 → 用 `open <URL>` 新建后再用 URL 片段匹配
4. **留空 `query` 时不匹配**，而是直接作用当前激活标签页——想操作用户正在看的页面就留空，但要意识到这会动到用户的页面

## 5. 命令执行超时

默认超时 20s（MCP 内部 25s）。常见原因：

- 页面本身加载慢 → 拆成 `open` 先打开，等页面就绪后再 `read`
- `read` 遇到超大页面 + 多层 iframe → 改用 `eval` 精确提取需要的字段，而不是整页 `read`
- 页面弹了模态框/遮罩挡住元素 → 先 `shot` 看当前状态，必要时先 `click "text=关闭"`

## 6. `click` / `fill` 报 success: false

- 元素在 iframe 里 → 当前实现对 iframe 内的交互支持有限，优先改用 `eval` 在页面上下文直接操作
- 选择器命中多个元素 → 收窄选择器
- 元素尚未渲染 → 先 `shot` 确认页面已加载到位
- 文本匹配要带 `text=` 前缀：`text=保存`，不要直接写 `保存`

## 7. 截图存不下来 / 找不到文件

- CLI 的 `shot` 未指定路径时，文件存到**当前工作目录**，不是仓库目录，用绝对路径更稳妥：

  ```bash
  node "$BRIDGE" shot "看板" "E:/tmp/shot.png"
  ```

- MCP 的 `browser_screenshot` 未指定 `outputPath` 时存到系统临时目录

## 8. 守护进程日志

想看实时日志，前台启动：

```bash
node server.js --server
```

## 安全防护与鉴权机制 (v2.3.0)

- **Origin 守门防护**：守护进程会自动校验所有 HTTP 请求与 WebSocket 握手的 `Origin` 标头。仅允许无 Origin（本地 CLI/MCP）及 `chrome-extension://`、`http://127.0.0.1` 访问。任何公网第三方网页发起的跨站请求均会被即时拦截并返回 HTTP `403 Forbidden`，根除 Local CSRF 隐患。
- **本地会话密钥认证**：守护进程会在项目根目录自动维护 `.bridge_token`（或通过环境变量 `BRIDGE_TOKEN` 指定）。所有外部 HTTP API 调用必须携带 `Authorization: Bearer <token>` 或 `token=<token>` 参数。
- **通信安全性**：所有数据均在您本机回环地址（127.0.0.1）内流转，不与任何外部公网云端服务器传输数据。
