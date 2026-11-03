'use strict';

const { runAiCliCommandRouter } = require('./ai-cli/router');

function runToolCommandRouter(cmd, args, context = {}) {
  return runAiCliCommandRouter(cmd, args, context);
}

module.exports = {
  runToolCommandRouter,
  runAiCliCommandRouter
};
