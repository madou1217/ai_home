#!/usr/bin/env node
'use strict';

// 远程工作区工具的 MCP server（stdio）。由 harness（claude / codex）在 AIH Server 本机启动，
// 本身不连远端：每次 tools/call 转发给 AIH Server 的内部端点（loopback + 会话令牌），
// 由 Server 进程里共享的连接池执行（不为每一轮对话重新握手 SSH）。
//
// 上下文只经一个环境变量 AIH_LAUNCH_CONTEXT（0600 JSON）：{ toolsUrl, token }。
// 端点不可达 / 超时 → 返回工具错误（模型能看到原因），不挂死 harness。

const http = require('node:http');
const { readLaunchContext } = require('../runtime/launch-context');
const { TOOL_DEFINITIONS } = require('./session-tools');

const context = readLaunchContext(process.env);
const TOOLS_URL = String(context.toolsUrl || '').trim();
const TOKEN = String(context.token || '').trim();
const CALL_TIMEOUT_MS = 35 * 60 * 1000; // 比 run_command 的上限多 5 分钟

// 直连模式（终端里 `aih claude --remote=<工作区>`）：没有 Server 端点，本进程自己持有连接池，
// 上下文是 { aiHomeDir, workspaceId }。凭据仍来自 aih 本机配置（与 Server 同一份），不经命令行传递。
let directHost = null;
function direct(name, args) {
  if (!directHost) {
    const fs = require('node:fs');
    const { getRemoteWorkspaceService } = require('./index');
    directHost = getRemoteWorkspaceService({ fs, aiHomeDir: String(context.aiHomeDir) }).host(String(context.workspaceId));
  }
  const { callRemoteTool } = require('./session-tools');
  return callRemoteTool(directHost, name, args).catch((error) => ({
    isError: true, content: [{ type: 'text', text: `[${error.code || 'remote_unavailable'}] ${error.message}` }]
  }));
}

function forward(name, args) {
  if (!TOOLS_URL && context.workspaceId && context.aiHomeDir) return direct(name, args);
  return new Promise((resolve) => {
    let target;
    try { target = new URL(TOOLS_URL); } catch (_error) {
      resolve({ isError: true, content: [{ type: 'text', text: '[remote_tools_unconfigured] 远程工具端点未配置' }] });
      return;
    }
    const body = JSON.stringify({ name, arguments: args || {} });
    const req = http.request({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-AIH-Remote-Tools-Token': TOKEN
      },
      timeout: CALL_TIMEOUT_MS
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed && Array.isArray(parsed.content)) { resolve(parsed); return; }
        } catch (_error) { /* fallthrough */ }
        resolve({ isError: true, content: [{ type: 'text', text: `[remote_tools_bad_response] HTTP ${res.statusCode}` }] });
      });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ isError: true, content: [{ type: 'text', text: '[remote_tools_timeout] 远程工具调用超时' }] });
    });
    req.on('error', (error) => {
      resolve({ isError: true, content: [{ type: 'text', text: `[remote_tools_unreachable] ${error.message}` }] });
    });
    req.write(body);
    req.end();
  });
}

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function replyError(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);
}

async function handle(message) {
  const { id, method, params } = message;
  if (method === 'initialize') {
    reply(id, {
      protocolVersion: (params && params.protocolVersion) || '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'aih-remote-workspace', version: '1.0.0' }
    });
    return;
  }
  if (method === 'notifications/initialized' || id === undefined) return;
  if (method === 'ping') { reply(id, {}); return; }
  if (method === 'tools/list') { reply(id, { tools: TOOL_DEFINITIONS }); return; }
  if (method === 'tools/call') {
    reply(id, await forward(params && params.name, params && params.arguments));
    return;
  }
  replyError(id, -32601, `method not found: ${method}`);
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    let message;
    try { message = JSON.parse(line); } catch (_error) { continue; }
    handle(message).catch((error) => {
      if (message && message.id !== undefined) replyError(message.id, -32603, String(error && error.message || error));
    });
  }
});
process.stdin.on('end', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
