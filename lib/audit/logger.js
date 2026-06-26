const fs = require('fs');
const path = require('path');

function createAuditLogger(options = {}) {
  const fsImpl = options.fsImpl || fs;
  const logPath = options.logPath;
  const now = options.now || (() => new Date().toISOString());

  if (!logPath) {
    throw new Error('logPath is required to create audit logger.');
  }

  function append(entry) {
    try {
      fsImpl.mkdirSync(path.dirname(logPath), { recursive: true });
      fsImpl.appendFileSync(logPath, `${JSON.stringify(entry)}\n`, 'utf8');
      return true;
    } catch (e) {
      return false;
    }
  }

  function log(action, context = {}) {
    if (!action || typeof action !== 'string') return false;
    return append({
      ts: now(),
      action,
      context
    });
  }

  return {
    logPath,
    log
  };
}

module.exports = {
  createAuditLogger
};
