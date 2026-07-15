#!/usr/bin/env node
'use strict';

const { parseArgs, requireString } = require('./lib/cli');
const { stageReleaseAssets } = require('./lib/release-manifest');

function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifest = stageReleaseAssets({
    workspaceRoot: requireString(args, 'workspace-root'),
    inputRoot: requireString(args, 'input'),
    outputRoot: requireString(args, 'output'),
  });
  process.stdout.write(`Release 资产已准备: ${manifest.tag} (${manifest.assets.length} installers)\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { main };
