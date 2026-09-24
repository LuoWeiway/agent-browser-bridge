#!/usr/bin/env node
/**
 * Agent Browser Bridge - 标准 Model Context Protocol (MCP) Stdio 服务端
 * 版本: 2.2.0
 * 零第三方依赖 (标准 JSON-RPC 2.0 stdio 协议)
 *
 * 为 Claude Code, WorkBuddy, Cursor 等 AI Agent 提供浏览器控制与页面提取能力
 */

const readline = require('readline');
const { TOOLS, executeTool } = require('./tools');

function sendJson(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

async function handleToolCall(name, args = {}) {
  return executeTool(name, args);
}

async function main() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
  });

  rl.on('line', async (line) => {
    if (!line.trim()) return;

    let req;
    try {
      req = JSON.parse(line);
    } catch (e) {
      return;
    }

    const { id, method, params } = req;

    try {
      if (method === 'initialize') {
        sendJson({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: {
              tools: {}
            },
            serverInfo: {
              name: 'agent-browser-bridge',
              version: '2.2.0'
            }
          }
        });
        return;
      }

      if (method === 'notifications/initialized') {
        // 初始化就绪通知，无需返回值
        return;
      }

      if (method === 'ping') {
        sendJson({ jsonrpc: '2.0', id, result: {} });
        return;
      }

      if (method === 'tools/list') {
        sendJson({
          jsonrpc: '2.0',
          id,
          result: {
            tools: TOOLS
          }
        });
        return;
      }

      if (method === 'tools/call') {
        const { name, arguments: toolArgs } = params;
        const toolResult = await handleToolCall(name, toolArgs || {});
        sendJson({
          jsonrpc: '2.0',
          id,
          result: toolResult
        });
        return;
      }

      if (id !== undefined) {
        sendJson({
          jsonrpc: '2.0',
          id,
          error: {
            code: -32601,
            message: `Method not found: ${method}`
          }
        });
      }
    } catch (err) {
      if (id !== undefined) {
        sendJson({
          jsonrpc: '2.0',
          id,
          error: {
            code: -32603,
            message: err.message || String(err)
          }
        });
      }
    }
  });
}

module.exports = {
  TOOLS,
  handleToolCall
};

if (require.main === module) {
  main().catch(err => {
    process.stderr.write('MCP Server 发生严重错误: ' + err.stack + '\n');
    process.exit(1);
  });
}
