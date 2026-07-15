'use strict';

const crypto = require('node:crypto');
const { runCaptured } = require('./process-utils');

function parseEnvironmentAssignments(output) {
  const parsed = {};
  for (const line of output.split(/\r?\n/u)) {
    const match = /^([A-Z][A-Z0-9_]*)=(?:'([^']*)'|"([^"]*)"|([^;\s]*))(?:;.*)?$/u.exec(line.trim());
    if (match) {
      parsed[match[1]] = match[2] ?? match[3] ?? match[4] ?? '';
    }
  }
  return parsed;
}

async function bootstrapLinuxKeyring(baseEnvironment, dependencies = {}) {
  const platform = dependencies.platform ?? process.platform;
  const run = dependencies.run ?? runCaptured;
  const createProbeValue = dependencies.createProbeValue
    ?? (() => `aih-keyring-probe-${crypto.randomUUID()}`);

  if (platform !== 'linux') {
    throw new Error('--bootstrap-linux-keyring 仅能在 Linux 使用');
  }
  if (!baseEnvironment.DBUS_SESSION_BUS_ADDRESS) {
    throw new Error('Linux packaged smoke 必须运行在 dbus-run-session 中');
  }

  const login = await run(
    'gnome-keyring-daemon',
    ['--login', '--components=secrets'],
    { env: baseEnvironment, input: '\n' },
  );
  const environment = {
    ...baseEnvironment,
    ...parseEnvironmentAssignments(login.stdout),
  };
  const started = await run(
    'gnome-keyring-daemon',
    ['--start', '--components=secrets'],
    { env: environment },
  );
  Object.assign(environment, parseEnvironmentAssignments(started.stdout));

  const probeValue = createProbeValue();
  await run(
    'secret-tool',
    ['store', '--label=AIH Desktop Smoke Bootstrap', 'application', 'aih-desktop-smoke-bootstrap'],
    { env: environment, input: probeValue },
  );
  try {
    const lookup = await run(
      'secret-tool',
      ['lookup', 'application', 'aih-desktop-smoke-bootstrap'],
      { env: environment },
    );
    if (lookup.stdout.trim() !== probeValue) {
      throw new Error('Secret Service 写入后无法读回探针值');
    }
  } finally {
    await run(
      'secret-tool',
      ['clear', 'application', 'aih-desktop-smoke-bootstrap'],
      { env: environment },
    );
  }
  return environment;
}

module.exports = {
  bootstrapLinuxKeyring,
  parseEnvironmentAssignments,
};
