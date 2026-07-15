#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { loadPlaywright } = require('./playwright-require');

const DEFAULT_ENDPOINT = 'http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527';
const DEFAULT_ALTERNATE_ENDPOINT = 'http://43.207.102.163:9527';
const DEFAULT_TIMEOUT_MS = 90000;
const DEFAULT_BROWSER_CHANNEL = 'chrome';
const PROFILE_STORAGE_KEY = 'aih:control-plane-profiles:v1';
const ACTIVE_PROFILE_STORAGE_KEY = 'aih:active-control-plane-profile:v1';

function showHelp() {
  console.log(`AIH Fabric real server profile switch smoke

Usage:
  npx --yes --package playwright node scripts/fabric-real-server-profile-switch-smoke.js [options]

Options:
  --endpoint <url>             Primary AWS/current endpoint, default ${DEFAULT_ENDPOINT}.
  --alternate-endpoint <url>   Second real endpoint for the same AWS server, default ${DEFAULT_ALTERNATE_ENDPOINT}.
  --timeout-ms <n>             End-to-end browser timeout, default ${DEFAULT_TIMEOUT_MS}.
  --diagnostics-file <path>    Optional sanitized JSON export path.
  --browser-channel <channel>  Playwright browser channel, default ${DEFAULT_BROWSER_CHANNEL}; use bundled for Playwright Chromium.
  --headed                     Show the browser window.
  -h, --help                   Show this help.

Set AIH_MANAGEMENT_KEY before running. The smoke opens the real WebUI Server
Setup page in Chromium, saves both Server URL + Management Key profiles,
switches the active server through the product selector, reloads to prove
persistence, and reads the active node inventory with the Management Key. It
does not use mock data and does not open a new product port.
`);
}

function isFlag(value) {
  return String(value || '').startsWith('-');
}

function readOptionValue(args, index, flag) {
  const token = String(args[index] || '');
  const prefix = `${flag}=`;
  if (token.startsWith(prefix)) return { value: token.slice(prefix.length), consumed: 1 };
  const value = args[index + 1];
  if (value === undefined || isFlag(value)) throw new Error(`${flag} requires a value`);
  return { value: String(value), consumed: 2 };
}

function normalizeHttpEndpoint(value, flag) {
  const raw = String(value || '').trim().replace(/\/+$/, '');
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('invalid_protocol');
    parsed.hash = '';
    parsed.search = '';
    return parsed.toString().replace(/\/+$/, '');
  } catch (_error) {
    throw new Error(`${flag} must be a valid http(s) URL`);
  }
}

function normalizeBrowserChannel(value) {
  const normalized = String(value || '').trim();
  if (!normalized) return '';
  if (['bundled', 'chromium', 'playwright'].includes(normalized.toLowerCase())) return '';
  return normalized;
}

