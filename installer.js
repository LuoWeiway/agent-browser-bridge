/**
 * Agent Browser Bridge - Multi-Agent Auto-Installer
 * 零第三方依赖：支持自动探测并一键集成至主流 AI Agent
 *
 * 支持目标：
 * - WorkBuddy (~/.workbuddy-ai/mcp.json)
 * - Claude Code (~/.claude.json)
 * - Claude Desktop (%APPDATA%/Claude/claude_desktop_config.json)
 * - Cursor (~/.cursor/mcp.json)
 * - Windsurf (~/.codeium/windsurf/mcp_config.json)
 * - Roo Code / Cline (VS Code Extension settings)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const SERVER_NAME = 'agent-browser-bridge';
const MCP_SCRIPT_PATH = path.resolve(__dirname, 'mcp.js').replace(/\\/g, '/');

function getHomeDir() {
  return os.homedir();
}

function getAppDataDir() {
  return process.env.APPDATA || (process.platform === 'darwin'
    ? path.join(getHomeDir(), 'Library', 'Application Support')
    : path.join(getHomeDir(), '.config'));
}

// 预定义各 Agent 目标配置定义
function getAgentTargets() {
  const home = getHomeDir();
  const appData = getAppDataDir();

  return [
    {
      id: 'workbuddy',
      name: 'WorkBuddy AI',
      configPath: path.join(home, '.workbuddy-ai', 'mcp.json'),
      detectDir: path.join(home, '.workbuddy-ai'),
      getConfig: () => ({
        command: 'node',
        args: [MCP_SCRIPT_PATH]
      })
    },
    {
      id: 'claude-code',
      name: 'Claude Code (CLI)',
      configPath: path.join(home, '.claude.json'),
      detectDir: path.join(home, '.claude'),
      getConfig: () => ({
        type: 'stdio',
        command: 'node',
        args: [MCP_SCRIPT_PATH],
        env: {}
      })
    },
    {
      id: 'claude-desktop',
      name: 'Claude Desktop',
      configPath: process.platform === 'darwin'
        ? path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
        : path.join(appData, 'Claude', 'claude_desktop_config.json'),
      detectDir: process.platform === 'darwin'
        ? path.join(home, 'Library', 'Application Support', 'Claude')
        : path.join(appData, 'Claude'),
      getConfig: () => ({
        command: 'node',
        args: [MCP_SCRIPT_PATH]
      })
    },
    {
      id: 'cursor',
      name: 'Cursor Editor',
      configPath: path.join(home, '.cursor', 'mcp.json'),
      detectDir: path.join(home, '.cursor'),
      getConfig: () => ({
        command: 'node',
        args: [MCP_SCRIPT_PATH]
      })
    },
    {
      id: 'windsurf',
      name: 'Windsurf Editor',
      configPath: path.join(home, '.codeium', 'windsurf', 'mcp_config.json'),
      detectDir: path.join(home, '.codeium', 'windsurf'),
      getConfig: () => ({
        command: 'node',
        args: [MCP_SCRIPT_PATH]
      })
    },
    {
      id: 'roo-cline',
      name: 'Roo Code (VS Code Extension)',
      configPath: path.join(appData, 'Code', 'User', 'globalStorage', 'rooveterinaryinc.roo-cline', 'settings', 'cline_mcp_settings.json'),
      detectDir: path.join(appData, 'Code', 'User', 'globalStorage', 'rooveterinaryinc.roo-cline'),
      getConfig: () => ({
        command: 'node',
        args: [MCP_SCRIPT_PATH],
        disabled: false,
        autoApprove: []
      })
    },
    {
      id: 'cline',
      name: 'Cline (VS Code Extension)',
      configPath: path.join(appData, 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json'),
      detectDir: path.join(appData, 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev'),
      getConfig: () => ({
        command: 'node',
        args: [MCP_SCRIPT_PATH],
        disabled: false,
        autoApprove: []
      })
    }
  ];
}

function readJsonFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    return { __parseError: err.message };
  }
}

function writeJsonFile(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // 备份原文件
  if (fs.existsSync(filePath)) {
    const bakPath = `${filePath}.bak`;
    try {
      fs.copyFileSync(filePath, bakPath);
    } catch (e) {}
  }

  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

/**
 * 安装/注册至指定目标
 */
