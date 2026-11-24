import * as THREE from 'three';
import type {
  EmployeeVisualPersona,
  OfficeSessionItem,
  SessionAvailability,
} from './session-office-types';
import type { OfficeScenePalette } from './office-scene-types';
import {
  createSolidColorVoxelGeometry,
  FACE_SHADE,
  type SolidColorBoxInput,
  type VoxelFaceDir,
} from './office-voxel-builder';
import type { CharacterPoseOutput } from './office-voxel-behaviour';

/**
 * Minecraft Steve 体素角色模块：
 * 1. 严格轴对齐方块构成（总站立高度 1.75 世界单位，全尺寸为 0.0625 像素整数倍）。
 * 2. 64×64 程序化像素皮肤贴图（NearestFilter、无 mipmap、SRGBColorSpace、确定性 ±8% 像素亮度抖动）。
 * 3. 逐面烘焙 Minecraft 经典亮度（顶面 1.00 / ±X 0.80 / ±Z 0.65 / 底面 0.52）。
 * 4. 坐姿精准对齐椅面（y = 0.375）与桌面（y = 0.746），零穿模且每角色可见 Draw Call ≤ 7。
 */

const SKIN_SIZE = 64;
const SKIN_UV_INSET = 0.02;

/** 坐姿旋转 -90° 朝向 +Z 后的世界朝向面亮度映射（局部 +Z 朝上变为顶面 1.0） */
const SEATED_FORWARD_FACE_SHADE: Readonly<Record<VoxelFaceDir, number>> = {
  py: FACE_SHADE.nz,
  ny: FACE_SHADE.pz,
  px: FACE_SHADE.px,
  nx: FACE_SHADE.nx,
  pz: FACE_SHADE.py,
  nz: FACE_SHADE.ny,
};

interface Rgb {
  r: number;
  g: number;
  b: number;
}

interface SkinUvRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

type BoxUvRegions = Readonly<Record<VoxelFaceDir, SkinUvRect>>;

interface SkinnedVoxelBoxOptions {
  faceShadeOverride?: Readonly<Record<VoxelFaceDir, number>>;
  hiddenFaces?: Partial<Record<VoxelFaceDir, boolean>>;
}

interface FaceCornerTemplate {
  pos: readonly [number, number, number];
  uv: readonly [0 | 1, 0 | 1];
}

interface FaceTemplate {
  dir: VoxelFaceDir;
  normal: readonly [number, number, number];
  corners: readonly [
    FaceCornerTemplate,
    FaceCornerTemplate,
    FaceCornerTemplate,
    FaceCornerTemplate,
  ];
}

// 严格逆时针（CCW）向外绕序的六面模板，与 office-voxel-builder 保持一致
const BOX_FACE_TEMPLATES: readonly FaceTemplate[] = [
  {
    dir: 'py',
    normal: [0, 1, 0],
    corners: [
      { pos: [0, 1, 1], uv: [0, 0] },
      { pos: [1, 1, 1], uv: [1, 0] },
      { pos: [1, 1, 0], uv: [1, 1] },
      { pos: [0, 1, 0], uv: [0, 1] },
    ],
  },
  {
    dir: 'ny',
    normal: [0, -1, 0],
    corners: [
      { pos: [0, 0, 0], uv: [0, 0] },
      { pos: [1, 0, 0], uv: [1, 0] },
      { pos: [1, 0, 1], uv: [1, 1] },
      { pos: [0, 0, 1], uv: [0, 1] },
    ],
  },
  {
    dir: 'px',
    normal: [1, 0, 0],
    corners: [
      { pos: [1, 0, 1], uv: [0, 0] },
      { pos: [1, 0, 0], uv: [1, 0] },
      { pos: [1, 1, 0], uv: [1, 1] },
      { pos: [1, 1, 1], uv: [0, 1] },
    ],
  },
  {
    dir: 'nx',
    normal: [-1, 0, 0],
    corners: [
      { pos: [0, 0, 0], uv: [0, 0] },
      { pos: [0, 0, 1], uv: [1, 0] },
      { pos: [0, 1, 1], uv: [1, 1] },
      { pos: [0, 1, 0], uv: [0, 1] },
    ],
  },
  {
    dir: 'pz',
    normal: [0, 0, 1],
    corners: [
      { pos: [0, 0, 1], uv: [0, 0] },
      { pos: [1, 0, 1], uv: [1, 0] },
      { pos: [1, 1, 1], uv: [1, 1] },
      { pos: [0, 1, 1], uv: [0, 1] },
    ],
  },
  {
    dir: 'nz',
    normal: [0, 0, -1],
    corners: [
      { pos: [1, 0, 0], uv: [0, 0] },
      { pos: [0, 0, 0], uv: [1, 0] },
      { pos: [0, 1, 0], uv: [1, 1] },
      { pos: [1, 1, 0], uv: [0, 1] },
    ],
  },
];

// 64×64 Minecraft 皮肤图集无重叠像素区域定义
const HEAD_UV: BoxUvRegions = {
  py: { x: 8, y: 0, w: 8, h: 8 },
  ny: { x: 16, y: 0, w: 8, h: 8 },
  nx: { x: 0, y: 8, w: 8, h: 8 },
  pz: { x: 8, y: 8, w: 8, h: 8 },
  px: { x: 16, y: 8, w: 8, h: 8 },
  nz: { x: 24, y: 8, w: 8, h: 8 },
};

const TORSO_UV: BoxUvRegions = {
  py: { x: 8, y: 16, w: 8, h: 4 },
  ny: { x: 16, y: 16, w: 8, h: 4 },
  nx: { x: 4, y: 20, w: 4, h: 10 },
  pz: { x: 8, y: 20, w: 8, h: 10 },
  px: { x: 16, y: 20, w: 4, h: 10 },
  nz: { x: 20, y: 20, w: 8, h: 10 },
};

const RIGHT_ARM_UV: BoxUvRegions = {
  py: { x: 36, y: 16, w: 4, h: 4 },
  ny: { x: 40, y: 16, w: 4, h: 4 },
  nx: { x: 32, y: 20, w: 4, h: 10 },
  pz: { x: 36, y: 20, w: 4, h: 10 },
  px: { x: 40, y: 20, w: 4, h: 10 },
  nz: { x: 44, y: 20, w: 4, h: 10 },
};

const LEFT_ARM_UV: BoxUvRegions = {
  py: { x: 52, y: 16, w: 4, h: 4 },
  ny: { x: 56, y: 16, w: 4, h: 4 },
  nx: { x: 48, y: 20, w: 4, h: 10 },
  pz: { x: 52, y: 20, w: 4, h: 10 },
  px: { x: 56, y: 20, w: 4, h: 10 },
  nz: { x: 60, y: 20, w: 4, h: 10 },
};

const RIGHT_LEG_UV: BoxUvRegions = {
  py: { x: 4, y: 36, w: 4, h: 4 },
  ny: { x: 8, y: 36, w: 4, h: 4 },
  nx: { x: 0, y: 40, w: 4, h: 10 },
  pz: { x: 4, y: 40, w: 4, h: 10 },
  px: { x: 8, y: 40, w: 4, h: 10 },
  nz: { x: 12, y: 40, w: 4, h: 10 },
};

const LEFT_LEG_UV: BoxUvRegions = {
  py: { x: 20, y: 36, w: 4, h: 4 },
  ny: { x: 24, y: 36, w: 4, h: 4 },
  nx: { x: 16, y: 40, w: 4, h: 10 },
  pz: { x: 20, y: 40, w: 4, h: 10 },
  px: { x: 24, y: 40, w: 4, h: 10 },
  nz: { x: 28, y: 40, w: 4, h: 10 },
};

// 经典 Minecraft 角色肤色、发色、瞳色、裤装与鞋色表
const SKIN_TONES = [
  '#e8b892',
  '#d89d74',
  '#c48860',
  '#f0c7a8',
  '#a66e49',
  '#7a4e32',
] as const;

