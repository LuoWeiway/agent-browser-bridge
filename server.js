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

const PORT = 18888;
const PID_FILE = path.join(__dirname, '.bridge_daemon.pid');

// ==========================================
// 1. WebSocket 与 HTTP 桥接服务端
// ==========================================

class BridgeServer {
  constructor(port = PORT) {
    this.port = port;
    this.clients = new Set();
    this.pendingRequests = new Map();
    this.reqId = 1;

    this.server = http.createServer(async (req, res) => {
      // 允许本地跨域与 OPTIONS 预检
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      // 健康检查与客户端计数
      if (req.url === '/ping') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', clients: this.clients.size, pid: process.pid }));
        return;
      }

      // 核心 API 分发接口
      if (req.url === '/api' && req.method === 'POST') {
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

      res.writeHead(404);
      res.end('Not Found');
    });

    // 处理 WebSocket 协议升级握手
    this.server.on('upgrade', (req, socket, head) => {
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

      // 广播给所有已连接客户端（扩展的 offscreen/background）
      for (const client of this.clients) {
        try {
          client.socket.write(encoded);
        } catch (e) {
          this.clients.delete(client);
        }
      }
    });
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
        'Content-Length': Buffer.byteLength(postData)
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

      case 'help':
      default:
        console.log(`
Agent Browser Bridge CLI - 类似 OpenAI Codex 的真实浏览器控制与读取

常用指令:
  node server.js list                             列出当前浏览器所有打开的标签页
  node server.js read [url或标题关键词]            智能匹配标签并读取 Markdown 内容 (含 iframe)
  node server.js open <URL>                       在专属「Agent 任务」分组中后台静默打开新页面
  node server.js click <selector或文本> [关键词]   在目标页面点击元素 (例如 text=确定 或 #btn)
  node server.js fill <selector> <值> [关键词]     在目标页面的输入框填写内容
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
  ensureDaemon,
  callApi
};

if (require.main === module) {
  runCli();
}
