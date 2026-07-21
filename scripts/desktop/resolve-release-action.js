#!/usr/bin/env node
'use strict';

const { parseArgs, requireString } = require('./lib/cli');
const { resolveReleaseAction } = require('./lib/release-manifest');

function parseBoolean(value, label) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${label} 只能是 true 或 false`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const action = resolveReleaseAction({
    currentSha: requireString(args, 'current-sha'),
    tagCommitSha: args['tag-sha'] === 'none' ? '' : requireString(args, 'tag-sha'),
    releaseExists: parseBoolean(requireString(args, 'release-exists'), '--release-exists'),
  });
  process.stdout.write(`${action}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  main,
  parseBoolean,
};
