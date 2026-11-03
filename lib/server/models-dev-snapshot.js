'use strict';

const fs = require('node:fs');

// @opencode-ai/models ships its offline catalog as an ES module whose body is
// `JSON.parse("<12MB escaped JSON>")`. `require()`-ing it keeps that ~13.6MB module
// source alive as compiled code for the life of the process, plus an internalized
// copy of the JSON text, on top of the parsed object (heap snapshot 2026-10-31:
// ~26MB of strings retained by GC roots). Read the file, decode the one string literal,
// and parse it: the transient source string is collectable as soon as we return.
//
// The module's shape is fixed by the generator (see the package's script/generate.ts);
// if it ever changes we fall back to require() so behavior is identical, only larger.

let cached = null;

function readSnapshotFile() {
  const file = require.resolve('@opencode-ai/models/snapshot');
  const source = fs.readFileSync(file, 'utf8');
  const start = source.indexOf('JSON.parse(');
  if (start < 0) return null;
  const open = source.indexOf('"', start);
  const close = source.lastIndexOf('")');
  if (open < 0 || close <= open) return null;
  // The argument is a JS double-quoted string literal of JSON; JSON.parse can decode
  // a JSON string literal directly, which gives us the inner JSON text.
  const jsonText = JSON.parse(source.slice(open, close + 1));
  const data = JSON.parse(jsonText);
  const generated = source.match(/export const generatedAt = "([^"]*)"/);
  // A regex capture is a V8 sliced string that keeps a pointer to the whole 13.6MB
  // source. Round-trip it through a Buffer so the result owns its bytes and the
  // source becomes collectable (heap snapshot showed exactly this retainer).
  const generatedAt = generated ? Buffer.from(generated[1], 'utf8').toString('utf8') : '';
  return { ...data, generatedAt };
}

function loadModelsDevSnapshot() {
  if (cached) return cached;
  try {
    cached = readSnapshotFile();
  } catch (_error) {
    cached = null;
  }
  if (!cached) {
    // eslint-disable-next-line global-require
    const loaded = require('@opencode-ai/models/snapshot');
    const data = loaded && (loaded.default || loaded);
    cached = { ...data, generatedAt: loaded && loaded.generatedAt || data.generatedAt || '' };
  }
  return cached;
}

module.exports = { loadModelsDevSnapshot };
