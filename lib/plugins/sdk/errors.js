'use strict';

class PluginError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'PluginError';
    this.code = code;
  }
}

function requireCondition(condition, code, message) {
  if (!condition) throw new PluginError(code, message);
}

module.exports = { PluginError, requireCondition };
