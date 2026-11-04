#!/usr/bin/env node
'use strict';

/**
 * 发版入口：提升版本 → 提交 → 打 tag → 推送。
 *
 * 打包只由 tag 触发（.github/workflows/release-artifacts.yml 与 go-core-release.yml
 * 都只在 v* tag 上运行），所以这个脚本是「发 tag」的唯一推荐方式：
 *   npm run release:tag -- --bump patch
 *   npm run release:tag -- --version 1.2.3
 *   npm run release:tag -- --bump minor --dry-run
 *
 * 默认要求：
 *   - 工作区干净（不把未提交改动混进发版提交）；
 *   - 当前分支是 main，且与 origin/main 完全一致；
 *   - 新版本必须大于当前版本（semver）。
 *
 * 推送是显式动作：脚本默认会 push，--no-push 只在本机提交/打 tag。
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const semver = require('semver');

const REPO_ROOT = path.resolve(__dirname, '..');
const ROOT_PACKAGE = path.join(REPO_ROOT, 'package.json');
const WEB_PACKAGE = path.join(REPO_ROOT, 'web', 'package.json');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit'
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim();
    throw new Error(`${command} ${args.join(' ')} failed with exit ${result.status}${detail ? `: ${detail}` : ''}`);
  }
  return options.capture ? String(result.stdout || '').trim() : '';
}

function parseArgs(argv) {
  const options = {
    bump: '',
    version: '',
    branch: 'main',
    dryRun: false,
    push: true,
    message: ''
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      index += 1;
      return value;
    };
    if (arg === '--bump') options.bump = next();
    else if (arg === '--version') options.version = next();
    else if (arg === '--branch') options.branch = next();
    else if (arg === '--message') options.message = next();
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--no-push') options.push = false;
    else if (arg === '-h' || arg === '--help') options.help = true;
    else throw new Error(`unknown option: ${arg}`);
  }
  if (options.help) return options;
  if (options.bump && options.version) throw new Error('--bump and --version are mutually exclusive');
  if (!options.bump && !options.version) throw new Error('one of --bump <patch|minor|major> or --version <x.y.z> is required');
  if (options.bump && !['patch', 'minor', 'major'].includes(options.bump)) {
    throw new Error('--bump must be patch, minor or major');
  }
  if (options.version && !semver.valid(options.version)) throw new Error(`invalid semver: ${options.version}`);
  return options;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function nextVersion(current, options) {
  const next = options.version || semver.inc(current, options.bump);
  if (!next) throw new Error(`cannot compute the next version from ${current}`);
  if (semver.lte(next, current)) throw new Error(`next version ${next} must be greater than ${current}`);
  return next;
}

function ensureReleasePreconditions(branch) {
  const status = run('git', ['status', '--porcelain'], { capture: true });
  if (status) throw new Error('working tree is not clean; commit or stash changes before releasing');
  const current = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { capture: true });
  if (current !== branch) throw new Error(`release must run on ${branch} (current: ${current})`);
  run('git', ['fetch', '--quiet', 'origin']);
  const counts = run('git', ['rev-list', '--left-right', '--count', `origin/${branch}...HEAD`], { capture: true });
  const [behind, ahead] = counts.split(/\s+/).map(Number);
  if (behind > 0) throw new Error(`${branch} is ${behind} commit(s) behind origin/${branch}; pull first`);
  if (ahead > 0) throw new Error(`${branch} is ${ahead} commit(s) ahead of origin/${branch}; push or reset first`);
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(`AIH release tag

Usage:
  npm run release:tag -- --bump <patch|minor|major> [options]
  npm run release:tag -- --version <x.y.z> [options]

Options:
  --bump <kind>        Bump patch / minor / major
  --version <x.y.z>    Set an explicit version
  --branch <name>      Branch to release from, default main
  --message <text>     Commit message (default: chore(release): v<version>)
  --no-push            Commit and tag locally, do not push
  --dry-run            Print what would happen
  -h, --help           Show this help

Packaging only runs when a v* tag is pushed; the tag must match package.json.
`);
    return;
  }
  const rootPackage = readJson(ROOT_PACKAGE);
  const current = String(rootPackage.version || '').trim();
  if (!semver.valid(current)) throw new Error(`package.json has an invalid version: ${current}`);
  const version = nextVersion(current, options);
  const tag = `v${version}`;
  const message = options.message || `chore(release): ${tag}`;

  ensureReleasePreconditions(options.branch);
  const existing = run('git', ['tag', '--list', tag], { capture: true });
  if (existing) throw new Error(`tag already exists: ${tag}`);

  console.log(`[release] ${current} -> ${version} (${tag})`);
  if (options.dryRun) {
    console.log(`[dry-run] would update package.json + web/package.json, commit "${message}", tag ${tag}${options.push ? ', push commit and tag' : ' (no push)'}`);
    return;
  }

  rootPackage.version = version;
  writeJson(ROOT_PACKAGE, rootPackage);
  if (fs.existsSync(WEB_PACKAGE)) {
    const webPackage = readJson(WEB_PACKAGE);
    webPackage.version = version;
    writeJson(WEB_PACKAGE, webPackage);
  }

  run('git', ['add', 'package.json', 'web/package.json']);
  run('git', ['commit', '-m', message]);
  run('git', ['tag', '-a', tag, '-m', `AI Home ${tag}`]);
  if (options.push) {
    run('git', ['push', 'origin', `HEAD:${options.branch}`]);
    run('git', ['push', 'origin', tag]);
    console.log(`[release] pushed ${tag}; GitHub Actions will build the tagged artifacts`);
  } else {
    console.log(`[release] committed and tagged ${tag} locally (not pushed)`);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`release failed: ${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  main,
  nextVersion,
  parseArgs
};
