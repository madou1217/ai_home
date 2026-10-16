#!/usr/bin/env node
'use strict';

/**
 * 兼容入口：逻辑已收进 `lib/cli/commands/edge-router.js`（`aih edge` 用的就是它）。
 * 保留这个脚本是为了让既有文档 / 习惯里的 `node scripts/aih-edge.js ...` 继续可用。
 */

const { runEdgeCommand } = require('../lib/cli/commands/edge-router');

process.exit(runEdgeCommand(process.argv.slice(2)));
