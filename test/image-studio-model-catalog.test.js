'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { listImageStudioModels } = require('../lib/server/image-studio-model-catalog');

function oauthAccount(provider, accountRef, extra = {}) {
  return {
    provider,
    accountRef,
    accessToken: 'token',
    ...extra
  };
}

test('studio image catalog adds virtual gpt-image models for Codex OAuth accounts', () => {
  const models = listImageStudioModels({
    accounts: { codex: [oauthAccount('codex', 'acct_codex_image_0001')] }
  }, { now: 1 });
  assert.equal(models[0].id, 'gpt-image-2');
  assert.equal(models[0].provider, 'codex');
  assert.equal(models[0].capabilities.edit, true);
  assert.equal(models[0].capabilities.size, true);
  assert.equal(models[0].capabilities.quality, true);
  assert.equal(models[0].capabilities.multiple, true);
  assert.equal(models[0].capabilities.maxInputImages, 5);
  assert.equal(models[0].capabilities.background, true);
  assert.equal(models[0].capabilities.mask, false);
  assert.equal(models[0].capabilities.outputFormat, false);
  assert.deepEqual(models[0].qualityOptions, ['low', 'medium', 'high']);
});

test('studio image catalog keeps provider routes distinct and includes discovered image models', () => {
  const models = listImageStudioModels({
    accounts: {
      agy: [oauthAccount('agy', 'acct_agy_image_0001', {
        availableModels: ['gemini-3-pro-image', 'gemini-3-flash']
      })],
      gemini: [oauthAccount('gemini', 'acct_gemini_image_0001')]
    }
  }, { now: 1 });
  assert.equal(models.some((item) => item.key === 'agy:gemini-3-pro-image'), true);
  assert.equal(models.some((item) => item.key === 'agy:gemini-3-flash'), false);
  assert.equal(models.some((item) => item.key === 'gemini:gemini-3.1-flash-image'), true);
});

test('studio image catalog exposes model-specific Grok quality options', () => {
  const models = listImageStudioModels({
    accounts: {
      grok: [{ provider: 'grok', accountRef: 'acct_grok', accessToken: 'token' }]
    }
  });
  const current = models.find((model) => model.key === 'grok:grok-imagine-image-2.0');
  const quality = models.find((model) => model.key === 'grok:grok-imagine-image-quality');
  const legacy = models.find((model) => model.key === 'grok:grok-imagine-image');
  assert.deepEqual(current.qualityOptions, ['low', 'medium']);
  assert.equal(current.capabilities.quality, true);
  assert.equal(current.capabilities.maxInputImages, 3);
  assert.ok(quality);
  assert.deepEqual(quality.qualityOptions, []);
  assert.equal(quality.capabilities.quality, false);
  assert.equal(quality.capabilities.maxInputImages, 1);
  assert.deepEqual(legacy.qualityOptions, []);
  assert.equal(legacy.capabilities.quality, false);
  assert.equal(legacy.capabilities.maxInputImages, 1);
});

test('studio image catalog grants passthrough controls only to discovered api-key models', () => {
  const models = listImageStudioModels({
    accounts: {
      codex: [{
        provider: 'codex',
        accountRef: 'acct_codex_image_0002',
        authType: 'api-key',
        apiKey: 'key',
        availableModels: ['gpt-image-2', 'gpt-5.5']
      }]
    }
  }, { now: 1 });
  assert.deepEqual(models.map((item) => item.id), ['gpt-image-2']);
  assert.equal(models[0].capabilities.mask, true);
  assert.equal(models[0].capabilities.size, true);
  assert.equal(models[0].capabilities.maxInputImages, 16);
  assert.equal(models[0].capabilities.outputCompression, true);
});

test('studio image catalog never assigns a provider aggregate model to another api-key account', () => {
  const models = listImageStudioModels({
    accounts: {
      codex: [
        {
          provider: 'codex',
          accountRef: 'acct_known_endpoint',
          authType: 'api-key',
          apiKey: 'known-key'
        },
        {
          provider: 'codex',
          accountRef: 'acct_other_endpoint',
          authType: 'api-key',
          apiKey: 'other-key'
        }
      ]
    },
    webUiModelsCache: {
      byAccount: {
        acct_known_endpoint: ['gpt-image-2']
      },
      byProvider: {
        codex: ['gpt-image-2']
      }
    }
  }, { now: 1 });

  const model = models.find((item) => item.key === 'codex:gpt-image-2');
  assert.ok(model);
  assert.equal(model.accountCount, 1);
  assert.equal(model.availableAccountCount, 1);
});

test('studio image catalog exposes only capabilities backed by currently schedulable accounts', () => {
  const models = listImageStudioModels({
    accounts: {
      codex: [
        oauthAccount('codex', 'acct_codex_image_oauth'),
        {
          provider: 'codex',
          accountRef: 'acct_codex_image_key',
          authType: 'api-key',
          apiKey: 'key',
          schedulableStatus: 'disabled',
          availableModels: ['gpt-image-2']
        }
      ]
    }
  }, { now: 1 });
  const model = models.find((item) => item.key === 'codex:gpt-image-2');
  assert.ok(model);
  assert.equal(model.accountCount, 2);
  assert.equal(model.availableAccountCount, 1);
  assert.equal(model.capabilities.edit, true);
  assert.equal(model.capabilities.mask, false);
  assert.equal(model.capabilities.size, true);
});

test('studio image catalog keeps gpt-image-2 visible and explains why Codex accounts are unavailable', () => {
  const models = listImageStudioModels({
    accounts: {
      codex: [
        oauthAccount('codex', 'acct_codex_image_quota', {
          schedulableStatus: 'blocked_by_quota',
          schedulableReason: 'usage_exhausted'
        }),
        oauthAccount('codex', 'acct_codex_image_policy', {
          schedulableStatus: 'blocked_by_policy',
          schedulableReason: 'codex_usage_below_server_threshold'
        })
      ]
    }
  }, { now: 1 });

  const model = models.find((item) => item.key === 'codex:gpt-image-2');
  assert.ok(model);
  assert.equal(model.accountCount, 2);
  assert.equal(model.availableAccountCount, 0);
  assert.deepEqual(model.unavailableReasons, [
    { reason: 'blocked_by_policy:codex_usage_below_server_threshold', count: 1 },
    { reason: 'blocked_by_quota:usage_exhausted', count: 1 }
  ]);
});
