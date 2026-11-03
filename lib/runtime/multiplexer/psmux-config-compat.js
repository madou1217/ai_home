'use strict';

function quotePowerShellExecutable(command) {
  const executable = String(command || '').trim() || 'psmux';
  return `'${executable.replace(/\\/g, '/').replace(/'/g, "''")}'`;
}

function buildPsmuxExtendedKeysCompatLines(command) {
  const executable = quotePowerShellExecutable(command);
  return [
    // psmux implements modified Enter in its input layer but keeps unknown
    // options as inert values for tmux-compatible probes. Some builds still
    // warn when those options occur directly in a config file; run-shell
    // applies the same quiet commands after parsing without a startup banner.
    `run-shell "& ${executable} set -gq extended-keys on"`,
    `run-shell "& ${executable} set -gq extended-keys-format csi-u"`
  ];
}

module.exports = {
  buildPsmuxExtendedKeysCompatLines
};