function parsePositiveInteger(value, flag, fallback, min, max) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${flag} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function parseArgs(argv = [], env = process.env) {
  const options = {
    help: false,
    endpoint: DEFAULT_ENDPOINT,
    alternateEndpoint: DEFAULT_ALTERNATE_ENDPOINT,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    diagnosticsFile: '',
    browserChannel: DEFAULT_BROWSER_CHANNEL,
    managementKey: String(env.AIH_MANAGEMENT_KEY || '').trim(),
    headed: false
  };

  for (let index = 0; index < argv.length;) {
    const token = String(argv[index] || '').trim();
    if (!token) {
      index += 1;
      continue;
    }
    if (token === '-h' || token === '--help') {
      options.help = true;
      index += 1;
      continue;
    }
    if (token === '--headed') {
      options.headed = true;
      index += 1;
      continue;
    }
    if (token === '--endpoint' || token.startsWith('--endpoint=')) {
      const next = readOptionValue(argv, index, '--endpoint');
      options.endpoint = normalizeHttpEndpoint(next.value, '--endpoint');
      index += next.consumed;
      continue;
    }
    if (token === '--alternate-endpoint' || token.startsWith('--alternate-endpoint=')) {
      const next = readOptionValue(argv, index, '--alternate-endpoint');
      options.alternateEndpoint = normalizeHttpEndpoint(next.value, '--alternate-endpoint');
      index += next.consumed;
      continue;
    }
    if (token === '--timeout-ms' || token.startsWith('--timeout-ms=')) {
      const next = readOptionValue(argv, index, '--timeout-ms');
      options.timeoutMs = parsePositiveInteger(next.value, '--timeout-ms', DEFAULT_TIMEOUT_MS, 5000, 240000);
      index += next.consumed;
      continue;
    }
    if (token === '--diagnostics-file' || token.startsWith('--diagnostics-file=')) {
      const next = readOptionValue(argv, index, '--diagnostics-file');
      options.diagnosticsFile = String(next.value || '').trim();
      index += next.consumed;
      continue;
    }
    if (token === '--browser-channel' || token.startsWith('--browser-channel=')) {
      const next = readOptionValue(argv, index, '--browser-channel');
      options.browserChannel = normalizeBrowserChannel(next.value);
      index += next.consumed;
      continue;
    }
    throw new Error(`unknown option: ${token}`);
  }

  if (!options.help && options.endpoint === options.alternateEndpoint) {
    throw new Error('--endpoint and --alternate-endpoint must be different URLs');
  }
  return options;
}

function sanitizeProfile(profile) {
  if (!profile || typeof profile !== 'object') return null;
  return {
    id: String(profile.id || ''),
    name: String(profile.name || ''),
    endpoint: String(profile.endpoint || ''),
    connectionMode: String(profile.connectionMode || ''),
    state: String(profile.state || ''),
    managementKeyConfigured: Boolean(profile.managementKey),
    nodeCount: Number(profile.nodeCount || 0),
    accountCount: Number(profile.accountCount || 0),
    schedulableAccountCount: Number(profile.schedulableAccountCount || 0),
    sessionCount: Number(profile.sessionCount || 0),
    nodes: Array.isArray(profile.nodes)
      ? profile.nodes.map((node) => ({
        id: String(node && node.id || ''),
        name: String(node && node.name || ''),
        role: String(node && node.role || ''),
        online: Boolean(node && node.online),
        transportKinds: Array.isArray(node && node.transportKinds) ? node.transportKinds.map(String) : []
      }))
      : []
  };
}

function sanitizeProfiles(profiles) {
  return (Array.isArray(profiles) ? profiles : [])
    .map(sanitizeProfile)
    .filter(Boolean);
}

function summarizeBrowserConsole(messages = [], pageErrors = []) {
  const compact = (item) => ({
    type: String(item && item.type || ''),
    text: String(item && item.text || '').slice(0, 500)
  });
  return {
    errors: messages.filter((item) => item.type === 'error').length,
    warnings: messages.filter((item) => item.type === 'warning').length,
    errorSamples: messages.filter((item) => item.type === 'error').slice(0, 5).map(compact),
    warningSamples: messages.filter((item) => item.type === 'warning').slice(0, 5).map(compact),
    pageErrors
  };
}

function buildSetupUrl(endpoint) {
  return new URL('/ui/server-setup', endpoint).toString();
}

async function readProfileSnapshot(page) {
  return page.evaluate(({ profileKey, activeKey }) => {
    function readJson(value) {
      try {
        return JSON.parse(value || '[]');
      } catch (_error) {
        return [];
      }
    }
    const profiles = readJson(window.localStorage.getItem(profileKey));
    const activeProfileId = String(window.localStorage.getItem(activeKey) || '');
    return { profiles, activeProfileId };
  }, {
    profileKey: PROFILE_STORAGE_KEY,
    activeKey: ACTIVE_PROFILE_STORAGE_KEY
  });
}

