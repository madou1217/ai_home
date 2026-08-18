'use strict';
// Split web/src/services/control-plane-profiles.ts:
//   domain B = normalization/endpoint-resolution pure layer -> control-plane-profile-normalization.ts
//   main     = storage/events/sync/save/device-api core, imports + re-exports domain B
// Behavior-preserving: external export surface unchanged (re-export), tests green.
// Reads original from git HEAD so the script is re-runnable.
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const SRC_REL = 'web/src/services/control-plane-profiles.ts';
const DOMAIN_REL = 'web/src/services/control-plane-profile-normalization.ts';

function gitHeadSource(rel) {
  const raw = execSync(`git show HEAD:${rel}`, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const lines = raw.split('\n');
  if (lines.length < 1500) throw new Error(`${rel} too small (${lines.length}) - refusing`);
  return lines;
}

const lines = gitHeadSource(SRC_REL);

// --- domain line set ------------------------------------------------------
// moved-in base decls (contiguous slices in the 61-131 base segment)
// NOTE: 148-155 (normalizeFabricServerId) lives inside DOMAIN_BODY already - do NOT list twice
const MOVED_SLICES = [[72, 72], [74, 78], [79, 82], [102, 108], [110, 114]];
// domain body: normalizeText(133) .. normalizeProfile(953)
const DOMAIN_BODY = [133, 953];

const domainLineSet = new Set();
for (const [a, b] of [...MOVED_SLICES, DOMAIN_BODY]) {
  for (let i = a; i <= b; i++) domainLineSet.add(i);
}

// non-exported domain decls that main still needs -> add export keyword
const NEED_EXPORT = new Set([
  'normalizeText',
  'hasConfiguredManagementKey',
  'normalizeProfileConnectionMode',
  'normalizeProfileBroker',
  'getCurrentWebUiControlPlaneEndpoint',
  'inferProfileState',
  'stableProfileId',
  'resolveServerAuthorizationState',
  'selectProfileRoute',
  'normalizeAnyDescriptor',
  'normalizeDeviceStatus',
  'normalizeDeviceAccounts',
  'normalizeDeviceSessions',
  'normalizeDeviceNodeSessions',
  'normalizeDeviceSessionMessages',
  'normalizeDeviceNodeSessionMessages',
  'normalizeDeviceNodeSessionInput',
  'normalizeDeviceSessionEvents',
  'normalizeDeviceSessionStreamFrame',
  'normalizeDeviceNodeSessionStreamFrame',
  'normalizeDeviceNodes',
  'normalizeProfileNodes',
  'normalizeProfile',
]);

// --- import headers -------------------------------------------------------
const VALUE_IMPORTS_DOMAIN = [
  ["buildControlPlaneHttpUrl", './control-plane-api-client'],
  ["normalizeControlPlaneEndpoint", './control-plane-api-client'],
  ["isNativeDesktopRuntime", './native-server-profile-repository'],
  ["migrateLegacyServerRoutes", './server-routes/server-route-service'],
  ["normalizeStableServerId", './server-routes/server-route-service'],
  ["providerIds", '../providers/catalog'],
];
const TYPE_IMPORTS_DOMAIN = [
  "ControlPlaneDescriptor", "ControlPlaneDeviceAccountsResponse",
  "ControlPlaneDeviceAccountSummary", "ControlPlaneDeviceSessionEvent", "ControlPlaneDeviceSessionEventsResponse",
  "ControlPlaneDeviceNodeSessionInputResponse", "ControlPlaneDeviceNodeSessionMessagesResponse",
  "ControlPlaneDeviceNodeSessionsResponse", "ControlPlaneDeviceNodeSessionStreamFrame",
  "ControlPlaneDeviceSessionStreamFrame", "ControlPlaneDeviceSessionMessagesResponse",
  "ControlPlaneDeviceSessionMessagesSummary", "ControlPlaneDeviceSessionsResponse",
  "ControlPlaneDeviceSessionSummary", "ControlPlaneDeviceNodesResponse", "ControlPlaneDeviceStatus",
  "ControlPlaneDeviceStatusResponse", "ControlPlaneNodeSummary", "ControlPlaneProfileBroker",
  "ControlPlaneProfileConnectionMode", "ControlPlaneProfileState", "ControlPlaneProfile",
  "ServerAuthorizationState", "ServerRoute",
];
const RE_EXPORT_NAMES = [
  'CONTROL_PLANE_PROFILE_STATES',
  'CONTROL_PLANE_PROFILE_CONNECTION_MODES',
  'buildFabricBrokerProxyEndpoint',
  'resolveControlPlaneProfileEndpointInput',
  'normalizeControlPlaneProfileState',
  'buildControlPlaneDescriptorUrl',
];
const RE_EXPORT_TYPE_NAMES = [
  'ControlPlaneProfileEndpointInput',
  'ControlPlaneProfileEndpointResolution',
];
// main keeps value imports: resolveWebUiManagementKey, normalizeControlPlaneEndpoint, isNativeDesktopRuntime,
// listNativeServerProfiles, removeNativeServerProfile, setActiveNativeServerProfile, upsertNativeServerProfile,
// isNativeServerTransportAvailable, openNativeServerSse, requestNativeServerJson,
// mergeServerRoutes, migrateLegacyServerRoutes, normalizeStableServerId,
// buildControlPlaneHttpUrl? NO (domain-only), createControlPlaneApiClient, consumeControlPlaneEventStream,
// providerIds? NO (domain-only)
// Main drops: buildControlPlaneHttpUrl, providerIds
// Type imports in main's head that become unused once domain owns the normalize layer:
const MAIN_TYPE_DROP = new Set([
  'ControlPlaneDeviceAccountsResponse',
  'ControlPlaneDeviceAccountSummary',
  'ControlPlaneDeviceSessionEvent',
  'ControlPlaneDeviceSessionEventsResponse',
  'ControlPlaneDeviceNodeSessionInputResponse',
  'ControlPlaneDeviceNodeSessionMessagesResponse',
  'ControlPlaneDeviceNodeSessionsResponse',
  'ControlPlaneDeviceNodeSessionStreamFrame',
  'ControlPlaneDeviceSessionStreamFrame',
  'ControlPlaneDeviceSessionMessagesResponse',
  'ControlPlaneDeviceSessionMessagesSummary',
  'ControlPlaneDeviceSessionsResponse',
  'ControlPlaneDeviceSessionSummary',
  'ControlPlaneDeviceNodesResponse',
  'ControlPlaneDeviceStatusResponse',
]);

// --- assemble domain module ----------------------------------------------
function renderImportBlock(entries, typeOnly) {
  const perModule = new Map();
  for (const [name, mod] of entries) {
    if (!perModule.has(mod)) perModule.set(mod, []);
    perModule.get(mod).push(name);
  }
  const out = [];
  for (const [mod, names] of perModule) {
    out.push(`import ${typeOnly ? 'type ' : ''}{`);
    for (const n of names) out.push(`  ${n},`);
    out.push(`} from '${mod}';`);
    out.push('');
  }
  return out;
}

function domainExportFixup(text) {
  // add `export ` to non-exported decls main needs; keep existing exports untouched
  const out = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^(async\s+)?function\s+([A-Za-z0-9_$]+)/);
    if (m && !line.trim().startsWith('export ') && NEED_EXPORT.has(m[2])) {
      out.push(`export ${line}`);
    } else {
      out.push(line);
    }
  }
  return out.join('\n');
}

