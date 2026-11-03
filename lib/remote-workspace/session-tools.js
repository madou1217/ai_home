'use strict';

// 远程工作区的 AI 工具集（拆分执行的「执行侧」）：harness（codex / claude）留在 AIH Server，
// 它的读写文件、搜索、执行命令都经这组工具落到远端工作区。
//
// 只描述工具（名字、参数 schema、语义）和把一次调用翻译成 RemoteHost 操作；
// 传输（MCP stdio ↔ Server 内部路由）在 remote-tools-mcp-server.js / webui-remote-tools-routes.js。
//
// 安全约定：
//   - 所有路径都相对工作区根目录，越界（..、绝对路径、盘符）一律拒绝（path-guard）；
//   - 写文件带版本校验：模型读过的版本与远端当前不一致就拒绝（version_conflict），
//     不覆盖用户在别处做的修改；新文件用 expected_version = null；
//   - 命令在工作区根目录执行，有超时与输出上限。

const MAX_READ_BYTES = 512 * 1024;
const MAX_COMMAND_OUTPUT = 256 * 1024;
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const MAX_COMMAND_TIMEOUT_MS = 30 * 60 * 1000;

const TOOL_DEFINITIONS = Object.freeze([
  {
    name: 'read_file',
    description: '读取远程工作区内的文本文件。返回带行号的内容和 version（写回时作为 expected_version，防止覆盖别人的修改）。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对工作区根目录的路径' },
        offset: { type: 'integer', description: '起始行（从 1 开始，可选）' },
        limit: { type: 'integer', description: '最多读取的行数（可选）' }
      },
      required: ['path']
    }
  },
  {
    name: 'write_file',
    description: '写入（覆盖或新建）远程工作区内的文件，原子替换。修改已有文件时必须传 read_file 返回的 expected_version；新建文件传空字符串。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
        // 不用联合类型 ['string','null']：codex 的工具 schema 转换不支持，会让整个 MCP server 的工具被丢弃。
        expected_version: { type: 'string', description: 'read_file 返回的 version；新建文件传空字符串 ""' }
      },
      required: ['path', 'content', 'expected_version']
    }
  },
  {
    name: 'edit_file',
    description: '在远程文件中把 old_string 精确替换为 new_string（old_string 必须唯一，除非 replace_all=true）。自动做版本校验。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
        replace_all: { type: 'boolean' }
      },
      required: ['path', 'old_string', 'new_string']
    }
  },
  {
    name: 'list_directory',
    description: '列出远程工作区内某个目录的条目（目录在前）。',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: '相对路径，根目录用空字符串' } }
    }
  },
  {
    name: 'search',
    description: '在远程工作区内按正则搜索文件内容（远端 rg 优先，否则 grep），返回 path:line:text。',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        max_results: { type: 'integer' }
      },
      required: ['pattern']
    }
  },
  {
    name: 'run_command',
    description: '在远程工作区根目录执行一条 shell 命令（Linux/macOS 为 sh，Windows 为 PowerShell），返回退出码与输出。',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        timeout_ms: { type: 'integer', description: `超时毫秒（默认 ${DEFAULT_COMMAND_TIMEOUT_MS}）` }
      },
      required: ['command']
    }
  }
]);

function text(value) {
  return { content: [{ type: 'text', text: String(value) }] };
}

function failure(error) {
  const code = String(error && error.code || 'remote_tool_failed');
  const message = String(error && error.message || error || code);
  return { isError: true, content: [{ type: 'text', text: `[${code}] ${message}` }] };
}

function numberLines(content, offset, limit) {
  const lines = content.split('\n');
  const start = Math.max(1, Number(offset) || 1);
  const end = limit ? Math.min(lines.length, start + Number(limit) - 1) : lines.length;
  const out = [];
  for (let index = start; index <= end; index += 1) out.push(`${String(index).padStart(6)}\t${lines[index - 1]}`);
  return { body: out.join('\n'), total: lines.length, start, end };
}

function looksBinary(buffer) {
  return buffer.subarray(0, 8000).includes(0);
}

