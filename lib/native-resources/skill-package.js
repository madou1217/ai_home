'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const YAML = require('yaml');

function fail(code) { throw Object.assign(new Error(code), { code }); }
function validateSkillId(id) {
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) fail('skill_id_invalid');
  return id;
}
function readSkillFiles(root) {
  const files = [];
  let bytes = 0;
  function walk(dir, relative = '') {
    if (fs.lstatSync(dir).isSymbolicLink()) fail('skill_source_symlink');
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name);
      const entry = relative ? `${relative}/${name}` : name;
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) fail('skill_source_symlink');
      if (stat.isDirectory()) walk(file, entry);
      else if (stat.isFile()) {
        bytes += stat.size;
        if (bytes > 4 * 1024 * 1024 || files.length >= 256) fail('skill_source_limit');
        files.push({ name: entry, content: fs.readFileSync(file), executable: Boolean(stat.mode & 0o111) });
      } else fail('skill_source_type_invalid');
    }
  }
  walk(root);
  return files;
}
function digestFiles(files) {
  const hash = crypto.createHash('sha256');
  for (const file of files) {
    hash.update(JSON.stringify([file.name, file.content.length, file.executable]));
    hash.update(file.content);
  }
  return hash.digest('hex');
}
function readSkillPackage(root) {
  const files = readSkillFiles(root);
  const skill = files.find((file) => file.name === 'SKILL.md');
  if (!skill) fail('skill_manifest_missing');
  const text = skill.content.toString('utf8');
  const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!header) fail('skill_manifest_invalid');
  let metadata;
  try { metadata = YAML.parse(header[1]); } catch (_) { fail('skill_manifest_invalid'); }
  const id = validateSkillId(metadata?.name);
  if (typeof metadata.description !== 'string' || !metadata.description.trim()) fail('skill_description_missing');
  const instructionFile = files.find((file) => file.name === 'instructions.md');
  return { id, files, digest: digestFiles(files), instructions: instructionFile ? instructionFile.content.toString('utf8') : text.slice(header[0].length) };
}
function writeFiles(root, files) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  for (const file of files) {
    const target = path.join(root, ...file.name.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.content, { mode: file.executable ? 0o700 : 0o600 });
  }
}
module.exports = { fail, validateSkillId, readSkillFiles, digestFiles, readSkillPackage, writeFiles };
