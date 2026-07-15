'use strict';

function parseArgs(argv, options = {}) {
  const booleanNames = new Set(options.booleans || []);
  const repeatableNames = new Set(options.repeatable || []);
  const result = { _: [] };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--') {
      result._.push(...argv.slice(index + 1));
      break;
    }
    if (!argument.startsWith('--')) {
      result._.push(argument);
      continue;
    }

    const equalsIndex = argument.indexOf('=');
    const name = argument.slice(2, equalsIndex === -1 ? undefined : equalsIndex);
    if (!name) {
      throw new Error('参数名不能为空');
    }

    let value;
    if (equalsIndex !== -1) {
      value = argument.slice(equalsIndex + 1);
    } else if (booleanNames.has(name)) {
      value = true;
    } else {
      value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`参数 --${name} 缺少值`);
      }
      index += 1;
    }

    if (repeatableNames.has(name)) {
      if (!Array.isArray(result[name])) {
        result[name] = [];
      }
      result[name].push(value);
    } else if (Object.prototype.hasOwnProperty.call(result, name)) {
      throw new Error(`参数 --${name} 不能重复`);
    } else {
      result[name] = value;
    }
  }

  return result;
}

function requireString(args, name) {
  const value = args[name];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`必须提供 --${name}`);
  }
  return value;
}

function optionalList(args, name) {
  const value = args[name];
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

module.exports = {
  optionalList,
  parseArgs,
  requireString,
};
