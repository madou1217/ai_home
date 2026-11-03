'use strict';

function isEnvEnabled(name, defaultValue, env = process.env) {
  const raw = String((env && env[name]) || '').trim().toLowerCase();
  if (!raw) return defaultValue;
  return !['0', 'false', 'no', 'off'].includes(raw);
}

module.exports = {
  isEnvEnabled
};
