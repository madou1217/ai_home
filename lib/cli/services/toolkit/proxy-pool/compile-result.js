'use strict';

// 编译结果的「附加输出」契约。
//
// 有的协议光一行代理行写不完：Surge / Surfboard 的 WireGuard 要另起一个 `[WireGuard x]` 段，
// sing-box 的 ShadowTLS 要多输出一个辅助出站。这些额外内容统一挂在编译结果的 Symbol 键 extras 上
// ——Symbol 不会被 JSON.stringify / Object.keys 看见，所以 sing-box 的出站对象照样能直接序列化。
//
// 行式格式（Surge / Surfboard / Loon / QX）的编译结果是 `{ line }`：行本身还是字符串，渲染器用
// collectLines 取行、展开段落。段名（`wg1`、`wg2`…）在编译单个节点时定不下来（不知道自己在列表
// 里的位置），所以插件在行里写 SECTION_SLOT 占位符，由 collectLines 按出现顺序替换成序号名，
// 顺带避开节点名里的 `[` `]` 进段头。

const EXTRAS = Symbol('aih.compileExtras');
const SECTION_SLOT = '@@aih-section@@';

/** 给编译结果挂附加输出（段落 / 辅助出站）；没有附加内容时原样返回。 */
function withExtras(value, extras) {
  if (Array.isArray(extras) && extras.length) {
    Object.defineProperty(value, EXTRAS, { value: extras, enumerable: false });
  }
  return value;
}

function extrasOf(value) {
  const extras = value && (typeof value === 'object' || typeof value === 'function') ? value[EXTRAS] : undefined;
  return Array.isArray(extras) ? extras : [];
}

/** 行式编译结果 → 代理行字符串（兼容直接返回字符串的旧写法）。 */
function compiledLine(value) {
  if (typeof value === 'string') return value;
  return String((value && value.line) ?? '');
}

/**
 * 行式渲染器的编译结果列表 → { lines, sections }。
 * 段落按出现顺序编号（`${prefix}1`、`${prefix}2`…），行里的 SECTION_SLOT 换成段名。
 */
function collectLines(compiledNodes) {
  const lines = [];
  const sections = [];
  let count = 0;
  for (const compiled of compiledNodes) {
    let line = compiledLine(compiled);
    for (const section of extrasOf(compiled)) {
      count += 1;
      const name = `${section.prefix || 'section'}${count}`;
      line = line.split(SECTION_SLOT).join(name);
      sections.push(`[${section.header} ${name}]`, ...section.lines, '');
    }
    lines.push(line);
  }
  return { lines, sections };
}

module.exports = {
  EXTRAS,
  SECTION_SLOT,
  collectLines,
  compiledLine,
  extrasOf,
  withExtras
};