const domainParts = [];
domainParts.push("'use strict';");
domainParts.push('');
domainParts.push(renderImportBlock(VALUE_IMPORTS_DOMAIN, false).join('\n'));
domainParts.push(`import type {`);
for (const t of TYPE_IMPORTS_DOMAIN) domainParts.push(`  ${t},`);
domainParts.push(`} from '@/types';`);
domainParts.push('');
// moved-in base decls
for (const [a, b] of MOVED_SLICES) {
  domainParts.push(lines.slice(a - 1, b).join('\n'));
  domainParts.push('');
}
// domain body
domainParts.push(domainExportFixup(lines.slice(DOMAIN_BODY[0] - 1, DOMAIN_BODY[1]).join('\n')));
const domainText = domainParts.join('\n');
fs.writeFileSync(DOMAIN_REL, domainText);
console.log(`wrote ${DOMAIN_REL} (${domainText.split('\n').length} lines)`);

// --- assemble main module -------------------------------------------------
const mainParts = [];
// keep original head imports (1..57) verbatim
mainParts.push(lines.slice(0, 57).join('\n'));
// drop buildControlPlaneHttpUrl + providerIds from head? they sit in the verbatim slice;
// instead we keep them ONLY if still used - they are domain-only, so remove via rewrite below.
// export { normalizeControlPlaneEndpoint }; (line 59)
mainParts.push(lines.slice(57, 59).join('\n'));
mainParts.push('');
// real domain import (all NEED_EXPORT names + resolveControlPlaneProfileEndpointInput,
// which main uses locally in saveControlPlaneProfile while also re-exporting it)
const mainNeed = [...NEED_EXPORT, 'resolveControlPlaneProfileEndpointInput'].sort();
mainParts.push(`import {`);
for (const n of mainNeed) mainParts.push(`  ${n},`);
mainParts.push(`} from './control-plane-profile-normalization';`);
mainParts.push('');
// re-export original domain exports to keep export surface unchanged
mainParts.push(`export {`);
for (const n of RE_EXPORT_NAMES) mainParts.push(`  ${n},`);
mainParts.push(`} from './control-plane-profile-normalization';`);
mainParts.push('');
// type re-exports must use `export type` under isolatedModules
mainParts.push(`export type {`);
for (const n of RE_EXPORT_TYPE_NAMES) mainParts.push(`  ${n},`);
mainParts.push(`} from './control-plane-profile-normalization';`);
mainParts.push('');
// factory body: keep 60..73 base, 79..101 base, 116..131 base (skipping moved slices + domain body)
for (let i = 60; i <= lines.length; i++) {
  if (domainLineSet.has(i)) continue;
  mainParts.push(lines[i - 1]);
}
let mainText = mainParts.join('\n');
// remove now-unused value imports from the verbatim head (domain-only imports)
mainText = mainText
  .replace(/^\s*buildControlPlaneHttpUrl,\s*\n/gm, '')
  .replace(/^\s*buildControlPlaneHttpUrl\s*\n/gm, '')
  .replace(/^import \{ providerIds \} from '\.\.\/providers\/catalog';\n/gm, '');
