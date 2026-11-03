'use strict';

/**
 * 已学习的拼写纠正：用户确认过一次的「错法 → 正确命令」记在这里，
 * 下次同样的错法直接排第一。
 *
 * 存放位置是 `<aiHomeDir>/run/shell/corrections.json`（运行时状态目录，与 persistent-sessions
 * 同族；不含任何凭据）。写坏或读到非法内容一律当成空表（fail open），
 * 因为这只是提示质量的优化，不该让错误路径本身出错。
 */

const nodeFs = require('node:fs');
const nodePath = require('node:path');
const { resolveAihRunPath } = require('../../runtime/aih-storage-layout');

const CORRECTIONS_FILE_NAME = 'corrections.json';
const CORRECTIONS_MAX_ENTRIES = 200;

function resolveCorrectionsPath(aiHomeDir) {
  return resolveAihRunPath(aiHomeDir, 'shell', CORRECTIONS_FILE_NAME);
}

function readCorrectionsFile(filePath, fsImpl) {
  try {
    const raw = fsImpl.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    const entries = parsed && typeof parsed === 'object' && parsed.entries && typeof parsed.entries === 'object'
      ? parsed.entries
      : {};
    const map = new Map();
    for (const [typo, record] of Object.entries(entries)) {
      const argv = Array.isArray(record && record.argv) ? record.argv.map((token) => String(token)) : [];
      if (!typo || !argv.length) continue;
      map.set(String(typo), argv);
    }
    return map;
  } catch (_error) {
    return new Map();
  }
}

function writeCorrectionsFile(filePath, map, fsImpl) {
  const entries = {};
  const keys = [...map.keys()].slice(-CORRECTIONS_MAX_ENTRIES);
  for (const key of keys) entries[key] = { argv: map.get(key) };
  const dir = nodePath.dirname(filePath);
  fsImpl.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fsImpl.writeFileSync(tmp, `${JSON.stringify({ version: 1, entries }, null, 1)}\n`, { mode: 0o600 });
  fsImpl.renameSync(tmp, filePath);
}

function createCorrectionsStore(options = {}) {
  const fsImpl = options.fs || nodeFs;
  const aiHomeDir = String(options.aiHomeDir || '').trim();
  const filePath = resolveCorrectionsPath(aiHomeDir);
  const load = () => (filePath ? readCorrectionsFile(filePath, fsImpl) : new Map());
  const save = (map) => {
    if (!filePath) return false;
    try {
      writeCorrectionsFile(filePath, map, fsImpl);
      return true;
    } catch (_error) {
      return false;
    }
  };
  return {
    filePath,
    load,
    /** 记下一次确认过的纠正（同一个错法后写覆盖先写）。 */
    record(typo, argv) {
      const key = String(typo || '').trim();
      const words = (Array.isArray(argv) ? argv : []).map((token) => String(token)).filter(Boolean);
      if (!key || !words.length) return false;
      const map = load();
      map.delete(key);
      map.set(key, words);
      return save(map);
    },
    forget(typo) {
      const key = String(typo || '').trim();
      const map = load();
      if (!map.delete(key)) return false;
      return save(map);
    },
    list() {
      return [...load().entries()].map(([typo, argv]) => ({ typo, argv, command: argv.join(' ') }));
    },
    clear() {
      return save(new Map());
    }
  };
}

module.exports = {
  CORRECTIONS_FILE_NAME,
  CORRECTIONS_MAX_ENTRIES,
  createCorrectionsStore,
  resolveCorrectionsPath
};
