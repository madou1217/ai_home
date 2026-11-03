'use strict';

// sing-box 内核版本：客户端 UA 带版本时按版本输出，认不出时按基线 1.12（新 DNS 写法、AnyTLS 出站）。
const SING_BOX_BASELINE = '1.12.0';

/** "1.14.3" / "1.13" → [1, 14, 3]；不是版本号时返回 null。 */
function parseVersion(value) {
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(value ?? '').trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3] || 0)] : null;
}

function compareVersions(left, right) {
  const a = parseVersion(left) || [0, 0, 0];
  const b = parseVersion(right) || [0, 0, 0];
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

/** 版本未知按基线算。 */
function atLeast(version, minimum) {
  return compareVersions(version || SING_BOX_BASELINE, minimum) >= 0;
}

module.exports = {
  SING_BOX_BASELINE,
  atLeast,
  compareVersions,
  parseVersion
};
