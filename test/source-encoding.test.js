'use strict';

// 回归守卫：仓库里的文本文件必须是合法 UTF-8，且不能含 U+FFFD（替换字符）。
//
// 为什么需要：迁移/批量写入时偶尔会把一个多字节汉字截断，写进去就变成 U+FFFD。
// 它仍是合法 UTF-8，编译/运行都不会报错，只有人眼能发现（2026-11-05 在 Go 模型
// 目录注释和迁移计划里各出现过一次）。
//
// 口径：只看 git 跟踪的文本文件（未跟踪的调试产物不管）；二进制按前 8KB 是否含
// NUL 跳过；单文件上限 4MB。

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const MAX_BYTES = 4 * 1024 * 1024;
const REPLACEMENT_CHAR = '\uFFFD';

function listTrackedFiles() {
  try {
    const output = execFileSync('git', ['ls-files', '-z'], {
      cwd: REPO_ROOT,
      maxBuffer: 128 * 1024 * 1024
    });
    return output.toString('utf8').split('\0').filter(Boolean);
  } catch (_error) {
    return null;
  }
}

function looksBinary(buffer) {
  const head = buffer.subarray(0, 8192);
  return head.includes(0);
}

function inspectFile(relativePath) {
  const absolute = path.join(REPO_ROOT, relativePath);
  let buffer;
  try {
    const stat = fs.statSync(absolute);
    if (!stat.isFile() || stat.size > MAX_BYTES) return null;
    buffer = fs.readFileSync(absolute);
  } catch (_error) {
    return null;
  }
  if (looksBinary(buffer)) return null;
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch (_error) {
    return { path: relativePath, reason: 'invalid-utf8', line: 0 };
  }
  const index = text.indexOf(REPLACEMENT_CHAR);
  if (index < 0) return null;
  const line = text.slice(0, index).split('\n').length;
  return { path: relativePath, reason: 'replacement-char', line };
}

test('git 跟踪的文本文件不含 U+FFFD，且都是合法 UTF-8', () => {
  const files = listTrackedFiles();
  if (files === null) {
    // 非 git 工作区（打包产物里跑测试）没有可比对的基线。
    return;
  }
  const offenders = [];
  for (const file of files) {
    const hit = inspectFile(file);
    if (hit) offenders.push(hit);
  }
  assert.deepEqual(
    offenders,
    [],
    `发现乱码（多字节字符被截断）：\n${offenders
      .map((item) => `  ${item.path}:${item.line} (${item.reason})`)
      .join('\n')}`
  );
});