const HAIR_TONES = [
  '#2f2014',
  '#1e1d24',
  '#4c321e',
  '#6e4b2a',
  '#8f6a3c',
  '#353e4f',
] as const;

const EYE_TONES = [
  '#2e3c8a',
  '#2c6336',
  '#4d321c',
  '#1f5f7a',
  '#523378',
] as const;

const TROUSER_TONES = [
  '#3a4f8a',
  '#2c3442',
  '#5a5640',
  '#293d61',
] as const;

const SHOE_TONES = [
  '#2b3038',
  '#4a3423',
  '#222832',
  '#3d2b24',
] as const;

export interface OfficeCharacterRig {
  root: THREE.Group;
  torsoGroup: THREE.Group;
  headGroup: THREE.Group;
  leftArmGroup: THREE.Group;
  rightArmGroup: THREE.Group;
  legsGroup: THREE.Group;
  leftLegGroup: THREE.Group;
  rightLegGroup: THREE.Group;
  torsoMesh: THREE.Mesh;
  headMesh: THREE.Mesh;
  leftArmMesh: THREE.Mesh;
  rightArmMesh: THREE.Mesh;
  legsMesh: THREE.Mesh;
  leftLegMesh: THREE.Mesh;
  rightLegMesh: THREE.Mesh;
  handMugMesh: THREE.Mesh;
  visorMesh: THREE.Mesh;
  glassesMesh: THREE.Mesh;
  headsetMesh: THREE.Mesh;
  badgeLedMesh: THREE.Mesh;
  skinCanvas: HTMLCanvasElement;
  skinTexture: THREE.CanvasTexture;
  skinMaterial: THREE.MeshLambertMaterial;
  accessoryMaterial: THREE.MeshLambertMaterial;
  visorMaterial: THREE.MeshBasicMaterial;
  badgeLedMaterial: THREE.MeshLambertMaterial;
  phaseOffset: number;
  availability: SessionAvailability;
  posture: EmployeeVisualPersona['posture'];
  recentPulse: boolean;
  lastSkinSignature: string;
  lastAccentHex: string;
  lastElapsedSec: number;
  lastReducedMotion: boolean;
  activePose: CharacterPoseOutput | null;
}

