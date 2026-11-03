#!/usr/bin/env node
'use strict';

// Backwards-compatible CLI driver lives in the Codex-named module; the planner
// and apply gate are shared, with an explicit supported Provider on each ledger.
const driver = require('./codex-identity-rekey');
if (require.main === module) {
  try { process.exitCode = driver.main(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`${String(error.message || error)}\n`); process.exitCode = 1; }
}
module.exports = driver;
