import * as THREE from 'three';
import type {
  EmployeeVisualPersona,
  OfficeSessionItem,
  SessionAvailability,
} from './session-office-types';
import type { OfficeScenePalette } from './office-scene-types';
import { getSharedVoxelMaterialSet } from './office-voxel-atlas';
import {
  createSolidColorVoxelGeometry,
  FACE_SHADE,
  mergeVoxelGeometries,
  type SolidColorBoxInput,
  type VoxelFaceDir,
} from './office-voxel-builder';
import type { CharacterPoseOutput } from './office-voxel-behaviour';

/**
 * Minecraft Steve 高精度体素角色模块：
 * 1. 严格轴对齐方块比例（站立总高 1.75），并在头部/躯干合并经典 Minecraft 第二层立体皮肤外层
 *    （立体发冠/刘海层次与夹克领口/袖口浮雕，零额外 Draw Call）。
 * 2. 64×64 程序化像素皮肤贴图（NearestFilter、无 mipmap、SRGBColorSpace、±8% 像素质感）。
 * 3. PBR MeshStandardMaterial 接入场景日光、轮廓补光与夜间暖色灯笼，与体素世界完美融合。
 * 4. 脚底/椅底内置共享接触阴影面片（随站起/走动动态锚定，零每帧对象分配）。
 */

const SKIN_SIZE = 64;
const SKIN_UV_INSET = 0.02;

/** 坐姿旋转 -90° 朝向 +Z 后的世界朝向面亮度映射 */
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

// 64×64 Minecraft 皮肤图集无重叠像素区域
const HEAD_UV: BoxUvRegions = {
  py: { x: 8, y: 0, w: 8, h: 8 },
  ny: { x: 16, y: 0, w: 8, h: 8 },
  nx: { x: 0, y: 8, w: 8, h: 8 },
  pz: { x: 8, y: 8, w: 8, h: 8 },
  px: { x: 16, y: 8, w: 8, h: 8 },
  nz: { x: 24, y: 8, w: 8, h: 8 },
};

