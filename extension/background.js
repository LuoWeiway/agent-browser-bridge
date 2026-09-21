/**
 * Codex Chrome Bridge - Background Service Worker
 * 版本: 2.1.0
 * 架构: 仿 OpenAI Codex 浏览器控制架构
 * 核心升级:
 * 1. 任务标签分组 (Tab Groups) 隔离：新建/跳转任务在专属「Codex 任务」分组中进行，绝不覆盖用户正在操作的页面
 * 2. 静默无感操作：所有读取与页面创建默认在后台执行 (active: false)，不抢夺系统焦点与窗口焦点
 * 3. 严格匹配机制：杜绝找不到目标时盲目降级覆盖当前激活页面的 Bug
 * 4. 深度 DOM + Iframe 递归提取成结构化 Markdown
 */

const CODEX_GROUP_TITLE = 'Agent 任务';
let directSocket = null;
let reconnectTimer = null;

// ==========================================
// 1. 保活机制：Offscreen Document 与 Service Worker 连接
// ==========================================

async function ensureOffscreenDocument() {
  if (!chrome.offscreen) return;
  try {
    const existing = await chrome.offscreen.hasDocument();
    if (existing) return;

    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['BLOBS'],
      justification: '保持与本地 Codex CLI / MCP Bridge 服务 (127.0.0.1:18888) 的 WebSocket 长连接'
    });
  } catch (err) {
    console.warn('[Codex Bridge] 无法创建 Offscreen 文档:', err.message);
  }
}

function connectDirectSocket() {
  if (directSocket && (directSocket.readyState === WebSocket.OPEN || directSocket.readyState === WebSocket.CONNECTING)) {
    return;
  }

  try {
    directSocket = new WebSocket('ws://127.0.0.1:18888');

    directSocket.onopen = () => {
      console.log('[Codex Bridge SW] Direct socket 已连接');
      if (reconnectTimer) {
        clearInterval(reconnectTimer);
        reconnectTimer = null;
      }
    };

    directSocket.onmessage = async (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'ping' || msg.type === 'pong') return;
        const responseData = await handleCommand(msg.action, msg.params);
        if (directSocket && directSocket.readyState === WebSocket.OPEN) {
          directSocket.send(JSON.stringify({ id: msg.id, result: responseData }));
        }
      } catch (err) {
        console.error('[Codex Bridge SW] 消息处理异常:', err);
      }
    };

    directSocket.onclose = () => scheduleDirectReconnect();
    directSocket.onerror = () => {
      try { directSocket.close(); } catch (e) {}
    };
  } catch (e) {
    scheduleDirectReconnect();
  }
}

function scheduleDirectReconnect() {
  if (!reconnectTimer) {
    reconnectTimer = setInterval(() => {
      connectDirectSocket();
    }, 3000);
  }
}

chrome.runtime.onStartup.addListener(() => {
  ensureOffscreenDocument();
  connectDirectSocket();
});
chrome.runtime.onInstalled.addListener(() => {
  ensureOffscreenDocument();
  connectDirectSocket();
});
chrome.alarms.create('bridge_keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => {
  ensureOffscreenDocument();
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'reconnect') {
    ensureOffscreenDocument();
    connectDirectSocket();
    sendResponse({ status: 'reconnecting' });
    return false;
  }

  if (msg.id && msg.action) {
    handleCommand(msg.action, msg.params).then(res => {
      sendResponse(res);
    });
    return true; // 异步响应
  }
});

// ==========================================
// 2. 指令主分发器
// ==========================================

async function handleCommand(action, params = {}) {
  try {
    const query = params?.query || params?.urlMatch || '';
    switch (action) {
      case 'list':
        return await getTabList();
      case 'read':
        return await readTabContent(query, params?.full);
      case 'click':
        return await clickElement(query, params?.selector);
      case 'fill':
        return await fillElement(query, params?.selector, params?.value);
      case 'scroll':
        return await scrollTab(query, params?.direction, params?.amount);
      case 'shot':
        return await captureTab(query);
      case 'eval':
        return await evalInTab(query, params?.expression);
      case 'navigate':
      case 'open':
        return await navigateTab(query, params?.url, params?.active);
      case 'close':
        return await closeTab(query, params?.tabId);
      case 'clean':
        return await cleanAgentGroup();
      default:
        return { error: '未知指令: ' + action };
    }
  } catch (err) {
    return { error: err.message || String(err) };
  }
}

