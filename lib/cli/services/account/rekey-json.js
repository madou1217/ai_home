'use strict';

/**
 * A lossless JSON string transformer for migration, not a JSON serializer.
 * Database documents may contain 64-bit numbers. Parsing then JSON.stringify
 * would silently round them even when only an accountRef should change.
 * The visitor sees decoded strings and their structural path; every untouched
 * byte (numbers, whitespace, escapes and key order) stays exactly as stored.
 */
function transformJsonStrings(source, visitor, options = {}) {
  if (typeof source !== 'string' || Buffer.byteLength(source) > (options.maxBytes || 32 * 1024 * 1024)) {
    throw new Error('rekey_json_size_invalid');
  }
  let position = 0;
  let nodes = 0;
  const edits = [];
  const invalid = () => { throw new Error('rekey_json_invalid'); };
  const whitespace = () => { while (/[\x20\t\r\n]/.test(source[position] || '\0')) position++; };

  function string(path, isKey) {
    const start = position++;
    let escaped = false;
    while (position < source.length) {
      const character = source[position++];
      if (escaped) { escaped = false; continue; }
      if (character === '\\') { escaped = true; continue; }
      if (character !== '"') continue;
      let value;
      try { value = JSON.parse(source.slice(start, position)); } catch (_) { invalid(); }
      const next = visitor(value, path, { isKey });
      if (next !== undefined && typeof next !== 'string') throw new Error('rekey_json_transform_invalid');
      if (next !== undefined && next !== value) edits.push({ start, end: position, text: JSON.stringify(next) });
      return { before: value, after: next === undefined ? value : next };
    }
    invalid();
  }

  function value(path, depth) {
    if (++nodes > (options.maxNodes || 250000) || depth > 96) throw new Error('rekey_json_budget_exceeded');
    whitespace();
    const character = source[position];
    if (character === '"') return string(path, false);
    if (character === '{') {
      position++;
      const beforeKeys = new Set();
      const afterKeys = new Set();
      whitespace();
      if (source[position] === '}') { position++; return; }
      for (;;) {
        whitespace();
        if (source[position] !== '"') invalid();
        const key = string(path, true);
        if (beforeKeys.has(key.before) || afterKeys.has(key.after)) throw new Error('rekey_json_key_collision');
        beforeKeys.add(key.before); afterKeys.add(key.after);
        whitespace();
        if (source[position++] !== ':') invalid();
        value([...path, key.before], depth + 1);
        whitespace();
        const next = source[position++];
        if (next === '}') return;
        if (next !== ',') invalid();
      }
    }
    if (character === '[') {
      position++;
      whitespace();
      if (source[position] === ']') { position++; return; }
      let index = 0;
      for (;;) {
        value([...path, index++], depth + 1);
        whitespace();
        const next = source[position++];
        if (next === ']') return;
        if (next !== ',') invalid();
      }
    }
    const primitive = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(source.slice(position));
    if (!primitive) invalid();
    position += primitive[0].length;
  }

  value([], 0);
  whitespace();
  if (position !== source.length) invalid();
  let result = source;
  for (const edit of edits.reverse()) result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  return { text: result, changed: edits.length > 0, replacements: edits.length };
}

module.exports = { transformJsonStrings };