async function waitForReadyProfile(page, endpoint, timeoutMs) {
  try {
    await page.waitForFunction(({ profileKey, expectedEndpoint }) => {
      try {
        const profiles = JSON.parse(window.localStorage.getItem(profileKey) || '[]');
        return Array.isArray(profiles) && profiles.some((profile) => (
          profile
            && profile.endpoint === expectedEndpoint
            && profile.state === 'ready'
            && Boolean(profile.managementKey)
        ));
      } catch (_error) {
        return false;
      }
    }, {
      profileKey: PROFILE_STORAGE_KEY,
      expectedEndpoint: endpoint
    }, { timeout: timeoutMs });
  } catch (error) {
    const snapshot = await readProfileSnapshot(page).catch(() => ({ profiles: [], activeProfileId: '' }));
    const bodyText = await page.locator('body').innerText({ timeout: 1000 }).catch(() => '');
    const next = new Error('webui_ready_profile_store_timeout');
    next.stage = 'webui_save';
    next.cause = error;
    next.context = {
      expectedEndpoint: endpoint,
      currentUrl: page.url(),
      profileCount: Array.isArray(snapshot.profiles) ? snapshot.profiles.length : 0,
      activeProfileId: String(snapshot.activeProfileId || ''),
      profileEndpoints: (Array.isArray(snapshot.profiles) ? snapshot.profiles : [])
        .map((profile) => String(profile && profile.endpoint || ''))
        .filter(Boolean),
      bodyText: bodyText.slice(0, 800)
    };
    throw next;
  }
}

function findProfileByEndpoint(snapshot, endpoint) {
  const profiles = snapshot && Array.isArray(snapshot.profiles) ? snapshot.profiles : [];
  return profiles.find((profile) => profile && profile.endpoint === endpoint) || null;
}

async function saveProfileViaWebUi(page, endpoint, label, options) {
  await page.getByRole('button', { name: '添加 Server' }).first().click();
  const dialog = page.getByRole('dialog', { name: '添加 Server' });
  await dialog.waitFor({ state: 'visible', timeout: Math.min(options.timeoutMs, 30000) });
  await dialog.getByLabel('Server URL').fill(endpoint);
  await dialog.getByLabel('显示名称').fill(label);
  await dialog.getByLabel('Management Key').fill(options.managementKey);
  await dialog.getByRole('button', { name: '探测并保存' }).click();
  await waitForReadyProfile(page, endpoint, options.timeoutMs);
  const snapshot = await readProfileSnapshot(page);
  const profile = findProfileByEndpoint(snapshot, endpoint);
  if (!profile) {
    const error = new Error('ready_profile_missing_after_webui_save');
    error.stage = 'webui_save';
    throw error;
  }
  return profile;
}

async function waitForActiveProfile(page, profileId, timeoutMs) {
  await page.waitForFunction(({ activeKey, expectedProfileId }) => (
    String(window.localStorage.getItem(activeKey) || '') === expectedProfileId
  ), {
    activeKey: ACTIVE_PROFILE_STORAGE_KEY,
    expectedProfileId: profileId
  }, { timeout: timeoutMs });
}

async function switchProfileAndReload(page, profile, options) {
  const profileId = String(profile && profile.id || '');
  const select = page.locator('[data-testid="control-plane-profile-select"]');
  await select.waitFor({ state: 'visible', timeout: Math.min(options.timeoutMs, 30000) });
  await select.click();
  await page.getByRole('menuitem').filter({ hasText: String(profile.name || profile.endpoint) }).click();
  await waitForActiveProfile(page, profileId, options.timeoutMs);
  await page.reload({ waitUntil: 'domcontentloaded', timeout: Math.min(options.timeoutMs, 30000) });
  await waitForActiveProfile(page, profileId, options.timeoutMs);
  const snapshot = await readProfileSnapshot(page);
  if (snapshot.activeProfileId !== profileId) {
    const error = new Error('profile_selector_reload_persistence_failed');
    error.stage = 'profile_switch';
    error.expectedProfileId = profileId;
    error.actualProfileId = snapshot.activeProfileId;
    throw error;
  }
  return snapshot;
}

