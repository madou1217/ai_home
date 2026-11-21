// 宿主进程用 `node --import register-hooks.mjs host-entry.mjs` 启动。
// Node 22 里只有 module.register() 注册的钩子才生效；把钩子文件直接放进 --import 不会接管解析。

import { createRequire, register } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

export const HOST_PROVIDED_MODULES = Object.freeze({
  '@ai-home/plugin-sdk': pathToFileURL(require.resolve('../sdk/index.js')).href,
  '@deepseek-ai/cordis': pathToFileURL(require.resolve('@deepseek-ai/cordis')).href
});

register('./resolve-hooks.mjs', import.meta.url, { data: HOST_PROVIDED_MODULES });
