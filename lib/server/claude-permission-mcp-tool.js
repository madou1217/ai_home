#!/usr/bin/env node
'use strict';

// claude 的权限提示工具(P3,S1 实证协议):以 stdio MCP server 形态被 claude 启动
// (--permission-prompt-tool mcp__aih__approve)。claude 每次需要权限时调用 approve 工具,
// arguments={tool_name, input, tool_use_id};本进程把请求 POST 给 aih 的审批桥并【长挂】等
// 用户在 webUI 决策,拿到 {behavior:"allow"|"deny",...} 后原样作为工具结果返回。
//
// 零 aih 依赖(纯 node):经 env 取上下文——AIH_APPROVAL_URL(桥端点)、AIH_RUN_ID。
// 桥不可达/超时 → 返回 deny(安全默认,claude 会优雅收尾而不是挂死)。

const http = require('node:http');

const APPROVAL_URL = String(process.env.AIH_APPROVAL_URL || '').trim();
const RUN_ID = String(process.env.AIH_RUN_ID || '').trim();
const DECISION_TIMEOUT_MS = Math.max(30_000, Number(process.env.AIH_APPROVAL_TIMEOUT_MS) || 600_000);

function postForDecision(payload) {
  return new Promise((resolve) => {
    if (!APPROVAL_URL) {
      resolve({ behavior: 'deny', message: 'aih 审批桥未配置(AIH_APPROVAL_URL 缺失)' });
      return;
    }
    let target;
    try {
      target = new URL(APPROVAL_URL);
    } catch (_error) {
      resolve({ behavior: 'deny', message: 'aih 审批桥地址无效' });
      return;
    }
    const body = JSON.stringify(payload);
    const req = http.request({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      // 长挂等待用户决策:超时即 deny。
      timeout: DECISION_TIMEOUT_MS
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed && (parsed.behavior === 'allow' || parsed.behavior === 'deny')) {
            resolve(parsed);
            return;
          }
        } catch (_error) { /* fallthrough deny */ }
        resolve({ behavior: 'deny', message: 'aih 审批桥返回无效决策' });
      });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ behavior: 'deny', message: '审批等待超时,已默认拒绝' });
    });
    req.on('error', (error) => {
      resolve({ behavior: 'deny', message: `aih 审批桥不可达: ${error.message}` });
    });
    req.write(body);
    req.end();
  });
}

let stdinBuffer = '';
process.stdin.on('data', (chunk) => {
  stdinBuffer += chunk.toString();
  let newlineIndex;
  while ((newlineIndex = stdinBuffer.indexOf('\n')) >= 0) {
    const line = stdinBuffer.slice(0, newlineIndex);
    stdinBuffer = stdinBuffer.slice(newlineIndex + 1);
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch (_error) {
      continue;
    }
    handleMessage(message);
  }
});

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

async function handleMessage(message) {
  if (message.method === 'initialize') {
    reply(message.id, {
      protocolVersion: (message.params && message.params.protocolVersion) || '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'aih-approve', version: '1.0.0' }
    });
    return;
  }
  if (message.method === 'tools/list') {
    reply(message.id, {
      tools: [{
        name: 'approve',
        description: 'AIH webUI permission prompt tool',
        inputSchema: { type: 'object', properties: { tool_name: { type: 'string' }, input: { type: 'object' } }, additionalProperties: true }
      }]
    });
    return;
  }
  if (message.method === 'tools/call') {
    const args = (message.params && message.params.arguments) || {};
    const decision = await postForDecision({
      runId: RUN_ID,
      toolName: String(args.tool_name || ''),
      input: args.input && typeof args.input === 'object' ? args.input : {},
      toolUseId: String(args.tool_use_id || '')
    });
    // claude 契约:content[0].text = JSON 字符串 {behavior:"allow",updatedInput}|{behavior:"deny",message}
    const result = decision.behavior === 'allow'
      ? { behavior: 'allow', updatedInput: decision.updatedInput || args.input || {} }
      : { behavior: 'deny', message: decision.message || '用户在 webUI 拒绝了此操作' };
    reply(message.id, { content: [{ type: 'text', text: JSON.stringify(result) }] });
    return;
  }
  if (message.id !== undefined) reply(message.id, {});
}
