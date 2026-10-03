// ESM 解析钩子（运行在 Node 的 loader 线程）：插件代码 import 的 SDK 与 Cordis 一律解析到宿主自带的那一份，
// 保证整个宿主只有一个 Cordis（Service / Context 的 instanceof 与依赖注入依赖同一份实现），
// 外部插件包也不需要自带它们。映射表由 register-hooks.mjs 通过 initialize 传入。

let mapping = Object.create(null);

export async function initialize(data) {
  mapping = Object.assign(Object.create(null), data || {});
}

export async function resolve(specifier, context, nextResolve) {
  const target = mapping[specifier];
  if (target) return { url: target, shortCircuit: true };
  return nextResolve(specifier, context);
}
