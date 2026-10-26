'use strict';

// Adapter references are resolved at composition; service credentials never
// live in descriptors or in client-visible capability metadata.

const BUILTIN_TRANSLATION_PROVIDER_DESCRIPTORS = Object.freeze([
  {
    contractVersion: 1,
    id: 'aih-gateway',
    label: 'AIH Gateway',
    capabilities: {
      operations: ['selection', 'batch', 'page', 'replace'],
      streaming: true,
      detection: false,
      sourceAuto: true,
      glossary: true,
      formality: true
    },
    auth: {
      modes: ['managed'],
      required: false,
      fields: ['model', 'modelProvider']
    },
    config: {
      fields: ['model', 'provider', 'routes'],
      routeField: 'routes',
      modelSource: 'gateway',
      fieldDefinitions: {}
    },
    clientFreeAdapter: 'aih-gateway',
    metadata: { transport: 'local-gateway', access: 'managed', accessLabel: '使用 AIH 账号池', accessDescription: '由现有网关账号和模型目录提供翻译。' }
  },
  {
    contractVersion: 1,
    id: 'microsoft',
    label: 'Microsoft Translator',
    capabilities: { operations: ['selection', 'batch', 'page', 'replace'], streaming: false, detection: true, sourceAuto: true, glossary: false, formality: false },
    auth: { modes: ['api-key'], required: true, fields: ['apiKey', 'region'] },
    config: { fields: ['apiKey', 'region', 'endpoint'], modelSource: 'service', defaultModel: 'default', fieldDefinitions: { apiKey: { label: 'API Key', secret: true, required: true }, region: { label: '区域', placeholder: '例如 eastasia' }, endpoint: { label: '服务地址', format: 'url', defaultValue: 'https://api.cognitive.microsofttranslator.com' } } },
    clientFreeAdapter: 'microsoft',
    metadata: { service: 'azure-translator', access: 'official-free-quota', accessLabel: '官方免费额度 / 付费服务', accessDescription: '需 Azure Translator 密钥；免费额度与计费以官方账户条款为准。' }
  },
  {
    contractVersion: 1,
    id: 'google',
    label: 'Google Translate',
    capabilities: { operations: ['selection', 'batch', 'page', 'replace'], streaming: false, detection: true, sourceAuto: true, glossary: false, formality: false },
    auth: { modes: ['api-key'], required: true, fields: ['apiKey'] },
    config: { fields: ['apiKey', 'endpoint'], modelSource: 'service', defaultModel: 'default', fieldDefinitions: { apiKey: { label: 'API Key', secret: true, required: true }, endpoint: { label: '服务地址', format: 'url', defaultValue: 'https://translation.googleapis.com' } } },
    clientFreeAdapter: 'google',
    metadata: { service: 'cloud-translation-basic-v2', access: 'official-cloud', accessLabel: '官方云服务', accessDescription: '需 Google Cloud API Key；额度、赠金与计费以官方账户条款为准。' }
  },
  {
    contractVersion: 1,
    id: 'libretranslate',
    label: 'LibreTranslate',
    capabilities: { operations: ['selection', 'batch', 'page', 'replace'], streaming: false, detection: true, sourceAuto: true, glossary: false, formality: false },
    auth: { modes: ['api-key', 'none'], required: false, fields: ['apiKey', 'endpoint'] },
    config: { fields: ['apiKey', 'endpoint'], modelSource: 'service', defaultModel: 'default', fieldDefinitions: { apiKey: { label: 'API Key', secret: true }, endpoint: { label: '服务地址', format: 'url', required: true, placeholder: 'https://translate.example.com' } } },
    clientFreeAdapter: 'libretranslate',
    metadata: { service: 'libretranslate', access: 'self-hosted', accessLabel: '自托管 / 自行提供服务', accessDescription: '需要可访问的 LibreTranslate 服务地址；开源软件不代表提供免费公共服务。' }
  },
  {
    contractVersion: 1,
    id: 'deepl',
    label: 'DeepL',
    capabilities: { operations: ['selection', 'batch', 'page', 'replace'], streaming: false, detection: true, sourceAuto: true, glossary: false, formality: true },
    auth: { modes: ['api-key'], required: true, fields: ['apiKey', 'endpoint'] },
    config: { fields: ['apiKey', 'endpoint'], modelSource: 'service', defaultModel: 'default', fieldDefinitions: { apiKey: { label: 'API Key', secret: true, required: true }, endpoint: { label: '服务地址', format: 'url', placeholder: '留空时根据密钥选择 Free / Pro 地址' } } },
    clientFreeAdapter: 'deepl',
    metadata: { service: 'deepl', access: 'official-free-quota', accessLabel: '官方 API Free / Pro', accessDescription: '需 DeepL API 密钥；API Free 的额度与地区限制以官方条款为准。' }
  }
]);

module.exports = { BUILTIN_TRANSLATION_PROVIDER_DESCRIPTORS };
