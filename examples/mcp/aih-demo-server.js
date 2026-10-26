#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const root = fs.realpathSync(process.cwd());
let ready = false;
const tools = [
  { name: 'aih_echo', description: 'Echo a short text for an AIH MCP demo.', inputSchema: { type: 'object', properties: { text: { type: 'string', maxLength: 8192 } }, required: ['text'], additionalProperties: false } },
  { name: 'aih_list_files', description: 'List up to 100 immediate names inside the demo working directory.', inputSchema: { type: 'object', properties: { path: { type: 'string', default: '.' } }, additionalProperties: false } }
];
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
input.on('line', line => {
  if (Buffer.byteLength(line) > 1024 * 1024) { process.exitCode = 1; input.close(); process.stdin.destroy(); return; }
  let message;
  try { message = JSON.parse(line); } catch (_) { send({ id: null, error: { code: -32700, message: 'Parse error' } }); return; }
  const { id, method, params = {} } = message;
  if (id === undefined) { if (method === 'notifications/initialized') ready = true; return; }
  const error = (code, text) => send({ id, error: { code, message: text } });
  if (method === 'initialize') {
    send({ id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'aih-demo', version: '1.0.0' } } });
    return;
  }
  if (method === 'ping') { send({ id, result: {} }); return; }
  if (!ready) { error(-32002, 'Initialize first'); return; }
  if (method === 'tools/list') { send({ id, result: { tools } }); return; }
  if (method !== 'tools/call') { error(-32601, 'Unknown method'); return; }
  const args = params.arguments || {};
  try {
    let text;
    if (params.name === 'aih_echo') {
      if (typeof args.text !== 'string' || args.text.length > 8192 || Object.keys(args).some(k => k !== 'text')) throw new Error();
      text = args.text;
    } else if (params.name === 'aih_list_files') {
      if (Object.keys(args).some(k => k !== 'path') || (args.path !== undefined && typeof args.path !== 'string')) throw new Error();
      const dir = fs.realpathSync(path.resolve(root, args.path || '.'));
      const relative = path.relative(root, dir);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error();
      text = JSON.stringify(fs.readdirSync(dir).sort().slice(0, 100).map(x => x.slice(0, 255)));
    } else { error(-32602, 'Unknown tool'); return; }
    send({ id, result: { content: [{ type: 'text', text }] } });
  } catch (_) { send({ id, result: { isError: true, content: [{ type: 'text', text: 'Invalid or out-of-scope demo input' }] } }); }
});
