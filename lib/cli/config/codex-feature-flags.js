'use strict';

const { execFileSync } = require('node:child_process');

const CODEX_HOOKS_FEATURE_SWITCH_VERSION = '0.114.0';
const CODEX_HOOKS_FEATURE_FLAGS = ['hooks', 'codex_hooks'];

let installedCodexVersionCache;

function parseSemver(value) {
  const match = String(value || '').match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3])
  };
}

function compareSemver(left, right) {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (!a || !b) return null;
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

function getInstalledCodexVersion(options = {}) {
  if (typeof options.codexVersion === 'string') return options.codexVersion;
  if (installedCodexVersionCache !== undefined) return installedCodexVersionCache;

  const command = String(options.codexCommand || 'codex').trim() || 'codex';
  try {
    installedCodexVersionCache = String(execFileSync(command, ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1000
    }) || '').trim();
  } catch (_error) {
    installedCodexVersionCache = '';
  }
  return installedCodexVersionCache;
}

function resolveCodexHooksFeatureFlag(options = {}) {
  const codexVersion = getInstalledCodexVersion(options);
  const comparison = compareSemver(codexVersion, CODEX_HOOKS_FEATURE_SWITCH_VERSION);
  return {
    codexVersion,
    flagName: comparison !== null && comparison < 0 ? 'codex_hooks' : 'hooks',
    switchVersion: CODEX_HOOKS_FEATURE_SWITCH_VERSION
  };
}

function isFeatureLineFor(line, featureNames) {
  const match = String(line || '').trim().match(/^([A-Za-z0-9_-]+)\s*=/);
  return Boolean(match && featureNames.has(match[1]));
}

function findFeaturesSection(lines) {
  const featureIndex = lines.findIndex((line) => String(line || '').trim() === '[features]');
  if (featureIndex === -1) return null;

  let sectionEnd = featureIndex + 1;
  while (sectionEnd < lines.length) {
    const trimmed = String(lines[sectionEnd] || '').trim();
    if (trimmed.startsWith('[')) break;
    sectionEnd += 1;
  }

  return { featureIndex, sectionEnd };
}

function hasCodexHooksFeatureFlag(configText) {
  const featureNames = new Set(CODEX_HOOKS_FEATURE_FLAGS);
  const lines = String(configText || '').split('\n');
  const section = findFeaturesSection(lines);
  if (!section) return false;
  return lines
    .slice(section.featureIndex + 1, section.sectionEnd)
    .some((line) => isFeatureLineFor(line, featureNames));
}

function setFeatureFlag(configText, featureName) {
  const content = String(configText || '');
  const lines = content.split('\n');
  const featureNames = new Set(CODEX_HOOKS_FEATURE_FLAGS);
  const section = findFeaturesSection(lines);

  if (!section) {
    const base = content.trimEnd();
    return `${base}${base ? '\n\n' : ''}[features]\n${featureName} = true\n`;
  }

  const preservedFeatureLines = lines
    .slice(section.featureIndex + 1, section.sectionEnd)
    .filter((line) => !isFeatureLineFor(line, featureNames));

  const nextLines = [
    ...lines.slice(0, section.featureIndex),
    '[features]',
    `${featureName} = true`,
    ...preservedFeatureLines,
    ...lines.slice(section.sectionEnd)
  ];

  return nextLines.join('\n').replace(/\n*$/, '\n');
}

function enableCodexHooksFeatureFlag(configText, options = {}) {
  const resolved = resolveCodexHooksFeatureFlag(options);
  return {
    ...resolved,
    content: setFeatureFlag(configText, resolved.flagName)
  };
}

function normalizeCodexHooksFeatureFlag(configText, options = {}) {
  if (!hasCodexHooksFeatureFlag(configText)) {
    return {
      codexVersion: '',
      flagName: '',
      switchVersion: CODEX_HOOKS_FEATURE_SWITCH_VERSION,
      content: String(configText || '')
    };
  }
  return enableCodexHooksFeatureFlag(configText, options);
}

module.exports = {
  CODEX_HOOKS_FEATURE_SWITCH_VERSION,
  compareSemver,
  enableCodexHooksFeatureFlag,
  getInstalledCodexVersion,
  normalizeCodexHooksFeatureFlag,
  parseSemver,
  resolveCodexHooksFeatureFlag
};
