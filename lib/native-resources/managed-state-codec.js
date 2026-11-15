'use strict';

const MAX_BYTES = 8 * 1024 * 1024;
const invalid = (code) => Object.assign(new Error(code), { code });
const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value);
const integer = (value) => Number.isSafeInteger(value) && value >= 0;

function validateManagedState(value) {
  if (!isObject(value)) throw invalid('managed_resource_state_invalid');
  if (value.schemaVersion !== 1) throw invalid('managed_resource_schema_unsupported');
  if (!integer(value.revision) || !Array.isArray(value.resources)) throw invalid('managed_resource_state_invalid');
  for (const record of value.resources) {
    if (!isObject(record) || typeof record.kind !== 'string' || !record.kind || typeof record.id !== 'string' || !record.id
      || typeof record.enabled !== 'boolean' || !integer(record.createdAt) || !integer(record.updatedAt)) throw invalid('managed_resource_record_invalid');
  }
  return value;
}
function decimal(text) {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text);
  let digits = `${match[2]}${match[3] || ''}`.replace(/^0+/, '');
  if (!digits) return '0';
  let exponent = BigInt(match[4] || '0') - BigInt((match[3] || '').length);
  while (digits.endsWith('0')) { digits = digits.slice(0, -1); exponent += 1n; }
  return `${match[1]}${digits}e${exponent}`;
}
function decodeManagedState(raw, found) {
  if (!found) return { schemaVersion: 1, revision: 0, resources: [] };
  if (Buffer.byteLength(raw, 'utf8') > MAX_BYTES) throw invalid('managed_resource_state_too_large');
  let value;
  try { value = JSON.parse(raw); } catch (_) { throw invalid('managed_resource_state_invalid'); }
  // Syntax is validated by JSON.parse. This bounded lexical pass checks only
  // keys/numbers so a rewrite cannot silently collapse duplicate keys or round
  // an unknown field. It does not reinterpret JSON string contents.
  const stack = [];
  const tokens = /"(?:\\[\s\S]|[^"\\])*"|[{}\[\]]|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/g;
  for (const match of raw.matchAll(tokens)) {
    const token = match[0];
    if (token === '{' || token === '[') { stack.push(token === '{' ? new Set() : null); if (stack.length > 100) throw invalid('managed_resource_state_invalid'); }
    else if (token === '}' || token === ']') stack.pop();
    else if (token[0] === '"') {
      const string = JSON.parse(token);
      if (/^[\s]*:/.test(raw.slice(match.index + token.length))) {
        const keys = stack.at(-1); if (!keys || keys.has(string)) throw invalid('managed_resource_state_invalid'); keys.add(string);
      }
      for (let i = 0; i < string.length; i += 1) {
        const unit = string.charCodeAt(i);
        if (unit >= 0xd800 && unit <= 0xdbff) { const low = string.charCodeAt(++i); if (!(low >= 0xdc00 && low <= 0xdfff)) throw invalid('managed_resource_state_invalid'); }
        else if (unit >= 0xdc00 && unit <= 0xdfff) throw invalid('managed_resource_state_invalid');
      }
    } else {
      const number = Number(token);
      if (!Number.isFinite(number) || (Number.isInteger(number) && !Number.isSafeInteger(number)) || decimal(token) !== decimal(String(number))) throw invalid('managed_resource_numeric_unsupported');
    }
  }
  return validateManagedState(value);
}
module.exports = { decodeManagedState, validateManagedState, MAX_BYTES };
