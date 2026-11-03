'use strict';

// 远程工作区会话桥（Server 侧）：把「一个 harness 会话」绑定到「一个远程工作区」。
//
//   harness（本机 claude / codex） ──MCP stdio──▶ remote-tools-mcp-server（本机子进程）
//        ──loopback HTTP + 会话令牌──▶ POST /v0/webui/internal/remote-tools（本模块）
//        ──共享连接池──▶ 远端工作区（RemoteHost）
//
// 每个会话一个随机令牌（只存在于 0600 的 launch context 文件与本进程内存），
// 令牌决定能操作哪个工作区：harness 不能借别人的令牌越权到别的工作区。
//
// 影子工作目录：harness 需要一个本机 cwd（会话历史按 cwd 归档、codex 以它为沙箱根）。
// 每个远程工作区一个固定的空目录 <aiHome>/run/remote-workspaces/<workspaceId>，
// 不放任何项目文件——原生文件 / 命令工具被禁用，模型只能经远程工具读写远端。

const crypto = require('node:crypto');
const path = require('node:path');
const { writeLaunchContext } = require('../runtime/launch-context');
const { readJsonValue } = require('./app-state-store');

const WORKSPACE_ID = /^ws_[a-f0-9]{16}$/;
const TOOLS_PATH = '/v0/webui/internal/remote-tools';
const MCP_SERVER_NAME = 'aih_remote';
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

const tokens = new Map(); // token → { workspaceId, aiHomeDir, expiresAt }

// claude 原生工具里会直接读写本机 / 执行本机命令的那些：远程会话里全部禁用。
const CLAUDE_LOCAL_TOOLS = Object.freeze([
  'Bash', 'BashOutput', 'KillShell', 'Read', 'Write', 'Edit', 'NotebookEdit', 'Glob', 'Grep'
]);

const REMOTE_INSTRUCTIONS = [
  '你在一个「远程工作区」里工作：项目文件在远端机器上，不在本机。',
  `只能用 ${MCP_SERVER_NAME} 提供的工具（read_file / write_file / edit_file / list_directory / search / run_command）`,
  '读写文件和执行命令；路径一律相对工作区根目录。修改文件前先 read_file，写回时带上它返回的 version。',
  '本机当前目录是一个空的占位目录，不要在本机查找项目文件。'
].join('');

function isRemoteWorkspaceId(value) {
  return WORKSPACE_ID.test(String(value || ''));
}

function shadowDirectory(aiHomeDir, workspaceId) {
  if (!isRemoteWorkspaceId(workspaceId)) throw Object.assign(new Error('invalid_remote_workspace'), { code: 'invalid_remote_workspace' });
  return path.join(aiHomeDir, 'run', 'remote-workspaces', workspaceId);
}

/** 影子目录 → 工作区 ID（不是影子目录返回空串）。 */
function workspaceIdFromProjectPath(aiHomeDir, projectPath) {
  const root = path.join(String(aiHomeDir || ''), 'run', 'remote-workspaces') + path.sep;
  const value = String(projectPath || '');
  if (!aiHomeDir || !value.startsWith(root)) return '';
  const id = value.slice(root.length).replace(/[\\/]+$/, '');
  return isRemoteWorkspaceId(id) ? id : '';
}