// remove now-unused type imports from the verbatim head (@/types names only used by domain)
for (const name of MAIN_TYPE_DROP) {
  mainText = mainText
    .replace(new RegExp(`^  ${name},\\n`, 'gm'), '')
    .replace(new RegExp(`^  ${name}\\n`, 'gm'), '');
}
fs.writeFileSync(SRC_REL, mainText);
console.log(`wrote ${SRC_REL} (${mainText.split('\n').length} lines)`);

// --- verification ---------------------------------------------------------
const ts = require(path.join(__dirname, '..', 'web', 'node_modules', 'typescript'));
for (const f of [SRC_REL, DOMAIN_REL]) {
  const src = fs.readFileSync(f, 'utf8');
  const sf = ts.createSourceFile(f, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const errs = sf.parseDiagnostics || [];
  if (errs.length) {
    console.log(`TS parse errors in ${f}:`);
    for (const e of errs) console.log('  ', ts.flattenDiagnosticMessageText(e.messageText, '\n'));
    process.exitCode = 1;
  } else {
    console.log(`TS parse OK: ${f}`);
  }
}
// line accounting: every original line 1..2349 must be in main OR domain
// (except intentionally removed domain-only imports)
const INTENTIONAL_DROPS = new Set([
  'buildControlPlaneHttpUrl,',
  "import { providerIds } from '../providers/catalog';",
  'ControlPlaneDeviceAccountsResponse,',
  'ControlPlaneDeviceAccountSummary,',
  'ControlPlaneDeviceSessionEvent,',
  'ControlPlaneDeviceSessionEventsResponse,',
  'ControlPlaneDeviceNodeSessionInputResponse,',
  'ControlPlaneDeviceNodeSessionMessagesResponse,',
  'ControlPlaneDeviceNodeSessionsResponse,',
  'ControlPlaneDeviceNodeSessionStreamFrame,',
  'ControlPlaneDeviceSessionStreamFrame,',
  'ControlPlaneDeviceSessionMessagesResponse,',
  'ControlPlaneDeviceSessionMessagesSummary,',
  'ControlPlaneDeviceSessionsResponse,',
  'ControlPlaneDeviceSessionSummary,',
  'ControlPlaneDeviceNodesResponse,',
  'ControlPlaneDeviceStatusResponse,',
]);
let missing = 0;
for (let i = 1; i <= lines.length; i++) {
  if (domainLineSet.has(i)) continue;
  const t = lines[i - 1].trim();
  if (t && !t.startsWith('//') && !t.startsWith('*')) {
    if (INTENTIONAL_DROPS.has(t)) continue;
    // check the line survived in mainText
    if (!mainText.includes(lines[i - 1].trim())) {
      if (missing < 20) console.log(`MISSING line ${i}: ${lines[i - 1]}`);
      missing++;
    }
  }
}
console.log(`\nmissing non-blank main lines: ${missing}`);
if (missing > 0) process.exitCode = 1;
