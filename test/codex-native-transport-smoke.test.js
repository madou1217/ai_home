'use strict';

// Explicit local native-client smoke. Synthetic OAuth and two loopback upstreams;
// no production auth/config, no real inference, no GUI or user's live processes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const zlib = require('node:zlib');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { parse } = require('smol-toml');
const { registerAccountIdentity } = require('../lib/account/account-registration');
const { resolveNativeAuthIdentitySeed } = require('../lib/account/account-identity');
const { writeAccountNativeAuth, writeAccountCredentials } = require('../lib/server/account-credential-store');
const { writeDefaultAccountRef } = require('../lib/account/default-account-store');
const { writeServerConfig } = require('../lib/server/server-config-store');
const { createHostConfigSyncer } = require('../lib/account/host-sync');
const enabled = process.env.AIH_NATIVE_CODEX_TRANSPORT_SMOKE === '1';
const binary = process.env.AIH_NATIVE_CODEX_BINARY || '/Applications/ChatGPT.app/Contents/Resources/codex.aih-original';

function connectRpc(child) {
  let sequence = 0, buffer = '', stderr = '';
  const pending = new Map(), notifications = [], waits = new Set();
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-12000); });
  child.stdout.on('data', chunk => {
    buffer += chunk;
    while (buffer.includes('\n')) {
      const split = buffer.indexOf('\n'), line = buffer.slice(0, split); buffer = buffer.slice(split + 1);
      let message; try { message = JSON.parse(line); } catch (_) { continue; }
      const waiter = pending.get(message.id);
      if (waiter) { pending.delete(message.id); message.error ? waiter.reject(new Error(JSON.stringify(message.error))) : waiter.resolve(message.result); }
      else {
        notifications.push(message);
        for (const wait of waits) if (wait.predicate(message)) { waits.delete(wait); wait.resolve(message); }
      }
    }
  });
  child.on('exit', code => {
    for (const waiter of pending.values()) waiter.reject(new Error(`native exited ${code}: ${stderr.slice(-2000)}`));
    pending.clear();
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`native RPC timed out: ${method}: ${stderr.slice(-2000)}`)); }, 12000);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
  return {
    request,
    notify: (method, params = {}) => child.stdin.write(JSON.stringify({ method, params }) + '\n'),
    async turn(threadId, marker) {
      const start = await request('turn/start', { threadId, input: [{ type: 'text', text: marker }], approvalPolicy: 'never' });
      const predicate = message => message.method === 'turn/completed' && message.params?.turn?.id === start.turn.id;
      const known = notifications.find(predicate); if (known) return known.params.turn;
      const result = await new Promise((resolve, reject) => {
        const entry = { predicate, resolve: value => { clearTimeout(timer); resolve(value); } };
        const timer = setTimeout(() => { waits.delete(entry); reject(new Error('native turn timed out: ' + stderr.slice(-2000))); }, 12000);
        waits.add(entry);
      });
      return result.params.turn;
    }
  };
}

