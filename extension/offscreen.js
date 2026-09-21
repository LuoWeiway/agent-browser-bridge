// offscreen.js - 维持与本地 127.0.0.1:18888 的 WebSocket 稳定长连接
let socket = null;
let reconnectTimer = null;
let pingTimer = null;

function connect() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }

  try {
    socket = new WebSocket('ws://127.0.0.1:18888');

    socket.onopen = () => {
      console.log('[Codex Bridge Offscreen] Connected to 127.0.0.1:18888');
      if (reconnectTimer) {
        clearInterval(reconnectTimer);
        reconnectTimer = null;
      }
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

        // 将指令转发给 background 处理（background 拥有 tabs, scripting, debugger 等最高扩展权限）
        chrome.runtime.sendMessage(msg, (response) => {
          if (socket && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({
              id: msg.id,
              result: response
            }));
          }
        });
      } catch (err) {
        console.error('[Codex Bridge Offscreen] Message processing error:', err);
      }
    };

    socket.onclose = () => {
      scheduleReconnect();
    };

    socket.onerror = () => {
      socket.close();
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
    reconnectTimer = setInterval(() => {
      connect();
    }, 2500);
  }
}

// 接收来自 popup 或 background 的显式重连广播
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'reconnect_ws') {
    connect();
    sendResponse({ status: 'reconnecting' });
  }
});

connect();