// ==========================================
// 3. 标签页匹配与 Codex 任务分组管理
// ==========================================

function isContentUrl(url) {
  if (!url) return false;
  return !url.startsWith('chrome://') &&
         !url.startsWith('edge://') &&
         !url.startsWith('chrome-extension://') &&
         !url.startsWith('about:');
}

/**
 * 智能查找最契合的标签页
 * @param {string} query 关键词或URL
 * @param {boolean} allowFallback 是否允许找不到时降级到当前激活页（严格模式下为 false，防覆盖用户操作）
 */
async function getBestTab(query, allowFallback = false) {
  const allTabs = await chrome.tabs.query({});
  if (!allTabs || allTabs.length === 0) return null;

  // 1. 如果没有传入 query，根据 allowFallback 决定是否返回当前活动页
  if (!query || typeof query !== 'string' || !query.trim()) {
    if (!allowFallback) return null;
    const focusedTabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (focusedTabs.length > 0 && isContentUrl(focusedTabs[0].url)) return focusedTabs[0];

    const anyActive = allTabs.find(t => t.active && isContentUrl(t.url));
    if (anyActive) return anyActive;

    const anyContent = allTabs.find(t => isContentUrl(t.url));
    return anyContent || allTabs[0];
  }

  const q = query.trim().toLowerCase();

  // 2. 打分排序算法
  let bestTab = null;
  let highestScore = -1;

  for (const tab of allTabs) {
    if (!isContentUrl(tab.url)) continue;

    let score = 0;
    const tabUrl = (tab.url || '').toLowerCase();
    const tabTitle = (tab.title || '').toLowerCase();

    // 完整 URL 精确匹配
    if (tabUrl === q) score += 1000;
    // URL 前缀或包含
    else if (tabUrl.includes(q)) score += 300;

    // 标题完全包含
    if (tabTitle.includes(q)) score += 200;

    // 分词匹配（针对“禅道Bug”、“21005”等关键词）
    const tokens = q.split(/[\s\-_/\\,，。]+/);
    for (const token of tokens) {
      if (!token) continue;
      if (tabTitle.includes(token)) score += 80;
      if (tabUrl.includes(token)) score += 60;
    }

    // 活跃状态小加权
    if (tab.active) score += 10;

    if (score > highestScore) {
      highestScore = score;
      bestTab = tab;
    }
  }

  // 只要有任何明确匹配命中即返回
  if (bestTab && highestScore >= 60) {
    return bestTab;
  }

  // 3. 若未命中且明确允许降级（例如明确针对当前页进行 read）
  if (allowFallback) {
    const fallbackTabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return fallbackTabs[0] || allTabs[0];
  }

  return null;
}

/**
 * 将标签页加入到 Codex 专属任务分组，实现与用户日常标签的清晰隔离
 */
async function addTabToCodexGroup(tabId, windowId) {
  if (!chrome.tabGroups) return null;
  try {
    const groups = await chrome.tabGroups.query({ windowId, title: CODEX_GROUP_TITLE });
    let groupId = (groups && groups.length > 0) ? groups[0].id : null;

    if (groupId) {
      await chrome.tabs.group({ tabIds: [tabId], groupId });
    } else {
      groupId = await chrome.tabs.group({ tabIds: [tabId] });
      await chrome.tabGroups.update(groupId, {
        title: CODEX_GROUP_TITLE,
        color: 'blue',
        collapsed: false
      });
    }
    return groupId;
  } catch (err) {
    console.warn('[Codex Bridge] TabGroups 组织提示:', err.message);
    return null;
  }
}

async function getTabList() {
  const tabs = await chrome.tabs.query({});
  return tabs.map(t => ({
    id: t.id,
    title: t.title,
    url: t.url,
    active: t.active,
    windowId: t.windowId,
    groupId: t.groupId
  }));
}

// ==========================================
// 4. 深度内容提取器 (支持主页面 + 跨域 iframe)
// ==========================================

