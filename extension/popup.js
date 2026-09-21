// popup.js - 显示连接状态与标签信息
async function updateUI() {
  const statusEl = document.getElementById('status');
  const titleEl = document.getElementById('tabTitle');
  const urlEl = document.getElementById('tabUrl');

  try {
    const res = await fetch('http://127.0.0.1:18888/ping', { cache: 'no-store' });
    const data = await res.json();
    if (data.status === 'ok') {
      statusEl.textContent = '🟢 已连接 (' + (data.clients || 1) + ')';
      statusEl.className = 'badge badge-ok';
    } else {
      statusEl.textContent = '🔴 异常';
      statusEl.className = 'badge badge-err';
    }
  } catch (e) {
    statusEl.textContent = '🔴 未连接服务';
    statusEl.className = 'badge badge-err';
  }

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      titleEl.textContent = tab.title || '(无标题)';
      urlEl.textContent = tab.url || '';
    } else {
      titleEl.textContent = '无激活标签页';
      urlEl.textContent = '';
    }
  } catch (e) {
    titleEl.textContent = '无法获取标签页';
  }
}

document.getElementById('reconnectBtn').addEventListener('click', async () => {
  const statusEl = document.getElementById('status');
  statusEl.textContent = '正在重连...';
  try {
    await chrome.runtime.sendMessage({ action: 'reconnect_ws' });
  } catch (e) {}
  setTimeout(updateUI, 800);
});

updateUI();
