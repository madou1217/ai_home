'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { fail, readSkillFiles, digestFiles, writeFiles } = require('./skill-package');
function stat(file) {
  try { return fs.lstatSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; return null; }
}
function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, text, { mode: stat(file)?.mode & 0o777 || 0o600, flag: 'wx' });
    fs.renameSync(temp, file);
  } finally { fs.rmSync(temp, { force: true }); }
}
function block(id, content) {
  return `<!-- aih-skill:${id}:begin -->\n${content.trim()}\n<!-- aih-skill:${id}:end -->\n`;
}
function blockRange(text, id) {
  const begin = `<!-- aih-skill:${id}:begin -->`;
  const end = `<!-- aih-skill:${id}:end -->`;
  const start = text.indexOf(begin);
  if (start < 0 && !text.includes(end)) return null;
  const finish = text.indexOf(end, start);
  if (start < 0 || finish < start || text.indexOf(begin, start + begin.length) >= 0 || text.indexOf(end, finish + end.length) >= 0) fail('skill_block_invalid');
  return { start, end: finish + end.length + (text[finish + end.length] === '\n' ? 1 : 0) };
}
const directory = {
  inspect(record) {
    const info = stat(record.target);
    if (!info) return 'absent';
    if (!info.isDirectory() || info.isSymbolicLink()) return 'conflict';
    try { return digestFiles(readSkillFiles(record.target)) === record.digest ? 'present' : 'modified'; }
    catch (_) { return 'modified'; }
  },
  apply(record, pkg, previous) {
    const info = stat(record.target);
    if (info) {
      if (!previous) fail('skill_target_conflict');
      const status = directory.inspect(previous);
      if (status !== 'present') fail('skill_target_modified');
      if (record.digest === previous.digest) return;
    }
    fs.mkdirSync(path.dirname(record.target), { recursive: true });
    const temporary = `${record.target}.${crypto.randomUUID()}.tmp`;
    const backup = `${temporary}.old`;
    try {
      writeFiles(temporary, pkg.files);
      if (info) fs.renameSync(record.target, backup);
      try { fs.renameSync(temporary, record.target); }
      catch (error) { if (info) fs.renameSync(backup, record.target); throw error; }
      if (info) fs.rmSync(backup, { recursive: true });
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  },
  remove(record) {
    const status = directory.inspect(record);
    if (status === 'absent') return;
    if (status !== 'present') fail('skill_target_modified');
    fs.rmSync(record.target, { recursive: true });
  }
};
function readInstructions(file) {
  const info = stat(file);
  if (!info) return '';
  if (!info.isFile() || info.isSymbolicLink()) fail('skill_target_conflict');
  return fs.readFileSync(file, 'utf8');
}
const instructions = {
  inspect(record, pkg) {
    try {
      const text = readInstructions(record.target);
      const range = blockRange(text, record.id);
      if (!range) return 'absent';
      return text.slice(range.start, range.end) === block(record.id, pkg.instructions) ? 'present' : 'modified';
    } catch (_) { return 'conflict'; }
  },
  apply(record, pkg, previous, previousPackage) {
    const text = readInstructions(record.target);
    const range = blockRange(text, record.id);
    if (range) {
      if (!previous) fail('skill_target_conflict');
      if (instructions.inspect(previous, previousPackage) !== 'present') fail('skill_target_modified');
      const next = text.slice(0, range.start) + block(record.id, pkg.instructions) + text.slice(range.end);
      if (next !== text) atomicWrite(record.target, next);
    } else atomicWrite(record.target, text + (text && !text.endsWith('\n') ? '\n' : '') + block(record.id, pkg.instructions));
  },
  remove(record, pkg) {
    const text = readInstructions(record.target);
    const range = blockRange(text, record.id);
    if (!range) return;
    if (instructions.inspect(record, pkg) !== 'present') fail('skill_target_modified');
    atomicWrite(record.target, text.slice(0, range.start) + text.slice(range.end));
  }
};
module.exports = { SKILL_PROJECTIONS: Object.freeze({ native: directory, 'projection-only': instructions }), atomicWrite };
