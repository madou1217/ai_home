const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const ts = require('../web/node_modules/typescript');
const axios = require('../web/node_modules/axios/dist/node/axios.cjs');

function loadNativeAxiosAdapter(response) {
  const filename = path.join(
    __dirname,
    '..',
    'web',
    'src',
    'services',
    'native-axios-adapter.ts'
  );
  const source = fs.readFileSync(filename, 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true
    }
  });
  const requests = [];
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = Module._nodeModulePaths(path.dirname(filename));
  const originalRequire = mod.require.bind(mod);
  mod.require = (request) => {
    if (request === './control-plane-selection') {
      return { getActiveControlPlaneProfileId: () => 'server-aws' };
    }
    if (request === './native-server-transport') {
      return {
        requestNativeServerJson: async (input) => {
          requests.push(input);
          return response;
        },
        requestNativeServerBlob: async () => {
          throw new Error('unexpected_blob_request');
        }
      };
    }
    return originalRequire(request);
  };
  mod._compile(compiled.outputText, filename);
  return { createNativeAxiosAdapter: mod.exports.createNativeAxiosAdapter, requests };
}

test('native Axios keeps a 401 JSON body on error.response for the WebUI auth gate', async () => {
  const body = { error: 'webui_unauthorized', message: 'Management Key 无效' };
  const { createNativeAxiosAdapter, requests } = loadNativeAxiosAdapter({
    status: 401,
    headers: { contentType: 'application/json' },
    data: body
  });
  const client = axios.create({
    baseURL: '/v0',
    adapter: createNativeAxiosAdapter()
  });

  await assert.rejects(client.get('/webui/accounts'), (error) => {
    assert.equal(error.response.status, 401);
    assert.deepEqual(error.response.data, body);
    assert.equal(error.code, axios.AxiosError.ERR_BAD_REQUEST);
    return true;
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].profileId, 'server-aws');
  assert.equal(requests[0].path, '/v0/webui/accounts');
});

test('native Axios keeps a business 409 payload and honors validateStatus', async () => {
  const body = {
    error: 'job_already_running',
    jobId: 'job-7',
    job: { id: 'job-7', status: 'running' }
  };
  const rejected = loadNativeAxiosAdapter({
    status: 409,
    headers: { contentType: 'application/json' },
    data: body
  });
  const rejectingClient = axios.create({
    baseURL: '/v0',
    adapter: rejected.createNativeAxiosAdapter()
  });

  await assert.rejects(rejectingClient.post('/webui/accounts/import', {}), (error) => {
    assert.equal(error.response.status, 409);
    assert.deepEqual(error.response.data, body);
    return true;
  });

  const accepted = loadNativeAxiosAdapter({
    status: 409,
    headers: { contentType: 'application/json' },
    data: body
  });
  const acceptingClient = axios.create({
    baseURL: '/v0',
    adapter: accepted.createNativeAxiosAdapter(),
    validateStatus: (status) => status === 409
  });
  const response = await acceptingClient.post('/webui/accounts/import', {});

  assert.equal(response.status, 409);
  assert.deepEqual(response.data, body);
});

test('native Axios omits Content-Type when GET and POST requests have no body', async () => {
  const loaded = loadNativeAxiosAdapter({
    status: 200,
    headers: { contentType: 'application/json' },
    data: { ok: true }
  });
  const client = axios.create({
    baseURL: '/v0',
    adapter: loaded.createNativeAxiosAdapter(),
    headers: { 'Content-Type': 'application/json' }
  });

  await client.get('/webui/accounts');
  await client.post('/webui/projects/watch/snapshot');

  assert.equal(loaded.requests.length, 2);
  for (const request of loaded.requests) {
    assert.equal(request.body, undefined);
    assert.equal(request.contentType, undefined);
  }
});

test('native Axios forwards JSON Content-Type when the request has a body', async () => {
  const loaded = loadNativeAxiosAdapter({
    status: 200,
    headers: { contentType: 'application/json' },
    data: { ok: true }
  });
  const client = axios.create({
    baseURL: '/v0',
    adapter: loaded.createNativeAxiosAdapter()
  });

  await client.post('/webui/accounts/import', { provider: 'codex' });

  assert.equal(loaded.requests.length, 1);
  assert.deepEqual(loaded.requests[0].body, { provider: 'codex' });
  assert.equal(loaded.requests[0].contentType, 'application/json');
});
