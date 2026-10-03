// ESM 解析钩子（运行在 Node 的 loader 线程）。
//
// 1. 插件代码 import 的 SDK 与 Cordis 一律解析到宿主自带的那一份，保证整个宿主只有一个 Cordis
//    （Service / Context 的 instanceof 与依赖注入依赖同一份实现），外部插件包也不需要自带它们。
//    映射表由 register-hooks.mjs 通过 initialize 传入。
// 2. 代次隔离：宿主用 `?generation=N&instance=I` import 插件入口；入口里的相对 import（以及插件自带的
//    ESM 依赖）按 URL 规则会丢掉查询参数，导致各代共享同一份模块状态。这里把父模块的 generation /
//    instance 继续传给它解析出的 file: 模块，使同一代次的整棵 ESM 模块树独立。
//    CommonJS 依赖由 require 缓存按文件名共享，不在隔离范围内（见 M0 报告）。

let mapping = Object.create(null);

export async function initialize(data) {
  mapping = Object.assign(Object.create(null), data || {});
}

function generationScope(parentURL) {
  if (!parentURL || !parentURL.startsWith('file:')) return null;
  const params = new URL(parentURL).searchParams;
  const generation = params.get('generation');
  return generation ? { generation, instance: params.get('instance') || '' } : null;
}

export async function resolve(specifier, context, nextResolve) {
  const target = mapping[specifier];
  if (target) return { url: target, shortCircuit: true };
  const resolved = await nextResolve(specifier, context);
  const scope = generationScope(context.parentURL);
  if (!scope || !resolved.url.startsWith('file:')) return resolved;
  const url = new URL(resolved.url);
  if (url.searchParams.has('generation')) return resolved;
  url.searchParams.set('generation', scope.generation);
  url.searchParams.set('instance', scope.instance);
  return { ...resolved, url: url.href };
}