function hashText(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** 确定性像素噪点，返回 [-1, 1] */
function pixelNoise(seed: number, x: number, y: number): number {
  let h = (seed * 374761393 + x * 668265263 + y * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = h ^ (h >>> 16);
  return ((h >>> 0) / 4294967295) * 2 - 1;
}

function clampByte(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}

/** 解析 #rrggbb / #rgb / rgb(...) 为 0..255 sRGB，非法值返回 null */
function tryParseSrgb(input: string): Rgb | null {
  const trimmed = (input || '').trim();
  const hex6 = /^#([0-9a-fA-F]{6})$/.exec(trimmed);
  if (hex6) {
    const num = parseInt(hex6[1], 16);
    return {
      r: (num >> 16) & 255,
      g: (num >> 8) & 255,
      b: num & 255,
    };
  }
  const hex3 = /^#([0-9a-fA-F]{3})$/.exec(trimmed);
  if (hex3) {
    const s = hex3[1];
    return {
      r: parseInt(s[0] + s[0], 16),
      g: parseInt(s[1] + s[1], 16),
      b: parseInt(s[2] + s[2], 16),
    };
  }
  const rgbMatch = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(trimmed);
  if (rgbMatch) {
    return {
      r: clampByte(Number(rgbMatch[1])),
      g: clampByte(Number(rgbMatch[2])),
      b: clampByte(Number(rgbMatch[3])),
    };
  }
  return null;
}

/** 安全解析颜色为 0..255 sRGB，避免非法色值产生 NaN 或控制台告警 */
function parseSrgb(input: string, fallbackHex: string): Rgb {
  return tryParseSrgb(input) ?? tryParseSrgb(fallbackHex) ?? { r: 56, g: 232, b: 255 };
}

function scaleRgb(rgb: Rgb, factor: number): Rgb {
  return {
    r: clampByte(rgb.r * factor),
    g: clampByte(rgb.g * factor),
    b: clampByte(rgb.b * factor),
  };
}

function lerpRgb(a: Rgb, b: Rgb, t: number): Rgb {
  return {
    r: clampByte(a.r + (b.r - a.r) * t),
    g: clampByte(a.g + (b.g - a.g) * t),
    b: clampByte(a.b + (b.b - a.b) * t),
  };
}

/**
 * 构建带 64×64 皮肤 UV 与逐面亮度烘焙的轴对齐体素盒几何。
 */
function createSkinnedVoxelBox(
  w: number,
  h: number,
  d: number,
  uvRegions: BoxUvRegions,
  pivotOffset: readonly [number, number, number],
  options?: SkinnedVoxelBoxOptions
): THREE.BufferGeometry {
  const minX = pivotOffset[0] - w * 0.5;
  const minY = pivotOffset[1] - h * 0.5;
  const minZ = pivotOffset[2] - d * 0.5;

  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];

  const shadeMap = options?.faceShadeOverride ?? FACE_SHADE;
  const hiddenFaces = options?.hiddenFaces;

  for (let f = 0; f < BOX_FACE_TEMPLATES.length; f += 1) {
    const tpl = BOX_FACE_TEMPLATES[f];
    if (hiddenFaces?.[tpl.dir]) continue;

    const rect = uvRegions[tpl.dir];
    const u0 = (rect.x + SKIN_UV_INSET) / SKIN_SIZE;
    const u1 = (rect.x + rect.w - SKIN_UV_INSET) / SKIN_SIZE;
    const v1 = 1 - (rect.y + SKIN_UV_INSET) / SKIN_SIZE;
    const v0 = 1 - (rect.y + rect.h - SKIN_UV_INSET) / SKIN_SIZE;
    const shade = shadeMap[tpl.dir];
    const baseIndex = positions.length / 3;

    for (let c = 0; c < 4; c += 1) {
      const corner = tpl.corners[c];
      positions.push(
        minX + corner.pos[0] * w,
        minY + corner.pos[1] * h,
        minZ + corner.pos[2] * d
      );
      normals.push(tpl.normal[0], tpl.normal[1], tpl.normal[2]);
      uvs.push(
        corner.uv[0] === 0 ? u0 : u1,
        corner.uv[1] === 0 ? v0 : v1
      );
      colors.push(shade, shade, shade);
    }

    indices.push(
      baseIndex,
      baseIndex + 1,
      baseIndex + 2,
      baseIndex,
      baseIndex + 2,
      baseIndex + 3
    );
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.setIndex(indices);
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

/**
 * 逐像素绘制 64×64 Minecraft Steve 皮肤贴图（全区域带 ±8% 像素亮度抖动）。
 */
function paintMinecraftSkin(
  canvas: HTMLCanvasElement,
  sessionKey: string,
  shirtHex: string,
  accentHex: string
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('无法创建 2D Canvas 上下文以生成 Minecraft 角色皮肤');
  }
  ctx.imageSmoothingEnabled = false;

  const hash = hashText(sessionKey);
  const seed = (hash & 0x7fffffff) || 1337;

  const skinRgb = parseSrgb(SKIN_TONES[hash % SKIN_TONES.length], '#e8b892');
  const skinNoseRgb = scaleRgb(skinRgb, 0.87);
  const hairRgb = parseSrgb(HAIR_TONES[(hash >>> 4) % HAIR_TONES.length], '#2f2014');
  const hairHighlightRgb = scaleRgb(hairRgb, 1.14);
  const eyeRgb = parseSrgb(EYE_TONES[(hash >>> 8) % EYE_TONES.length], '#2e3c8a');
  const scleraRgb: Rgb = { r: 244, g: 247, b: 252 };
  const browRgb = lerpRgb(skinRgb, hairRgb, 0.36);
  const mouthRgb = lerpRgb(scaleRgb(skinRgb, 0.62), hairRgb, 0.35);
  const beardRgb = lerpRgb(hairRgb, scaleRgb(skinRgb, 0.72), 0.28);

  const hairStyle = (hash >>> 12) % 4;
  const mouthStyle = (hash >>> 15) % 3;

  const shirtRgb = parseSrgb(shirtHex, '#38e8ff');
  const shirtDarkRgb = scaleRgb(shirtRgb, 0.78);
  const collarRgb: Rgb = { r: 236, g: 242, b: 248 };
  const tieRgb = lerpRgb(parseSrgb(accentHex, '#38e8ff'), shirtDarkRgb, 0.35);
  const beltRgb: Rgb = { r: 46, g: 38, b: 32 };
  const buckleRgb: Rgb = { r: 204, g: 210, b: 218 };
  const badgePlateRgb: Rgb = { r: 30, g: 38, b: 50 };
  const watchRgb: Rgb = { r: 232, g: 196, b: 78 };

  const trouserRgb = parseSrgb(TROUSER_TONES[(hash >>> 18) % TROUSER_TONES.length], '#3a4f8a');
  const trouserDarkRgb = scaleRgb(trouserRgb, 0.82);
  const shoeRgb = parseSrgb(SHOE_TONES[(hash >>> 21) % SHOE_TONES.length], '#2b3038');
  const shoeSoleRgb: Rgb = { r: 30, g: 34, b: 40 };
  const shoeLaceRgb: Rgb = { r: 218, g: 224, b: 232 };

  const imageData = ctx.createImageData(SKIN_SIZE, SKIN_SIZE);
  const data = imageData.data;

  const putPixel = (px: number, py: number, rgb: Rgb, jitter = 0.08): void => {
    if (px < 0 || px >= SKIN_SIZE || py < 0 || py >= SKIN_SIZE) return;
    const factor = 1 + pixelNoise(seed, px, py) * jitter;
    const idx = (py * SKIN_SIZE + px) * 4;
    data[idx] = clampByte(rgb.r * factor);
    data[idx + 1] = clampByte(rgb.g * factor);
    data[idx + 2] = clampByte(rgb.b * factor);
    data[idx + 3] = 255;
  };

  const fillRect = (
    rect: SkinUvRect,
    painter: (lx: number, ly: number) => { rgb: Rgb; jitter?: number }
  ): void => {
    for (let ly = 0; ly < rect.h; ly += 1) {
      for (let lx = 0; lx < rect.w; lx += 1) {
        const res = painter(lx, ly);
        putPixel(rect.x + lx, rect.y + ly, res.rgb, res.jitter ?? 0.08);
      }
    }
  };

  // === 1. 头部 8×8×8 ===
  // 顶面：头发（带确定性发丝亮暗纹理）
  fillRect(HEAD_UV.py, (lx, ly) => ({
    rgb: (lx + ly * 3) % 5 === 0 ? hairHighlightRgb : hairRgb,
  }));

  // 底面：下巴肤色
  fillRect(HEAD_UV.ny, () => ({ rgb: scaleRgb(skinRgb, 0.94) }));

  // 正面（+Z）：经典 Minecraft 像素脸（顶部 2 行刘海、鬓角、双像素眼、鼻梁、嘴/胡须）
  fillRect(HEAD_UV.pz, (lx, ly) => {
    // 顶 2 行头发刘海
    if (ly <= 1) {
      return { rgb: ly === 0 && (lx === 2 || lx === 5) ? hairHighlightRgb : hairRgb };
    }
    // 第 3 行：两侧鬓角与不同发型的斜刘海
    if (ly === 2) {
      const isSideburn = lx === 0 || lx === 7;
      const isFringe =
        (hairStyle === 1 && lx <= 3)
        || (hairStyle === 2 && (lx <= 1 || lx >= 6));
      if (isSideburn || isFringe) return { rgb: hairRgb };
      return { rgb: skinRgb };
    }
    // 第 4 行：眉弓与长发侧鬓
    if (ly === 3) {
      if (hairStyle === 2 && (lx === 0 || lx === 7)) return { rgb: hairRgb };
      if (lx === 1 || lx === 2 || lx === 5 || lx === 6) return { rgb: browRgb };
      return { rgb: skinRgb };
    }
    // 第 5 行：清晰 2×1 像素双眼（白眼白 + 彩色瞳孔）
    if (ly === 4) {
      if (lx === 1 || lx === 6) return { rgb: scleraRgb, jitter: 0.04 };
      if (lx === 2 || lx === 5) return { rgb: eyeRgb, jitter: 0.05 };
      if (hairStyle === 2 && (lx === 0 || lx === 7)) return { rgb: hairRgb };
      return { rgb: skinRgb };
    }
    // 第 6 行：中央 2 像素鼻梁
    if (ly === 5) {
      if (lx === 3 || lx === 4) return { rgb: skinNoseRgb };
      return { rgb: skinRgb };
    }
    // 第 7 行：嘴部 / 经典 Steve 络腮微笑
    if (ly === 6) {
      if (lx === 3 || lx === 4) return { rgb: mouthRgb, jitter: 0.06 };
      if (mouthStyle === 0 && (lx === 2 || lx === 5)) return { rgb: beardRgb };
      if (mouthStyle === 2 && (lx === 2 || lx === 5)) return { rgb: lerpRgb(skinRgb, mouthRgb, 0.55) };
      return { rgb: skinRgb };
    }
    // 第 8 行：下巴 / 经典下颌胡须
    if (mouthStyle === 0 && lx >= 2 && lx <= 5) {
      return { rgb: beardRgb };
    }
    return { rgb: skinRgb };
  });

  // 左右侧面（nx 靠右缘为前脸，px 靠左缘为前脸）
  const paintHeadSide = (rect: SkinUvRect, frontAtLeft: boolean): void => {
    fillRect(rect, (lx, ly) => {
      const distFromFront = frontAtLeft ? lx : 7 - lx;
      if (ly <= 1) return { rgb: hairRgb };
      if (hairStyle === 2) {
        // 长发包耳造型
        if (distFromFront >= 1 && ly <= 6) return { rgb: hairRgb };
        if (distFromFront === 0 && ly <= 4) return { rgb: hairRgb };
        return { rgb: skinRgb };
      }
      if (hairStyle === 3) {
        // 利落短寸渐变
        if (ly === 2 && distFromFront >= 1) return { rgb: hairRgb };
        if (ly === 3 && distFromFront >= 4) return { rgb: hairRgb };
        return { rgb: skinRgb };
      }
      // 经典 Steve 阶梯鬓角与后脑发线
      if (ly === 2) return { rgb: hairRgb };
      if (ly === 3 && (distFromFront === 0 || distFromFront >= 3)) return { rgb: hairRgb };
      if (ly === 4 && distFromFront >= 4) return { rgb: hairRgb };
      if (ly === 5 && distFromFront >= 5) return { rgb: hairRgb };
      return { rgb: skinRgb };
    });
  };
  paintHeadSide(HEAD_UV.nx, false);
  paintHeadSide(HEAD_UV.px, true);

  // 背面（-Z）：完整后脑头发 + 底部后颈肤色
  fillRect(HEAD_UV.nz, (lx, ly) => {
    const backHairRows = hairStyle === 2 ? 7 : hairStyle === 3 ? 4 : 6;
    if (ly < backHairRows) {
      return { rgb: ly === 1 && (lx === 2 || lx === 5) ? hairHighlightRgb : hairRgb };
    }
    return { rgb: skinRgb };
  });

  // === 2. 躯干 8×10×4 ===
  fillRect(TORSO_UV.py, (lx, ly) => {
    if (lx >= 2 && lx <= 5 && ly >= 1 && ly <= 2) {
      return { rgb: collarRgb };
    }
    return { rgb: shirtRgb };
  });
  fillRect(TORSO_UV.ny, () => ({ rgb: trouserDarkRgb }));

  // 胸前（+Z）：衬衫领口、领带/门襟、胸牌底板、腰带与皮带扣
  fillRect(TORSO_UV.pz, (lx, ly) => {
    if (ly === 9) {
      return { rgb: lx === 3 || lx === 4 ? buckleRgb : beltRgb };
    }
    if (ly === 0 && lx >= 2 && lx <= 5) {
      return { rgb: collarRgb };
    }
    if (ly === 1 && (lx === 3 || lx === 4)) {
      return { rgb: collarRgb };
    }
    // 胸口状态灯后方的 2×2 深色像素工牌底板
    if ((ly === 2 || ly === 3) && (lx === 5 || lx === 6)) {
      return { rgb: badgePlateRgb };
    }
    // 中央领带 / 门襟点缀
    if (ly >= 2 && ly <= 7 && (lx === 3 || lx === 4)) {
      return { rgb: ly % 2 === 0 ? tieRgb : lerpRgb(tieRgb, shirtDarkRgb, 0.35) };
    }
    if (lx === 0 || lx === 7 || ly === 8) {
      return { rgb: shirtDarkRgb };
    }
    return { rgb: shirtRgb };
  });

  // 后背（-Z）：简洁衬衫接缝与腰带
  fillRect(TORSO_UV.nz, (lx, ly) => {
    if (ly === 9) return { rgb: beltRgb };
    if (ly === 0 && lx >= 2 && lx <= 5) return { rgb: collarRgb };
    if (ly === 1 || lx === 0 || lx === 7 || ly === 8) return { rgb: shirtDarkRgb };
    return { rgb: shirtRgb };
  });

  // 躯干左右侧
  const paintTorsoSide = (rect: SkinUvRect): void => {
    fillRect(rect, (_lx, ly) => {
      if (ly === 9) return { rgb: beltRgb };
      if (ly === 8) return { rgb: shirtDarkRgb };
      return { rgb: shirtRgb };
    });
  };
  paintTorsoSide(TORSO_UV.nx);
  paintTorsoSide(TORSO_UV.px);

  // === 3. 左右双臂 4×10×4（上袖子 + 白袖口 + 下方肤色手掌） ===
  const paintArm = (uv: BoxUvRegions, hasWatch: boolean): void => {
    fillRect(uv.py, () => ({ rgb: shirtRgb }));
    // 拳头前端（ny）：肤色 + 指缝暗像素
    fillRect(uv.ny, (_lx, ly) => ({
      rgb: ly === 2 ? scaleRgb(skinRgb, 0.86) : skinRgb,
    }));

    const sideFaces: readonly VoxelFaceDir[] = ['pz', 'nz', 'px', 'nx'];
    for (let i = 0; i < sideFaces.length; i += 1) {
      const dir = sideFaces[i];
      fillRect(uv[dir], (lx, ly) => {
        if (ly <= 5) {
          return { rgb: ly === 5 ? shirtDarkRgb : shirtRgb };
        }
        if (ly === 6) {
          return { rgb: collarRgb };
        }
        // 左腕手表像素点缀
        if (hasWatch && ly === 7 && (dir === 'pz' || dir === 'px') && (lx === 1 || lx === 2)) {
          return { rgb: watchRgb };
        }
        return { rgb: ly === 9 ? scaleRgb(skinRgb, 0.92) : skinRgb };
      });
    }
  };
  paintArm(RIGHT_ARM_UV, false);
  paintArm(LEFT_ARM_UV, true);

  // === 4. 左右双腿 4×10×4（牛仔长裤 + 裤脚 + 方块鞋） ===
  const paintLeg = (uv: BoxUvRegions, outerDir: 'px' | 'nx'): void => {
    fillRect(uv.py, () => ({ rgb: trouserDarkRgb }));
    // 鞋底（ny）：深色鞋底与纹路
    fillRect(uv.ny, (lx, ly) => ({
      rgb: (lx === 1 || lx === 2) && (ly === 1 || ly === 2) ? shoeRgb : shoeSoleRgb,
    }));

    const sideFaces: readonly VoxelFaceDir[] = ['pz', 'nz', 'px', 'nx'];
    for (let i = 0; i < sideFaces.length; i += 1) {
      const dir = sideFaces[i];
      fillRect(uv[dir], (lx, ly) => {
        if (ly <= 6) {
          const isOuterSeam = dir === outerDir && (lx === 1 || lx === 2) && ly >= 2;
          const isPocket = dir === 'pz' && ly === 0 && (lx === 0 || lx === 3);
          return { rgb: isOuterSeam || isPocket ? trouserDarkRgb : trouserRgb };
        }
        if (ly === 7) {
          return { rgb: trouserDarkRgb };
        }
        if (ly === 8) {
          // 鞋面与正面鞋带像素高光
          if (dir === 'pz' && (lx === 1 || lx === 2)) {
            return { rgb: shoeLaceRgb };
          }
          return { rgb: shoeRgb };
        }
        // 底部鞋边
        return { rgb: shoeSoleRgb };
      });
    }
  };
  paintLeg(RIGHT_LEG_UV, 'nx');
  paintLeg(LEFT_LEG_UV, 'px');

  ctx.putImageData(imageData, 0, 0);
}

/** 构建发光护目镜几何（单次合批，严格轴对齐盒） */
function createVisorGeometry(accentHex: string): THREE.BufferGeometry {
  const frameHex = '#222936';
  const boxes: SolidColorBoxInput[] = [
    // 跨眼发光像素条（不叠加暗面，保持清晰自发光感）
    {
      minX: -0.25,
      minY: 0.1875,
      minZ: 0.25,
      maxX: 0.25,
      maxY: 0.25,
      maxZ: 0.28125,
      color: accentHex,
      shadeFaces: false,
    },
    // 上沿深色像素边框
    {
      minX: -0.28125,
      minY: 0.25,
      minZ: 0.25,
      maxX: 0.28125,
      maxY: 0.28125,
      maxZ: 0.28125,
      color: frameHex,
      shadeFaces: true,
    },
    // 右侧镜腿（-X）
    {
      minX: -0.28125,
      minY: 0.1875,
      minZ: -0.0625,
      maxX: -0.25,
      maxY: 0.25,
      maxZ: 0.28125,
      color: frameHex,
      shadeFaces: true,
    },
    // 左侧镜腿（+X）
    {
      minX: 0.25,
      minY: 0.1875,
      minZ: -0.0625,
      maxX: 0.28125,
      maxY: 0.25,
      maxZ: 0.28125,
      color: frameHex,
      shadeFaces: true,
    },
  ];
  return createSolidColorVoxelGeometry(boxes);
}

/** 构建方块像素眼镜几何（双镂空方框 + 鼻梁 + 双镜腿，露出双眼像素） */
function createGlassesGeometry(): THREE.BufferGeometry {
  const frameHex = '#202733';
  const boxes: SolidColorBoxInput[] = [
    // 右眼镜框四边（-X，精准框住 [-0.1875, -0.0625] × [0.1875, 0.25]）
    { minX: -0.21875, minY: 0.25, minZ: 0.25, maxX: -0.03125, maxY: 0.28125, maxZ: 0.28125, color: frameHex },
    { minX: -0.21875, minY: 0.15625, minZ: 0.25, maxX: -0.03125, maxY: 0.1875, maxZ: 0.28125, color: frameHex },
    { minX: -0.21875, minY: 0.1875, minZ: 0.25, maxX: -0.1875, maxY: 0.25, maxZ: 0.28125, color: frameHex },
    { minX: -0.0625, minY: 0.1875, minZ: 0.25, maxX: -0.03125, maxY: 0.25, maxZ: 0.28125, color: frameHex },
    // 左眼镜框四边（+X，精准框住 [+0.0625, +0.1875] × [0.1875, 0.25]）
    { minX: 0.03125, minY: 0.25, minZ: 0.25, maxX: 0.21875, maxY: 0.28125, maxZ: 0.28125, color: frameHex },
    { minX: 0.03125, minY: 0.15625, minZ: 0.25, maxX: 0.21875, maxY: 0.1875, maxZ: 0.28125, color: frameHex },
    { minX: 0.03125, minY: 0.1875, minZ: 0.25, maxX: 0.0625, maxY: 0.25, maxZ: 0.28125, color: frameHex },
    { minX: 0.1875, minY: 0.1875, minZ: 0.25, maxX: 0.21875, maxY: 0.25, maxZ: 0.28125, color: frameHex },
    // 鼻梁连接桥
    { minX: -0.03125, minY: 0.21875, minZ: 0.25, maxX: 0.03125, maxY: 0.25, maxZ: 0.28125, color: frameHex },
    // 两侧外角连接段
    { minX: -0.28125, minY: 0.21875, minZ: 0.25, maxX: -0.21875, maxY: 0.25, maxZ: 0.28125, color: frameHex },
    { minX: 0.21875, minY: 0.21875, minZ: 0.25, maxX: 0.28125, maxY: 0.25, maxZ: 0.28125, color: frameHex },
    // 左右镜腿
    { minX: -0.28125, minY: 0.21875, minZ: -0.0625, maxX: -0.25, maxY: 0.25, maxZ: 0.25, color: frameHex },
    { minX: 0.25, minY: 0.21875, minZ: -0.0625, maxX: 0.28125, maxY: 0.25, maxZ: 0.25, color: frameHex },
  ];
  return createSolidColorVoxelGeometry(boxes);
}

/** 构建方块头戴耳机 + L 形体素麦杆几何（单次合批） */
function createHeadsetGeometry(accentHex: string): THREE.BufferGeometry {
  const bandHex = '#262e3b';
  const cupHex = '#1b2029';
  const micArmHex = '#313a4a';
  const boxes: SolidColorBoxInput[] = [
    // 头顶横梁
    { minX: -0.3125, minY: 0.5, minZ: -0.0625, maxX: 0.3125, maxY: 0.5625, maxZ: 0.0625, color: bandHex },
    // 左右竖梁
    { minX: -0.3125, minY: 0.28125, minZ: -0.0625, maxX: -0.25, maxY: 0.5, maxZ: 0.0625, color: bandHex },
    { minX: 0.25, minY: 0.28125, minZ: -0.0625, maxX: 0.3125, maxY: 0.5, maxZ: 0.0625, color: bandHex },
    // 右方形耳罩 + 外侧亮点饰板
    { minX: -0.3125, minY: 0.125, minZ: -0.09375, maxX: -0.25, maxY: 0.3125, maxZ: 0.09375, color: cupHex },
    { minX: -0.34375, minY: 0.15625, minZ: -0.0625, maxX: -0.3125, maxY: 0.28125, maxZ: 0.0625, color: accentHex },
    // 左方形耳罩 + 外侧亮点饰板
    { minX: 0.25, minY: 0.125, minZ: -0.09375, maxX: 0.3125, maxY: 0.3125, maxZ: 0.09375, color: cupHex },
    { minX: 0.3125, minY: 0.15625, minZ: -0.0625, maxX: 0.34375, maxY: 0.28125, maxZ: 0.0625, color: accentHex },
    // L 形体素麦克风杆（前伸段 + 嘴前折入段 + 方块麦头）
    { minX: -0.3125, minY: 0.09375, minZ: 0.03125, maxX: -0.28125, maxY: 0.125, maxZ: 0.3125, color: micArmHex },
    { minX: -0.28125, minY: 0.09375, minZ: 0.28125, maxX: -0.09375, maxY: 0.125, maxZ: 0.3125, color: micArmHex },
    { minX: -0.09375, minY: 0.078125, minZ: 0.265625, maxX: -0.03125, maxY: 0.140625, maxZ: 0.328125, color: accentHex },
  ];
  return createSolidColorVoxelGeometry(boxes);
}

/** 构建手持方块咖啡杯几何（局部 +Z 朝上，匹配右臂前伸 -90° 时的竖直托杯姿态） */
function createHandCoffeeMugGeometry(): THREE.BufferGeometry {
  const boxes: SolidColorBoxInput[] = [
    // 白色陶瓷杯身（位于右拳掌心前方）
    {
      minX: -0.055,
      minY: -0.57,
      minZ: 0.0,
      maxX: 0.055,
      maxY: -0.46,
      maxZ: 0.125,
      color: '#f1f5f9',
      shadeFaces: true,
    },
    // 深棕咖啡液面顶盖
    {
      minX: -0.042,
      minY: -0.558,
      minZ: 0.115,
      maxX: 0.042,
      maxY: -0.472,
      maxZ: 0.132,
      color: '#4a2c18',
      shadeFaces: true,
    },
    // 外侧方块杯耳
    {
      minX: -0.09,
      minY: -0.535,
      minZ: 0.03,
      maxX: -0.055,
      maxY: -0.495,
      maxZ: 0.095,
      color: '#e2e8f0',
      shadeFaces: true,
    },
  ];
  return createSolidColorVoxelGeometry(boxes);
}

function tagCharacterTree(object: THREE.Object3D, sessionKey: string): void {
  object.traverse((child) => {
    child.userData.sessionKey = sessionKey;
    child.userData.hitKind = 'station';
    if (child instanceof THREE.Mesh) {
      child.castShadow = true;
      child.receiveShadow = true;
    }
  });
}

export function createOfficeCharacter(
  session: OfficeSessionItem,
  palette: OfficeScenePalette
): OfficeCharacterRig {
  const hash = hashText(session.sessionKey);
  const shirtHex = session.persona.avatarTone || palette.accentHex;
  const accentHex = session.persona.deskAccent || palette.accentHex;

  // 1. 生成 64×64 Minecraft 像素皮肤纹理（严格 NearestFilter + 无 mipmap + SRGBColorSpace）
  const skinCanvas = document.createElement('canvas');
  skinCanvas.width = SKIN_SIZE;
  skinCanvas.height = SKIN_SIZE;
  paintMinecraftSkin(skinCanvas, session.sessionKey, shirtHex, accentHex);

  const skinTexture = new THREE.CanvasTexture(skinCanvas);
  skinTexture.magFilter = THREE.NearestFilter;
  skinTexture.minFilter = THREE.NearestFilter;
  skinTexture.generateMipmaps = false;
  skinTexture.colorSpace = THREE.SRGBColorSpace;
  skinTexture.wrapS = THREE.ClampToEdgeWrapping;
  skinTexture.wrapT = THREE.ClampToEdgeWrapping;
  skinTexture.needsUpdate = true;

  // 2. 共享哑光体素材质（头、躯干、双臂、双腿共用 1 份材质与 1 张贴图）
  const skinMaterial = new THREE.MeshLambertMaterial({
    map: skinTexture,
    vertexColors: true,
  });
  const accessoryMaterial = new THREE.MeshLambertMaterial({
    vertexColors: true,
  });
  const visorMaterial = new THREE.MeshBasicMaterial({
    vertexColors: true,
  });
  const badgeLedMaterial = new THREE.MeshLambertMaterial({
    color: palette.successHex,
    emissive: palette.successHex,
    emissiveIntensity: 0.9,
  });

  // 3. 角色层级与坐姿关节（原点位于椅面中心地面，站立总高 1.75）
  const root = new THREE.Group();

  // 躯干组：枢轴位于椅面顶 y = 0.375，躯干覆盖 y = 0.375..1.00
  const torsoGroup = new THREE.Group();
  torsoGroup.position.set(0, 0.375, 0);
  root.add(torsoGroup);

  const torsoGeo = createSkinnedVoxelBox(0.5, 0.625, 0.25, TORSO_UV, [0, 0.3125, 0]);
  const torsoMesh = new THREE.Mesh(torsoGeo, skinMaterial);
  torsoGroup.add(torsoMesh);

  // 胸口状态指示灯方块（0.0625 × 0.0625 × 0.03125）
  const badgeLedGeo = createSolidColorVoxelGeometry([
    {
      minX: -0.03125,
      minY: -0.03125,
      minZ: -0.015625,
      maxX: 0.03125,
      maxY: 0.03125,
      maxZ: 0.015625,
      shadeFaces: false,
    },
  ]);
  const badgeLedMesh = new THREE.Mesh(badgeLedGeo, badgeLedMaterial);
  badgeLedMesh.position.set(0.125, 0.4375, 0.140625);
  torsoGroup.add(badgeLedMesh);

  // 头部组：枢轴位于颈部 (0, 0.625, 0)（世界 y = 1.00），头方块覆盖 y = 1.00..1.50
  const headGroup = new THREE.Group();
  headGroup.position.set(0, 0.625, 0);
  torsoGroup.add(headGroup);

  const headGeo = createSkinnedVoxelBox(0.5, 0.5, 0.5, HEAD_UV, [0, 0.25, 0]);
  const headMesh = new THREE.Mesh(headGeo, skinMaterial);
  headGroup.add(headMesh);

  // 三种体素头饰（每种合批为 1 个 Mesh，运行期仅显示 1 个）
  const visorMesh = new THREE.Mesh(createVisorGeometry(accentHex), visorMaterial);
  const glassesMesh = new THREE.Mesh(createGlassesGeometry(), accessoryMaterial);
  const headsetMesh = new THREE.Mesh(createHeadsetGeometry(accentHex), accessoryMaterial);
  headGroup.add(visorMesh);
  headGroup.add(glassesMesh);
  headGroup.add(headsetMesh);

  // 左右双臂：枢轴位于肩部 (±0.375, 0.50, 0)（世界 y = 0.875），各 0.25 × 0.625 × 0.25
  const leftArmGroup = new THREE.Group();
  leftArmGroup.position.set(0.375, 0.5, 0);
  torsoGroup.add(leftArmGroup);

  const leftArmGeo = createSkinnedVoxelBox(0.25, 0.625, 0.25, LEFT_ARM_UV, [0, -0.1875, 0], {
    faceShadeOverride: SEATED_FORWARD_FACE_SHADE,
  });
  const leftArmMesh = new THREE.Mesh(leftArmGeo, skinMaterial);
  leftArmGroup.add(leftArmMesh);

  const rightArmGroup = new THREE.Group();
  rightArmGroup.position.set(-0.375, 0.5, 0);
  torsoGroup.add(rightArmGroup);

  const rightArmGeo = createSkinnedVoxelBox(0.25, 0.625, 0.25, RIGHT_ARM_UV, [0, -0.1875, 0], {
    faceShadeOverride: SEATED_FORWARD_FACE_SHADE,
  });
  const rightArmMesh = new THREE.Mesh(rightArmGeo, skinMaterial);
  rightArmGroup.add(rightArmMesh);

  // 右手手持方块咖啡杯（默认隐藏，接咖啡/喝咖啡/端杯回座期间显示，复用 accessoryMaterial 零新增材质）
  const handMugMesh = new THREE.Mesh(createHandCoffeeMugGeometry(), accessoryMaterial);
  handMugMesh.name = 'character-hand-coffee-mug';
  handMugMesh.visible = false;
  rightArmGroup.add(handMugMesh);

  // 左右独立腿部关节（支持坐姿 -90° 前伸、0.4s 坐站过渡、走路 ±30° 交替摆腿，复用共享皮肤材质）：
  // 站立时 legsGroup 位于 y = 0.625，腿盒覆盖 [-0.625, 0] 使鞋底精准贴地 y = 0；
  // 坐姿时 legsGroup 位于 (0, 0.50, -0.0625) 且左右腿旋转 -Math.PI/2，覆盖 y ∈ [0.375, 0.625]，与椅面/桌面零穿模。
  const legsGroup = new THREE.Group();
  legsGroup.position.set(0, 0.5, -0.0625);
  root.add(legsGroup);

  const leftLegGroup = new THREE.Group();
  leftLegGroup.position.set(0.125, 0, 0);
  leftLegGroup.rotation.set(-Math.PI / 2, 0, 0);
  legsGroup.add(leftLegGroup);

  const leftLegGeo = createSkinnedVoxelBox(0.25, 0.625, 0.25, LEFT_LEG_UV, [0, -0.3125, 0]);
  const leftLegMesh = new THREE.Mesh(leftLegGeo, skinMaterial);
  leftLegGroup.add(leftLegMesh);

  const rightLegGroup = new THREE.Group();
  rightLegGroup.position.set(-0.125, 0, 0);
  rightLegGroup.rotation.set(-Math.PI / 2, 0, 0);
  legsGroup.add(rightLegGroup);

  const rightLegGeo = createSkinnedVoxelBox(0.25, 0.625, 0.25, RIGHT_LEG_UV, [0, -0.3125, 0]);
  const rightLegMesh = new THREE.Mesh(rightLegGeo, skinMaterial);
  rightLegGroup.add(rightLegMesh);

  // 统一打标命中元数据与阴影开关
  tagCharacterTree(root, session.sessionKey);

  const rig: OfficeCharacterRig = {
    root,
    torsoGroup,
    headGroup,
    leftArmGroup,
    rightArmGroup,
    legsGroup,
    leftLegGroup,
    rightLegGroup,
    torsoMesh,
    headMesh,
    leftArmMesh,
    rightArmMesh,
    legsMesh: leftLegMesh,
    leftLegMesh,
    rightLegMesh,
    handMugMesh,
    visorMesh,
    glassesMesh,
    headsetMesh,
    badgeLedMesh,
    skinCanvas,
    skinTexture,
    skinMaterial,
    accessoryMaterial,
    visorMaterial,
    badgeLedMaterial,
    phaseOffset: (hash % 628) / 100,
    availability: session.availability,
    posture: session.persona.posture,
    recentPulse: session.activity.recentPulse,
    lastSkinSignature: `${session.sessionKey}|${shirtHex}|${accentHex}`,
    lastAccentHex: accentHex,
    lastElapsedSec: 0,
    lastReducedMotion: true,
    activePose: null,
  };

  updateOfficeCharacter(rig, session, palette);
  return rig;
}

export function updateOfficeCharacter(
  rig: OfficeCharacterRig,
  session: OfficeSessionItem,
  palette: OfficeScenePalette
): void {
  rig.availability = session.availability;
  rig.posture = session.persona.posture;
  rig.recentPulse = session.activity.recentPulse;

  // 若衬衫或主题强调色变化，原地重绘 64×64 像素皮肤并更新头饰强调色
  const shirtHex = session.persona.avatarTone || palette.accentHex;
  const accentHex = session.persona.deskAccent || palette.accentHex;
  const skinSignature = `${session.sessionKey}|${shirtHex}|${accentHex}`;
  if (rig.lastSkinSignature !== skinSignature) {
    rig.lastSkinSignature = skinSignature;
    paintMinecraftSkin(rig.skinCanvas, session.sessionKey, shirtHex, accentHex);
    rig.skinTexture.needsUpdate = true;
  }
  if (rig.lastAccentHex !== accentHex) {
    rig.lastAccentHex = accentHex;
    rig.visorMesh.geometry.dispose();
    rig.visorMesh.geometry = createVisorGeometry(accentHex);
    rig.headsetMesh.geometry.dispose();
    rig.headsetMesh.geometry = createHeadsetGeometry(accentHex);
  }

  // 头饰三选一，始终仅有 1 个可见 Draw Call
  const visorStyle = session.persona.visorStyle;
  rig.visorMesh.visible = visorStyle === 'visor';
  rig.glassesMesh.visible = visorStyle === 'glasses';
  rig.headsetMesh.visible = visorStyle === 'headset';

  // 根据会话可用状态同步皮肤色调与胸口 LED 状态灯
  if (session.availability === 'exited') {
    rig.skinMaterial.color.set('#9aa5b4');
    rig.accessoryMaterial.color.set('#9aa5b4');
    rig.visorMaterial.color.set('#738091');
    rig.badgeLedMaterial.color.set('#64748b');
    rig.badgeLedMaterial.emissive.set('#334155');
    rig.badgeLedMaterial.emissiveIntensity = 0.25;
  } else if (session.availability === 'unavailable') {
    rig.skinMaterial.color.set('#ffe6bd');
    rig.accessoryMaterial.color.set('#f2dcba');
    rig.visorMaterial.color.set('#d9c298');
    rig.badgeLedMaterial.color.set(palette.warningHex);
    rig.badgeLedMaterial.emissive.set(palette.warningHex);
    rig.badgeLedMaterial.emissiveIntensity = 0.95;
  } else if (session.availability === 'directory-only') {
    rig.skinMaterial.color.set('#ffffff');
    rig.accessoryMaterial.color.set('#ffffff');
    rig.visorMaterial.color.set('#ffffff');
    rig.badgeLedMaterial.color.set(palette.accentHex);
    rig.badgeLedMaterial.emissive.set(palette.accentHex);
    rig.badgeLedMaterial.emissiveIntensity = 1.05;
  } else {
    rig.skinMaterial.color.set('#ffffff');
    rig.accessoryMaterial.color.set('#ffffff');
    rig.visorMaterial.color.set('#ffffff');
    rig.badgeLedMaterial.color.set(palette.successHex);
    rig.badgeLedMaterial.emissive.set(palette.successHex);
    rig.badgeLedMaterial.emissiveIntensity = session.activity.recentPulse ? 1.45 : 1.0;
  }

  // 若角色正在走动或执行行为动画，保持当前姿态不被悬停/选中重同步打断
  animateOfficeCharacter(rig, rig.lastElapsedSec, rig.lastReducedMotion, rig.activePose);
}

const WALK_LEG_SWING_RAD = THREE.MathUtils.degToRad(30);
const WALK_ARM_SWING_RAD = THREE.MathUtils.degToRad(22);
const WALK_BODY_BOB = 0.02;
const SEATED_TORSO_Y = 0.375;
const STANDING_TORSO_Y = 0.625;
const SEATED_LEGS_Y = 0.5;
const SEATED_LEGS_Z = -0.0625;
const STANDING_LEGS_Y = 0.625;

export function animateOfficeCharacter(
  rig: OfficeCharacterRig,
  elapsedSec: number,
  reducedMotion: boolean,
  pose?: CharacterPoseOutput | null
): void {
  rig.lastElapsedSec = elapsedSec;
  rig.lastReducedMotion = reducedMotion;
  rig.activePose = pose ?? null;

  const t = elapsedSec + rig.phaseOffset;

  // 非坐姿行为动画（仅在非 reducedMotion 且存在活动行为时生效，全程零临时对象分配）
  if (!reducedMotion && pose && pose.phase !== 'seated') {
    const stand = pose.standBlend;
    rig.handMugMesh.visible = pose.holdingCoffee;

    if (pose.phase === 'standing_up' || pose.phase === 'sitting_down') {
      // 坐 ⇄ 站 约 0.4s 平滑过渡（腿部折叠/展开、躯干升降、双臂由敲键垂落）
      const torsoY = SEATED_TORSO_Y + (STANDING_TORSO_Y - SEATED_TORSO_Y) * stand;
      const legsY = SEATED_LEGS_Y + (STANDING_LEGS_Y - SEATED_LEGS_Y) * stand;
      const legsZ = SEATED_LEGS_Z * (1 - stand);
      const legPitch = -Math.PI * 0.5 * (1 - stand);
      const leftArmPitch = -Math.PI * 0.5 * (1 - stand);
      const rightArmPitch = pose.holdingCoffee
        ? -1.25 - 0.25 * (1 - stand)
        : leftArmPitch;

      rig.torsoGroup.position.set(0, torsoY, 0);
      rig.torsoGroup.rotation.set((1 - stand) * 0.08, 0, 0);
      rig.headGroup.rotation.set((1 - stand) * 0.06, 0, 0);
      rig.legsGroup.position.set(0, legsY, legsZ);
      rig.legsGroup.rotation.set(0, 0, 0);
      rig.leftLegGroup.rotation.set(legPitch, 0, 0);
      rig.rightLegGroup.rotation.set(legPitch, 0, 0);
      rig.leftArmGroup.rotation.set(leftArmPitch, 0, 0);
      rig.rightArmGroup.rotation.set(rightArmPitch, 0, pose.holdingCoffee ? 0.1 : 0);
      return;
    }

    if (pose.phase === 'brewing_coffee') {
      // 面向咖啡机：右臂前伸取杯，到达后半段杯方块出现在手上并略微收回
      const p = pose.actionProgress;
      let reach = 0;
      if (p < 0.3) {
        reach = p / 0.3;
      } else if (p < 0.72) {
        reach = 1;
      } else {
        reach = 1 - ((p - 0.72) / 0.28) * 0.22;
      }
      const rightArmX = -1.48 * reach;
      const rightArmZ = pose.holdingCoffee ? 0.12 * Math.min(1, (p - 0.5) * 3) : 0;
      const headPitch = p < 0.75 ? 0.12 * reach : 0.12 * (1 - (p - 0.75) / 0.25);

      rig.torsoGroup.position.set(0, STANDING_TORSO_Y, 0);
      rig.torsoGroup.rotation.set(0.03 * reach, 0, 0);
      rig.headGroup.rotation.set(headPitch, 0, 0);
      rig.legsGroup.position.set(0, STANDING_LEGS_Y, 0);
      rig.legsGroup.rotation.set(0, 0, 0);
      rig.leftLegGroup.rotation.set(0, 0, 0);
      rig.rightLegGroup.rotation.set(0, 0, 0);
      rig.leftArmGroup.rotation.set(-0.08 + Math.sin(t * 1.8) * 0.02, 0, 0);
      rig.rightArmGroup.rotation.set(rightArmX, 0, rightArmZ);
      return;
    }

    if (pose.phase === 'drinking_coffee') {
      // 举杯喝两口：右臂两次举向嘴边、内收对准口部，头部轻微上仰
      const sipSlot = (pose.actionProgress * 2) % 1;
      const sip = sipSlot > 0.1 && sipSlot < 0.9
        ? Math.sin(((sipSlot - 0.1) / 0.8) * Math.PI)
        : 0;

      rig.torsoGroup.position.set(0, STANDING_TORSO_Y, 0);
      rig.torsoGroup.rotation.set(-0.04 * sip, 0, 0);
      rig.headGroup.rotation.set(-0.22 * sip, 0, 0);
      rig.legsGroup.position.set(0, STANDING_LEGS_Y, 0);
      rig.legsGroup.rotation.set(0, 0, 0);
      rig.leftLegGroup.rotation.set(0, 0, 0);
      rig.rightLegGroup.rotation.set(0, 0, 0);
      rig.leftArmGroup.rotation.set(-0.06, 0, 0);
      rig.rightArmGroup.rotation.set(-1.18 - 0.9 * sip, 0, 0.14 + 0.3 * sip);
      return;
    }

    if (pose.phase === 'stroll_pause') {
      // 散步路点停顿观望：自然呼吸 + 左右缓慢环顾
      const breath = Math.sin(t * 2.0) * 0.015;
      const lookYaw = Math.sin(pose.actionProgress * Math.PI * 2 + rig.phaseOffset) * 0.28;

      rig.torsoGroup.position.set(0, STANDING_TORSO_Y, 0);
      rig.torsoGroup.rotation.set(breath, lookYaw * 0.16, 0);
      rig.headGroup.rotation.set(0.03, lookYaw, 0);
      rig.legsGroup.position.set(0, STANDING_LEGS_Y, 0);
      rig.legsGroup.rotation.set(0, 0, 0);
      rig.leftLegGroup.rotation.set(0, 0, 0);
      rig.rightLegGroup.rotation.set(0, 0, 0);
      rig.leftArmGroup.rotation.set(Math.sin(t * 1.6) * 0.03, 0, 0);
      rig.rightArmGroup.rotation.set(-Math.sin(t * 1.6) * 0.03, 0, 0);
      return;
    }

    // 走路循环：双腿前后摆 ±30°、双臂反向摆 ±22°、身体上下微颠 0.02
    const wb = pose.walkBlend;
    const strideSin = Math.sin(pose.walkPhase);
    const legSwing = strideSin * WALK_LEG_SWING_RAD * wb;
    const armSwing = strideSin * WALK_ARM_SWING_RAD * wb;
    const bob = Math.abs(strideSin) * WALK_BODY_BOB * wb;

    rig.torsoGroup.position.set(0, STANDING_TORSO_Y + bob, 0);
    rig.torsoGroup.rotation.set(0.03 * wb, 0, 0);
    rig.headGroup.rotation.set(0.02 * wb, Math.sin(t * 1.1) * 0.06, 0);
    rig.legsGroup.position.set(0, STANDING_LEGS_Y, 0);
    rig.legsGroup.rotation.set(0, 0, 0);
    rig.leftLegGroup.rotation.set(legSwing, 0, 0);
    rig.rightLegGroup.rotation.set(-legSwing, 0, 0);
    rig.leftArmGroup.rotation.set(-armSwing, 0, 0);
    if (pose.holdingCoffee) {
      // 端着咖啡杯慢走回座：右臂前平端稳杯子，随步态小幅柔和起伏
      rig.rightArmGroup.rotation.set(-1.24 + strideSin * 0.05 * wb, 0, 0.1);
    } else {
      rig.rightArmGroup.rotation.set(armSwing, 0, 0);
    }
    return;
  }

  // 坐姿基准：躯干落于椅面 y = 0.375，双腿精确 -90° 前伸且不持杯
  rig.handMugMesh.visible = false;
  rig.torsoGroup.position.set(0, SEATED_TORSO_Y, 0);
  rig.legsGroup.position.set(0, SEATED_LEGS_Y, SEATED_LEGS_Z);
  rig.legsGroup.rotation.set(0, 0, 0);
  rig.leftLegGroup.rotation.set(-Math.PI / 2, 0, 0);
  rig.rightLegGroup.rotation.set(-Math.PI / 2, 0, 0);

  if (rig.availability === 'exited') {
    // 退出状态：微微低头、双手静置桌面边缘上方（严格高于桌面 y = 0.746，零穿模）
    rig.torsoGroup.rotation.set(0.06, 0, 0);
    rig.headGroup.rotation.set(0.28, 0, 0);
    rig.leftArmGroup.rotation.set(-1.64, 0, 0);
    rig.rightArmGroup.rotation.set(-1.64, 0, 0);
    return;
  }

  if (rig.availability === 'unavailable') {
    // 不可用/保留标识状态：微低头待机
    rig.torsoGroup.rotation.set(0, 0, 0);
    rig.headGroup.rotation.set(0.1, 0, 0);
    rig.leftArmGroup.rotation.set(-Math.PI / 2, 0, 0);
    rig.rightArmGroup.rotation.set(-Math.PI / 2, 0, 0);
    return;
  }

  if (reducedMotion) {
    // 减弱动态模式：保持坐姿不位移
    rig.torsoGroup.rotation.set(0, 0, 0);
    rig.headGroup.rotation.set(0, 0, 0);
    rig.leftArmGroup.rotation.set(-Math.PI / 2, 0, 0);
    rig.rightArmGroup.rotation.set(-Math.PI / 2, 0, 0);
    return;
  }

  const breath = Math.sin(t * 2.0) * 0.015;
  const pulseNod = rig.recentPulse ? Math.sin(t * 6.4) * 0.035 : 0;

  if (rig.posture === 'typing') {
    const isInteractive = rig.availability === 'interactive';
    const speed = isInteractive ? 9.5 : 6.5;
    const amp = isInteractive ? 0.055 : 0.04;
    // 以 -1.67 rad 为基准上下交替敲击键盘，叠加躯干前倾后最低点仍高于桌面 y = 0.746（零穿模）
    const leftArmX = -1.67 + Math.sin(t * speed) * amp;
    const rightArmX = -1.67 + Math.sin(t * speed + Math.PI) * amp;
    const headYaw = Math.sin(t * 1.35) * 0.07;
    const headPitch = 0.04 + Math.sin(t * 2.7) * 0.025 + pulseNod;

    rig.torsoGroup.rotation.set(0.03 + breath, headYaw * 0.18, 0);
    rig.headGroup.rotation.set(headPitch, headYaw, 0);
    rig.leftArmGroup.rotation.set(leftArmX, 0, 0);
    rig.rightArmGroup.rotation.set(rightArmX, 0, 0);
  } else if (rig.posture === 'reading') {
    const headNod = Math.sin(t * 2.2) * 0.04 + pulseNod;
    const headYaw = Math.sin(t * 0.85) * 0.08;

    rig.torsoGroup.rotation.set(-0.02 + breath, 0, 0);
    rig.headGroup.rotation.set(-0.02 + headNod, headYaw, 0);
    rig.leftArmGroup.rotation.set(-1.6 + Math.sin(t * 1.8) * 0.02, 0, 0);
    rig.rightArmGroup.rotation.set(-1.62 + Math.sin(t * 2.4 + 1.2) * 0.03, 0, 0);
  } else {
    // monitoring：平缓扫视屏幕与柔和手部起伏
    const glance = Math.sin(t * 0.95) * 0.09;

    rig.torsoGroup.rotation.set(0.01 + breath, glance * 0.12, 0);
    rig.headGroup.rotation.set(0.01 + pulseNod, glance, 0);
    rig.leftArmGroup.rotation.set(-1.62 + Math.sin(t * 2.0) * 0.018, 0, 0);
    rig.rightArmGroup.rotation.set(-1.62 + Math.sin(t * 2.0 + 1.8) * 0.018, 0, 0);
  }

  if (rig.recentPulse && rig.availability === 'interactive') {
    rig.badgeLedMaterial.emissiveIntensity = 1.0 + Math.abs(Math.sin(t * 5.0)) * 0.7;
  }
}

export function disposeOfficeCharacter(rig: OfficeCharacterRig): void {
  const geometries = new Set<THREE.BufferGeometry>([
    rig.torsoMesh.geometry,
    rig.headMesh.geometry,
    rig.leftArmMesh.geometry,
    rig.rightArmMesh.geometry,
    rig.leftLegMesh.geometry,
    rig.rightLegMesh.geometry,
    rig.handMugMesh.geometry,
    rig.visorMesh.geometry,
    rig.glassesMesh.geometry,
    rig.headsetMesh.geometry,
    rig.badgeLedMesh.geometry,
  ]);
  for (const geo of geometries) {
    geo.dispose();
  }

  rig.skinMaterial.dispose();
  rig.accessoryMaterial.dispose();
  rig.visorMaterial.dispose();
  rig.badgeLedMaterial.dispose();
  rig.skinTexture.dispose();
}
