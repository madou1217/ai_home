'use strict';

const nodeFs = require('node:fs');
const nodePath = require('node:path');
const { buildManagedHostPluginArgs } = require('../native-resources/host-plugin-runtime');
const {
  ensureRequestedModel,
  fetchGatewayModelCatalog,
  withModelMetadata
} = require('./gateway-catalog');
const {
  buildHarnessModelEntries,
  linkHostSessions,
  resolveHarnessProjectionRoot,
  writePrivateJson,
  writePrivateText
} = require('./projection');

const PROVIDER_ID = 'aih';
const EXTENSION_FILE = 'aih-model-refresh.ts';

function buildPiModelsDocument(input = {}) {
  const headers = {
    'x-aih-route-owner': 'node'
  };
  const accountRef = String(input.accountRef || '').trim();
  if (accountRef) headers['x-account-ref'] = accountRef;
  return {
    providers: {
      [PROVIDER_ID]: {
        name: 'AIH Gateway',
        baseUrl: String(input.baseUrl || '').trim().replace(/\/+$/, ''),
        api: 'openai-completions',
        // Pi 支持 $ENV_VAR 插值；client key 只经子进程 env 传递，不落到磁盘。
        apiKey: '$OPENAI_API_KEY',
        headers,
        compat: {
          supportsDeveloperRole: false,
          supportsReasoningEffort: false,
          maxTokensField: 'max_tokens'
        },
        models: Array.isArray(input.models) ? input.models : []
      }
    }
  };
}

function buildPiLaunchArgs(input = {}) {
  const args = ['--provider', PROVIDER_ID];
  const model = String(input.model || '').trim();
  if (model) args.push('--model', model);
  return [...args, ...(Array.isArray(input.nativeArgs) ? input.nativeArgs : [])];
}

async function preparePiHarness(input = {}) {
  const fsImpl = input.fs || nodeFs;
  const pathImpl = input.path || nodePath;
  const accountRef = String(input.accountRef || '').trim();
  const provider = String(input.provider || '').trim().toLowerCase();
  const gateway = input.gateway || {};
  const baseUrl = String(gateway.baseUrl || '').trim().replace(/\/+$/, '');
  const apiKey = String(gateway.apiKey || '').trim();
  if (!baseUrl) throw new Error('gateway_base_url_missing');
  if (!apiKey) throw new Error('gateway_api_key_missing');

  let catalog = input.catalog || null;
  if (!catalog) {
    catalog = await fetchGatewayModelCatalog({
      baseUrl,
      apiKey,
      fetchImpl: input.fetchImpl,
      timeoutMs: input.timeoutMs
    });
  }
  catalog = withModelMetadata(catalog, provider);
  catalog = ensureRequestedModel(catalog, input.model, provider);
  const models = buildHarnessModelEntries(catalog);
  if (!models.length) throw new Error('gateway_model_catalog_empty');
  const requested = String(input.model || '').trim();
  const model = models.some((entry) => entry.id === requested)
    ? requested
    : String(models[0].id || '').trim();

  const agentDir = resolveHarnessProjectionRoot({
    fs: fsImpl,
    path: pathImpl,
    aiHomeDir: input.aiHomeDir,
    harnessId: 'pi',
    accountRef
  });
  const modelsPath = pathImpl.join(agentDir, 'models.json');
  const extensionsDir = pathImpl.join(agentDir, 'extensions');
  fsImpl.mkdirSync(extensionsDir, { recursive: true, mode: 0o700 });
  const extensionPath = pathImpl.join(extensionsDir, EXTENSION_FILE);
  const extensionSource = input.extensionSource
    || fsImpl.readFileSync(pathImpl.join(__dirname, 'pi-extension.ts'), 'utf8');
  writePrivateText(fsImpl, extensionPath, extensionSource);

  const document = buildPiModelsDocument({
    baseUrl,
    accountRef,
    models
  });
  writePrivateJson(fsImpl, modelsPath, document);

  const sessionSummary = linkHostSessions({
    fs: fsImpl,
    path: pathImpl,
    projectionRoot: agentDir,
    hostHomeDir: input.hostHomeDir,
    hostSegments: ['.pi', 'agent']
  });

  return {
    ok: true,
    harness: 'pi',
    agentDir,
    modelsPath,
    extensionPath,
    models,
    model,
    args: buildPiLaunchArgs({ model, nativeArgs: [
      ...buildManagedHostPluginArgs({ host: 'pi', aiHomeDir: input.aiHomeDir, hostHomeDir: input.hostHomeDir }),
      ...(Array.isArray(input.nativeArgs) ? input.nativeArgs : [])
    ] }),
    env: {
      PI_CODING_AGENT_DIR: agentDir,
      OPENAI_API_KEY: apiKey,
      '$OPENAI_API_KEY': apiKey
    },
    sessionSummary
  };
}

module.exports = {
  EXTENSION_FILE,
  PROVIDER_ID,
  buildPiLaunchArgs,
  buildPiModelsDocument,
  preparePiHarness
};
