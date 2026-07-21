'use strict';

function nonEmptyString(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function isFlag(value) {
  return String(value || '').startsWith('-');
}

function readOptionValue(args, index, flag) {
  const token = String(args[index] || '');
  const prefix = `${flag}=`;
  if (token.startsWith(prefix)) {
    return { value: token.slice(prefix.length), consumed: 1 };
  }
  const value = args[index + 1];
  if (value === undefined || isFlag(value)) {
    const error = new Error(`missing_value:${flag}`);
    error.code = 'missing_option_value';
    error.flag = flag;
    throw error;
  }
  return { value: String(value), consumed: 2 };
}

function normalizePositiveInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(number)));
}

module.exports = {
  isFlag,
  nonEmptyString,
  normalizePositiveInteger,
  readOptionValue
};
