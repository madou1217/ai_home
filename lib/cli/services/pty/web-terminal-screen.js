'use strict';

const { RUNTIME_MARKER_ENV, parseRuntimeMarkerValue } = require('../../../runtime/persistent-session');

// A successful interactive CLI exit should return a Web Terminal shell to a
// clean screen. Other terminals and failed runs retain their diagnostic output.
function clearWebTerminalScreen(processObj, options = {}) {
  const marker = parseRuntimeMarkerValue(processObj && processObj.env && processObj.env[RUNTIME_MARKER_ENV]);
  const output = processObj && processObj.stdout;
  if (marker.web !== '1' || options.headless || options.isLogin || options.exitCode !== 0
      || !output || !output.isTTY || typeof output.write !== 'function') return false;
  output.write('\x1b[2J\x1b[3J\x1b[H');
  return true;
}

module.exports = { clearWebTerminalScreen };
