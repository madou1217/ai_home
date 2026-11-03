'use strict';
const { spawn } = require('node:child_process');
const { mcpError, requireMcp } = require('./mcp-errors');
const MAX_FRAME_BYTES = 1024 * 1024;
const PROTOCOLS = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'];
function createMcpStdioClient(server, options = {}) {
  requireMcp(typeof server.command === 'string' && server.command.trim(), 'mcp_command_required');
  requireMcp(!server.args || (Array.isArray(server.args) && server.args.every(x => typeof x === 'string')), 'mcp_args_invalid');
  const env = {};
  for (const key of ['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  Object.assign(env, server.env || {});
  const child = spawn(server.command, server.args || [], {
    cwd: server.cwd, env, shell: false, windowsHide: true,
    detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe']
  });
  const pending = new Map();
  let buffer = Buffer.alloc(0);
  let id = 0;
  let failure;
  let initialized;
  let closed = false;
  let killTimer;
  const closedPromise = new Promise(resolve => child.once('close', () => {
    closed = true;
    clearTimeout(killTimer);
    options.signal?.removeEventListener('abort', cancel);
    rejectAll(failure || mcpError('mcp_stdio_closed'));
    resolve();
  }));
  function rejectAll(error) {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); }
    pending.clear();
  }
  function kill(signal) {
    try {
      if (process.platform === 'win32') child.kill(signal);
      else if (child.pid) process.kill(-child.pid, signal);
    } catch (_) {}
  }
  function stop(error) {
    if (failure) return;
    failure = error;
    rejectAll(error);
    child.stdin.destroy();
    kill('SIGTERM');
    killTimer = setTimeout(() => kill('SIGKILL'), 200);
    killTimer.unref();
  }
  function cancel() { stop(mcpError('mcp_cancelled')); }
  function write(message) {
    const frame = Buffer.from(JSON.stringify(message) + '\n');
    requireMcp(frame.length <= MAX_FRAME_BYTES, 'mcp_request_limit');
    child.stdin.write(frame, error => { if (error) stop(mcpError('mcp_stdio_closed')); });
  }
  child.on('error', () => stop(mcpError('mcp_spawn_failed')));
  child.stdin.on('error', () => stop(mcpError('mcp_stdio_closed')));
  child.stderr.resume(); // Child diagnostics can contain secrets; never expose them.
  child.stdout.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    let end;
    while ((end = buffer.indexOf(10)) >= 0) {
      if (end > MAX_FRAME_BYTES) { stop(mcpError('mcp_response_limit')); return; }
      const line = buffer.subarray(0, end).toString('utf8').trim();
      buffer = buffer.subarray(end + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch (_) { stop(mcpError('mcp_response_invalid')); return; }
      if (!message || message.jsonrpc !== '2.0' || typeof message !== 'object' || Array.isArray(message)) { stop(mcpError('mcp_response_invalid')); return; }
      if (typeof message.method === 'string') {
        if (message.id !== undefined) write({ jsonrpc: '2.0', id: message.id, ...(message.method === 'ping' ? { result: {} } : { error: { code: -32601, message: 'Method not supported' } }) });
        continue;
      }
      const item = pending.get(message.id);
      if (!item) { stop(mcpError('mcp_response_id_mismatch')); return; }
      pending.delete(message.id);
      clearTimeout(item.timer);
      if (Object.hasOwn(message, 'error') === Object.hasOwn(message, 'result')) { item.reject(mcpError('mcp_response_invalid')); stop(mcpError('mcp_response_invalid')); return; }
      if (message.error) item.reject(mcpError('mcp_remote_error'));
      else item.resolve(message.result);
    }
    if (buffer.length > MAX_FRAME_BYTES) stop(mcpError('mcp_response_limit'));
  });
  options.signal?.addEventListener('abort', cancel, { once: true });
  if (options.signal?.aborted) cancel();
  function request(method, params = {}) {
    if (failure || closed) return Promise.reject(failure || mcpError('mcp_stdio_closed'));
    return new Promise((resolve, reject) => {
      const requestId = ++id;
      const timer = setTimeout(() => stop(mcpError('mcp_request_timeout')), options.timeoutMs || 5000);
      pending.set(requestId, { resolve, reject, timer });
      try { write({ jsonrpc: '2.0', id: requestId, method, params }); }
      catch (error) { stop(error); }
    });
  }
  function initialize() {
    if (!initialized) initialized = request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'aih-mcp-manager', version: '1.0.0' } }).then(result => {
      requireMcp(PROTOCOLS.includes(result?.protocolVersion) && typeof result.serverInfo?.name === 'string', 'mcp_initialize_invalid');
      write({ jsonrpc: '2.0', method: 'notifications/initialized' });
      return result;
    }).catch(error => { stop(error); throw error; });
    return initialized;
  }
  async function listTools() {
    await initialize();
    const tools = [];
    const cursors = new Set();
    let cursor;
    do {
      const result = await request('tools/list', cursor ? { cursor } : {});
      requireMcp(Array.isArray(result?.tools), 'mcp_tools_invalid');
      for (const tool of result.tools) {
        requireMcp(typeof tool?.name === 'string' && tool.name.length <= 128 && tool.inputSchema?.type === 'object' && !tools.some(x => x.name === tool.name), 'mcp_tools_invalid');
        tools.push(tool);
      }
      requireMcp(tools.length <= 256 && cursors.size < 20, 'mcp_tools_limit');
      cursor = result.nextCursor;
      if (cursor !== undefined) {
        requireMcp(typeof cursor === 'string' && cursor.length > 0 && !cursors.has(cursor), 'mcp_tools_cursor_invalid');
        cursors.add(cursor);
      }
    } while (cursor);
    return tools;
  }
  async function callTool(name, args = {}) {
    await initialize();
    requireMcp(typeof name === 'string' && name && args && typeof args === 'object' && !Array.isArray(args), 'mcp_tool_arguments_invalid');
    const result = await request('tools/call', { name, arguments: args });
    requireMcp(Array.isArray(result?.content), 'mcp_tool_result_invalid');
    return result;
  }
  async function close() {
    if (!closed) stop(mcpError('mcp_stdio_closed'));
    await closedPromise;
  }
  return { initialize, listTools, callTool, close, get closed() { return closed; } };
}
module.exports = { createMcpStdioClient };
