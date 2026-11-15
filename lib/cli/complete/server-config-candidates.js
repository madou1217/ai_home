'use strict';

// The existing server schema is authoritative. A '|' can separate switches OR
// enum values; only --prefixed tokens are command options.
function fieldFlags(field) {
  return String(field.flag || '').match(/--[a-z][a-z0-9-]*/g) || [];
}

function listServerConfigFlags() {
  try {
    const { SERVER_CONFIG_FIELDS } = require('../../server/server-config-schema');
    const seen = new Set();
    const out = [];
    for (const field of SERVER_CONFIG_FIELDS) {
      for (const value of fieldFlags(field)) {
        if (seen.has(value)) continue;
        seen.add(value);
        out.push({ value, description: String(field.summary || '').split('。')[0] });
      }
    }
    return out;
  } catch (_error) {
    return [];
  }
}

// null = switch/unknown; [] = a pending non-enumerated value. These states
// cannot be conflated or --port= will offer --host as its value.
function serverConfigValueCandidates(flagName) {
  try {
    const { SERVER_CONFIG_FIELDS } = require('../../server/server-config-schema');
    const field = SERVER_CONFIG_FIELDS.find((item) => fieldFlags(item).includes(String(flagName || '').trim()));
    if (!field || field.type === 'bool') return null;
    return (Array.isArray(field.values) ? field.values : []).map((value) => ({
      value: String(value), description: '允许的取值'
    }));
  } catch (_error) {
    return null;
  }
}

function listServerConfigValues(flagName) {
  return serverConfigValueCandidates(flagName) || [];
}

module.exports = { listServerConfigFlags, listServerConfigValues, serverConfigValueCandidates };
