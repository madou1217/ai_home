'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createMcpStdioClient } = require('../lib/native-resources/mcp-stdio-client');
const demo = path.resolve(__dirname, '../examples/mcp/aih-demo-server.js');
test('real stdio demo initializes, lists tools, echoes, and confines file listing to cwd', async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-mcp-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.writeFileSync(path.join(cwd, 'demo.txt'), 'demo');
  const client = createMcpStdioClient({ command: process.execPath, args: [demo], cwd });
  try {
    const init = await client.initialize();
    assert.equal(init.serverInfo.name, 'aih-demo');
    assert.deepEqual((await client.listTools()).map(x => x.name).sort(), ['aih_echo', 'aih_list_files']);
    assert.equal((await client.callTool('aih_echo', { text: 'AIH_MCP_DEMO_OK' })).content[0].text, 'AIH_MCP_DEMO_OK');
    assert.deepEqual(JSON.parse((await client.callTool('aih_list_files', {})).content[0].text), ['demo.txt']);
    assert.equal((await client.callTool('aih_list_files', { path: '..' })).isError, true);
    assert.equal((await client.callTool('aih_echo', { text: 'x'.repeat(8193) })).isError, true);
  } finally { await client.close(); }
});
for (const [name, code, expected] of [
  ['EOF', 'process.exit(0)', 'mcp_stdio_closed'],
  ['invalid JSON', 'console.log("bad");setInterval(()=>{},1000)', 'mcp_response_invalid'],
  ['wrong id', 'console.log(JSON.stringify({jsonrpc:"2.0",id:999,result:{}}));setInterval(()=>{},1000)', 'mcp_response_id_mismatch'],
  ['oversize frame', 'console.log("x".repeat(1048577));setInterval(()=>{},1000)', 'mcp_response_limit'],
  ['timeout', 'setInterval(()=>{},1000)', 'mcp_request_timeout']
]) {
  test(`stdio rejects ${name} and terminates the child`, async () => {
    const client = createMcpStdioClient({ command: process.execPath, args: ['-e', code] }, { timeoutMs: 300 });
    await assert.rejects(client.initialize(), { code: expected });
    await client.close();
    assert.equal(client.closed, true);
  });
}
test('stdio cancellation and missing executable return typed diagnostics', async () => {
  const abort = new AbortController();
  const client = createMcpStdioClient({ command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] }, { signal: abort.signal });
  const pending = client.initialize();
  abort.abort();
  await assert.rejects(pending, { code: 'mcp_cancelled' });
  await client.close();
  const missing = createMcpStdioClient({ command: path.join(os.tmpdir(), 'aih-no-such-binary') });
  await assert.rejects(missing.initialize(), { code: 'mcp_spawn_failed' });
  await missing.close();
});