// 立体发冠第二层区域（复用头顶头发纯色带，零额外贴图开销）
const HAIR_CROWN_UV: BoxUvRegions = {
  py: { x: 8, y: 0, w: 8, h: 8 },
  ny: { x: 8, y: 0, w: 8, h: 8 },
  nx: { x: 0, y: 8, w: 8, h: 2 },
  pz: { x: 8, y: 8, w: 8, h: 2 },
  px: { x: 16, y: 8, w: 8, h: 2 },
  nz: { x: 24, y: 8, w: 8, h: 2 },
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
  shadowMesh: THREE.Mesh;
  visorMesh: THREE.Mesh;
  glassesMesh: THREE.Mesh;
  headsetMesh: THREE.Mesh;
  badgeLedMesh: THREE.Mesh;
  skinCanvas: HTMLCanvasElement;
  skinTexture: THREE.CanvasTexture;
  skinMaterial: THREE.MeshStandardMaterial;
  accessoryMaterial: THREE.MeshStandardMaterial;
  visorMaterial: THREE.MeshBasicMaterial;
  badgeLedMaterial: THREE.MeshStandardMaterial;
  phaseOffset: number;
  availability: SessionAvailability;
  posture: EmployeeVisualPersona['posture'];
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

function pixelNoise(seed: number, x: number, y: number): number {
  let h = (seed * 374761393 + x * 668265263 + y * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = h ^ (h >>> 16);
  return ((h >>> 0) / 4294967295) * 2 - 1;
}

function clampByte(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}

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

/** 合并头主体与经典 Minecraft 第二层立体发冠浮雕（零额外 Draw Call） */
function createLayeredHeadGeometry(): THREE.BufferGeometry {
  const baseHead = createSkinnedVoxelBox(0.5, 0.5, 0.5, HEAD_UV, [0, 0.25, 0]);
  // 第二层头发外廓：覆盖顶部 2 像素高（y: 0.375..0.522），外扩 0.022 呈现立体刘海/发冠感
  const hairCrown = createSkinnedVoxelBox(0.544, 0.145, 0.544, HAIR_CROWN_UV, [0, 0.452, 0], {
    hiddenFaces: { ny: true },
  });
  const merged = mergeVoxelGeometries([baseHead, hairCrown]);
  baseHead.dispose();
  hairCrown.dispose();
  return merged;
}

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
  const hairHighlightRgb = scaleRgb(hairRgb, 1.16);
  const eyeRgb = parseSrgb(EYE_TONES[(hash >>> 8) % EYE_TONES.length], '#2e3c8a');
  const scleraRgb: Rgb = { r: 246, g: 249, b: 254 };
  const browRgb = lerpRgb(skinRgb, hairRgb, 0.38);
  const mouthRgb = lerpRgb(scaleRgb(skinRgb, 0.62), hairRgb, 0.35);
  const beardRgb = lerpRgb(hairRgb, scaleRgb(skinRgb, 0.72), 0.28);

  const hairStyle = (hash >>> 12) % 4;
  const mouthStyle = (hash >>> 15) % 3;

  const shirtRgb = parseSrgb(shirtHex, '#38e8ff');
  const shirtDarkRgb = scaleRgb(shirtRgb, 0.78);
  const collarRgb: Rgb = { r: 238, g: 244, b: 250 };
  const tieRgb = lerpRgb(parseSrgb(accentHex, '#38e8ff'), shirtDarkRgb, 0.32);
  const beltRgb: Rgb = { r: 44, g: 36, b: 30 };
  const buckleRgb: Rgb = { r: 210, g: 216, b: 224 };
  const badgePlateRgb: Rgb = { r: 28, g: 36, b: 48 };
  const watchRgb: Rgb = { r: 235, g: 198, b: 82 };

  const trouserRgb = parseSrgb(TROUSER_TONES[(hash >>> 18) % TROUSER_TONES.length], '#3a4f8a');
  const trouserDarkRgb = scaleRgb(trouserRgb, 0.82);
  const shoeRgb = parseSrgb(SHOE_TONES[(hash >>> 21) % SHOE_TONES.length], '#2b3038');
  const shoeSoleRgb: Rgb = { r: 28, g: 32, b: 38 };
  const shoeLaceRgb: Rgb = { r: 222, g: 228, b: 236 };

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
  fillRect(HEAD_UV.py, (lx, ly) => ({
    rgb: (lx + ly * 3) % 5 === 0 ? hairHighlightRgb : hairRgb,
  }));
  fillRect(HEAD_UV.ny, () => ({ rgb: scaleRgb(skinRgb, 0.94) }));

  fillRect(HEAD_UV.pz, (lx, ly) => {
    if (ly <= 1) {
      return { rgb: ly === 0 && (lx === 2 || lx === 5) ? hairHighlightRgb : hairRgb };
    }
    if (ly === 2) {
      const isSideburn = lx === 0 || lx === 7;
      const isFringe =
        (hairStyle === 1 && lx <= 3)
        || (hairStyle === 2 && (lx <= 1 || lx >= 6));
      if (isSideburn || isFringe) return { rgb: hairRgb };
      return { rgb: skinRgb };
    }
    if (ly === 3) {
      if (hairStyle === 2 && (lx === 0 || lx === 7)) return { rgb: hairRgb };
      if (lx === 1 || lx === 2 || lx === 5 || lx === 6) return { rgb: browRgb };
      return { rgb: skinRgb };
    }
    if (ly === 4) {
      if (lx === 1 || lx === 6) return { rgb: scleraRgb, jitter: 0.04 };
      if (lx === 2 || lx === 5) return { rgb: eyeRgb, jitter: 0.05 };
      if (hairStyle === 2 && (lx === 0 || lx === 7)) return { rgb: hairRgb };
      return { rgb: skinRgb };
    }
    if (ly === 5) {
      if (lx === 3 || lx === 4) return { rgb: skinNoseRgb };
      return { rgb: skinRgb };
    }
    if (ly === 6) {
      if (lx === 3 || lx === 4) return { rgb: mouthRgb, jitter: 0.06 };
      if (mouthStyle === 0 && (lx === 2 || lx === 5)) return { rgb: beardRgb };
      if (mouthStyle === 2 && (lx === 2 || lx === 5)) return { rgb: lerpRgb(skinRgb, mouthRgb, 0.55) };
      return { rgb: skinRgb };
    }
    if (mouthStyle === 0 && lx >= 2 && lx <= 5) {
      return { rgb: beardRgb };
    }
    return { rgb: skinRgb };
  });

  const paintHeadSide = (rect: SkinUvRect, frontAtLeft: boolean): void => {
    fillRect(rect, (lx, ly) => {
      const distFromFront = frontAtLeft ? lx : 7 - lx;
      if (ly <= 1) return { rgb: hairRgb };
      if (hairStyle === 2) {
        if (distFromFront >= 1 && ly <= 6) return { rgb: hairRgb };
        if (distFromFront === 0 && ly <= 4) return { rgb: hairRgb };
        return { rgb: skinRgb };
      }
      if (hairStyle === 3) {
        if (ly === 2 && distFromFront >= 1) return { rgb: hairRgb };
        if (ly === 3 && distFromFront >= 4) return { rgb: hairRgb };
        return { rgb: skinRgb };
      }
      if (ly === 2) return { rgb: hairRgb };
      if (ly === 3 && (distFromFront === 0 || distFromFront >= 3)) return { rgb: hairRgb };
      if (ly === 4 && distFromFront >= 4) return { rgb: hairRgb };
      if (ly === 5 && distFromFront >= 5) return { rgb: hairRgb };
      return { rgb: skinRgb };
    });
  };
  paintHeadSide(HEAD_UV.nx, false);
  paintHeadSide(HEAD_UV.px, true);

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

  fillRect(TORSO_UV.pz, (lx, ly) => {
    if (ly === 9) {
      return { rgb: lx === 3 || lx === 4 ? buckleRgb : beltRgb };
    }
    if (ly === 0 && lx >= 2 && lx <= 5) return { rgb: collarRgb };
    if (ly === 1 && (lx === 3 || lx === 4)) return { rgb: collarRgb };
    if ((ly === 2 || ly === 3) && (lx === 5 || lx === 6)) return { rgb: badgePlateRgb };
    if (ly >= 2 && ly <= 7 && (lx === 3 || lx === 4)) {
      return { rgb: ly % 2 === 0 ? tieRgb : lerpRgb(tieRgb, shirtDarkRgb, 0.35) };
    }
    if (lx === 0 || lx === 7 || ly === 8) return { rgb: shirtDarkRgb };
    return { rgb: shirtRgb };
  });

  fillRect(TORSO_UV.nz, (lx, ly) => {
    if (ly === 9) return { rgb: beltRgb };
    if (ly === 0 && lx >= 2 && lx <= 5) return { rgb: collarRgb };
    if (ly === 1 || lx === 0 || lx === 7 || ly === 8) return { rgb: shirtDarkRgb };
    return { rgb: shirtRgb };
  });

  const paintTorsoSide = (rect: SkinUvRect): void => {
    fillRect(rect, (_lx, ly) => {
      if (ly === 9) return { rgb: beltRgb };
      if (ly === 8) return { rgb: shirtDarkRgb };
      return { rgb: shirtRgb };
    });
  };
  paintTorsoSide(TORSO_UV.nx);
  paintTorsoSide(TORSO_UV.px);

  // === 3. 左右双臂 4×10×4 ===
  const paintArm = (uv: BoxUvRegions, hasWatch: boolean): void => {
    fillRect(uv.py, () => ({ rgb: shirtRgb }));
    fillRect(uv.ny, (_lx, ly) => ({
      rgb: ly === 2 ? scaleRgb(skinRgb, 0.86) : skinRgb,
    }));

    const sideFaces: readonly VoxelFaceDir[] = ['pz', 'nz', 'px', 'nx'];
    for (let i = 0; i < sideFaces.length; i += 1) {
      const dir = sideFaces[i];
      fillRect(uv[dir], (lx, ly) => {
        if (ly <= 5) return { rgb: ly === 5 ? shirtDarkRgb : shirtRgb };
        if (ly === 6) return { rgb: collarRgb };
        if (hasWatch && ly === 7 && (dir === 'pz' || dir === 'px') && (lx === 1 || lx === 2)) {
          return { rgb: watchRgb };
        }
        return { rgb: ly === 9 ? scaleRgb(skinRgb, 0.92) : skinRgb };
      });
    }
  };
  paintArm(RIGHT_ARM_UV, false);
  paintArm(LEFT_ARM_UV, true);

  // === 4. 左右双腿 4×10×4 ===
  const paintLeg = (uv: BoxUvRegions, outerDir: 'px' | 'nx'): void => {
    fillRect(uv.py, () => ({ rgb: trouserDarkRgb }));
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
        if (ly === 7) return { rgb: trouserDarkRgb };
        if (ly === 8) {
          if (dir === 'pz' && (lx === 1 || lx === 2)) return { rgb: shoeLaceRgb };
          return { rgb: shoeRgb };
        }
        return { rgb: shoeSoleRgb };
      });
    }
  };
  paintLeg(RIGHT_LEG_UV, 'nx');
  paintLeg(LEFT_LEG_UV, 'px');

  ctx.putImageData(imageData, 0, 0);
}