async function readActiveNodeInventory(page) {
  return page.evaluate(({ profileKey, activeKey }) => {
    function readProfiles() {
      try {
        return JSON.parse(window.localStorage.getItem(profileKey) || '[]');
      } catch (_error) {
        return [];
      }
    }
    const activeProfileId = String(window.localStorage.getItem(activeKey) || '');
    const profiles = readProfiles();
    const active = profiles.find((profile) => profile && profile.id === activeProfileId) || null;
    if (!active) return { ok: false, error: 'active_profile_missing' };
    if (!active.managementKey) return { ok: false, error: 'active_profile_management_key_missing' };
    return fetch(`${String(active.endpoint).replace(/\/+$/, '')}/v0/node-rpc/device-nodes`, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${active.managementKey}`
      },
      credentials: 'omit'
    }).then(async (response) => {
      const payload = await response.json().catch(() => null);
      const nodes = Array.isArray(payload && payload.result && payload.result.nodes)
        ? payload.result.nodes
        : Array.isArray(payload && payload.nodes) ? payload.nodes : [];
      return {
        ok: response.ok,
        status: response.status,
        activeProfileId,
        endpoint: active.endpoint,
        nodeCount: nodes.length,
        nodes: nodes.map((node) => ({
          id: String(node && node.id || ''),
          name: String(node && node.name || ''),
          role: String(node && node.role || ''),
          online: Boolean(node && node.online),
          transportKinds: Array.isArray(node && node.transportKinds) ? node.transportKinds.map(String) : []
        })),
        error: response.ok ? '' : `device_nodes_http_${response.status}`
      };
    }).catch((error) => ({
      ok: false,
      activeProfileId,
      endpoint: active.endpoint,
      nodeCount: 0,
      nodes: [],
      error: String(error && error.message || error || 'device_nodes_fetch_failed')
    }));
  }, {
    profileKey: PROFILE_STORAGE_KEY,
    activeKey: ACTIVE_PROFILE_STORAGE_KEY
  });
}

function createBrowserLaunchOptions(options = {}) {
  const launchOptions = { headless: !options.headed };
  if (options.browserChannel) launchOptions.channel = options.browserChannel;
  return launchOptions;
}

function failureFromError(error) {
  return {
    stage: String(error && error.stage || 'unknown'),
    code: String(error && error.code || error && error.message || error || 'server_profile_switch_smoke_failed'),
    message: String(error && error.message || error || '').slice(0, 500),
    status: Number(error && error.status || 0) || undefined,
    expectedProfileId: error && error.expectedProfileId ? String(error.expectedProfileId) : undefined,
    actualProfileId: error && error.actualProfileId ? String(error.actualProfileId) : undefined,
    context: error && error.context && typeof error.context === 'object' ? error.context : undefined
  };
}

function buildReport(options, details) {
  const finalSnapshot = details.finalSnapshot || {};
  const profiles = sanitizeProfiles(finalSnapshot.profiles);
  const endpoints = [options.endpoint, options.alternateEndpoint];
  const readyProfiles = endpoints
    .map((endpoint) => profiles.find((profile) => profile.endpoint === endpoint) || null)
    .filter((profile) => profile && profile.state === 'ready' && profile.managementKeyConfigured);
  const activeNodeInventory = details.activeNodeInventory || null;
  const switchProofs = Array.isArray(details.switchProofs) ? details.switchProofs : [];
  const failures = [];
  if (readyProfiles.length !== endpoints.length) failures.push({ stage: 'profile_store', code: 'ready_profile_count_mismatch' });
  if (!switchProofs.every((proof) => proof && proof.reloadPersisted)) failures.push({ stage: 'profile_switch', code: 'active_profile_reload_not_proven' });
  if (!activeNodeInventory || !activeNodeInventory.ok || activeNodeInventory.nodeCount < 1) {
    failures.push({
      stage: 'node_inventory',
      code: activeNodeInventory && activeNodeInventory.error || 'active_node_inventory_unavailable'
    });
  }
  if (details.failure) failures.push(details.failure);
  const ok = failures.length === 0;
  return {
    ok,
    mode: 'server-profile-switch-smoke',
    endpoints,
    timeoutMs: options.timeoutMs,
    browser: details.browser || {},
    readyProfiles,
    activeProfileId: String(finalSnapshot.activeProfileId || ''),
    switchProofs,
    activeNodeInventory,
    failures,
    failurePage: details.failurePage || null,
    console: details.console || {}
  };
}

async function writeDiagnosticsFile(filePath, report) {
  if (!filePath) return '';
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return filePath;
}

async function runServerProfileSwitchSmoke(options = {}, deps = {}) {
  const playwright = deps.playwright || loadPlaywright();
  const startedAt = Date.now();
  const consoleMessages = [];
  const pageErrors = [];
  let browser = null;
  let page = null;
  const details = {
    switchProofs: []
  };

  try {
    if (!String(options.managementKey || '').trim()) {
      const error = new Error('missing_management_key');
      error.stage = 'configuration';
      throw error;
    }

    browser = await playwright.chromium.launch(createBrowserLaunchOptions(options));
    const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    page = await context.newPage();
    page.on('console', (message) => {
      consoleMessages.push({ type: message.type(), text: message.text().slice(0, 500) });
    });
    page.on('pageerror', (error) => {
      pageErrors.push({ message: String(error && error.message || error).slice(0, 500) });
    });

    await page.goto(buildSetupUrl(options.endpoint), {
      waitUntil: 'domcontentloaded',
      timeout: Math.min(options.timeoutMs, 30000)
    });
    const primaryProfile = await saveProfileViaWebUi(page, options.endpoint, 'Primary Server', options);
    const alternateProfile = await saveProfileViaWebUi(page, options.alternateEndpoint, 'Alternate Server', options);

    const afterPrimarySwitch = await switchProfileAndReload(page, primaryProfile, options);
    details.switchProofs.push({
      profileId: primaryProfile.id,
      endpoint: primaryProfile.endpoint,
      reloadPersisted: afterPrimarySwitch.activeProfileId === primaryProfile.id
    });
    const afterAlternateSwitch = await switchProfileAndReload(page, alternateProfile, options);
    details.switchProofs.push({
      profileId: alternateProfile.id,
      endpoint: alternateProfile.endpoint,
      reloadPersisted: afterAlternateSwitch.activeProfileId === alternateProfile.id
    });

    details.activeNodeInventory = await readActiveNodeInventory(page);
    details.finalSnapshot = await readProfileSnapshot(page);
    await context.close();
  } catch (error) {
    details.failure = failureFromError(error);
    if (page) {
      details.failurePage = {
        url: page.url(),
        bodyText: await page.locator('body').innerText({ timeout: 1000 })
          .catch(() => '')
          .then((text) => text.slice(0, 800))
      };
      details.finalSnapshot = await readProfileSnapshot(page).catch(() => ({ profiles: [], activeProfileId: '' }));
    } else if (!details.finalSnapshot && browser) {
      details.finalSnapshot = { profiles: [], activeProfileId: '' };
    }
  } finally {
    if (browser) await browser.close();
  }

  details.browser = {
    engine: 'chromium',
    channel: options.browserChannel || 'bundled',
    headed: options.headed === true,
    durationMs: Date.now() - startedAt
  };
  details.console = summarizeBrowserConsole(consoleMessages, pageErrors);
  const report = buildReport(options, details);
  await writeDiagnosticsFile(options.diagnosticsFile, report);
  return report;
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      showHelp();
      return;
    }
    const report = await runServerProfileSwitchSmoke(options);
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
  } catch (error) {
    console.error(`\x1b[31m[aih] fabric real server profile switch smoke failed: ${String(error && error.message || error)}\x1b[0m`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  ACTIVE_PROFILE_STORAGE_KEY,
  DEFAULT_ALTERNATE_ENDPOINT,
  DEFAULT_BROWSER_CHANNEL,
  DEFAULT_ENDPOINT,
  PROFILE_STORAGE_KEY,
  buildReport,
  buildSetupUrl,
  createBrowserLaunchOptions,
  failureFromError,
  normalizeHttpEndpoint,
  parseArgs,
  runServerProfileSwitchSmoke,
  sanitizeProfile,
  sanitizeProfiles,
  writeDiagnosticsFile
};
