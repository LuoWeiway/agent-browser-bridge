#!/usr/bin/env node
/**
 * Agent Browser Bridge - 本地守护服务与 CLI 命令行交互引擎
 * 零第三方依赖 (使用 Node.js 原生 http / crypto / child_process)
 *
 * 核心功能:
 * 1. 守护进程 (Daemon): 长期驻留后台监听 18888 端口，维护与 Chrome 扩展的 WebSocket 通讯
 * 2. 自动启动守护 (Auto-spawn): CLI 或 MCP 调用时，若服务未运行则自动静默拉起
 * 3. 命令行交互 (CLI): 提供类似 Codex 的终端浏览器交互指令 (read / list / click / fill / shot / nav / eval)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const PORT = parseInt(process.env.BRIDGE_PORT || '18888', 10);
const PID_FILE = path.join(__dirname, '.bridge_daemon.pid');
const TOKEN_FILE = path.join(__dirname, '.bridge_token');

// ==========================================
// 0. 安全令牌与 Origin 校验体系
// ==========================================

function getOrCreateToken() {
  if (process.env.BRIDGE_TOKEN) {
    return process.env.BRIDGE_TOKEN.trim();
  }
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
      if (t && t.length >= 16) return t;
    }
  } catch (e) {}

  const newToken = crypto.randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(TOKEN_FILE, newToken, { mode: 0o600, encoding: 'utf8' });
  } catch (err) {}
  return newToken;
}

const BRIDGE_TOKEN = getOrCreateToken();

function isAllowedOrigin(origin) {
  if (!origin) return true; // 本地 CLI / Stdio MCP 子进程无 Origin 标头
  if (origin.startsWith('chrome-extension://')) return true; // Chrome 扩展内部发起的请求
  if (/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) return true; // 本地开发页面
  return false;
}

function verifyAuth(req, parsedUrl) {
  const origin = req.headers['origin'];
  // Chrome 扩展自身的请求予以放行
  if (origin && origin.startsWith('chrome-extension://')) {
    return true;
  }

  const authHeader = req.headers['authorization'] || '';
  let token = '';
  if (authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7).trim();
  } else if (req.headers['x-bridge-token']) {
    token = String(req.headers['x-bridge-token']).trim();
  } else if (parsedUrl && parsedUrl.searchParams.has('token')) {
    token = parsedUrl.searchParams.get('token').trim();
  }

  if (token && token.length === BRIDGE_TOKEN.length) {
    try {
      return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(BRIDGE_TOKEN));
    } catch (e) {
      return false;
    }
  }
  return false;
}

// ==========================================
// 1. WebSocket 与 HTTP 桥接服务端
// ==========================================

class BridgeServer {
  constructor(port = PORT) {
    this.port = port;
    this.clients = new Set();
    this.pendingRequests = new Map();
    this.sseSessions = new Map();
    this.reqId = 1;

    this.server = http.createServer(async (req, res) => {
      const reqOrigin = req.headers['origin'];

      // 0. 安全守门：严禁不受信任的外部网页跨站访问本地 Bridge
      if (reqOrigin && !isAllowedOrigin(reqOrigin)) {
        res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: false, error: 'Forbidden: Invalid Origin' }));
        return;
      }

      // 动态反射合法的跨域标头
      if (reqOrigin) {
        res.setHeader('Access-Control-Allow-Origin', reqOrigin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
      } else {
        res.setHeader('Access-Control-Allow-Origin', '*');
      }
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Bridge-Token');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      const parsedUrl = new URL(req.url, `http://127.0.0.1:${this.port}`);
      const pathname = parsedUrl.pathname;

      // 1. 健康检查与客户端计数 (公开只读)
      if (pathname === '/ping') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: 'ok',
          clients: this.clients.size,
          sseClients: this.sseSessions.size,
          pid: process.pid,
          version: '2.3.0',
          authRequired: true
        }));
        return;
      }

      // 2. 核心 API 分发接口 (CLI / Stdio MCP 转发通道 - 需鉴权)
      if (pathname === '/api' && req.method === 'POST') {
        if (!verifyAuth(req, parsedUrl)) {
          res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: false, error: 'Unauthorized: missing or invalid bridge token' }));
          return;
        }

        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
          try {
            const { action, params, timeout } = JSON.parse(body || '{}');
            const result = await this.sendCommand(action, params || {}, timeout || 20000);
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success: true, result }));
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success: false, error: err.message || String(err) }));
          }
        });
        return;
      }

      // 3. 通用 HTTP REST 工具清单 (供非 MCP Agent / OpenAI Function Calling 调用)
      if (pathname === '/v1/tools' && req.method === 'GET') {
        try {
          const { TOOLS, getOpenAITools } = require('./tools');
          const openaiTools = getOpenAITools();
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ tools: TOOLS, openai_tools: openaiTools }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }

      // 4. 通用 HTTP REST 工具执行接口 (需鉴权)
      if ((pathname === '/v1/tools/call' || pathname.startsWith('/v1/tools/')) && req.method === 'POST') {
        if (!verifyAuth(req, parsedUrl)) {
          res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: false, error: 'Unauthorized: missing or invalid bridge token' }));
          return;
        }

        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
          try {
            const { executeTool } = require('./tools');
            const data = JSON.parse(body || '{}');
            let toolName = data.name || data.tool;
            if (!toolName && pathname.startsWith('/v1/tools/') && pathname !== '/v1/tools/call') {
              toolName = pathname.replace('/v1/tools/', '').trim();
            }
            const toolArgs = data.arguments || data.args || data.params || {};

            if (!toolName) {
              res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
              res.end(JSON.stringify({ success: false, error: '缺少工具名称 (name)' }));
              return;
            }

            const toolResult = await executeTool(toolName, toolArgs, {
              callApi: (act, pms, to) => this.sendCommand(act, pms, to)
            });
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success: !toolResult.isError, result: toolResult }));
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success: false, error: err.message || String(err) }));
          }
        });
        return;
      }

      // 5. MCP Server-Sent Events (SSE) 协议通道 (需鉴权)
      if (pathname === '/sse' && req.method === 'GET') {
        if (!verifyAuth(req, parsedUrl)) {
          res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: false, error: 'Unauthorized: missing or invalid bridge token' }));
          return;
        }

        const sessionId = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': reqOrigin || '*'
        });

        res.write(`event: endpoint\ndata: /message?sessionId=${sessionId}&token=${BRIDGE_TOKEN}\n\n`);
        this.sseSessions.set(sessionId, res);

        req.on('close', () => {
          this.sseSessions.delete(sessionId);
        });
        return;
      }

      // 6. MCP SSE 客户端消息接收通道 (需鉴权)
      if (pathname === '/message' && req.method === 'POST') {
        if (!verifyAuth(req, parsedUrl)) {
          res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: false, error: 'Unauthorized: missing or invalid bridge token' }));
          return;
        }

        const sessionId = parsedUrl.searchParams.get('sessionId');
        const sseRes = this.sseSessions.get(sessionId);

        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
          try {
            const jsonRpc = JSON.parse(body || '{}');
            const responseRpc = await this.handleJsonRpc(jsonRpc);
            if (responseRpc && sseRes) {
              sseRes.write(`event: message\ndata: ${JSON.stringify(responseRpc)}\n\n`);
            }
            res.writeHead(202, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'accepted' }));
          } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
          }
        });
        return;
      }

      res.writeHead(404);
      res.end('Not Found');
    });

    // 处理 WebSocket 协议升级握手
    this.server.on('upgrade', (req, socket, head) => {
      const origin = req.headers['origin'];
      if (origin && !isAllowedOrigin(origin)) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }

      const key = req.headers['sec-websocket-key'];
      if (!key) {
        socket.destroy();
        return;
      }

      const accept = crypto.createHash('sha1')
        .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
        .digest('base64');

      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
      );

      const client = { socket, ip: socket.remoteAddress };
      this.clients.add(client);

      let socketBuffer = Buffer.alloc(0);
      socket.on('data', (chunk) => {
        socketBuffer = Buffer.concat([socketBuffer, chunk]);

        while (socketBuffer.length >= 2) {
          const secondByte = socketBuffer[1];
          const isMasked = (secondByte & 0x80) === 0x80;
          let length = secondByte & 0x7f;
          let offset = 2;

          if (length === 126) {
            if (socketBuffer.length < 4) break;
            length = socketBuffer.readUInt16BE(2);
            offset = 4;
          } else if (length === 127) {
            if (socketBuffer.length < 10) break;
            length = Number(socketBuffer.readBigUInt64BE(2));
            offset = 10;
          }

          const maskLength = isMasked ? 4 : 0;
          const totalFrameSize = offset + maskLength + length;
          if (socketBuffer.length < totalFrameSize) {
            // 帧数据尚未接收完整，等待下一个 TCP 数据包
            break;
          }

          const frameBuffer = socketBuffer.slice(0, totalFrameSize);
          socketBuffer = socketBuffer.slice(totalFrameSize);

          const message = this.decodeFrame(frameBuffer);
          if (message) {
            try {
              const data = JSON.parse(message);
              // 响应保活心跳
              if (data.type === 'ping') {
                socket.write(this.encodeFrame(JSON.stringify({ type: 'pong' })));
                continue;
              }

              // 处理指令异步响应
              if (data.id && this.pendingRequests.has(data.id)) {
                const { resolve } = this.pendingRequests.get(data.id);
                this.pendingRequests.delete(data.id);
                resolve(data.result);
              }
            } catch (e) {}
          }
        }
      });

      socket.on('close', () => { this.clients.delete(client); });
      socket.on('error', () => { this.clients.delete(client); });
    });
  }

  start() {
    this.server.listen(this.port, '127.0.0.1', () => {
      fs.writeFileSync(PID_FILE, process.pid.toString());
      console.log(`[Codex Bridge] 守护服务已在 127.0.0.1:${this.port} 运行 (PID: ${process.pid})`);
    });
  }

  // 发送指令给 Chrome 扩展并等待其处理完成
  async sendCommand(action, params = {}, timeoutMs = 20000) {
    // 若当前暂无客户端连接，最多等待 5 秒（给正在唤醒的扩展预留时间）
    const waitStart = Date.now();
    while (this.clients.size === 0 && Date.now() - waitStart < 5000) {
      await new Promise(r => setTimeout(r, 200));
    }

    if (this.clients.size === 0) {
      throw new Error(
        'Chrome 扩展未连接。请确认：\n' +
        '1. 已在 Chrome 打开并在 chrome://extensions 载入了扩展\n' +
        '2. 检查扩展图标弹出窗口是否显示为绿色已连接'
      );
    }

    const id = this.reqId++;
    const payload = JSON.stringify({ id, action, params });
    const encoded = this.encodeFrame(payload);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`指令 ${action} 执行超时 (${timeoutMs / 1000}s)`));
        }
      }, timeoutMs);

      this.pendingRequests.set(id, {
        resolve: (res) => {
          clearTimeout(timer);
          resolve(res);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        }
      });

      // 优先选取最新的一个可用客户端发送（避免多连接重复执行）
      const clientList = Array.from(this.clients);
      let sent = false;
      while (clientList.length > 0) {
        const client = clientList.pop();
        try {
          client.socket.write(encoded);
          sent = true;
          break;
        } catch (e) {
          this.clients.delete(client);
        }
      }

      if (!sent) {
        this.pendingRequests.delete(id);
        clearTimeout(timer);
        reject(new Error('Chrome 扩展连接已断开，未能发送指令'));
      }
    });
  }

  // 处理标准 MCP JSON-RPC 请求 (供 SSE 协议分发)
  async handleJsonRpc(req) {
    const { id, method, params } = req;
    const { TOOLS, handleToolCall } = require('./mcp');

    if (method === 'initialize') {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'agent-browser-bridge', version: '2.2.0' }
        }
      };
    }
    if (method === 'notifications/initialized') {
      return null;
    }
    if (method === 'ping') {
      return { jsonrpc: '2.0', id, result: {} };
    }
    if (method === 'tools/list') {
      return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
    }
    if (method === 'tools/call') {
      const { name, arguments: toolArgs } = params || {};
      const toolResult = await handleToolCall(name, toolArgs || {});
      return { jsonrpc: '2.0', id, result: toolResult };
    }
    if (id !== undefined) {
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${method}` }
      };
    }
    return null;
  }

  // WebSocket 帧解码 (RFC 6455)
  decodeFrame(buffer) {
    if (buffer.length < 2) return null;
    const secondByte = buffer[1];
    const isMasked = (secondByte & 0x80) === 0x80;
    let length = secondByte & 0x7f;
    let offset = 2;

    if (length === 126) {
      length = buffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      length = Number(buffer.readBigUInt64BE(2));
      offset = 10;
    }

    if (isMasked) {
      const mask = buffer.slice(offset, offset + 4);
      offset += 4;
      const data = buffer.slice(offset, offset + length);
      const decoded = Buffer.alloc(data.length);
      for (let i = 0; i < data.length; i++) {
        decoded[i] = data[i] ^ mask[i % 4];
      }
      return decoded.toString('utf8');
    }
    return buffer.slice(offset, offset + length).toString('utf8');
  }

  // WebSocket 帧编码 (RFC 6455)
  encodeFrame(text) {
    const payload = Buffer.from(text, 'utf8');
    const length = payload.length;
    let header;

    if (length <= 125) {
      header = Buffer.from([0x81, length]);
    } else if (length <= 65535) {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(length), 2);
    }

    return Buffer.concat([header, payload]);
  }
}

// ==========================================
// 2. 守护进程检测与自动拉起 (Auto-Spawn)
// ==========================================

function checkServerRunning() {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${PORT}/ping`, { timeout: 600 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json.status === 'ok');
        } catch (e) {
          resolve(false);
        }
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function ensureDaemon() {
  const isRunning = await checkServerRunning();
  if (isRunning) return true;

  // 后台无声启动守护进程
  const child = spawn(process.execPath, [__filename, '--daemon'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  });
  child.unref();

  // 等待最多 3 秒直至服务就绪
  for (let i = 0; i < 15; i++) {
    await new Promise(r => setTimeout(r, 200));
    if (await checkServerRunning()) {
      return true;
    }
  }
  return false;
}

// 统一 HTTP 客户端请求入口
function callApi(action, params = {}, timeout = 25000) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({ action, params, timeout });
    const req = http.request({
      hostname: '127.0.0.1',
      port: PORT,
      path: '/api',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        'Authorization': `Bearer ${BRIDGE_TOKEN}`
      },
      timeout
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.success) {
            resolve(json.result);
          } else {
            reject(new Error(json.error || '请求失败'));
          }
        } catch (e) {
          reject(new Error('解析响应失败: ' + data));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('请求超时'));
    });
    req.write(postData);
    req.end();
  });
}

// ==========================================
// 3. 命令行交互 (CLI 命令实现)
// ==========================================

function openExtensionPage() {
  const extPath = path.resolve(__dirname, 'extension').replace(/\\/g, '/');
  console.log(`\n======================================================`);
  console.log(`🧩 Chrome 扩展快速加载助手`);
  console.log(`======================================================`);
  console.log(`扩展本地绝对路径:`);
  console.log(`👉  ${extPath}\n`);
  console.log(`操作步骤:`);
  console.log(`1. 在 Chrome 地址栏访问: chrome://extensions`);
  console.log(`2. 开启右上角「开发者模式」开关`);
  console.log(`3. 点击左上角「加载已解压的扩展程序」，选择上述路径`);
  console.log(`4. 工具栏出现图标并显示 🟢 即完成连接！\n`);

  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', 'chrome://extensions'], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', ['chrome://extensions'], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', ['chrome://extensions'], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch (e) {}
}

async function runCli() {
  const args = process.argv.slice(2);
  const cmd = args[0] ? args[0].toLowerCase() : 'help';

  // 1. 显式启动前台服务模式
  if (cmd === '--server' || cmd === 'server') {
    const server = new BridgeServer(PORT);
    server.start();
    return;
  }

  // 2. 内部使用的后台守护模式
  if (cmd === '--daemon') {
    const server = new BridgeServer(PORT);
    server.start();
    return;
  }

  // 3. 全链路诊断模式 (无需预先拉起守护)
  if (cmd === 'doctor') {
    const { runDoctor } = require('./doctor');
    const fix = args.includes('--fix');
    await runDoctor({ fix });
    return;
  }

  // 4. 多 Agent 一键自动集成安装
  if (cmd === 'install' || cmd === 'setup') {
    const { runInstall } = require('./installer');
    const target = args.find(a => !a.startsWith('-') && a !== cmd) || 'all';
    const dryRun = args.includes('--dry-run') || args.includes('-d');
    runInstall(target, { dryRun });
    return;
  }

  // 5. 快速打开 Chrome 扩展管理页与路径指引
  if (cmd === 'open-ext' || cmd === 'ext') {
    openExtensionPage();
    return;
  }

  // 确保后台服务自动运行
  await ensureDaemon();

  try {
    switch (cmd) {
      case 'list': {
        const tabs = await callApi('list');
        console.log('\n===== 当前 Chrome 打开的标签页列表 =====\n');
        tabs.forEach((t, i) => {
          const activeFlag = t.active ? '🟢 [激活]' : '⚪';
          console.log(`${i + 1}. ${activeFlag} ${t.title || '(无标题)'}`);
          console.log(`   URL: ${t.url}`);
          console.log(`   Tab ID: ${t.id} (Window: ${t.windowId})\n`);
        });
        break;
      }

      case 'read': {
        const query = args[1] || '';
        const res = await callApi('read', { query, urlMatch: query });
        if (res.error) {
          console.error('\n❌ 读取错误:', res.error);
        } else {
          console.log('\n' + (res.markdown || res.text || JSON.stringify(res, null, 2)));
        }
        break;
      }

      case 'click': {
        const selector = args[1];
        const query = args[2] || '';
        if (!selector) {
          console.error('用法: node server.js click <selector或文本> [页面关键词/URL]');
          process.exit(1);
        }
        const res = await callApi('click', { selector, query });
        console.log(JSON.stringify(res, null, 2));
        break;
      }

      case 'fill':
      case 'type': {
        const selector = args[1];
        const value = args[2];
        const query = args[3] || '';
        if (!selector || value === undefined) {
          console.error('用法: node server.js fill <selector> <value> [页面关键词/URL]');
          process.exit(1);
        }
        const res = await callApi('fill', { selector, value, query });
        console.log(JSON.stringify(res, null, 2));
        break;
      }

      case 'scroll': {
        const direction = args[1] || 'down';
        const query = args[2] || '';
        const res = await callApi('scroll', { direction, query });
        console.log(JSON.stringify(res, null, 2));
        break;
      }

      case 'shot': {
        const query = args[1] || '';
        let outFile = args[2];
        if (!outFile) {
          outFile = path.join(process.cwd(), `screenshot_${Date.now()}.png`);
        }
        const res = await callApi('shot', { query });
        if (res.dataUrl) {
          const base64Data = res.dataUrl.replace(/^data:image\/\w+;base64,/, '');
          fs.writeFileSync(outFile, Buffer.from(base64Data, 'base64'));
          console.log(`\n📸 截图成功已保存至: ${outFile}`);
          console.log(`   目标页面: ${res.title} (${res.url})`);
        } else {
          console.error('截图失败:', res.error || res);
        }
        break;
      }

      case 'open':
      case 'nav':
      case 'navigate': {
        const url = args[1];
        const query = args[2] || '';
        if (!url) {
          console.error('用法: node server.js open <URL> [页面关键词]');
          process.exit(1);
        }
        const res = await callApi('navigate', { url, query, active: false });
        console.log(JSON.stringify(res, null, 2));
        break;
      }

      case 'eval': {
        const expression = args[1];
        const query = args[2] || '';
        if (!expression) {
          console.error('用法: node server.js eval <js代码> [页面关键词]');
          process.exit(1);
        }
        const res = await callApi('eval', { expression, query });
        console.log(JSON.stringify(res, null, 2));
        break;
      }

      case 'close': {
        const query = args[1];
        if (!query) {
          console.error('用法: node server.js close <关键词或URL>');
          process.exit(1);
        }
        const res = await callApi('close', { query });
        console.log(JSON.stringify(res, null, 2));
        break;
      }

      case 'clean': {
        const res = await callApi('clean');
        console.log(JSON.stringify(res, null, 2));
        break;
      }

      case 'press':
      case 'key': {
        const key = args[1];
        const selector = args[2] && !args[2].startsWith('--') ? args[2] : null;
        const query = args[3] || '';
        if (!key) {
          console.error('用法: node server.js press <按键名称> [selector] [页面关键词]');
          process.exit(1);
        }
        const res = await callApi('pressKey', { key, selector, query });
        console.log(JSON.stringify(res, null, 2));
        break;
      }

      case 'hover': {
        const selector = args[1];
        const query = args[2] || '';
        if (!selector) {
          console.error('用法: node server.js hover <selector或文本> [页面关键词]');
          process.exit(1);
        }
        const res = await callApi('hover', { selector, query });
        console.log(JSON.stringify(res, null, 2));
        break;
      }

      case 'wait':
      case 'wait-for': {
        const selector = args[1];
        const timeout = args[2] && !isNaN(args[2]) ? parseInt(args[2], 10) : 10000;
        const query = args[3] || '';
        if (!selector) {
          console.error('用法: node server.js wait <selector或文本> [超时毫秒] [页面关键词]');
          process.exit(1);
        }
        const res = await callApi('waitFor', { selector, timeout, state: 'visible', query });
        console.log(JSON.stringify(res, null, 2));
        break;
      }

      case 'select': {
        const selector = args[1];
        const valueOrLabel = args[2];
        const query = args[3] || '';
        if (!selector || valueOrLabel === undefined) {
          console.error('用法: node server.js select <selector> <值或选项文本> [页面关键词]');
          process.exit(1);
        }
        const res = await callApi('selectOption', { selector, value: valueOrLabel, label: valueOrLabel, query });
        console.log(JSON.stringify(res, null, 2));
        break;
      }

      case 'logs':
      case 'console': {
        const query = args[1] || '';
        const level = args[2] || 'all';
        const res = await callApi('getConsoleLogs', { query, level, clear: false, limit: 100 });
        if (res.logs && Array.isArray(res.logs)) {
          console.log(`\n===== 捕获控制台日志 (${res.returnedCount || res.logs.length} 条) =====\n`);
          if (res.logs.length === 0) {
            console.log('（当前页面未捕获到控制台错误或警告）\n');
          } else {
            res.logs.forEach(l => {
              const time = l.timestamp ? new Date(l.timestamp).toLocaleTimeString() : '';
              console.log(`[${time}] [${l.level.toUpperCase()}] ${l.message}`);
              if (l.stack) console.log(`   Stack: ${l.stack}`);
            });
            console.log('');
          }
        } else {
          console.log(JSON.stringify(res, null, 2));
        }
        break;
      }

      case 'help':
      default:
        console.log(`
Agent Browser Bridge CLI (v2.3.0) - 类似 OpenAI Codex 的真实浏览器控制与读取

一键安装与自检:
  node server.js doctor                           🩺 全链路健康检查与状态诊断
  node server.js install [all|agent]              🚀 一键自动注册至各类 AI Agent (WorkBuddy/Claude/Cursor等)
  node server.js open-ext                         🧩 快捷打开 Chrome 扩展管理页与路径指引

日常控制与交互指令:
  node server.js list                             列出当前浏览器所有打开的标签页
  node server.js read [url或标题关键词]            智能匹配标签并读取 Markdown 内容 (含 iframe)
  node server.js open <URL>                       在专属「Agent 任务」分组中后台静默打开新页面
  node server.js click <selector或文本> [关键词]   在目标页面点击元素 (例如 text=确定 或 #btn)
  node server.js hover <selector或文本> [关键词]   鼠标悬停展开下拉列表或 Tooltip 浮层
  node server.js fill <selector> <值> [关键词]     在目标页面的输入框填写内容
  node server.js press <按键名> [selector] [关键词]模拟键盘按键 (Enter, Escape, Tab, 方向键等)
  node server.js select <selector> <值> [关键词]   在原生 <select> 下拉列表中选择选项
  node server.js wait <selector> [超时ms] [关键词] 等待页面异步元素出现或变为可见
  node server.js logs [关键词] [级别]              查看页面控制台错误与未处理异常 (error/warn/all)
  node server.js scroll [down|up|top|bottom]      页面滚动
  node server.js shot [关键词] [输出图片路径]      截取目标网页快照保存为 PNG
  node server.js eval <js代码> [关键词]            在目标页面中执行 JavaScript
  node server.js close <关键词或URL>              关闭匹配的标签页
  node server.js clean                            一键清理所有 Agent 任务分组中的标签页
  node server.js --server                         前台启动守护服务并查看日志
`);
        break;
    }
  } catch (err) {
    console.error('\n❌ 执行失败:', err.message || err);
    process.exit(1);
  }
}

// 模块导出供 MCP Server 直接复用
module.exports = {
  PORT,
  BRIDGE_TOKEN,
  getOrCreateToken,
  BridgeServer,
  ensureDaemon,
  callApi
};

if (require.main === module) {
  runCli();
}
