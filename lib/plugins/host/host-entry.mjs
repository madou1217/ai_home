// Plugin Host 子进程入口：起本机 RPC 服务，把 prepare / activate / invoke / dispose / status 交给 HostRuntime。
// 由 supervisor.js 拉起；socket 路径与令牌只经环境变量传入（环境变量按白名单构造，不含网关凭据）。

import { createRequire } from 'node:module';
import { HostRuntime } from './host-runtime.mjs';

const require = createRequire(import.meta.url);
const { createRpcServer } = require('../transport/rpc-server');
const { PluginError } = require('../sdk/errors');

const socketPath = process.env.AIH_PLUGIN_SOCKET || '';
const token = process.env.AIH_PLUGIN_TOKEN || '';
// 令牌读出后立即从环境中删掉：插件代码跑在本进程里，不能拿它回连 socket 调 prepare / dispose / shutdown。
delete process.env.AIH_PLUGIN_TOKEN;
if (!socketPath) throw new Error('plugin_host_socket_missing');
if (token.length < 32) throw new Error('plugin_host_token_invalid');

const runtime = new HostRuntime({ hostVersion: process.env.AIH_PLUGIN_HOST_VERSION || '1.0.0' });
let server = null;

async function shutdown(code = 0) {
  try { await runtime.shutdown(); } catch (_error) {}
  try { await server?.close(); } catch (_error) {}
  process.exit(code);
}

server = createRpcServer({
  socketPath,
  token,
  onCall: async (method, value, context) => {
    // 返回显式信封 { value, payload? }：invoke 由 runtime 归一化 handler 的返回值。
    if (method === 'prepare') return { value: await runtime.prepare(value) };
    if (method === 'activate') return { value: await runtime.activate(value?.generation) };
    if (method === 'invoke') return runtime.invoke(value, context);
    if (method === 'dispose') return { value: await runtime.dispose(value?.generation) };
    if (method === 'status') return { value: runtime.status() };
    if (method === 'ping') return { value: { pong: true }, payload: context.payload };
    if (method === 'shutdown') { setImmediate(() => { void shutdown(0); }); return { value: { state: 'stopping' } }; }
    throw new PluginError('plugin_rpc_method_unknown');
  }
});

await server.listen();
process.stdout.write(`${JSON.stringify({ event: 'plugin_host_ready', pid: process.pid })}\n`);
process.once('SIGTERM', () => { void shutdown(0); });
process.once('SIGINT', () => { void shutdown(0); });
// 父进程（网关）退出时 stdin 管道会 EOF：宿主随之退出，不留孤儿进程。只在 supervisor 显式声明时启用，
// 其他启动方式（例如测试里 stdin 指向 /dev/null）不会因为立即 EOF 而退出。
if (process.env.AIH_PLUGIN_EXIT_WITH_PARENT === '1') {
  process.stdin.on('end', () => { void shutdown(0); });
  process.stdin.on('error', () => { void shutdown(0); });
  process.stdin.resume();
}
