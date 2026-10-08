'use strict';

const files = require('./native-session-bridge-files');

function ensurePrivateDirectory(directory) {
  return files.ensurePrivateDirectory(directory, 'codebuddy_ide_bridge_directory_not_private');
}

module.exports = { ...files, ensurePrivateDirectory };
