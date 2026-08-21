/**
 * FNV-1a + avalanche：同一账号/事件稳定，不同盐值互相去相关。
 * 花园里所有"看着随机"的东西都从这里取值，重渲染不会让花瞬移或改色。
 */
export function stableGardenRandom(...parts: Array<string | number>): number {
  let hash = 0x811c9dc5;
  // 分隔符不可省：否则 ('a','bc') 与 ('ab','c') 会撞进同一个值。
  const input = parts.map((part) => String(part)).join('\u001f');
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x7feb352d);
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x846ca68b);
  hash ^= hash >>> 16;
  return (hash >>> 0) / 0x100000000;
}

/** 在 [minimum, maximum] 里取一个稳定值。 */
export function stableGardenRange(
  minimum: number,
  maximum: number,
  ...parts: Array<string | number>
): number {
  const low = Math.min(minimum, maximum);
  const high = Math.max(minimum, maximum);
  return low + (high - low) * stableGardenRandom(...parts);
}
