'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const { resolveAiHomeDir } = require('../../runtime/aih-home');
const { createSystemTranslationService } = require('../translation/service');

/**
 * Start the standalone desktop host. The host is the Node consumer for the
 * native full-app process: it owns the JSON protocol, persists settings, and
 * routes translation requests through the direct-provider execution port.
 */
function createFullAppHost({ serviceFactory = createSystemTranslationService, fsImpl = fs, aiHomeDir, platform = process.platform, executionTarget, ...options } = {}) {
  const root = aiHomeDir || resolveAiHomeDir();
  const service = serviceFactory({
    ...options,
    fs: fsImpl,
    aiHomeDir: root,
    platform,
    mode: 'full-app',
    ...(executionTarget ? { executionTarget } : {})
  });
  let started = false;
  return {
    service,
    async start() {
      if (started) return service.getStatus();
      started = true;
      await service.setEnabled(true);
      return service.getStatus();
    },
    stop() {
      started = false;
      service.stop();
    },
    async translate(text, target = 'zh-Hans') {
      const id = crypto.randomUUID();
      service.sendEvent({ type: 'host-translate', id, text: String(text || ''), target });
      return service.translate({ id, text: String(text || ''), target, targetPolicy: 'explicit' });
    }
  };
}

async function runFullAppHost(options = {}) {
  const host = createFullAppHost(options);
  await host.start();
  const stop = () => host.stop();
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  return host;
}

module.exports = { createFullAppHost, runFullAppHost };