function installTarget(target, dryRun = false) {
  const result = {
    id: target.id,
    name: target.name,
    configPath: target.configPath,
    detected: false,
    installed: false,
    message: ''
  };

  const detected = fs.existsSync(target.detectDir) || fs.existsSync(target.configPath);
  result.detected = detected;

  let json = readJsonFile(target.configPath);
  if (json && json.__parseError) {
    result.message = `配置文件解析失败 (${json.__parseError})，请手动检查`;
    return result;
  }

  if (!json) {
    json = {};
  }

  if (!json.mcpServers || typeof json.mcpServers !== 'object') {
    json.mcpServers = {};
  }

  const existing = json.mcpServers[SERVER_NAME];
  const targetConfig = target.getConfig();

  if (existing && JSON.stringify(existing) === JSON.stringify(targetConfig)) {
    result.installed = true;
    result.message = '已配置且配置项一致（跳过）';
    return result;
  }

  json.mcpServers[SERVER_NAME] = targetConfig;

  if (dryRun) {
    result.message = `[Dry-run] 将写入至: ${target.configPath}`;
    return result;
  }

  try {
    writeJsonFile(target.configPath, json);
    result.installed = true;
    result.message = `成功写入配置 (已自动备份原文件至 .bak)`;
  } catch (err) {
    result.message = `写入失败: ${err.message}`;
  }

  return result;
}

/**
 * 扫描并执行安装
 */
function runInstall(targetName = 'all', options = {}) {
  const targets = getAgentTargets();
  const dryRun = !!options.dryRun;

  console.log(`\n======================================================`);
  console.log(`🚀 Agent Browser Bridge - AI Agent 自动集成助手`);
  console.log(`======================================================`);
  console.log(`MCP 脚本绝对路径: ${MCP_SCRIPT_PATH}`);
  if (dryRun) console.log(`模式: 模拟运行 (Dry-run, 不会修改任何文件)\n`);
  else console.log(``);

  const selectedTargets = targetName === 'all'
    ? targets
    : targets.filter(t => t.id === targetName.toLowerCase());

  if (selectedTargets.length === 0) {
    console.error(`❌ 未知目标: "${targetName}"`);
    console.log(`支持的目标: all, ${targets.map(t => t.id).join(', ')}`);
    return false;
  }

  let successCount = 0;
  let detectedCount = 0;

  for (const t of selectedTargets) {
    const res = installTarget(t, dryRun);
    const mark = res.installed ? '✅' : (res.detected ? '⚠️' : '⚪');
    console.log(`${mark} [${t.name}]`);
    console.log(`   配置文件: ${t.configPath}`);
    console.log(`   环境检测: ${res.detected ? '已检测到此 Agent 环境' : '未检测到此 Agent（仍可按需写入）'}`);
    console.log(`   操作结果: ${res.message}\n`);

    if (res.detected) detectedCount++;
    if (res.installed) successCount++;
  }

  console.log(`------------------------------------------------------`);
  console.log(`✨ 安装总结: 已扫描 ${selectedTargets.length} 项，生效/已就绪 ${successCount} 项。`);
  console.log(`👉 温馨提示: 首次使用某些 Agent（如 WorkBuddy/Cursor），需在其设置页面点击 Trust/信任 或重启软件即可激活！\n`);
  return true;
}

module.exports = {
  SERVER_NAME,
  MCP_SCRIPT_PATH,
  getAgentTargets,
  installTarget,
  runInstall
};

if (require.main === module) {
  const args = process.argv.slice(2);
  const target = args.find(a => !a.startsWith('-')) || 'all';
  const dryRun = args.includes('--dry-run') || args.includes('-d');
  runInstall(target, { dryRun });
}
