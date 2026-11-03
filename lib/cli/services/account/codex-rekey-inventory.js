'use strict';

const path = require('node:path');
const { parse: parseToml } = require('smol-toml');
const { sha256 } = require('./rekey-database');
const { inspectReplaceableMetadata } = require('./rekey-file-metadata');
const { hashBackup } = require('./rekey-backup');
const { nativeStoreKind, isNativeSidecar } = require('./rekey-native-policy');
const { inspectNativeStore } = require('./rekey-native-inventory');
const { immutableArtifactReason } = require('./rekey-immutable-artifacts');
const { isUnrelatedLiveObservation, isUnrelatedNativeDiagnostic } = require('./rekey-live-observation-policy');
const {
  containsMappedRef, replaceAccountPathSegments, replaceRuntimeKey, transformJsonText
} = require('./codex-rekey-reference-policy');

const inventoryScope = require('./rekey-inventory-scope');
const SKIPPED_DIRECTORIES = new Set(inventoryScope.skippedDirectories);
const TEXT_EXTENSIONS = new Set(inventoryScope.textExtensions);
const MAX_FILE_BYTES = 16 * 1024 * 1024;

function lstatOptional(fs, file) {
  try { return fs.lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

/**
 * Only a closed set of parsed TOML string fields may change. Comments and
 * formatting remain intact; unrecognized occurrences block rather than letting
 * a global replacement alter an auth command or a third-party configuration.
 */
function transformToml(text, mapping) {
  parseToml(text);
  let next = text;
  for (const [before, after] of mapping) {
    const expression = new RegExp(`^(\\s*(?:["']?X-Account-Ref["']?|AIH_PROVIDER_ACCOUNT_REF|AIH_CODEX_GATEWAY_ACCOUNT_REF)\\s*=\\s*)(["'])${before}\\2`, 'gm');
    next = next.replace(expression, (_all, prefix, quote) => `${prefix}${quote}${after}${quote}`);
  }
  // Known absolute runtime paths inside quoted strings are addresses, not user
  // prose. Parse validation above ensures we are not repairing malformed TOML.
  next = next.replace(/"(?:\\.|[^"\\])*"|'[^']*'/g, token => {
    const quote = token[0];
    let value;
    try { value = quote === '"' ? JSON.parse(token) : token.slice(1, -1); } catch (_) { return token; }
    if (!containsMappedRef(value, mapping) || !path.isAbsolute(value)) return token;
    const changed = replaceAccountPathSegments(value, mapping);
    return quote === '"' ? JSON.stringify(changed) : `'${changed}'`;
  });
  if (containsMappedRef(next.replace(/^\s*#.*$/gm, ''), mapping)) throw new Error('rekey_toml_reference_unclassified');
  return next;
}

function renamedComponent(name, mapping, parent) {
  const simple = replaceAccountPathSegments(name, mapping);
  if (simple !== name) return simple;
  if (parent.endsWith(`${path.sep}persistent-sessions`) && name.endsWith('.json')) {
    const body = name.slice(0, -5);
    return `${body.split('--').map(value => replaceRuntimeKey(value, mapping)).join('--')}.json`;
  }
  return name;
}

/**
 * Enumerates AIH-owned addressing metadata without following symlinks into the
 * user's shared native sessions. Dependency packages, caches and historical
 * transcripts are intentionally immutable resources, not configuration writers.
 * Each skipped subtree is recorded so the inventory is never called a whole-
 * disk search. Unknown references in examined machine files remain blockers.
 */
function buildFilesystemPlan(fs, aiHomeDir, _provider, mapping, options = {}) {
  if (![undefined, 0, 1].includes(options.observationPolicy)) throw new Error('rekey_observation_policy_unsupported');
  // Old durable journals retain their original strict fingerprint semantics.
  // New plans declare version 1; this is not a CLI bypass switch.
  const scopedObservations = options.observationPolicy !== 0;
  const root = fs.realpathSync(aiHomeDir);
  const entries = [];
  const edits = [];
  const links = [];
  const moves = [];
  const blockers = [];
  const skipped = [];
  const nativeDatabases = [];
  const pending = inventoryScope.roots.map(name => path.join(root, name));
  for (const name of fs.readdirSync(root).sort()) {
    const candidate = path.join(root, name);
    if (TEXT_EXTENSIONS.has(path.extname(name)) && !fs.lstatSync(candidate).isDirectory()) pending.push(candidate);
  }
  let inspected = 0;
  while (pending.length) {
    const file = pending.pop();
    const relative = path.relative(root, file);
    if (relative === path.join('run', 'maintenance') || relative.startsWith(`${path.join('run', 'maintenance')}${path.sep}`)) continue;
    // Sidecar presence is transient reader coordination; its stability and
    // safety are checked with the main native snapshot, not counted twice.
    if (isNativeSidecar(relative)) {
      const main = file.replace(/-(wal|shm|journal)$/, '');
      if (!lstatOptional(fs, main)) blockers.push({ path: relative, reason: 'native_sidecar_without_main' });
      continue;
    }
    if (++inspected > 250000) { blockers.push({ path: relative, reason: 'rekey_inventory_limit' }); break; }
    let stat;
    try { stat = lstatOptional(fs, file); }
    catch (_) { blockers.push({ path: relative, reason: 'rekey_inventory_unreadable' }); continue; }
    if (!stat) continue;
    if (inventoryScope.roots.includes(relative) && stat.isSymbolicLink()) {
      blockers.push({ path: relative, reason: 'rekey_traversal_root_is_symlink' });
      continue;
    }
    const mode = stat.mode & 0o777;
    const entry = { uid: stat.uid, gid: stat.gid, path: relative, kind: stat.isDirectory() ? 'directory' : stat.isSymbolicLink() ? 'link' : 'file', mode };
    const component = path.basename(file);
    const renamed = renamedComponent(component, mapping, path.dirname(file));
    if (containsMappedRef(component, mapping) && renamed === component) {
      blockers.push({ path: relative, reason: 'rekey_filename_reference_unclassified' });
    }
    if (renamed !== component) {
      const destination = path.join(path.dirname(file), renamed);
      if (stat.isSymbolicLink()) blockers.push({ path: relative, reason: 'rekey_account_root_is_symlink' });
      else if (lstatOptional(fs, destination)) blockers.push({ path: relative, reason: 'rekey_target_exists' });
      else moves.push({ source: relative, destination: path.relative(root, destination) });
    }
    if (stat.isSymbolicLink()) {
      const target = fs.readlinkSync(file);
      entry.target = target;
      if (containsMappedRef(target, mapping)) {
        const resolved = path.resolve(path.dirname(file), target);
        if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
          blockers.push({ path: relative, reason: 'rekey_external_symlink_reference' });
        } else {
          const next = replaceAccountPathSegments(target, mapping);
          if (containsMappedRef(next, mapping)) blockers.push({ path: relative, reason: 'rekey_symlink_reference_unclassified' });
          else if (next !== target) links.push({ source: relative, before: target, after: next });
        }
      }
    } else if (stat.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(component)) skipped.push({ path: relative, reason: 'immutable_native_resource' });
      else {
        try { for (const name of fs.readdirSync(file).sort().reverse()) pending.push(path.join(file, name)); }
        catch (_) { blockers.push({ path: relative, reason: 'rekey_inventory_unreadable' }); }
      }
    } else if (stat.isFile()) {
      if (isNativeSidecar(relative)) {
        // WAL/SHM belong to the main native store's logical snapshot; a raw WAL
        // byte scan both misses committed rows and invents stale-page blockers.
        continue;
      }
      if (nativeStoreKind(relative)) {
        try {
          const native = inspectNativeStore(root, relative, mapping);
          entry.kind = 'native-sqlite';
          if (native.changes.length) {
            const { schemaDigest, ...participant } = native;
            nativeDatabases.push(participant);
          }
          for (const blocker of native.blockers) blockers.push({ path: relative, ...blocker });
          if (scopedObservations && isUnrelatedNativeDiagnostic(relative, native.kind, mapping) && !native.changes.length) {
            // Still inspect every row for unclassified machine references. Only
            // the recognized diagnostic content outside both old/new account
            // roots is not a restoration target; its schema and ownership are.
            entry.diagnosticSchemaDigest = native.schemaDigest;
            skipped.push({ path: relative, reason: 'unrelated_native_diagnostic_content' });
          } else {
            entry.logicalDigest = native.before.digest;
            for (const historical of native.immutable) skipped.push({ path: relative, ...historical });
          }
        } catch (error) {
          blockers.push({ path: relative, reason: error.message?.startsWith('re') ? error.message : 'rekey_native_inspection_failed' });
        }
        entries.push(entry);
        continue;
      }
      const immutableReason = immutableArtifactReason(fs, relative, file);
      if (immutableReason) {
        entry.hash = hashBackup(file); entry.size = stat.size;
        skipped.push({ path: relative, reason: immutableReason });
        entries.push(entry);
        continue;
      }
      entry.size = stat.size;
      if (TEXT_EXTENSIONS.has(path.extname(component))) {
        if (stat.size > MAX_FILE_BYTES) blockers.push({ path: relative, reason: 'rekey_machine_file_too_large' });
        else {
          try {
            const bytes = fs.readFileSync(file);
            entry.hash = sha256(bytes);
            const text = bytes.toString('utf8');
            if (scopedObservations && isUnrelatedLiveObservation(relative, text, mapping)) {
              delete entry.hash; delete entry.size;
              entry.observation = 'unrelated_live_projection';
              entries.push(entry);
              continue;
            }
            if (containsMappedRef(text, mapping)) {
              if (stat.nlink > 1) throw new Error('rekey_hardlinked_machine_file');
              let result;
              if (path.extname(component) === '.json') {
                result = transformJsonText(text, mapping);
                if (result.unknown.length) throw new Error('rekey_json_reference_unclassified');
              } else if (path.extname(component) === '.toml') {
                const changed = transformToml(text, mapping);
                result = { text: changed, changed: changed !== text };
              } else throw new Error('rekey_machine_file_format_unclassified');
              if (result.changed) {
                const metadataDigest = inspectReplaceableMetadata(file, stat);
                edits.push({ source: relative, mode, uid: stat.uid, gid: stat.gid, metadataDigest, beforeHash: entry.hash, afterHash: sha256(result.text), content: result.text });
              }
            }
          } catch (error) { blockers.push({ path: relative, reason: error.message?.startsWith('rekey_') ? error.message : 'rekey_machine_file_invalid' }); }
        }
      } else {
        entry.mtimeMs = stat.mtimeMs;
        // Unknown formats are not invisible. Scan bytes in bounded chunks and
        // block a reference rather than pretending a binary rewrite is safe.
        const descriptor = fs.openSync(file, 'r');
        const buffer = Buffer.alloc(64 * 1024);
        let tail = Buffer.alloc(0);
        try {
          for (;;) {
            const length = fs.readSync(descriptor, buffer, 0, buffer.length, null);
            if (!length) break;
            const chunk = Buffer.concat([tail, buffer.subarray(0, length)]);
            if ([...mapping.keys()].some(ref => chunk.includes(Buffer.from(ref)))) {
              blockers.push({ path: relative, reason: 'rekey_unclassified_file_reference' });
              break;
            }
            tail = chunk.subarray(Math.max(0, chunk.length - 64));
          }
        } finally { fs.closeSync(descriptor); }
      }
    } else blockers.push({ path: relative, reason: 'rekey_special_file_unclassified' });
    if (!inventoryScope.roots.includes(relative)) entries.push(entry);
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));
  edits.sort((a, b) => a.source.localeCompare(b.source));
  links.sort((a, b) => a.source.localeCompare(b.source));
  // Children move first; rollback reverses this order before restoring contents.
  moves.sort((a, b) => b.source.split(path.sep).length - a.source.split(path.sep).length || a.source.localeCompare(b.source));
  nativeDatabases.sort((a, b) => a.source.localeCompare(b.source));
  return { edits, links, moves, nativeDatabases, blockers, skipped, inspected, ...(scopedObservations ? { observationPolicy: 1 } : {}), fingerprint: sha256(JSON.stringify(entries)) };
}

function verifyFilesystemPlan(fs, aiHomeDir, provider, mapping, plan) {
  const current = buildFilesystemPlan(fs, aiHomeDir, provider, mapping, { observationPolicy: plan.observationPolicy || 0 });
  if (JSON.stringify(current) !== JSON.stringify(plan)) throw new Error('rekey_filesystem_plan_stale');
}

module.exports = { buildFilesystemPlan, verifyFilesystemPlan, transformToml, lstatOptional };
