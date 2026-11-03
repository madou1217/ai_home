'use strict';

// 从 CLI 自报的整行里取出版本号：`codex-cli 0.158.0` → `0.158.0`，
// `2.1.284 (Claude Code)` → `2.1.284`，`0.154.0-alpha.3` 原样。取不到时原样返回（去空白）。

const { normalizeVersion } = require('../../cli/services/toolkit/app-update-checker');

function toVersionText(value) {
  const raw = String(value == null ? '' : value).trim();
  const parsed = normalizeVersion(raw);
  return parsed ? parsed.text : raw;
}

module.exports = { toVersionText };
