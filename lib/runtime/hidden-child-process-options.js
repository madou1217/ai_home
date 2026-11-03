'use strict';

function withHiddenWindowsConsole(options = {}) {
  return {
    ...options,
    windowsHide: true
  };
}

module.exports = {
  withHiddenWindowsConsole
};