async function readTabContent(query, full = false) {
  // 若未传参则允许读取当前激活页，若传参则严格匹配
  const tab = await getBestTab(query, !query);
  if (!tab || !tab.id) {
    return { error: '未找到匹配的 Chrome 标签页: ' + (query || '当前页') };
  }

  if (!isContentUrl(tab.url)) {
    return {
      title: tab.title,
      url: tab.url,
      tabId: tab.id,
      text: `[提示] 目标页面为浏览器内置页面 (${tab.url})，受 Chrome 安全策略保护无法提取 DOM。`
    };
  }

  try {
    // 注入提取脚本，allFrames: true 确保穿透所有 iframe (如禅道内部 QA 列表)
    const frameResults = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: () => {
        const isTop = (window === window.top);

        const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4'))
          .map(h => {
            const level = h.tagName.toLowerCase();
            const text = (h.innerText || '').trim();
            return text ? `${level}: ${text}` : null;
          })
          .filter(Boolean)
          .slice(0, 30);

        const inputs = Array.from(document.querySelectorAll('input:not([type="hidden"]), select, textarea'))
          .map(el => {
            const label = el.labels && el.labels[0] ? el.labels[0].innerText.trim() : '';
            const name = el.name || el.id || el.placeholder || '';
            const val = el.value !== undefined ? String(el.value).trim() : '';
            const desc = label || name || '未命名输入框';
            return desc ? `[输入项] ${desc} (value: "${val.slice(0, 50)}")` : null;
          })
          .filter(Boolean)
          .slice(0, 25);

        const buttons = Array.from(document.querySelectorAll('button, a.btn, input[type="button"], input[type="submit"]'))
          .map(b => (b.innerText || b.value || '').trim())
          .filter(t => t.length > 0 && t.length < 30)
          .slice(0, 20);

        // 提取主要可点击导航/操作链接
        const links = Array.from(document.querySelectorAll('a[href]'))
          .map(a => {
            const text = (a.innerText || '').replace(/\s+/g, ' ').trim();
            const href = a.getAttribute('href') || '';
            if (!text || text.length > 60 || href.startsWith('javascript:') || href === '#') return null;
            return `[${text}](${href})`;
          })
          .filter(Boolean)
          .slice(0, 25);

        const tables = Array.from(document.querySelectorAll('table')).slice(0, 5).map(tbl => {
          const rows = Array.from(tbl.querySelectorAll('tr')).slice(0, 40);
          if (rows.length === 0) return '';
          const mdRows = rows.map(tr => {
            const cells = Array.from(tr.querySelectorAll('th, td')).map(c => (c.innerText || '').replace(/\s+/g, ' ').trim());
            return '| ' + cells.join(' | ') + ' |';
          });
          if (mdRows.length > 1) {
            const colCount = rows[0].querySelectorAll('th, td').length;
            const divider = '| ' + new Array(colCount).fill('---').join(' | ') + ' |';
            mdRows.splice(1, 0, divider);
          }
          return mdRows.join('\n');
        }).filter(Boolean);

        let bodyText = '';
        if (document.body) {
          const mainContainer = document.querySelector('main, article, #content, .content') || document.body;
          bodyText = (mainContainer.innerText || '')
            .replace(/[ \t]+/g, ' ')
            .replace(/\n\s*\n+/g, '\n\n')
            .trim();
        }

        return {
          isTop,
          title: document.title || '',
          url: window.location.href,
          headings,
          inputs,
          buttons,
          links,
          tables,
          bodyText: bodyText.slice(0, 25000)
        };
      }
    });

    if (!frameResults || frameResults.length === 0) {
      return { title: tab.title, url: tab.url, text: '(未能获取页面渲染内容)' };
    }

    let output = `# ${tab.title || '无标题'}\n`;
    output += `> 网址: ${tab.url}\n> 标签页 ID: ${tab.id}\n\n`;

    const topFrame = frameResults.find(f => f.result?.isTop)?.result || frameResults[0].result;
    if (topFrame) {
      if (topFrame.headings && topFrame.headings.length > 0) {
        output += `### 页面大纲\n${topFrame.headings.map(h => '- ' + h).join('\n')}\n\n`;
      }
      if (topFrame.inputs && topFrame.inputs.length > 0) {
        output += `### 表单控件\n${topFrame.inputs.map(i => '- ' + i).join('\n')}\n\n`;
      }
      if (topFrame.buttons && topFrame.buttons.length > 0) {
        output += `### 交互按钮\n${topFrame.buttons.map(b => '`' + b + '`').join('  ')}\n\n`;
      }
      if (topFrame.links && topFrame.links.length > 0) {
        output += `### 页面关键链接\n${topFrame.links.map(l => '- ' + l).join('\n')}\n\n`;
      }
      if (topFrame.tables && topFrame.tables.length > 0) {
        output += `### 数据表格\n${topFrame.tables.join('\n\n')}\n\n`;
      }
    }

    const childFrames = frameResults.filter(f => !f.result?.isTop && f.result?.bodyText?.trim());
    if (childFrames.length > 0) {
      output += `### 内部子框架内容 (${childFrames.length} 个 iframe)\n`;
      childFrames.forEach((cf, idx) => {
        const res = cf.result;
        output += `\n#### [Iframe ${idx + 1}] ${res.url}\n`;
        if (res.tables && res.tables.length > 0) {
          output += `**表格数据:**\n${res.tables.join('\n\n')}\n\n`;
        }
        output += `**正文内容:**\n${res.bodyText.slice(0, 10000)}\n`;
      });
    } else if (topFrame && topFrame.bodyText) {
      output += `### 正文内容\n${topFrame.bodyText}\n`;
    }

    return {
      title: tab.title,
      url: tab.url,
      tabId: tab.id,
      markdown: output.slice(0, 32000)
    };
  } catch (err) {
    return {
      title: tab.title,
      url: tab.url,
      error: '读取页面内容异常: ' + err.message
    };
  }
}

