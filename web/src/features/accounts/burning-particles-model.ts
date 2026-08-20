export interface BurningSparkSpec {
  dx: number;
  dy: number;
  fall: number;
  width: number;
  height: number;
  delay: number;
  duration: number;
  rotation: number;
  hue: number;
  saturation: number;
  lightness: number;
  ember: boolean;
}

/** 将燃点限制在真实进度条范围内；边界值仍对应 0% / 100% 的真实端点。 */
export function clampBurningAnchor(value: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(100, numeric));
}

function hexToHsl(hex: string): [number, number, number] {
  const match = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!match) return [16, 82, 54];
  const value = parseInt(match[1], 16);
  const r = ((value >> 16) & 0xff) / 255;
  const g = ((value >> 8) & 0xff) / 255;
  const b = (value & 0xff) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  let hue = 0;
  if (delta !== 0) {
    if (max === r) hue = ((g - b) / delta) % 6;
    else if (max === g) hue = (b - r) / delta + 2;
    else hue = (r - g) / delta + 4;
    hue *= 60;
    if (hue < 0) hue += 360;
  }
  const lightness = (max + min) / 2;
  const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1));
  return [Math.round(hue), Math.round(saturation * 100), Math.round(lightness * 100)];
}

/** FNV-1a 将额度轨道身份压成稳定的 32-bit 种子。 */
function hashSeedKey(seedKey: string): number {
  let hash = 0x811c9dc5;
  const text = String(seedKey || 'default');
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** 同一轨道跨重渲染稳定，不同轨道与不同参数通道彼此去相关。 */
function seededRandom(trackSeed: number, salt: number): number {
  let value = (trackSeed ^ Math.imul(salt, 0x9e3779b1)) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d);
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b);
  value ^= value >>> 16;
  return (value >>> 0) / 0x100000000;
}

/**
 * 构建紧贴燃点的火药火花：短生命周期、径向爆发、少量重力下坠。
 * activityRate 只调节密度和节奏，轨迹范围始终被限制在燃点附近。
 */
export function buildBurningSparkSpecs(
  color: string,
  activityRate = 0,
  seedKey = 'default'
): BurningSparkSpec[] {
  const [baseHue, baseSaturation, baseLightness] = hexToHsl(color);
  const rate = Math.max(0, Math.min(20, Number(activityRate) || 0));
  const count = 32 + Math.min(16, Math.round(rate * 1.5));
  const speed = 1 + rate / 45;
  const trackSeed = hashSeedKey(seedKey);
  const emberOffset = trackSeed % 5;

  return Array.from({ length: count }, (_, index) => {
    const particle = index + 1;
    const r1 = seededRandom(trackSeed, particle);
    const r2 = seededRandom(trackSeed, particle + 101);
    const r3 = seededRandom(trackSeed, particle + 201);
    const r4 = seededRandom(trackSeed, particle + 301);
    const r5 = seededRandom(trackSeed, particle + 401);
    const r6 = seededRandom(trackSeed, particle + 501);
    const r7 = seededRandom(trackSeed, particle + 601);
    const ember = (index + emberOffset) % 5 === 0;
    const angle = -Math.PI + r1 * Math.PI * 2;
    const distance = ember ? 4 + r2 * 6 : 7 + r2 * 11;
    const duration = (ember ? 0.42 + r3 * 0.28 : 0.26 + r3 * 0.24) / speed;

    return {
      dx: Math.cos(angle) * distance,
      dy: Math.sin(angle) * distance,
      fall: ember ? 3 + r4 * 5 : 1 + r4 * 3,
      width: ember ? 1.4 + r5 * 1.2 : 3 + r5 * 3.5,
      height: ember ? 1.4 + r7 : 1 + r7 * 1.2,
      delay: -r6 * duration,
      duration,
      rotation: angle * (180 / Math.PI),
      hue: (baseHue + (r1 - 0.5) * 24 + 360) % 360,
      saturation: Math.min(100, Math.max(48, baseSaturation + (r2 - 0.5) * 22)),
      lightness: Math.min(88, Math.max(48, baseLightness + 8 + r3 * 22)),
      ember
    };
  });
}