function createVisorGeometry(accentHex: string): THREE.BufferGeometry {
  const frameHex = '#222936';
  const boxes: SolidColorBoxInput[] = [
    { minX: -0.25, minY: 0.1875, minZ: 0.25, maxX: 0.25, maxY: 0.25, maxZ: 0.28125, color: accentHex, shadeFaces: false },
    { minX: -0.28125, minY: 0.25, minZ: 0.25, maxX: 0.28125, maxY: 0.28125, maxZ: 0.28125, color: frameHex, shadeFaces: true },
    { minX: -0.28125, minY: 0.1875, minZ: -0.0625, maxX: -0.25, maxY: 0.25, maxZ: 0.28125, color: frameHex, shadeFaces: true },
    { minX: 0.25, minY: 0.1875, minZ: -0.0625, maxX: 0.28125, maxY: 0.25, maxZ: 0.28125, color: frameHex, shadeFaces: true },
  ];
  return createSolidColorVoxelGeometry(boxes);
}

function createGlassesGeometry(): THREE.BufferGeometry {
  const frameHex = '#202733';
  const boxes: SolidColorBoxInput[] = [
    { minX: -0.21875, minY: 0.25, minZ: 0.25, maxX: -0.03125, maxY: 0.28125, maxZ: 0.28125, color: frameHex },
    { minX: -0.21875, minY: 0.15625, minZ: 0.25, maxX: -0.03125, maxY: 0.1875, maxZ: 0.28125, color: frameHex },
    { minX: -0.21875, minY: 0.1875, minZ: 0.25, maxX: -0.1875, maxY: 0.25, maxZ: 0.28125, color: frameHex },
    { minX: -0.0625, minY: 0.1875, minZ: 0.25, maxX: -0.03125, maxY: 0.25, maxZ: 0.28125, color: frameHex },
    { minX: 0.03125, minY: 0.25, minZ: 0.25, maxX: 0.21875, maxY: 0.28125, maxZ: 0.28125, color: frameHex },
    { minX: 0.03125, minY: 0.15625, minZ: 0.25, maxX: 0.21875, maxY: 0.1875, maxZ: 0.28125, color: frameHex },
    { minX: 0.03125, minY: 0.1875, minZ: 0.25, maxX: 0.0625, maxY: 0.25, maxZ: 0.28125, color: frameHex },
    { minX: 0.1875, minY: 0.1875, minZ: 0.25, maxX: 0.21875, maxY: 0.25, maxZ: 0.28125, color: frameHex },
    { minX: -0.03125, minY: 0.21875, minZ: 0.25, maxX: 0.03125, maxY: 0.25, maxZ: 0.28125, color: frameHex },
    { minX: -0.28125, minY: 0.21875, minZ: 0.25, maxX: -0.21875, maxY: 0.25, maxZ: 0.28125, color: frameHex },
    { minX: 0.21875, minY: 0.21875, minZ: 0.25, maxX: 0.28125, maxY: 0.25, maxZ: 0.28125, color: frameHex },
    { minX: -0.28125, minY: 0.21875, minZ: -0.0625, maxX: -0.25, maxY: 0.25, maxZ: 0.25, color: frameHex },
    { minX: 0.25, minY: 0.21875, minZ: -0.0625, maxX: 0.28125, maxY: 0.25, maxZ: 0.25, color: frameHex },
  ];
  return createSolidColorVoxelGeometry(boxes);
}

