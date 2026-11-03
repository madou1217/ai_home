'use strict';

// Go Core 子进程的监听地址与端口合成一个环境变量（`host=…,port=…`），
// 两者都只在 Node 侧解析；Go 子进程仍通过启动参数接收最终值。
const GO_CORE_BIND_ENV = 'AIH_GO_CORE_BIND';

function parseGoCoreBind(value) {
  const out = {};
  if (typeof value !== 'string' || !value.trim()) return out;
  for (const pair of value.split(',')) {
    const index = pair.indexOf('=');
    if (index <= 0) continue;
    const key = pair.slice(0, index).trim();
    const field = pair.slice(index + 1).trim();
    if (!field) continue;
    if (key === 'host') out.host = field;
    if (key === 'port') out.port = Number(field);
  }
  return out;
}

function serializeGoCoreBind({ host, port } = {}) {
  const parts = [];
  if (typeof host === 'string' && host.trim()) parts.push(`host=${host.trim()}`);
  if (port !== undefined && port !== null && port !== '') parts.push(`port=${port}`);
  return parts.join(',');
}

function readGoCoreBindField(env, field) {
  const parsed = parseGoCoreBind(env ? env[GO_CORE_BIND_ENV] : undefined);
  return parsed[field];
}

module.exports = { GO_CORE_BIND_ENV, parseGoCoreBind, serializeGoCoreBind, readGoCoreBindField };
