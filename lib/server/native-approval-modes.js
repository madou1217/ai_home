'use strict';

// 会话级审批模式(P3):bypass / confirm / plan → 各 provider 的启动形态映射。纯函数,无 IO。
//
// 模式语义(与 2026-07-03 "流畅优先"决策兼容——默认 bypass 零变化):
//   bypass  默认。保持各 provider 现状(claude 继承用户 settings;codex --dangerously-bypass;
//           opencode --dangerously-skip)。
//   confirm 需要权限的操作转发 webUI 审批。claude=官方 --permission-prompt-tool(MCP,S1 实证);
//           codex=app-server JSON-RPC(S3 实证,接入后生效);opencode=serve API(S4 实证,接入后生效)。
//   plan    仅 claude:--permission-mode plan + confirm——ExitPlanMode 本身走权限工具(S1 实证),
//           "计划完成,执行吗"的确认点天然存在。其他 provider 降级为 confirm。

const APPROVAL_MODES = new Set(['bypass', 'confirm', 'plan']);

function normalizeApprovalMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  return APPROVAL_MODES.has(mode) ? mode : 'bypass';
}

function approvalModeNeedsBridge(mode) {
  return normalizeApprovalMode(mode) !== 'bypass';
}

// claude:confirm/plan 需要的追加 CLI 参数。mcpConfigJson 由调用方生成(含权限工具的
// command/args/env),这里只负责拼参数。bypass 返回空(保持现状)。
function claudeApprovalArgs(mode, mcpConfigJson) {
  const normalized = normalizeApprovalMode(mode);
  if (normalized === 'bypass') return [];
  const args = [
    '--permission-mode', normalized === 'plan' ? 'plan' : 'default',
    '--permission-prompt-tool', 'mcp__aih__approve'
  ];
  if (mcpConfigJson) args.push('--mcp-config', mcpConfigJson);
  return args;
}

function grokApprovalArgs(mode) {
  const normalized = normalizeApprovalMode(mode);
  const permissionMode = normalized === 'bypass'
    ? 'bypassPermissions'
    : (normalized === 'plan' ? 'plan' : 'default');
  return ['--permission-mode', permissionMode];
}

// 权限工具 MCP server 的 --mcp-config JSON(env 里带回话上下文与回传端点)。
function buildClaudeApprovalMcpConfig(options = {}) {
  const toolPath = String(options.toolPath || '').trim();
  if (!toolPath) return '';
  return JSON.stringify({
    mcpServers: {
      aih: {
        command: String(options.nodePath || process.execPath),
        args: [toolPath],
        env: {
          AIH_APPROVAL_URL: String(options.approvalUrl || ''),
          AIH_RUN_ID: String(options.runId || '')
        }
      }
    }
  });
}

module.exports = {
  normalizeApprovalMode,
  approvalModeNeedsBridge,
  claudeApprovalArgs,
  grokApprovalArgs,
  buildClaudeApprovalMcpConfig
};