function createHeadsetGeometry(accentHex: string): THREE.BufferGeometry {
  const bandHex = '#262e3b';
  const cupHex = '#1b2029';
  const micArmHex = '#313a4a';
  const boxes: SolidColorBoxInput[] = [
    { minX: -0.328, minY: 0.522, minZ: -0.0625, maxX: 0.328, maxY: 0.584, maxZ: 0.0625, color: bandHex },
    { minX: -0.328, minY: 0.28125, minZ: -0.0625, maxX: -0.268, maxY: 0.522, maxZ: 0.0625, color: bandHex },
    { minX: 0.268, minY: 0.28125, minZ: -0.0625, maxX: 0.328, maxY: 0.522, maxZ: 0.0625, color: bandHex },
    { minX: -0.328, minY: 0.125, minZ: -0.09375, maxX: -0.268, maxY: 0.3125, maxZ: 0.09375, color: cupHex },
    { minX: -0.358, minY: 0.15625, minZ: -0.0625, maxX: -0.328, maxY: 0.28125, maxZ: 0.0625, color: accentHex },
    { minX: 0.268, minY: 0.125, minZ: -0.09375, maxX: 0.328, maxY: 0.3125, maxZ: 0.09375, color: cupHex },
    { minX: 0.328, minY: 0.15625, minZ: -0.0625, maxX: 0.358, maxY: 0.28125, maxZ: 0.0625, color: accentHex },
    { minX: -0.328, minY: 0.09375, minZ: 0.03125, maxX: -0.296, maxY: 0.125, maxZ: 0.3125, color: micArmHex },
    { minX: -0.296, minY: 0.09375, minZ: 0.28125, maxX: -0.09375, maxY: 0.125, maxZ: 0.3125, color: micArmHex },
    { minX: -0.09375, minY: 0.078125, minZ: 0.265625, maxX: -0.03125, maxY: 0.140625, maxZ: 0.328125, color: accentHex },
  ];
  return createSolidColorVoxelGeometry(boxes);
}

