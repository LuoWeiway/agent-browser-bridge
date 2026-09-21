#!/usr/bin/env node
/**
 * Agent Browser Bridge - 标准 Model Context Protocol (MCP) Stdio 服务端
 * 零第三方依赖 (标准 JSON-RPC 2.0 stdio 协议)
 *
 * 为 Claude Code 提供对用户日常使用中的 Chrome 浏览器无感控制能力：
 * 1. browser_read: 读取已打开页面/内部系统 (禅道/看板/各类登录态应用)
 * 2. browser_list_tabs: 查询当前全部打开的标签页
 * 3. browser_click: 模拟元素点击
 * 4. browser_fill: 表单输入
 * 5. browser_scroll: 页面滚动
 * 6. browser_screenshot: 网页截图
 * 7. browser_navigate: 打开或跳转网址
 * 8. browser_eval: 页面 JS 执行
 */

const readline = require('readline');
const path = require('path');
const fs = require('fs');
const { ensureDaemon, callApi } = require('./server');

const TOOLS = [
  {
    name: 'browser_read',
    description: '从当前打开的 Chrome 浏览器中智能模糊定位并读取网页内容（支持传入 URL 关键字或中文标题描述如"禅道"、"水稳"，完整提取包含 iframe、表格、大纲、表单控件与正文，100% 保留所有用户登录态与内部网络权限）',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '目标页面的 URL 关键词、网页标题关键字或自然语言描述（例如"禅道"、"生产记录"、"localhost:8080"），留空则默认读取当前正在聚焦的活动标签页'
        }
      }
    }
  },
  {
    name: 'browser_list_tabs',
    description: '列出当前用户 Chrome 浏览器全部窗口中已打开的标签页列表（包含 Tab ID、页面标题、完整 URL 以及是否处于激活状态）',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'browser_click',
    description: '在 Chrome 标签页中定位元素并触发真实的模拟点击（支持 CSS 选择器如 "#saveBtn" 或以 text= 开头的文本匹配如 "text=保存"）',
    inputSchema: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: '元素 CSS 选择器（如 "#submit-btn"）或文本匹配（如 "text=确定"、"text=编辑"）'
        },
        query: {
          type: 'string',
          description: '定位目标标签页的关键词或 URL，留空则针对当前激活标签页'
        }
      },
      required: ['selector']
    }
  },
  {
    name: 'browser_fill',
    description: '在 Chrome 标签页的输入框中填入文本并自动触发 input 与 change 响应事件',
    inputSchema: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: '输入框 CSS 选择器（如 "#username"、"input[placeholder=搜索]"）'
        },
        value: {
          type: 'string',
          description: '要输入的文字内容'
        },
        query: {
          type: 'string',
          description: '定位目标标签页的关键词或 URL，留空则针对当前激活标签页'
        }
      },
      required: ['selector', 'value']
    }
  },
  {
    name: 'browser_scroll',
    description: '在 Chrome 标签页中滚动页面查看更多内容',
    inputSchema: {
      type: 'object',
      properties: {
        direction: {
          type: 'string',
          enum: ['down', 'up', 'top', 'bottom'],
          description: '滚动方向：down (向下滚一屏), up (向上滚一屏), top (滚到顶部), bottom (滚到底部)'
        },
        query: {
          type: 'string',
          description: '定位目标标签页的关键词或 URL，留空则针对当前激活标签页'
        }
      }
    }
  },
  {
    name: 'browser_screenshot',
    description: '截取 Chrome 目标网页的可视区域快照，保存为本地 PNG 图片并返回绝对路径',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '定位目标标签页的关键词或 URL，留空则截取当前激活页面'
        },
        outputPath: {
          type: 'string',
          description: '图片保存的本地路径（可选，留空则保存到临时目录）'
        }
      }
    }
  },
  {
    name: 'browser_navigate',
    description: '在 Chrome 浏览器中跳转指定网址；若匹配不到标签页则自动新建标签页',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: '要访问的网页 URL'
        },
        query: {
          type: 'string',
          description: '要被跳转的目标标签页关键词，若留空或未匹配则新建标签页'
        }
      },
      required: ['url']
    }
  },
  {
    name: 'browser_eval',
    description: '在 Chrome 目标标签页的 JavaScript 上下文中执行任意代码并获取返回结果',
    inputSchema: {
      type: 'object',
      properties: {
        expression: {
          type: 'string',
          description: '要执行的 JavaScript 表达式字符串（例如 "document.title" 或 "window.__INITIAL_STATE__"）'
        },
        query: {
          type: 'string',
          description: '定位目标标签页的关键词或 URL，留空则针对当前激活标签页'
        }
      },
      required: ['expression']
    }
  },
  {
    name: 'browser_close_tab',
    description: '关闭指定匹配的 Chrome 标签页',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '要关闭的标签页关键词或 URL'
        }
      },
      required: ['query']
    }
  },
  {
    name: 'browser_clean_group',
    description: '一键清理并关闭所有 Agent 任务分组（Agent 任务）中的后台临时标签页',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  }
];

