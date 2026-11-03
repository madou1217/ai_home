'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { readSkillFiles, digestFiles } = require('./skill-package');

// Adoption is limited to the historical bundled resource, never inferred from
// a generic symlink or a marker bearing an arbitrary user skill's name.
function isLegacyDirectory(target, pkg, legacySource) {
  if (pkg.id !== 'aih-collab' || !legacySource) return false;
  try {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) {
      return path.resolve(path.dirname(target), fs.readlinkSync(target)) === path.resolve(legacySource);
    }
    if (!stat.isDirectory() || fs.readFileSync(path.join(target, '.aih-managed'), 'utf8').trim() !== 'v1') return false;
    return digestFiles(readSkillFiles(target).filter((file) => file.name !== '.aih-managed')) === pkg.digest;
  } catch (_) { return false; }
}
function legacyInstructionRange(text, pkg, legacySource) {
  if (pkg.id !== 'aih-collab' || !legacySource) return null;
  const block = `<!-- aih-collab:v1:begin -->\n${pkg.instructions.trim()}\n<!-- aih-collab:end -->`;
  const start = text.indexOf(block);
  if (start < 0 || text.indexOf('<!-- aih-collab:v1:begin -->', start + 1) >= 0) return null;
  return { start, end: start + block.length + (text[start + block.length] === '\n' ? 1 : 0) };
}
module.exports = { isLegacyDirectory, legacyInstructionRange };