function createHandCoffeeMugGeometry(): THREE.BufferGeometry {
  const boxes: SolidColorBoxInput[] = [
    { minX: -0.055, minY: -0.57, minZ: 0.0, maxX: 0.055, maxY: -0.46, maxZ: 0.125, color: '#f1f5f9', shadeFaces: true },
    { minX: -0.042, minY: -0.558, minZ: 0.115, maxX: 0.042, maxY: -0.472, maxZ: 0.132, color: '#4a2c18', shadeFaces: true },
    { minX: -0.09, minY: -0.535, minZ: 0.03, maxX: -0.055, maxY: -0.495, maxZ: 0.095, color: '#e2e8f0', shadeFaces: true },
  ];
  return createSolidColorVoxelGeometry(boxes);
}

function tagCharacterTree(object: THREE.Object3D, sessionKey: string): void {
  object.traverse((child) => {
    child.userData.sessionKey = sessionKey;
    child.userData.hitKind = 'station';
    if (child instanceof THREE.Mesh && !child.userData.noShadow) {
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
  const sharedMaterials = getSharedVoxelMaterialSet();

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

  // PBR 哑光体素材质：保留像素锐度并接收真实方向光、轮廓补光与夜间灯笼暖光
  const skinMaterial = new THREE.MeshStandardMaterial({
    map: skinTexture,
    vertexColors: true,
    roughness: 0.86,
    metalness: 0.04,
    envMapIntensity: 0.45,
  });
  const accessoryMaterial = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.48,
    metalness: 0.25,
    envMapIntensity: 0.7,
  });
  const visorMaterial = new THREE.MeshBasicMaterial({
    vertexColors: true,
    toneMapped: false,
  });
  const badgeLedMaterial = new THREE.MeshStandardMaterial({
    color: palette.successHex,
    emissive: palette.successHex,
    emissiveIntensity: 1.15,
    roughness: 0.3,
  });

  const root = new THREE.Group();

  // 动态脚底接触阴影（走路时始终贴地跟随，坐姿时收于椅底）
  const shadowGeo = new THREE.PlaneGeometry(0.68, 0.52);
  shadowGeo.rotateX(-Math.PI / 2);
  const shadowMesh = new THREE.Mesh(shadowGeo, sharedMaterials.contactShadow);
  shadowMesh.position.set(0, 0.012, 0);
  shadowMesh.userData.noShadow = true;
  shadowMesh.renderOrder = 1;
  root.add(shadowMesh);

  const torsoGroup = new THREE.Group();
  torsoGroup.position.set(0, 0.375, 0);
  root.add(torsoGroup);

  const torsoGeo = createSkinnedVoxelBox(0.5, 0.625, 0.25, TORSO_UV, [0, 0.3125, 0]);
  const torsoMesh = new THREE.Mesh(torsoGeo, skinMaterial);
  torsoGroup.add(torsoMesh);

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

  const headGroup = new THREE.Group();
  headGroup.position.set(0, 0.625, 0);
  torsoGroup.add(headGroup);

  const headGeo = createLayeredHeadGeometry();
  const headMesh = new THREE.Mesh(headGeo, skinMaterial);
  headGroup.add(headMesh);

  const visorMesh = new THREE.Mesh(createVisorGeometry(accentHex), visorMaterial);
  const glassesMesh = new THREE.Mesh(createGlassesGeometry(), accessoryMaterial);
  const headsetMesh = new THREE.Mesh(createHeadsetGeometry(accentHex), accessoryMaterial);
  headGroup.add(visorMesh);
  headGroup.add(glassesMesh);
  headGroup.add(headsetMesh);

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

  const handMugMesh = new THREE.Mesh(createHandCoffeeMugGeometry(), accessoryMaterial);
  handMugMesh.name = 'character-hand-coffee-mug';
  handMugMesh.visible = false;
  rightArmGroup.add(handMugMesh);

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
    shadowMesh,
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

  const visorStyle = session.persona.visorStyle;
  rig.visorMesh.visible = visorStyle === 'visor';
  rig.glassesMesh.visible = visorStyle === 'glasses';
  rig.headsetMesh.visible = visorStyle === 'headset';

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
    rig.badgeLedMaterial.emissiveIntensity = 1.1;
  } else {
    rig.skinMaterial.color.set('#ffffff');
    rig.accessoryMaterial.color.set('#ffffff');
    rig.visorMaterial.color.set('#ffffff');
    rig.badgeLedMaterial.color.set(palette.successHex);
    rig.badgeLedMaterial.emissive.set(palette.successHex);
    rig.badgeLedMaterial.emissiveIntensity = 1.15;
  }

  animateOfficeCharacter(rig, rig.lastElapsedSec, rig.lastReducedMotion, rig.activePose);
}

