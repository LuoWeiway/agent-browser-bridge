// offscreen.js - 维持与本地 127.0.0.1:18888 的 WebSocket 稳定长连接
let socket = null;
let reconnectTimer = null;
let pingTimer = null;
let backoffMs = 1000;
const MAX_BACKOFF_MS = 10000;

function connect() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }

  try {
    socket = new WebSocket('ws://127.0.0.1:18888');

    socket.onopen = () => {
      console.log('[Agent Bridge Offscreen] Connected to 127.0.0.1:18888');
      backoffMs = 1000; // 连接成功重置退避时间

      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }

      // 注册自身角色，供服务端做单路由分发，避免双连重复执行
      try {
        socket.send(JSON.stringify({ type: 'register', role: 'offscreen' }));
      } catch (e) {}

      if (!pingTimer) {
        pingTimer = setInterval(() => {
          if (socket && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: 'ping' }));
          }
        }, 5000);
      }
    };

    socket.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'pong' || msg.type === 'ping') return;

        // 将指令转发给 background 处理（background 拥有 tabs, scripting 等扩展特权）
        chrome.runtime.sendMessage(msg, (response) => {
          if (socket && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({
              id: msg.id,
              result: response
            }));
          }
        });
      } catch (err) {
        console.error('[Agent Bridge Offscreen] Message processing error:', err);
      }
    };

    socket.onclose = () => {
      scheduleReconnect();
    };

    socket.onerror = () => {
      try { socket.close(); } catch (e) {}
    };
  } catch (e) {
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }

  if (!reconnectTimer) {
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, backoffMs);

    // 指数退避：每次重连失败增加 1.8 倍，最大 10 秒
    backoffMs = Math.min(MAX_BACKOFF_MS, Math.round(backoffMs * 1.8));
  }
}

// 监听网络恢复事件，立即触发重连
window.addEventListener('online', () => {
  backoffMs = 1000;
  connect();
});

// 接收来自 popup 或 background 的显式重连广播
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'reconnect_ws' || request.action === 'reconnect') {
    backoffMs = 1000;
    connect();
    sendResponse({ status: 'reconnecting' });
    return false;
  }
});

connect();
