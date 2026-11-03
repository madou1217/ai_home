'use strict';

// aih 自己落盘的运行时状态文件（run/<kind>/*.json）的容错读取，供各 provider 插件判忙。

function listJsonFiles(fsImpl, dir) {
  try {
    return fsImpl.readdirSync(dir).filter((name) => name.endsWith('.json'));
  } catch (_error) {
    return [];
  }
}

function readJson(fsImpl, file) {
  try {
    return JSON.parse(fsImpl.readFileSync(file, 'utf8'));
  } catch (_error) {
    return null;
  }
}

module.exports = { listJsonFiles, readJson };
