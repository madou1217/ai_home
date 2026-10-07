'use strict';

// 写临时文件再 rename：读者只会看到旧内容或完整的新内容。临时文件必须与目标同目录
// （跨目录 rename 不原子），并且任何一步失败都要删掉它——aih 不留 *.tmp 残留。

const crypto = require('node:crypto');
const nodePath = require('node:path');

function writeFileAtomic(fs, filePath, data, options = {}) {
  const temporary = nodePath.join(
    nodePath.dirname(filePath),
    `.${nodePath.basename(filePath)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
  );
  try {
    fs.writeFileSync(temporary, data, options);
    fs.renameSync(temporary, filePath);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch (_cleanupError) { /* 本来就没写出来 */ }
    throw error;
  }
}

module.exports = { writeFileAtomic };
