'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

async function startGoGateway(context, upstreamBase, model, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-http-go-'));
  const binary = options.binary || process.env.AIH_CODEX_HTTP_GO_BINARY;
  const clientKey = 'fixture-client-key-0123456789abcdef';
  const managementKey = 'fixture-management-key-0123456789abcdef';
  const child = spawn(binary, ['--port', '0'], {
    env: { PATH: process.env.PATH, HOME: root, USERPROFILE: root, AIH_HOME: root,
      AIH_SERVER_CLIENT_KEY: clientKey, AIH_SERVER_MANAGEMENT_KEY: managementKey,
      SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, TEMP: root, TMP: root,
      LOCALAPPDATA: root, NO_PROXY: '127.0.0.1,localhost' },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
  });
  context.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  let stderr = '';
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-4000); });
  const base = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Go fixture startup timed out: ' + stderr)), 10000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Go fixture exited ${code}: ${stderr}`)); });
    child.stdout.on('data', data => {
      output += data;
      const match = output.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
  });
  async function register(apiKey = 'synthetic-upstream-key') {
    const result = await fetch(base + '/v1/management/accounts', {
      method: 'POST', headers: { authorization: `Bearer ${managementKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ provider_id: 'codex', auth: { kind: 'api_key', api_key: apiKey, base_url: upstreamBase } })
    });
    if (!result.ok) throw new Error('Go fixture account registration failed: ' + result.status);
    return (await result.json()).data.account_ref;
  }
  const accountRef = await register();
  let catalog;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await fetch(base + '/v1/models', { headers: { authorization: `Bearer ${clientKey}` } });
    const document = await response.json();
    catalog = { status: response.status, document };
    if (document.data?.some(entry => entry.id === model)) return { base, accountRef, clientKey, managementKey, register };
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Go fixture model catalog not ready: ' + JSON.stringify(catalog) + '\n' + stderr);
}

module.exports = { startGoGateway };
