// popup.js - 显示连接状态与快捷测试
async function updateUI() {
  const statusBadge = document.getElementById('statusBadge');
  const daemonStatus = document.getElementById('daemonStatus');
  const clientStatus = document.getElementById('clientStatus');
  const titleEl = document.getElementById('tabTitle');
  const urlEl = document.getElementById('tabUrl');

  let daemonOk = false;
  let clientsCount = 0;

  try {
    const res = await fetch('http://127.0.0.1:18888/ping', { cache: 'no-store' });
    const data = await res.json();
    if (data.status === 'ok') {
      daemonOk = true;
      clientsCount = data.clients || 0;
      daemonStatus.innerHTML = `<span style="color: #027a48;">🟢 运行中 (PID: ${data.pid || 'OK'})</span>`;
    } else {
      daemonStatus.innerHTML = `<span style="color: #b42318;">🔴 异常</span>`;
    }
  } catch (e) {
    daemonStatus.innerHTML = `<span style="color: #b42318;">🔴 未启动</span>`;
  }

  if (daemonOk) {
    if (clientsCount > 0) {
      clientStatus.innerHTML = `<span style="color: #027a48;">🟢 已连接 (${clientsCount})</span>`;
      statusBadge.textContent = '🟢 正常工作';
      statusBadge.className = 'badge badge-ok';
    } else {
      clientStatus.innerHTML = `<span style="color: #b45309;">⚠️ 未连接 (请重连)</span>`;
      statusBadge.textContent = '⚠️ 待重连';
      statusBadge.className = 'badge badge-warn';
    }
  } else {
    clientStatus.innerHTML = `<span style="color: #666;">⚪ 待检测</span>`;
    statusBadge.textContent = '🔴 服务未启动';
    statusBadge.className = 'badge badge-err';
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

function showFeedback(text, isError = false) {
  const box = document.getElementById('feedbackBox');
  box.style.display = 'block';
  box.style.background = isError ? '#feefef' : '#e6f7ed';
  box.style.color = isError ? '#b42318' : '#027a48';
  box.style.border = isError ? '1px solid #fecaca' : '1px solid #bbf7d0';
  box.textContent = text;
  setTimeout(() => {
    box.style.display = 'none';
  }, 4000);
}

document.getElementById('reconnectBtn').addEventListener('click', async () => {
  const statusBadge = document.getElementById('statusBadge');
  statusBadge.textContent = '正在重连...';
  try {
    await chrome.runtime.sendMessage({ action: 'reconnect_ws' });
  } catch (e) {}
  setTimeout(updateUI, 600);
});

document.getElementById('testReadBtn').addEventListener('click', async () => {
  showFeedback('⏳ 正在提取当前页面...', false);
  try {
    const res = await fetch('http://127.0.0.1:18888/api', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'read', params: { query: '' }, timeout: 8000 })
    });
    const json = await res.json();
    if (json.success && json.result) {
      const len = (json.result.markdown || json.result.text || '').length;
      showFeedback(`✅ 读取成功！提取到 ${len} 字符 Markdown 结构化内容`);
    } else {
      showFeedback(`❌ 读取失败: ${json.error || '未响应'}`, true);
    }
  } catch (err) {
    showFeedback(`❌ 请求失败: ${err.message}`, true);
  }
});

document.getElementById('cleanGroupBtn').addEventListener('click', async () => {
  try {
    const res = await fetch('http://127.0.0.1:18888/api', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'clean', params: {}, timeout: 5000 })
    });
    const json = await res.json();
    if (json.success) {
      showFeedback('🧹 已关闭所有 Agent 临时标签页');
    } else {
      showFeedback(`清理失败: ${json.error}`, true);
    }
  } catch (err) {
    showFeedback(`请求失败: ${err.message}`, true);
  }
});

updateUI();