test('installed App engine resumes the same relay thread with OAuth and never contacts the gateway', {
  skip: !enabled || !fs.existsSync(binary) || process.platform !== 'darwin', timeout: 60000
}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-native-mode-smoke-'));
  const home = path.join(root, 'home'), codexHome = path.join(home, '.codex'), aiHomeDir = path.join(home, '.ai_home');
  const workspace = path.join(root, 'workspace'), stateFile = path.join(root, 'hook.json');
  fs.mkdirSync(codexHome, { recursive: true }); fs.mkdirSync(workspace);
  const children = new Set(), servers = [], sockets = new Set(), requests = [];
  let gatewayDisabled = false;
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        try { process.kill(-child.pid, 'SIGTERM'); } catch (_) {}
        await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 2000))]);
      }
    }
    for (const socket of sockets) socket.destroy();
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
    fs.rmSync(root, { recursive: true, force: true });
  });
  async function upstream(kind) {
    const server = http.createServer(async (req, res) => {
      if (req.method === 'POST' && req.url.includes('/responses')) {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        let bytes = Buffer.concat(chunks);
        if (req.headers['content-encoding'] === 'zstd') bytes = zlib.zstdDecompressSync(bytes);
        if (req.headers['content-encoding'] === 'gzip') bytes = zlib.gunzipSync(bytes);
        const payload = JSON.parse(bytes);
        requests.push({ kind, url: req.url, authIsNative: req.headers.authorization === `Bearer ${oauth.tokens.access_token}`, payload });
        if (kind === 'gateway' && gatewayDisabled) {
          res.writeHead(503, { 'content-type': 'application/json' }); res.end('{"error":{"code":"no_available_account"}}'); return;
        }
        const id = `resp_${requests.length}`, text = `completed-on-${kind}`;
        const item = { id: 'msg_' + id, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
        const response = { id, object: 'response', created_at: 1700000000, model: 'gpt-5.4', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
        const events = [
          { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
          { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
          { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: text },
          { type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text },
          { type: 'response.output_item.done', output_index: 0, item },
          { type: 'response.completed', response }
        ];
        res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')); return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"models":[],"data":[]}');
    });
    server.on('upgrade', (_req, socket) => socket.end('HTTP/1.1 426 Upgrade Required\r\nContent-Length: 0\r\n\r\n'));
    server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    servers.push(server); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${server.address().port}`;
  }
  const nativeBase = await upstream('native'), gatewayBase = await upstream('gateway');
  const jwt = payload => `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.fixture`;
  const now = Math.floor(Date.now() / 1000);
  const oauth = { auth_mode: 'chatgpt', last_refresh: new Date().toISOString(), tokens: {
    access_token: jwt({ iat: now - 10, exp: now + 7200, 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-workspace', chatgpt_plan_type: 'plus' } }),
    id_token: jwt({ email: 'fixture@example.invalid', 'https://api.openai.com/auth': { chatgpt_user_id: 'fixture-user', chatgpt_account_id: 'fixture-workspace' } }),
    refresh_token: 'fixture-unused-refresh', account_id: 'fixture-workspace'
  } };
  const nativeIdentity = resolveNativeAuthIdentitySeed('codex', { auth: oauth });
  const nativeRef = registerAccountIdentity(fs, aiHomeDir, { provider: 'codex', cliAccountId: '36', identitySeed: nativeIdentity.identitySeed }).accountRef;
  writeAccountNativeAuth(fs, aiHomeDir, nativeRef, { auth: oauth });
  const relayRef = registerAccountIdentity(fs, aiHomeDir, { provider: 'codex', cliAccountId: '1', identitySeed: 'api-key:codex:fixture-relay' }).accountRef;
  writeAccountCredentials(fs, aiHomeDir, relayRef, { OPENAI_API_KEY: 'fixture-relay-account', OPENAI_BASE_URL: gatewayBase + '/v1' });
  writeServerConfig({ host: '127.0.0.1', port: Number(new URL(gatewayBase).port), apiKey: 'fixture-client-key' }, { fs, aiHomeDir });
  const configFile = path.join(codexHome, 'config.toml');
  fs.writeFileSync(configFile, `model="gpt-5.4"\nchatgpt_base_url="${nativeBase}/backend-api"\napproval_policy="never"\n[features]\nresponses_websockets_v2=false\n`);
  fs.writeFileSync(stateFile, JSON.stringify({ enabled: true, remoteControlProxy: false, traceResponses: false }));
  const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, AIH_HOST_HOME: home, AIH_HOME: aiHomeDir,
    CODEX_HOME: codexHome, TERM: 'dumb', NO_PROXY: '127.0.0.1,localhost',
    CODEX_APP_SERVER_CHATGPT_BASE_URL: nativeBase + '/backend-api',
    CODEX_REFRESH_TOKEN_URL_OVERRIDE: nativeBase + '/reject-refresh' };
  const sync = createHostConfigSyncer({ fs, fse: { copySync: (source, target) => fs.copyFileSync(source, target) }, ensureDir: dir => fs.mkdirSync(dir, { recursive: true }),
    aiHomeDir, hostHomeDir: home, cliConfigs: { codex: { globalDir: '.codex' } }, codexVersion: '0.154.0',
    processObj: { platform: process.platform, env, pid: process.pid, execPath: process.execPath } });
  function select(ref) { assert.equal(sync('codex', ref).ok, true); writeDefaultAccountRef(fs, aiHomeDir, 'codex', ref); }
  async function launch() {
    // Override only the built-in OpenAI test endpoint; its OAuth auth stays native.
    // OS-level network restriction makes unexpected public endpoints fail closed.
    const policy = '(version 1)(allow default)(deny network*)(allow network-outbound (remote ip "localhost:*"))';
    const child = spawn('/usr/bin/sandbox-exec', ['-p', policy, process.execPath, path.resolve(__dirname, '../lib/server/codex-app-server-stdio-proxy.js'),
      '--upstream', binary, '--state-file', stateFile, '--', 'app-server', '-c', `openai_base_url="${nativeBase}/codex"`], { cwd: workspace, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    children.add(child); const rpc = connectRpc(child);
    await rpc.request('initialize', { clientInfo: { name: 'aih_native_transport_fixture', version: '1.0.0' }, capabilities: { experimentalApi: true } });
    rpc.notify('initialized');
    return { child, rpc };
  }
  async function stop(session) { process.kill(-session.child.pid, 'SIGTERM'); await once(session.child, 'exit'); children.delete(session.child); }

  select(relayRef);
  let session = await launch();
  const started = await session.rpc.request('thread/start', { model: 'gpt-5.4', cwd: workspace, approvalPolicy: 'never', sandbox: 'read-only' });
  const threadId = started.thread.id;
  assert.equal(started.modelProvider, 'aih_server');
  const first = await session.rpc.turn(threadId, 'remember prior-context-fixture'); assert.equal(first.status, 'completed', JSON.stringify(first));
  assert.deepEqual(requests.map(x => x.kind), ['gateway']);
  await stop(session);

  select(nativeRef);
  const config = parse(fs.readFileSync(configFile, 'utf8'));
  assert.equal(config.model_provider, 'openai'); assert.ok(config.model_providers.aih_server);
  const authBefore = fs.readFileSync(path.join(codexHome, 'auth.json'), 'utf8');
  gatewayDisabled = true;
  env.OPENAI_API_KEY = 'fixture-inherited-relay-key';
  env.OPENAI_BASE_URL = gatewayBase + '/v1';
  env.AIH_CODEX_GATEWAY_ACCOUNT_REF = relayRef;
  session = await launch();
  const resumed = await session.rpc.request('thread/resume', { threadId, modelProvider: null, model: null });
  assert.equal(resumed.thread.id, threadId); assert.equal(resumed.modelProvider, 'openai');
  const second = await session.rpc.turn(threadId, 'continue with prior context'); assert.equal(second.status, 'completed', JSON.stringify(second));
  assert.deepEqual(requests.map(x => x.kind), ['gateway', 'native']);
  assert.equal(requests[1].authIsNative, true);
  assert.ok(JSON.stringify(requests[1].payload.input).includes('prior-context-fixture'));
  assert.equal(fs.readFileSync(path.join(codexHome, 'auth.json'), 'utf8'), authBefore);
  await stop(session);

  delete env.OPENAI_API_KEY; delete env.OPENAI_BASE_URL; delete env.AIH_CODEX_GATEWAY_ACCOUNT_REF;
  gatewayDisabled = false; select(relayRef); session = await launch();
  const relayResume = await session.rpc.request('thread/resume', { threadId, modelProvider: null, model: null });
  assert.equal(relayResume.modelProvider, 'aih_server');
  const third = await session.rpc.turn(threadId, 'back to relay'); assert.equal(third.status, 'completed', JSON.stringify(third));
  assert.deepEqual(requests.map(x => x.kind), ['gateway', 'native', 'gateway']);
  await stop(session);
  t.diagnostic(JSON.stringify({ sameThread: true, routeSequence: requests.map(x => x.kind), nativeUsesOAuth: true, gatewayCallsDuringNative: 0 }));
});
