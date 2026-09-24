/**
 * Agent Browser Bridge - Health & Environment Doctor
 * 零第三方依赖：全链路健康状态检查与自愈引导
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { getAgentTargets } = require('./installer');

const EXTENSION_DIR = path.resolve(__dirname, 'extension').replace(/\\/g, '/');

function pingBridge() {
  return new Promise((resolve) => {
    const req = http.get('http://127.0.0.1:18888/ping', { timeout: 2000 }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve({ ok: true, data: json });
        } catch (e) {
          resolve({ ok: false, error: '返回非 JSON 数据' });
        }
      });
    });

    req.on('error', (err) => {
      resolve({ ok: false, error: err.message });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, error: '连接超时 (127.0.0.1:18888)' });
    });
  });
}

function probeTabs() {
  const { BRIDGE_TOKEN } = require('./server');
  return new Promise((resolve) => {
    const postData = JSON.stringify({ action: 'list', params: {}, timeout: 5000 });
    const req = http.request('http://127.0.0.1:18888/api', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        'Authorization': `Bearer ${BRIDGE_TOKEN}`
      },
      timeout: 6000
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json);
        } catch (e) {
          resolve({ success: false, error: '解析响应异常' });
        }
      });
    });

    req.on('error', err => resolve({ success: false, error: err.message }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ success: false, error: '探针超时' });
    });

    req.write(postData);
    req.end();
  });
}

function checkSecurityOrigin() {
  return new Promise((resolve) => {
    const req = http.request('http://127.0.0.1:18888/ping', {
      method: 'GET',
      headers: { 'Origin': 'http://malicious-site.com' },
      timeout: 2000
    }, (res) => {
      resolve(res.statusCode === 403);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

async function runDoctor(options = {}) {
  const autoFix = !!options.fix;
  console.log(`\n======================================================`);
  console.log(`🩺 Agent Browser Bridge - 全链路诊断报告${autoFix ? ' [自愈修复模式]' : ''}`);
  console.log(`======================================================\n`);

  const issues = [];

  // 1. Node.js 环境检查
  const nodeVer = process.version;
  const majorVer = parseInt(nodeVer.replace('v', '').split('.')[0], 10);
  if (majorVer >= 18) {
    console.log(`✅ [1/6] Node.js 运行环境: ${nodeVer} (符合要求 >= 18)`);
  } else {
    console.log(`❌ [1/6] Node.js 运行环境: ${nodeVer} (建议升级至 Node.js 18+)`);
    issues.push('请升级 Node.js 至 18 或更高版本以获得更佳的 WebSocket / Fetch 支持');
  }

  // 2. 本地安全令牌检查 (.bridge_token)
  const tokenFile = path.join(__dirname, '.bridge_token');
  let tokenReady = fs.existsSync(tokenFile);
  if (!tokenReady && autoFix) {
    try {
      require('./server').getOrCreateToken();
      tokenReady = fs.existsSync(tokenFile);
    } catch (e) {}
  }
  if (tokenReady) {
    console.log(`✅ [2/6] 安全防护体系: 已启用 (本地会话令牌已生成，CSRF 防护生效)`);
  } else {
    console.log(`⚠️ [2/6] 安全防护体系: 待就绪 (首次启动守护进程将自动生成 .bridge_token)`);
  }

  // 3. 守护进程及端口检查
  let pingRes = await pingBridge();
  if (!pingRes.ok && autoFix) {
    console.log(`🔧 [自愈] 正在后台启动守护进程...`);
    try {
      await require('./server').ensureDaemon();
      pingRes = await pingBridge();
    } catch (e) {}
  }

  if (pingRes.ok) {
    const clients = pingRes.data.clients || 0;
    const pid = pingRes.data.pid || '未知';
    console.log(`✅ [3/6] Bridge 守护进程: 正在运行 (PID: ${pid}, 端口: 127.0.0.1:18888)`);

    // 4. Chrome 扩展连接状态
    if (clients > 0) {
      console.log(`✅ [4/6] Chrome 扩展连接: 正常 (已连接 ${clients} 个客户端)`);

      // 5. 浏览器实时通信验证
      process.stdout.write(`   正在探测浏览器标签页... `);
      const probeRes = await probeTabs();
      if (probeRes.success && Array.isArray(probeRes.result)) {
        const tabs = probeRes.result;
        const activeTab = tabs.find(t => t.active);
        console.log(`成功通信！`);
        console.log(`✅ [5/6] 浏览器页面数据: 实时获取成功 (共 ${tabs.length} 个标签页)`);
        if (activeTab) {
          console.log(`   当前聚焦页面: "${activeTab.title || '(无标题)'}"`);
          console.log(`   URL: ${activeTab.url}`);
        }
      } else {
        console.log(`通信超时或异常: ${probeRes.error || '未响应'}`);
        console.log(`⚠️ [5/6] 浏览器页面数据: 未能成功提取标签页`);
        issues.push('Chrome 扩展已连入但指令未正常响应，请点击扩展图标中的「🔄 重新加载」或重新启动 Chrome');
      }
    } else {
      console.log(`❌ [4/6] Chrome 扩展连接: 未连接 (clients: 0)`);
      console.log(`⚠️ [5/6] 浏览器页面数据: 跳过 (因扩展未连入)`);
      issues.push(
        `Chrome 扩展尚未加载或休眠。\n` +
        `   👉 快捷方式: 运行 "node server.js open-ext" 可自动打开 Chrome 扩展管理页\n` +
        `   👉 手动加载: 访问 chrome://extensions 开启右上角「开发者模式」，选择以下目录加载:\n` +
        `      ${EXTENSION_DIR}`
      );
    }
  } else {
    console.log(`⚠️ [3/6] Bridge 守护进程: 未运行 (${pingRes.error})`);
    console.log(`⚪ [4/6] Chrome 扩展连接: 无法检测 (守护进程未启动)`);
    console.log(`⚪ [5/6] 浏览器页面数据: 跳过`);
    issues.push(
      `守护进程尚未启动。在终端中执行 "node server.js list" 即可自动在后台拉起，或执行 "node server.js doctor --fix"。`
    );
  }

  // 6. AI Agent 集成状态扫描
  console.log(`\n🔍 [6/6] AI Agent 集成状态扫描:`);
  const targets = getAgentTargets();
  let configuredAgents = 0;

  for (const t of targets) {
    if (fs.existsSync(t.configPath)) {
      try {
        const content = fs.readFileSync(t.configPath, 'utf8');
        const json = JSON.parse(content);
        if (json.mcpServers && json.mcpServers['agent-browser-bridge']) {
          console.log(`   ✅ ${t.name}: 已注册`);
          configuredAgents++;
          continue;
        }
      } catch (e) {}

      if (autoFix) {
        const installRes = require('./installer').installTarget(t);
        if (installRes.installed) {
          console.log(`   🔧 [自愈] ${t.name}: 成功自动注册配置！`);
          configuredAgents++;
          continue;
        }
      }

      console.log(`   ⚠️ ${t.name}: 配置文件存在但尚未注册 agent-browser-bridge`);
    } else {
      console.log(`   ⚪ ${t.name}: 未安装/未检测到配置`);
    }
  }

  if (configuredAgents === 0) {
    issues.push('尚未为任何 AI Agent 注册此工具。运行 "node server.js install all" 可一键完成注册！');
  }

  // 总结与修复指引
  console.log(`\n------------------------------------------------------`);
  if (issues.length === 0) {
    console.log(`🎉 诊断结果: 全链路通畅！所有组件正常运作，Agent 可无缝控制浏览器。`);
  } else {
    console.log(`⚠️ 发现 ${issues.length} 个待处理项:`);
    issues.forEach((item, idx) => {
      console.log(`\n${idx + 1}. ${item}`);
    });
  }
  console.log(`------------------------------------------------------\n`);

  return issues.length === 0;
}

module.exports = {
  runDoctor
};

if (require.main === module) {
  const args = process.argv.slice(2);
  const fix = args.includes('--fix');
  runDoctor({ fix }).catch(err => console.error(err));
}