function ensureShadowDirectory(fsImpl, aiHomeDir, workspaceId) {
  const dir = shadowDirectory(aiHomeDir, workspaceId);
  fsImpl.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function loadWorkspace(fsImpl, aiHomeDir, workspaceId) {
  const list = readJsonValue(fsImpl, aiHomeDir, 'ssh_workspaces');
  return Array.isArray(list) ? list.find((item) => item && item.id === workspaceId) || null : null;
}

function prune(now) {
  for (const [token, entry] of tokens) if (entry.expiresAt <= now) tokens.delete(token);
}

/**
 * 为一次 harness 启动签发远程工具上下文。
 * @returns {{ token, launchContextPath, mcpServer: {command, args, env} }}
 */
function issueRemoteToolsContext({ fs: fsImpl, aiHomeDir, workspaceId, port, runId, now = Date.now() }) {
  if (!loadWorkspace(fsImpl, aiHomeDir, workspaceId)) {
    throw Object.assign(new Error('远程工作区不存在'), { code: 'workspace_not_found' });
  }
  prune(now);
  const token = crypto.randomBytes(24).toString('hex');
  tokens.set(token, { workspaceId, aiHomeDir, expiresAt: now + TOKEN_TTL_MS });
  const launchContextPath = writeLaunchContext({
    toolsUrl: `http://127.0.0.1:${port}${TOOLS_PATH}`,
    token
  }, { root: aiHomeDir, name: `remote-tools-${runId || token.slice(0, 12)}` });
  return {
    token,
    launchContextPath,
    mcpServer: {
      command: process.execPath,
      args: [path.join(__dirname, '..', 'remote-workspace', 'remote-tools-mcp-server.js')],
      env: { AIH_LAUNCH_CONTEXT: launchContextPath }
    }
  };
}

/**
 * 终端（CLI 进程）用的直连上下文：MCP server 自己连远端，不依赖 Server 进程内的令牌。
 * @returns {{ launchContextPath, mcpServer }}
 */
function issueDirectRemoteToolsContext({ fs: fsImpl, aiHomeDir, workspaceId, runId }) {
  if (!loadWorkspace(fsImpl, aiHomeDir, workspaceId)) {
    throw Object.assign(new Error('远程工作区不存在'), { code: 'workspace_not_found' });
  }
  const launchContextPath = writeLaunchContext({ aiHomeDir, workspaceId },
    { root: aiHomeDir, name: `remote-tools-direct-${runId || crypto.randomBytes(6).toString('hex')}` });
  return {
    launchContextPath,
    mcpServer: {
      command: process.execPath,
      args: [path.join(__dirname, '..', 'remote-workspace', 'remote-tools-mcp-server.js')],
      env: { AIH_LAUNCH_CONTEXT: launchContextPath }
    }
  };
}

/** `--remote=` 的值是已登记的远程工作区（id 或名称）时返回该工作区，否则 null（走旧的 target:root 语义）。 */
function findWorkspaceByRef(fsImpl, aiHomeDir, ref) {
  const value = String(ref || '').trim();
  if (!value) return null;
  const list = readJsonValue(fsImpl, aiHomeDir, 'ssh_workspaces');
  if (!Array.isArray(list)) return null;
  return list.find((item) => item && item.id === value)
    || list.find((item) => item && item.label === value)
    || null;
}

function revokeRemoteToolsToken(token) {
  tokens.delete(String(token || ''));
}

/** POST /v0/webui/internal/remote-tools（仅 loopback，见 webui-auth-gate）。 */
async function handleRemoteToolsRequest(ctx) {
  const { req, res, writeJson, readRequestBody } = ctx;
  const token = String(req.headers['x-aih-remote-tools-token'] || '').trim();
  const entry = token ? tokens.get(token) : null;
  if (!entry || entry.expiresAt <= Date.now()) {
    writeJson(res, 403, { isError: true, content: [{ type: 'text', text: '[remote_tools_forbidden] 远程工具令牌无效或已过期' }] });
    return true;
  }
  const payload = await readRequestBody(req, { maxBytes: 8 * 1024 * 1024 })
    .then((buffer) => (buffer ? JSON.parse(buffer.toString('utf8')) : null))
    .catch(() => null);
  if (!payload || typeof payload.name !== 'string') {
    writeJson(res, 400, { isError: true, content: [{ type: 'text', text: '[remote_tools_bad_request] 请求无效' }] });
    return true;
  }
  const { getRemoteWorkspaceService } = require('../remote-workspace');
  const { callRemoteTool } = require('../remote-workspace/session-tools');
  let result;
  try {
    const host = getRemoteWorkspaceService({ fs: ctx.fs, aiHomeDir: entry.aiHomeDir }).host(entry.workspaceId);
    result = await callRemoteTool(host, payload.name, payload.arguments);
  } catch (error) {
    result = { isError: true, content: [{ type: 'text', text: `[${error.code || 'remote_unavailable'}] ${error.message}` }] };
  }
  writeJson(res, 200, result);
  return true;
}

/** claude 启动参数：远程工具 MCP + 禁用本机文件 / 命令工具 + 远程工作区说明。 */
function claudeRemoteArgs(context) {
  return [
    '--mcp-config', JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: context.mcpServer } }),
    '--disallowedTools', CLAUDE_LOCAL_TOOLS.join(','),
    '--append-system-prompt', REMOTE_INSTRUCTIONS
  ];
}

