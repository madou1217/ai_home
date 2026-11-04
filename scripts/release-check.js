#!/usr/bin/env node
'use strict';

/**
 * 发版一致性检查：tag、package.json、发行包、校验和必须全部对得上。
 *
 * CI 在构建完成后跑：
 *   node scripts/release-check.js --tag "$RELEASE_TAG" --no-head --require-artifacts
 *
 * 本机在发 tag 前跑：
 *   npm run release:check -- --tag v1.2.3
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const { TARGETS, artifactBaseName, isWindows, targetKey } = require('./package/targets');

const REPO_ROOT = path.resolve(__dirname, '..');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  if (result.error) throw result.error;
  return {
    ok: result.status === 0,
    stdout: String(result.stdout || '').trim(),
    stderr: String(result.stderr || '').trim()
  };
}

function parseArgs(argv) {
  const options = {
    tag: '',
    artifacts: path.join(REPO_ROOT, 'dist', 'release'),
    checkHead: true,
    requireArtifacts: false,
    targets: ''
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      index += 1;
      return value;
    };
    if (arg === '--tag') options.tag = next();
    else if (arg === '--artifacts') options.artifacts = path.resolve(next());
    else if (arg === '--targets') options.targets = next();
    else if (arg === '--no-head') options.checkHead = false;
    else if (arg === '--require-artifacts') options.requireArtifacts = true;
    else if (arg === '-h' || arg === '--help') options.help = true;
    else throw new Error(`unknown option: ${arg}`);
  }
  return options;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function verifyChecksum(file, failures) {
  const checksumFile = `${file}.sha256`;
  if (!fs.existsSync(checksumFile)) {
    failures.push(`missing checksum: ${path.basename(checksumFile)}`);
    return;
  }
  const text = fs.readFileSync(checksumFile, 'utf8').trim();
  const expected = text.split(/\s+/)[0].toLowerCase();
  const actual = sha256(file);
  if (expected !== actual) failures.push(`checksum mismatch: ${path.basename(file)}`);
}

function selectedTargets(value) {
  const requested = String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
  if (requested.length === 0) return TARGETS;
  const selected = TARGETS.filter((target) => requested.includes(targetKey(target)));
  if (selected.length !== requested.length) {
    throw new Error(`unknown --targets entry (expected ${TARGETS.map(targetKey).join(',')})`);
  }
  return selected;
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(`AIH release check

Usage:
  node scripts/release-check.js [--tag v1.2.3] [--artifacts dist/release]
                                [--targets linux-x64,win32-x64] [--no-head] [--require-artifacts]

Checks:
  - package.json version matches the tag (default: v<version>)
  - the tag exists and (unless --no-head) points at HEAD
  - every selected target has a single-file package, an archive, a .sha256 and a valid checksum
  - the manifest version and artifact hashes match`);
    return;
  }
  const packageJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  const version = String(packageJson.version || '').trim();
  const tag = options.tag || `v${version}`;
  const failures = [];
  const notes = [];

  if (tag !== `v${version}`) failures.push(`tag ${tag} does not match package.json v${version}`);

  const tagRef = run('git', ['rev-parse', '--verify', `refs/tags/${tag}`]);
  if (!tagRef.ok) {
    failures.push(`tag does not exist: ${tag}`);
  } else if (options.checkHead) {
    const head = run('git', ['rev-parse', 'HEAD']);
    if (!head.ok || head.stdout !== tagRef.stdout) failures.push(`tag ${tag} does not point at HEAD`);
  }

  const targets = selectedTargets(options.targets);
  const manifestFile = path.join(options.artifacts, `aih-${version}-manifest.json`);
  let manifest = null;
  if (fs.existsSync(manifestFile)) {
    try {
      manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
      if (manifest.version !== version) failures.push(`manifest version ${manifest.version} does not match ${version}`);
    } catch (_error) {
      failures.push('manifest is not valid JSON');
    }
  } else {
    failures.push(`missing manifest: ${path.basename(manifestFile)}`);
  }

  for (const target of targets) {
    const base = artifactBaseName(version, target);
    const single = path.join(options.artifacts, isWindows(target) ? `${base}.exe` : `${base}.run`);
    const archive = path.join(options.artifacts, isWindows(target) ? `${base}.zip` : `${base}.tar.gz`);
    const required = [single, archive];
    for (const file of required) {
      if (!fs.existsSync(file)) {
        const message = `missing artifact: ${path.basename(file)}`;
        if (options.requireArtifacts) failures.push(message);
        else notes.push(message);
        continue;
      }
      verifyChecksum(file, failures);
      if (manifest) {
        const entry = (manifest.targets || []).find((item) => item.target === targetKey(target));
        if (!entry) {
          failures.push(`manifest has no entry for ${targetKey(target)}`);
        } else {
          const artifact = (entry.artifacts || []).find((item) => item.file === path.basename(file));
          if (!artifact) failures.push(`manifest has no artifact ${path.basename(file)}`);
          else if (artifact.sha256 !== sha256(file)) failures.push(`manifest hash mismatch: ${path.basename(file)}`);
        }
      }
    }
  }

  for (const note of notes) console.warn(`[release-check] warning: ${note}`);
  if (failures.length > 0) {
    for (const failure of failures) console.error(`[release-check] ${failure}`);
    process.exit(1);
  }
  console.log(`[release-check] ok: ${tag} (${targets.map(targetKey).join(', ')})`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`release check failed: ${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  main,
  parseArgs,
  sha256
};
