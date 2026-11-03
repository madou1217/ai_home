'use strict';

function normalizeRootCommandArgs(rawArgs) {
  let args = Array.isArray(rawArgs) ? rawArgs.slice() : [];
  let cmd = args[0];

  if (cmd === 'serve') {
    const serveAction = String(args[1] || '').trim().toLowerCase();
    if (serveAction === 'help' || serveAction === '--help' || serveAction === '-h') {
      args = ['server', 'help'];
    } else if (!serveAction) {
      args = ['server', 'start'];
    } else {
      args = ['server', 'serve', ...args.slice(1)];
    }
    cmd = 'server';
  }

  if (cmd === 'daemon') {
    args = ['server', ...args.slice(1)];
    cmd = 'server';
  }

  return { args, cmd };
}

module.exports = {
  normalizeRootCommandArgs
};
