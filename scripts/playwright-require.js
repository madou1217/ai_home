'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function pushUnique(items, value) {
  const normalized = String(value || '').trim();
  if (!normalized || items.includes(normalized)) return;
  items.push(normalized);
}

function getPathEntries(env = process.env) {
  return String(env.PATH || '')
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function buildNpxPathCandidates(env = process.env) {
  const candidates = [];
  getPathEntries(env).forEach((entry) => {
    if (path.basename(entry) !== '.bin') return;
    const nodeModulesDir = path.dirname(entry);
    if (path.basename(nodeModulesDir) !== 'node_modules') return;
    pushUnique(candidates, path.join(nodeModulesDir, 'playwright'));
  });
  return candidates;
}

function buildNpxCacheCandidates(input = {}) {
  const fsImpl = input.fsImpl || fs;
  const homeDir = input.homeDir || os.homedir();
  const npxRoot = path.join(homeDir, '.npm', '_npx');
  try {
    return fsImpl.readdirSync(npxRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const dir = path.join(npxRoot, entry.name);
        let mtimeMs = 0;
        try {
          mtimeMs = Number(fsImpl.statSync(dir).mtimeMs) || 0;
        } catch (_error) {
          mtimeMs = 0;
        }
        return {
          path: path.join(dir, 'node_modules', 'playwright'),
          mtimeMs
        };
      })
      .sort((left, right) => right.mtimeMs - left.mtimeMs)
      .map((entry) => entry.path);
  } catch (_error) {
    return [];
  }
}

function buildPlaywrightModuleCandidates(input = {}) {
  const env = input.env || process.env;
  const cwd = input.cwd || process.cwd();
  const scriptDir = input.scriptDir || __dirname;
  const candidates = [];

  pushUnique(candidates, env.PLAYWRIGHT_REQUIRE_PATH);
  pushUnique(candidates, path.join(cwd, 'node_modules', 'playwright'));
  pushUnique(candidates, path.join(scriptDir, '..', 'node_modules', 'playwright'));
  buildNpxPathCandidates(env).forEach((candidate) => pushUnique(candidates, candidate));
  pushUnique(candidates, path.join('/opt/homebrew/lib/node_modules', 'playwright'));
  pushUnique(candidates, path.join('/usr/local/lib/node_modules', 'playwright'));
  pushUnique(candidates, path.join('/opt/homebrew/Cellar/playwright-cli/0.1.14/libexec/lib/node_modules/@playwright/cli/node_modules/playwright'));
  pushUnique(candidates, path.join('/opt/homebrew/Cellar/playwright-mcp/0.0.76/libexec/lib/node_modules/@playwright/mcp/node_modules/playwright'));
  buildNpxCacheCandidates(input).forEach((candidate) => pushUnique(candidates, candidate));

  return candidates;
}

function findPlaywrightModulePath(input = {}) {
  const fsImpl = input.fsImpl || fs;
  for (const candidate of buildPlaywrightModuleCandidates(input)) {
    if (!candidate) continue;
    if (fsImpl.existsSync(path.join(candidate, 'package.json'))) return candidate;
  }
  return '';
}

function loadPlaywright(input = {}) {
  try {
    return require('playwright');
  } catch (error) {
    const candidate = findPlaywrightModulePath(input);
    if (candidate) return require(candidate);
    const next = new Error(input.message || 'playwright_package_missing: run with `npx --yes --package playwright node <script>`');
    next.cause = error;
    throw next;
  }
}

module.exports = {
  buildNpxPathCandidates,
  buildPlaywrightModuleCandidates,
  findPlaywrightModulePath,
  loadPlaywright
};
