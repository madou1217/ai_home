'use strict';

// 识别「请求来自真实的 opencode 客户端」（经 aih 改道到网关的 opencode CLI）。
//
// 为什么需要（2026-10-18）：免费档门禁只认 opencode 自己发出的请求形状。真实 opencode
// 的请求**本来就满足**门禁 —— 正文请求自带 `read` 等工具，标题请求不带工具、靠标题
// 提示词过门禁。网关的免费客户端为非 opencode 客户端补的 `read` 垫片若也加到这类请求上，
// 反而会把标题请求变成「不像 opencode」而吃 403（实测：原样 200，加垫片 403），
// 每次失败还会轮换共享出口池、连累同时在飞的正文请求。所以真实 opencode 的请求原样转发。
//
// 这不是安全边界：伪造这两个头的客户端只会让自己的请求少一个垫片、自己吃门禁。

function readHeader(headers, name) {
  if (!headers) return '';
  const raw = headers[name] !== undefined ? headers[name] : headers[name.toLowerCase()];
  return String(Array.isArray(raw) ? raw[0] : raw || '').trim();
}

function isOpenCodeNativeClient(headers) {
  return Boolean(readHeader(headers, 'x-opencode-client'))
    && /^opencode\//i.test(readHeader(headers, 'user-agent'));
}

module.exports = {
  isOpenCodeNativeClient
};