const WALK_LEG_SWING_RAD = THREE.MathUtils.degToRad(30);
const WALK_ARM_SWING_RAD = THREE.MathUtils.degToRad(22);
const WALK_BODY_BOB = 0.024;
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

  if (!reducedMotion && pose && pose.phase !== 'seated') {
    const stand = pose.standBlend;
    rig.handMugMesh.visible = pose.holdingCoffee;
    rig.shadowMesh.visible = true;
    rig.shadowMesh.position.set(0, 0.012, 0);
    rig.shadowMesh.scale.set(0.95, 1, 0.95);

    if (pose.phase === 'standing_up' || pose.phase === 'sitting_down') {
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

    const wb = pose.walkBlend;
    const strideSin = Math.sin(pose.walkPhase);
    const legSwing = strideSin * WALK_LEG_SWING_RAD * wb;
    const armSwing = strideSin * WALK_ARM_SWING_RAD * wb;
    const bob = Math.abs(strideSin) * WALK_BODY_BOB * wb;

    rig.torsoGroup.position.set(0, STANDING_TORSO_Y + bob, 0);
    rig.torsoGroup.rotation.set(0.035 * wb, 0, 0);
    rig.headGroup.rotation.set(0.02 * wb, Math.sin(t * 1.1) * 0.06, 0);
    rig.legsGroup.position.set(0, STANDING_LEGS_Y, 0);
    rig.legsGroup.rotation.set(0, 0, 0);
    rig.leftLegGroup.rotation.set(legSwing, 0, 0);
    rig.rightLegGroup.rotation.set(-legSwing, 0, 0);
    rig.leftArmGroup.rotation.set(-armSwing, 0, 0);
    if (pose.holdingCoffee) {
      rig.rightArmGroup.rotation.set(-1.24 + strideSin * 0.05 * wb, 0, 0.1);
    } else {
      rig.rightArmGroup.rotation.set(armSwing, 0, 0);
    }
    return;
  }

  // 坐姿基准（座椅下方已有工位合批接触阴影，此处隐藏避免双层叠加）
  rig.shadowMesh.visible = false;
  rig.handMugMesh.visible = false;
  rig.torsoGroup.position.set(0, SEATED_TORSO_Y, 0);
  rig.legsGroup.position.set(0, SEATED_LEGS_Y, SEATED_LEGS_Z);
  rig.legsGroup.rotation.set(0, 0, 0);
  rig.leftLegGroup.rotation.set(-Math.PI / 2, 0, 0);
  rig.rightLegGroup.rotation.set(-Math.PI / 2, 0, 0);

  if (rig.availability === 'exited') {
    rig.torsoGroup.rotation.set(0.06, 0, 0);
    rig.headGroup.rotation.set(0.28, 0, 0);
    rig.leftArmGroup.rotation.set(-1.64, 0, 0);
    rig.rightArmGroup.rotation.set(-1.64, 0, 0);
    return;
  }

  if (rig.availability === 'unavailable') {
    rig.torsoGroup.rotation.set(0, 0, 0);
    rig.headGroup.rotation.set(0.1, 0, 0);
    rig.leftArmGroup.rotation.set(-Math.PI / 2, 0, 0);
    rig.rightArmGroup.rotation.set(-Math.PI / 2, 0, 0);
    return;
  }

  if (reducedMotion) {
    rig.torsoGroup.rotation.set(0, 0, 0);
    rig.headGroup.rotation.set(0, 0, 0);
    rig.leftArmGroup.rotation.set(-Math.PI / 2, 0, 0);
    rig.rightArmGroup.rotation.set(-Math.PI / 2, 0, 0);
    return;
  }

  const breath = Math.sin(t * 2.0) * 0.015;

  if (rig.posture === 'typing') {
    const isInteractive = rig.availability === 'interactive';
    const speed = isInteractive ? 9.6 : 6.4;
    const amp = isInteractive ? 0.056 : 0.038;
    const burst = 0.65 + 0.35 * Math.sin(t * 1.4);
    const leftArmX = -1.67 + Math.sin(t * speed) * amp * burst;
    const rightArmX = -1.67 + Math.sin(t * speed + Math.PI) * amp * burst;
    const headYaw = Math.sin(t * 1.25) * 0.08;
    const headPitch = 0.04 + Math.sin(t * 2.5) * 0.025;

    rig.torsoGroup.rotation.set(0.03 + breath, headYaw * 0.18, 0);
    rig.headGroup.rotation.set(headPitch, headYaw, 0);
    rig.leftArmGroup.rotation.set(leftArmX, 0, 0);
    rig.rightArmGroup.rotation.set(rightArmX, 0, 0);
  } else if (rig.posture === 'reading') {
    const headNod = Math.sin(t * 2.1) * 0.04;
    const headYaw = Math.sin(t * 0.85) * 0.09;

    rig.torsoGroup.rotation.set(-0.02 + breath, 0, 0);
    rig.headGroup.rotation.set(-0.02 + headNod, headYaw, 0);
    rig.leftArmGroup.rotation.set(-1.6 + Math.sin(t * 1.8) * 0.02, 0, 0);
    rig.rightArmGroup.rotation.set(-1.62 + Math.sin(t * 2.4 + 1.2) * 0.03, 0, 0);
  } else {
    const glance = Math.sin(t * 0.95) * 0.1;

    rig.torsoGroup.rotation.set(0.01 + breath, glance * 0.12, 0);
    rig.headGroup.rotation.set(0.01, glance, 0);
    rig.leftArmGroup.rotation.set(-1.62 + Math.sin(t * 2.0) * 0.018, 0, 0);
    rig.rightArmGroup.rotation.set(-1.62 + Math.sin(t * 2.0 + 1.8) * 0.018, 0, 0);
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
    rig.shadowMesh.geometry,
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