// ==========================================
// 5. 交互控制 (纯后台静默驱动，不劫持焦点)
// ==========================================

async function clickElement(query, selector) {
  const tab = await getBestTab(query, false);
  if (!tab || !tab.id) return { error: '未找到匹配的标签页: ' + query };

  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: (sel) => {
        let el = null;
        if (sel.startsWith('text=')) {
          const textToFind = sel.slice(5).trim();
          const elements = Array.from(document.querySelectorAll('button, a, input[type="button"], input[type="submit"], div, span'));
          el = elements.find(e => (e.innerText || e.value || '').trim() === textToFind) ||
               elements.find(e => (e.innerText || e.value || '').includes(textToFind));
        } else {
          try {
            el = document.querySelector(sel);
          } catch (e) {}
        }

        if (!el) return { success: false, notFound: true };

        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.focus();

        const opts = { bubbles: true, cancelable: true, view: window };
        // 派发 PointerEvents 与 MouseEvents，兼顾 React 18+ / Vue 3 / 原生前端交互
        try { el.dispatchEvent(new PointerEvent('pointerdown', opts)); } catch (e) {}
        el.dispatchEvent(new MouseEvent('mousedown', opts));
        try { el.dispatchEvent(new PointerEvent('pointerup', opts)); } catch (e) {}
        el.dispatchEvent(new MouseEvent('mouseup', opts));
        el.click();

        return {
          success: true,
          tagName: el.tagName,
          text: (el.innerText || el.value || '').slice(0, 40)
        };
      },
      args: [selector]
    });

    const hit = res.find(r => r.result && r.result.success);
    if (hit) {
      return { success: true, tabId: tab.id, target: hit.result };
    }
    return { success: false, error: `未能在页面 (${tab.title}) 中找到元素: ${selector}` };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function fillElement(query, selector, value) {
  const tab = await getBestTab(query, false);
  if (!tab || !tab.id) return { error: '未找到匹配的标签页: ' + query };

  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: (sel, val) => {
        const el = document.querySelector(sel);
        if (!el) return { success: false };

        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.focus();

        // 兼容 React 16/17/18+ 受控组件及原生 Input/Textarea Setter
        const prototype = el instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
        const nativeSetter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
        if (nativeSetter) {
          nativeSetter.call(el, val);
        } else {
          el.value = val;
        }

        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));

        return { success: true, name: el.name || el.id || el.tagName };
      },
      args: [selector, value]
    });

    const hit = res.find(r => r.result && r.result.success);
    if (hit) {
      return { success: true, tabId: tab.id, field: hit.result.name, value };
    }
    return { success: false, error: `未找到输入框: ${selector}` };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function scrollTab(query, direction = 'down', amount = 600) {
  const tab = await getBestTab(query, false);
  if (!tab || !tab.id) return { error: '未找到匹配的标签页: ' + query };

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (dir, amt) => {
        if (dir === 'top') {
          window.scrollTo({ top: 0, behavior: 'smooth' });
        } else if (dir === 'bottom') {
          window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
        } else if (dir === 'up') {
          window.scrollBy({ top: -amt, behavior: 'smooth' });
        } else {
          window.scrollBy({ top: amt, behavior: 'smooth' });
        }
      },
      args: [direction, amount]
    });
    return { success: true, tabId: tab.id, direction };
  } catch (e) {
    return { error: e.message };
  }
}