function sendJson(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

async function handleToolCall(name, args = {}) {
  // 确保桥接守护进程已在后台运行
  await ensureDaemon();

  switch (name) {
    case 'browser_read': {
      const q = args.query || '';
      const res = await callApi('read', { query: q, urlMatch: q });
      if (res.error) {
        return { content: [{ type: 'text', text: '读取失败: ' + res.error }], isError: true };
      }
      const text = res.markdown || res.text || JSON.stringify(res, null, 2);
      return { content: [{ type: 'text', text }] };
    }

    case 'browser_list_tabs': {
      const tabs = await callApi('list');
      let text = '### 当前打开的 Chrome 标签页\n\n';
      tabs.forEach((t, i) => {
        text += `${i + 1}. ${t.active ? '**[当前激活]** ' : ''}${t.title || '(无标题)'}\n`;
        text += `   - URL: ${t.url}\n`;
        text += `   - Tab ID: ${t.id} (Window: ${t.windowId})\n`;
      });
      return { content: [{ type: 'text', text }] };
    }

    case 'browser_click': {
      const res = await callApi('click', { selector: args.selector, query: args.query || '' });
      return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }], isError: !res.success };
    }

    case 'browser_fill': {
      const res = await callApi('fill', { selector: args.selector, value: args.value, query: args.query || '' });
      return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }], isError: !res.success };
    }

    case 'browser_scroll': {
      const res = await callApi('scroll', { direction: args.direction || 'down', query: args.query || '' });
      return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }] };
    }

    case 'browser_screenshot': {
      let outFile = args.outputPath;
      if (!outFile) {
        const tmpDir = process.env.TEMP || process.env.TMP || 'C:\\Windows\\Temp';
        outFile = path.join(tmpDir, `chrome_shot_${Date.now()}.png`);
      }
      const res = await callApi('shot', { query: args.query || '' });
      if (res.dataUrl) {
        const base64Data = res.dataUrl.replace(/^data:image\/\w+;base64,/, '');
        fs.writeFileSync(outFile, Buffer.from(base64Data, 'base64'));
        return {
          content: [
            { type: 'text', text: `📸 截图已成功保存至: ${outFile}\n页面: ${res.title}\n网址: ${res.url}` }
          ]
        };
      }
      return { content: [{ type: 'text', text: '截图失败: ' + (res.error || '未知原因') }], isError: true };
    }

    case 'browser_navigate': {
      const res = await callApi('navigate', { url: args.url, query: args.query || '', active: false });
      return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }] };
    }

    case 'browser_eval': {
      const res = await callApi('eval', { expression: args.expression, query: args.query || '' });
      return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }] };
    }

    case 'browser_close_tab': {
      const res = await callApi('close', { query: args.query });
      return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }], isError: !res.success };
    }

    case 'browser_clean_group': {
      const res = await callApi('clean');
      return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }] };
    }

    default:
      return { content: [{ type: 'text', text: `未知工具: ${name}` }], isError: true };
  }
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
              version: '2.1.0'
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

main().catch(err => {
  process.stderr.write('MCP Server 发生严重错误: ' + err.stack + '\n');
  process.exit(1);
});