// codex 命令行（终端交互）：-c 覆盖挂 MCP、关本机 shell。TOML 字面量。
function tomlValue(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(', ')}]`;
  if (value && typeof value === 'object') {
    return `{ ${Object.entries(value).map(([key, item]) => `${/^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key)} = ${tomlValue(item)}`).join(', ')} }`;
  }
  return '""';
}

function codexRemoteCliFlags(context) {
  const config = {
    'features.shell_tool': false,
    'features.unified_exec': false,
    project_doc_max_bytes: 0,
    developer_instructions: REMOTE_INSTRUCTIONS,
    [`mcp_servers.${MCP_SERVER_NAME}.command`]: context.mcpServer.command,
    [`mcp_servers.${MCP_SERVER_NAME}.args`]: context.mcpServer.args,
    [`mcp_servers.${MCP_SERVER_NAME}.env`]: context.mcpServer.env,
    [`mcp_servers.${MCP_SERVER_NAME}.tool_timeout_sec`]: 35 * 60
  };
  return Object.entries(config).flatMap(([key, value]) => ['-c', `${key}=${tomlValue(value)}`]);
}

// codex：app-server 原生 dynamicTools（thread/start 声明 + item/tool/call 服务端请求），
// 不走 MCP——codex 0.166 起 MCP 工具只在 code mode 的 exec 沙箱里可见，模型拿不到直接调用。
// 工具在 Server 进程内直接执行（共享连接池），不需要令牌 / 子进程。
const CODEX_DISABLED_LOCAL_TOOLS = Object.freeze({
  'features.shell_tool': false,
  'features.unified_exec': false,
  project_doc_max_bytes: 0
});

function codexDynamicTools() {
  const { TOOL_DEFINITIONS } = require('../remote-workspace/session-tools');
  return TOOL_DEFINITIONS.map((tool) => ({
    type: 'function', name: tool.name, description: tool.description, inputSchema: tool.inputSchema
  }));
}

/**
 * thread/start / thread/resume 参数补丁：会话的 projectPath 是远程工作区影子目录时，
 * 关掉本机 shell，声明远程工具，附加远程工作区说明。非远程会话原样返回。
 */
function codexRemoteThreadParams(params, { aiHomeDir, projectPath, resume = false }) {
  if (!workspaceIdFromProjectPath(aiHomeDir, projectPath)) return params;
  const developerInstructions = [params.developerInstructions, REMOTE_INSTRUCTIONS.replace(`${MCP_SERVER_NAME} 提供的`, '远程')]
    .filter(Boolean).join('\n\n');
  return {
    ...params,
    // dynamicTools 只在 thread/start 声明（随线程持久化）；resume 沿用。
    ...(resume ? {} : { dynamicTools: codexDynamicTools() }),
    developerInstructions,
    config: { ...(params.config || {}), ...CODEX_DISABLED_LOCAL_TOOLS }
  };
}

/**
 * 处理 codex 的 item/tool/call 服务端请求。不是远程工具请求返回 false（交给原有链路）。
 * @returns {boolean}
 */
function handleCodexToolCall(message, client, { fs: fsImpl, aiHomeDir, projectPath }) {
  if (!message || message.method !== 'item/tool/call') return false;
  const workspaceId = workspaceIdFromProjectPath(aiHomeDir, projectPath);
  const params = message.params || {};
  const respond = (result) => client.respond(message.id, {
    contentItems: (result.content || []).map((item) => ({ type: 'inputText', text: String(item.text || '') })),
    success: !result.isError
  });
  if (!workspaceId) {
    respond({ isError: true, content: [{ type: 'text', text: `[unknown_tool] ${params.tool}` }] });
    return true;
  }
  const { getRemoteWorkspaceService } = require('../remote-workspace');
  const { callRemoteTool } = require('../remote-workspace/session-tools');
  Promise.resolve()
    .then(() => callRemoteTool(getRemoteWorkspaceService({ fs: fsImpl, aiHomeDir }).host(workspaceId), params.tool, params.arguments))
    .catch((error) => ({ isError: true, content: [{ type: 'text', text: `[${error.code || 'remote_unavailable'}] ${error.message}` }] }))
    .then(respond, () => {});
  return true;
}

module.exports = {
  codexDynamicTools,
  codexRemoteCliFlags,
  codexRemoteThreadParams,
  handleCodexToolCall,
  CLAUDE_LOCAL_TOOLS,
  MCP_SERVER_NAME,
  REMOTE_INSTRUCTIONS,
  TOOLS_PATH,
  claudeRemoteArgs,
  ensureShadowDirectory,
  handleRemoteToolsRequest,
  isRemoteWorkspaceId,
  issueRemoteToolsContext,
  issueDirectRemoteToolsContext,
  findWorkspaceByRef,
  loadWorkspace,
  revokeRemoteToolsToken,
  shadowDirectory,
  workspaceIdFromProjectPath
};