async function captureTab(query) {
  const tab = await getBestTab(query, true);
  if (!tab || !tab.id) return { error: '未找到匹配的标签页: ' + query };

  try {
    // 仅在当前标签已被激活时直接截取，绝不主动 update 强制置顶切换，防止打扰用户
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    return {
      success: true,
      tabId: tab.id,
      title: tab.title,
      url: tab.url,
      dataUrl
    };
  } catch (e) {
    return { error: '截图需要标签页处于视口可见状态: ' + e.message };
  }
}

async function evalInTab(query, expression) {
  // 严格匹配目标标签页，哪怕在后台运行也能静默求值，决不抢焦点
  const tab = await getBestTab(query, false);
  if (!tab || !tab.id) return { error: '未找到匹配的标签页: ' + query };

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (code) => {
        try {
          return { success: true, result: window.eval(code) };
        } catch (e) {
          return { success: false, error: e.message };
        }
      },
      args: [expression]
    });

    if (results && results[0] && results[0].result) {
      return results[0].result;
    }
    return { error: '无返回值' };
  } catch (e) {
    return { error: e.message };
  }
}

/**
 * 导航/打开新页面核心（对齐 Codex 任务分组隔离机制）
 * 核心原则：绝不覆写任何已有标签页！始终在专属「Codex 任务」分组中以 active: false 静默新建
 */
async function navigateTab(query, url, isActive = false) {
  const focusedWin = await chrome.windows.getLastFocused();
  const windowId = focusedWin ? focusedWin.id : undefined;

  // 始终新建独立后台标签页，绝对不覆盖任何现有正在操作的标签页
  const newTab = await chrome.tabs.create({
    url,
    active: !!isActive, // 默认 false，后台静默打开，绝不抢占用户当前视窗！
    windowId
  });

  if (newTab && newTab.id) {
    await addTabToCodexGroup(newTab.id, newTab.windowId);
  }

  return {
    success: true,
    tabId: newTab.id,
    url,
    action: 'created_in_group',
    group: CODEX_GROUP_TITLE
  };
}

/**
 * 关闭指定标签页
 */
async function closeTab(query, tabId) {
  let targetId = tabId;
  if (!targetId && query) {
    const matched = await getBestTab(query, false);
    if (matched && matched.id) targetId = matched.id;
  }
  if (!targetId) return { error: '未找到要关闭的标签页: ' + query };

  await chrome.tabs.remove(targetId);
  return { success: true, closedTabId: targetId };
}

/**
 * 一键清理所有 Agent 任务分组中的后台标签页
 */
async function cleanAgentGroup() {
  if (!chrome.tabGroups) return { error: '当前浏览器环境不支持 tabGroups' };
  try {
    const groups = await chrome.tabGroups.query({ title: CODEX_GROUP_TITLE });
    if (!groups || groups.length === 0) {
      return { success: true, message: '当前没有打开的 Agent 任务分组' };
    }

    let closed = 0;
    for (const g of groups) {
      const tabs = await chrome.tabs.query({ groupId: g.id });
      const ids = tabs.map(t => t.id).filter(Boolean);
      if (ids.length > 0) {
        await chrome.tabs.remove(ids);
        closed += ids.length;
      }
    }
    return { success: true, closedCount: closed, groupTitle: CODEX_GROUP_TITLE };
  } catch (err) {
    return { error: '清理分组异常: ' + err.message };
  }
}
