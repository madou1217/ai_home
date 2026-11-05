#!/usr/bin/env node
'use strict';

// 模型目录切流判据：比较 Node 与 Go 的 /v1/models，输出差集。
//
// 背景：contracts/route-ownership/manifest.json 里 gateway.models.list 是最后一个
// 仍然 node_owned 的数据面条目。它不能凭「Go 有目录」就划转——Go 的目录只含 Go 能
// 路由的模型，Node 还可能列出 node-only Provider（当前只有 gemini）或自定义账号的
// 模型。划转前必须证明两边的差集是**已知且可接受**的。
//
// 用法：
//   node scripts/compare-model-catalog.js \
//     --node http://127.0.0.1:9527 --node-key <client key> \
//     --go http://127.0.0.1:<go port> --go-key <client key> \
//     [--allow-node-only gemini] [--json]
//
// 退出码：0 = 差集全在允许前缀内（可划转）；2 = 存在未预期的 node-only 模型。

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_REPORTED = 50;

function parseArgs(argv) {
  const options = {
    node: 'http://127.0.0.1:9527',
    go: '',
    nodeKey: '',
    goKey: '',
    allow: [],
    json: false,
    timeoutMs: DEFAULT_TIMEOUT_MS
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`缺少参数值: ${flag}`);
      return argv[index];
    };
    switch (flag) {
      case '--node': options.node = next(); break;
      case '--go': options.go = next(); break;
      case '--node-key': options.nodeKey = next(); break;
      case '--go-key': options.goKey = next(); break;
      case '--allow-node-only': options.allow.push(next()); break;
      case '--timeout-ms': options.timeoutMs = Number(next()) || DEFAULT_TIMEOUT_MS; break;
      case '--json': options.json = true; break;
      case '--help': options.help = true; break;
      default: throw new Error(`未知参数: ${flag}`);
    }
  }
  return options;
}

function usage() {
  return [
    '用法: node scripts/compare-model-catalog.js --go <url> [选项]',
    '',
    '  --node <url>              Node 服务地址（默认 http://127.0.0.1:9527）',
    '  --go <url>                Go Server 地址（必填）',
    '  --node-key <key>          Node 的 client key（也可用 AIH_SERVER_API_KEY）',
    '  --go-key <key>            Go 的 client key（缺省同 --node-key）',
    '  --allow-node-only <前缀>  允许只出现在 Node 的模型前缀，可重复',
    '  --json                    输出机器可读结果',
    '  --timeout-ms <ms>         单次请求超时（默认 15000）'
  ].join('\n');
}

async function fetchModelIds(baseUrl, key, timeoutMs) {
  const url = new URL('/v1/models', baseUrl).toString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: key ? { authorization: `Bearer ${key}` } : {},
      signal: controller.signal
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`${url} HTTP ${response.status}: ${text.slice(0, 200)}`);
    }
    let payload;
    try {
      payload = JSON.parse(text);
    } catch (_error) {
      throw new Error(`${url} 返回的不是 JSON`);
    }
    const rows = Array.isArray(payload && payload.data) ? payload.data : [];
    const ids = new Set();
    for (const row of rows) {
      const id = String(row && row.id || '').trim();
      if (id) ids.add(id);
    }
    return ids;
  } finally {
    clearTimeout(timer);
  }
}

function difference(left, right) {
  return [...left].filter((id) => !right.has(id)).sort();
}

function matchesAllowed(id, prefixes) {
  if (prefixes.length === 0) return false;
  const lower = id.toLowerCase();
  return prefixes.some((prefix) => lower.startsWith(String(prefix).toLowerCase()));
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${usage()}\n`);
    return 1;
  }
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  if (!options.go) {
    process.stderr.write(`缺少 --go\n\n${usage()}\n`);
    return 1;
  }
  options.nodeKey = options.nodeKey || process.env.AIH_SERVER_API_KEY || '';
  options.goKey = options.goKey || options.nodeKey;

  let nodeIds, goIds;
  try {
    [nodeIds, goIds] = await Promise.all([
      fetchModelIds(options.node, options.nodeKey, options.timeoutMs),
      fetchModelIds(options.go, options.goKey, options.timeoutMs)
    ]);
  } catch (error) {
    process.stderr.write(`读取模型目录失败: ${error.message}\n`);
    return 1;
  }

  const nodeOnly = difference(nodeIds, goIds);
  const goOnly = difference(goIds, nodeIds);
  const unexpected = nodeOnly.filter((id) => !matchesAllowed(id, options.allow));
  const result = {
    nodeCount: nodeIds.size,
    goCount: goIds.size,
    nodeOnly: nodeOnly.slice(0, MAX_REPORTED),
    goOnly: goOnly.slice(0, MAX_REPORTED),
    unexpectedNodeOnly: unexpected.slice(0, MAX_REPORTED),
    allowedPrefixes: options.allow,
    verdict: unexpected.length === 0 ? 'catalog_can_move' : 'catalog_blocked'
  };

  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`Node ${result.nodeCount} 个模型 / Go ${result.goCount} 个模型\n`);
    process.stdout.write(`仅 Node: ${result.nodeOnly.length ? result.nodeOnly.join(', ') : '（无）'}\n`);
    process.stdout.write(`仅 Go:   ${result.goOnly.length ? result.goOnly.join(', ') : '（无）'}\n`);
    if (result.allowedPrefixes.length) {
      process.stdout.write(`允许前缀: ${result.allowedPrefixes.join(', ')}\n`);
    }
    process.stdout.write(`结论: ${result.verdict}\n`);
  }
  return unexpected.length === 0 ? 0 : 2;
}

if (require.main === module) {
  main().then((code) => {
    process.exitCode = code;
  }, (error) => {
    process.stderr.write(`${error && error.stack || error}\n`);
    process.exitCode = 1;
  });
}

module.exports = { difference, matchesAllowed, parseArgs };

