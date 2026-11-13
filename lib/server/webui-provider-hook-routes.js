'use strict';

// Provider Hook 的两个入口已迁 Go：
//   GET  /v0/webui/provider-hooks          → Go 合同投影
//   POST /v0/webui/provider-hooks/install  → Go 写盘
//
// Node 只补 server 侧上下文（接收地址、发送脚本、Codex 版本与 Windows node 路径）；
// dry-run、确认校验、Provider 判定与文件写入全部在 Go。Go 不可用时直接 503，
// 不再回退本地实现——两套写盘逻辑会让「装没装」出现两个答案。

const path = require('node:path');
const { proxyGo } = require('./webui-go-proxy');

// 与 Node 安装模块的 DEFAULT_SENDER_SCRIPT_PATH 一致：server 没有显式配置时也要
// 写到仓库自带的 sender，而不是把空路径写进 hook 命令。
const DEFAULT_SENDER_SCRIPT_PATH = path.join(__dirname, '..', '..', 'scripts', 'aih-provider-session-hook-sender.js');

async function readJsonPayload(ctx, maxBytes) {
  return ctx.readRequestBody(ctx.req, { maxBytes })
    .then((buf) => (buf ? JSON.parse(buf.toString('utf8')) : null))
    .catch(() => null);
}

async function handleGetProviderHooksRequest(ctx) {
  return proxyGo(ctx, {
    method: 'getProviderHooks',
    message: 'Go Core 未就绪，Provider Hook 档案不可读'
  });
}

async function handleInstallProviderHooksRequest(ctx) {
  const payload = await readJsonPayload(ctx, 64 * 1024);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    ctx.writeJson(ctx.res, 400, { ok: false, error: 'invalid_payload' });
    return true;
  }
  const deps = ctx.deps || {};
  const metadata = {
    receiverUrl: String(deps.providerHookReceiverUrl || ''),
    senderScriptPath: String(deps.providerHookSenderScriptPath || DEFAULT_SENDER_SCRIPT_PATH),
    codexVersion: String(deps.codexClientVersion || '')
  };
  // Windows hook 命令直接落到 node.exe；POSIX 仍由 Go 用 /usr/bin/env node。
  if (process.platform === 'win32') metadata.nodeExecPath = process.execPath;
  return proxyGo(ctx, {
    method: 'installProviderHooks',
    args: [{ ...payload, ...metadata }],
    message: 'Go Core 未就绪，Provider Hook 未安装',
    passStatuses: [400]
  });
}

module.exports = {
  handleGetProviderHooksRequest,
  handleInstallProviderHooksRequest
};