const HANDLERS = Object.freeze({
  async read_file(host, args) {
    const file = await host.readFile(args.path, { maxBytes: MAX_READ_BYTES });
    if (looksBinary(file.content)) return text(`version: ${file.version}\n（二进制文件，${file.size} 字节，未显示内容）`);
    const { body, total, start, end } = numberLines(file.content.toString('utf8'), args.offset, args.limit);
    return text(`version: ${file.version}\nlines: ${start}-${end} / ${total}\n${body}`);
  },

  async write_file(host, args) {
    // 空字符串 / null 都表示「必须是新文件」；缺省（undefined）不校验。
    const raw = args.expected_version;
    const expected = raw === undefined ? undefined : (raw === null || raw === '' ? null : String(raw));
    const result = await host.writeFile(args.path, String(args.content), { expectedVersion: expected });
    return text(`已写入 ${result.path}（version: ${result.version}${result.unchanged ? '，内容未变化' : ''}）`);
  },

  async edit_file(host, args) {
    const file = await host.readFile(args.path, { maxBytes: MAX_READ_BYTES });
    const original = file.content.toString('utf8');
    const oldString = String(args.old_string);
    if (!oldString) throw Object.assign(new Error('old_string 不能为空'), { code: 'invalid_edit' });
    const count = original.split(oldString).length - 1;
    if (count === 0) throw Object.assign(new Error('old_string 在文件中不存在'), { code: 'edit_not_found' });
    if (count > 1 && !args.replace_all) {
      throw Object.assign(new Error(`old_string 出现了 ${count} 次，请提供更长的上下文或使用 replace_all`), { code: 'edit_ambiguous' });
    }
    const next = args.replace_all ? original.split(oldString).join(String(args.new_string)) : original.replace(oldString, () => String(args.new_string));
    const result = await host.writeFile(args.path, next, { expectedVersion: file.version });
    return text(`已修改 ${result.path}（替换 ${args.replace_all ? count : 1} 处，version: ${result.version}）`);
  },

  async list_directory(host, args) {
    const listing = await host.listDir(String(args.path || ''));
    const lines = listing.entries.map((entry) => `${entry.type === 'd' ? 'd' : entry.type === 'l' ? 'l' : '-'} ${String(entry.size).padStart(10)}  ${entry.name}${entry.type === 'd' ? '/' : ''}`);
    return text(`${listing.path || '.'}（${listing.entries.length} 项）\n${lines.join('\n')}`);
  },

  async search(host, args) {
    const found = await host.search(String(args.pattern), { maxResults: Math.min(Math.max(Number(args.max_results) || 200, 1), 1000) });
    const lines = found.matches.map((match) => `${match.path}:${match.line}:${match.text}`);
    return text(`${lines.length} 处匹配${found.truncated ? '（已截断）' : ''}\n${lines.join('\n')}`);
  },

  async run_command(host, args) {
    const timeoutMs = Math.min(Math.max(Number(args.timeout_ms) || DEFAULT_COMMAND_TIMEOUT_MS, 1000), MAX_COMMAND_TIMEOUT_MS);
    const result = await host.run(String(args.command), { timeoutMs, maxOutputBytes: MAX_COMMAND_OUTPUT });
    const parts = [`exit code: ${result.exitCode}${result.truncated ? '（输出已截断）' : ''}`];
    if (result.stdout) parts.push(`stdout:\n${result.stdout}`);
    if (result.stderr) parts.push(`stderr:\n${result.stderr}`);
    return { ...(result.exitCode === 0 ? {} : { isError: true }), content: [{ type: 'text', text: parts.join('\n') }] };
  }
});

/**
 * 执行一次工具调用。
 * @param {import('./ops/remote-host').RemoteHost} host
 * @returns {Promise<{content: Array, isError?: boolean}>} MCP tools/call 结果
 */
async function callRemoteTool(host, name, args = {}) {
  const handler = HANDLERS[name];
  if (!handler) return failure({ code: 'unknown_tool', message: `未知工具：${name}` });
  try {
    return await handler(host, args && typeof args === 'object' ? args : {});
  } catch (error) {
    return failure(error);
  }
}

module.exports = { TOOL_DEFINITIONS, callRemoteTool };
