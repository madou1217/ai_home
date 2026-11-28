import * as THREE from 'three';
import type { OfficeSceneThemeMode } from './office-scene-types';

/**
 * 程序化 Minecraft PBR 像素图集与共享材质引擎：
 * - 8×8 格（64 块），每格 16×16 核心像素 + 8px 边缘夹紧防渗色衬边（32×32 单元格，256×256 2 的幂次图集）。
 * - 同步生成 Albedo（sRGB）、PBR 粗糙度/金属度贴图（G=Roughness, B=Metalness）、像素微凹凸高度图（BumpMap）
 *   与定向自发光掩码图（EmissiveMap），使木纹、砖缝、金属高光、玻璃、灯笼与红石灯呈现类 Minecraft Shaders 层次。
 * - 近距 NearestFilter 保留纯粹方块像素锐度，远距 NearestMipmapLinearFilter + 各向异性消除闪烁与摩尔纹。
 * - 独立无缝循环像素水面贴图支持零分配 UV 流动动画；内置共享柔边方形接触阴影材质用于地面/桌面锚定。
 */

export const ATLAS_COLS = 8;
export const ATLAS_ROWS = 8;
export const TILE_PX = 16;
const TILE_PAD = 8;
const CELL_PX = TILE_PX + TILE_PAD * 2; // 32
export const ATLAS_SIZE = ATLAS_COLS * CELL_PX; // 256

export type VoxelQualityTier = 'high' | 'medium' | 'low';

export type VoxelTileId =
  | 'grass_top'
  | 'grass_side'
  | 'dirt'
  | 'stone'
  | 'stone_brick'
  | 'cobblestone'
  | 'water'
  | 'sand'
  | 'oak_planks'
  | 'spruce_planks'
  | 'oak_log_side'
  | 'oak_log_top'
  | 'oak_leaves'
  | 'glass'
  | 'bookshelf'
  | 'oak_door_top'
  | 'oak_door_bottom'
  | 'iron_block'
  | 'gold_block'
  | 'dark_iron'
  | 'lantern'
  | 'redstone_lamp_on'
  | 'redstone_lamp_off'
  | 'screen_off'
  | 'wool_white'
  | 'wool_light_gray'
  | 'wool_cyan'
  | 'wool_blue'
  | 'wool_green'
  | 'wool_red'
  | 'wool_yellow'
  | 'wool_purple'
  | 'chest_front'
  | 'chest_side'
  | 'chest_top'
  | 'keyboard_top'
  | 'terracotta'
  | 'mug_white'
  | 'mail_parcel'
  | 'pc_mesh'
  | 'wool_orange'
  | 'wool_brown'
  | 'flower_red'
  | 'flower_yellow'
  | 'quartz_block'
  | 'dark_oak_planks'
  | 'glowstone'
  | 'emerald_block'
  | 'birch_log_side'
  | 'birch_log_top'
  | 'birch_planks'
  | 'birch_leaves'
  | 'deepslate'
  | 'mossy_stone_brick'
  | 'bricks'
  | 'copper_block'
  | 'spruce_log_side'
  | 'spruce_log_top'
  | 'tall_grass'
  | 'flower_blue'
  | 'sugar_cane'
  | 'painting_landscape'
  | 'whiteboard'
  | 'corkboard';

export interface TileUvRect {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

const TILE_INDEX: Readonly<Record<VoxelTileId, number>> = {
  grass_top: 0,
  grass_side: 1,
  dirt: 2,
  stone: 3,
  stone_brick: 4,
  cobblestone: 5,
  water: 6,
  sand: 7,
  oak_planks: 8,
  spruce_planks: 9,
  oak_log_side: 10,
  oak_log_top: 11,
  oak_leaves: 12,
  glass: 13,
  bookshelf: 14,
  oak_door_top: 15,
  oak_door_bottom: 16,
  iron_block: 17,
  gold_block: 18,
  dark_iron: 19,
  lantern: 20,
  redstone_lamp_on: 21,
  redstone_lamp_off: 22,
  screen_off: 23,
  wool_white: 24,
  wool_light_gray: 25,
  wool_cyan: 26,
  wool_blue: 27,
  wool_green: 28,
  wool_red: 29,
  wool_yellow: 30,
  wool_purple: 31,
  chest_front: 32,
  chest_side: 33,
  chest_top: 34,
  keyboard_top: 35,
  terracotta: 36,
  mug_white: 37,
  mail_parcel: 38,
  pc_mesh: 39,
  wool_orange: 40,
  wool_brown: 41,
  flower_red: 42,
  flower_yellow: 43,
  quartz_block: 44,
  dark_oak_planks: 45,
  glowstone: 46,
  emerald_block: 47,
  birch_log_side: 48,
  birch_log_top: 49,
  birch_planks: 50,
  birch_leaves: 51,
  deepslate: 52,
  mossy_stone_brick: 53,
  bricks: 54,
  copper_block: 55,
  spruce_log_side: 56,
  spruce_log_top: 57,
  tall_grass: 58,
  flower_blue: 59,
  sugar_cane: 60,
  painting_landscape: 61,
  whiteboard: 62,
  corkboard: 63,
};

const UV_CACHE = new Map<VoxelTileId, TileUvRect>();

/** 获取图集内指定方块的 UV 矩形（指向 32×32 单元格中心的 16×16 像素核，兼容 flipY=true） */
export function getTileUvRect(tile: VoxelTileId): TileUvRect {
  const cached = UV_CACHE.get(tile);
  if (cached) return cached;

  const idx = TILE_INDEX[tile] ?? 0;
  const col = idx % ATLAS_COLS;
  const row = Math.floor(idx / ATLAS_COLS);
  const originX = col * CELL_PX + TILE_PAD;
  const originY = row * CELL_PX + TILE_PAD;
  const inset = 0.05;
  const u0 = (originX + inset) / ATLAS_SIZE;
  const u1 = (originX + TILE_PX - inset) / ATLAS_SIZE;
  const v1 = 1 - (originY + inset) / ATLAS_SIZE;
  const v0 = 1 - (originY + TILE_PX - inset) / ATLAS_SIZE;
  const rect: TileUvRect = { u0, v0, u1, v1 };
  UV_CACHE.set(tile, rect);
  return rect;
}

interface Rgb {
  r: number;
  g: number;
  b: number;
}

function hexToRgb(hex: string): Rgb {
  const clean = hex.replace('#', '');
  const num = parseInt(clean, 16);
  return {
    r: (num >> 16) & 255,
    g: (num >> 8) & 255,
    b: num & 255,
  };
}

function clampByte(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}

/** 确定性像素哈希，返回 [-1, 1] */
function pixelNoise(seed: number, x: number, y: number): number {
  let h = (seed * 374761393 + x * 668265263 + y * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = h ^ (h >>> 16);
  return ((h >>> 0) / 4294967295) * 2 - 1;
}

interface AtlasBuffers {
  albedo: ImageData;
  /** G 通道存储 Roughness (0..255)，B 通道存储 Metalness (0..255) */
  pbr: ImageData;
  /** 灰度高度图供 BumpMap 提供像素级微浮雕 */
  bump: ImageData;
  /** 仅自发光核心像素非零，用于灯笼/红石灯/萤石/指示灯 */
  emissive: ImageData;
}

interface PixelWriteOpts {
  jitter?: number;
  alpha?: number;
  roughness?: number;
  metalness?: number;
  height?: number;
  emissiveHex?: string;
}

function createTilePainter(buffers: AtlasBuffers, tileId: VoxelTileId) {
  const idx = TILE_INDEX[tileId];
  const col = idx % ATLAS_COLS;
  const row = Math.floor(idx / ATLAS_COLS);
  const baseX = col * CELL_PX + TILE_PAD;
  const baseY = row * CELL_PX + TILE_PAD;
  const seed = idx * 97 + 13;

  const setPx = (
    x: number,
    y: number,
    r: number,
    g: number,
    b: number,
    a = 255,
    roughness = 0.86,
    metalness = 0.0,
    height = 0.5,
    emissiveRgb?: Rgb
  ): void => {
    if (x < 0 || x >= TILE_PX || y < 0 || y >= TILE_PX) return;
    const offset = ((baseY + y) * ATLAS_SIZE + (baseX + x)) * 4;
    buffers.albedo.data[offset] = clampByte(r);
    buffers.albedo.data[offset + 1] = clampByte(g);
    buffers.albedo.data[offset + 2] = clampByte(b);
    buffers.albedo.data[offset + 3] = clampByte(a);

    const rByte = clampByte(roughness * 255);
    const mByte = clampByte(metalness * 255);
    buffers.pbr.data[offset] = 255;
    buffers.pbr.data[offset + 1] = rByte;
    buffers.pbr.data[offset + 2] = mByte;
    buffers.pbr.data[offset + 3] = 255;

    const hByte = clampByte(height * 255);
    buffers.bump.data[offset] = hByte;
    buffers.bump.data[offset + 1] = hByte;
    buffers.bump.data[offset + 2] = hByte;
    buffers.bump.data[offset + 3] = 255;

    if (emissiveRgb) {
      buffers.emissive.data[offset] = clampByte(emissiveRgb.r);
      buffers.emissive.data[offset + 1] = clampByte(emissiveRgb.g);
      buffers.emissive.data[offset + 2] = clampByte(emissiveRgb.b);
      buffers.emissive.data[offset + 3] = 255;
    } else {
      buffers.emissive.data[offset] = 0;
      buffers.emissive.data[offset + 1] = 0;
      buffers.emissive.data[offset + 2] = 0;
      buffers.emissive.data[offset + 3] = 255;
    }
  };

  const setHex = (x: number, y: number, hex: string, opts?: PixelWriteOpts): void => {
    const rgb = hexToRgb(hex);
    const jitter = opts?.jitter ?? 0.075;
    const n = pixelNoise(seed, x, y);
    const factor = 1 + n * jitter;
    const emissiveRgb = opts?.emissiveHex ? hexToRgb(opts.emissiveHex) : undefined;
    setPx(
      x,
      y,
      rgb.r * factor,
      rgb.g * factor,
      rgb.b * factor,
      opts?.alpha ?? 255,
      opts?.roughness ?? 0.86,
      opts?.metalness ?? 0.0,
      (opts?.height ?? 0.5) + n * 0.06,
      emissiveRgb
    );
  };

  return { setPx, setHex };
}

function paintNoiseBlock(
  buffers: AtlasBuffers,
  tileId: VoxelTileId,
  baseHex: string,
  accentHex: string,
  darkHex: string,
  roughness = 0.88,
  jitter = 0.075,
  emissive = false
): void {
  const { setHex } = createTilePainter(buffers, tileId);
  const seed = TILE_INDEX[tileId] * 131 + 7;
  for (let y = 0; y < TILE_PX; y += 1) {
    for (let x = 0; x < TILE_PX; x += 1) {
      const n = pixelNoise(seed + 19, x, y);
      const hex = n > 0.36 ? accentHex : n < -0.42 ? darkHex : baseHex;
      const height = n > 0.36 ? 0.64 : n < -0.42 ? 0.36 : 0.5;
      setHex(x, y, hex, {
        jitter,
        roughness,
        height,
        emissiveHex: emissive ? hex : undefined,
      });
    }
  }
}

function paintPlanks(
  buffers: AtlasBuffers,
  tileId: VoxelTileId,
  baseHex: string,
  lightHex: string,
  grainHex: string,
  seamHex: string
): void {
  const { setHex } = createTilePainter(buffers, tileId);
  const jointCols = [0, 8, 13, 4];
  const seed = TILE_INDEX[tileId] * 53 + 11;
  for (let y = 0; y < TILE_PX; y += 1) {
    const plankIdx = Math.floor(y / 4);
    const rowInPlank = y % 4;
    const jointX = jointCols[plankIdx % jointCols.length];
    for (let x = 0; x < TILE_PX; x += 1) {
      const isSeam = rowInPlank === 0 || x === jointX;
      const isTopBevel = rowInPlank === 1 && x !== jointX;
      const isGrain = !isSeam && pixelNoise(seed, Math.floor(x / 3), y) > 0.32;
      if (isSeam) {
        setHex(x, y, seamHex, { jitter: 0.05, roughness: 0.94, height: 0.22 });
      } else if (isTopBevel) {
        setHex(x, y, lightHex, { jitter: 0.06, roughness: 0.78, height: 0.66 });
      } else if (isGrain) {
        setHex(x, y, grainHex, { jitter: 0.07, roughness: 0.85, height: 0.44 });
      } else {
        setHex(x, y, baseHex, { jitter: 0.065, roughness: 0.82, height: 0.54 });
      }
    }
  }
}

function paintWool(
  buffers: AtlasBuffers,
  tileId: VoxelTileId,
  baseHex: string,
  shadeHex: string,
  highlightHex: string
): void {
  const { setHex } = createTilePainter(buffers, tileId);
  for (let y = 0; y < TILE_PX; y += 1) {
    for (let x = 0; x < TILE_PX; x += 1) {
      const weaveDark = (x + y * 2) % 4 === 0 || (x % 3 === 0 && y % 2 === 0);
      const weaveLight = (x + y) % 5 === 1;
      if (weaveDark) {
        setHex(x, y, shadeHex, { jitter: 0.06, roughness: 0.96, height: 0.38 });
      } else if (weaveLight) {
        setHex(x, y, highlightHex, { jitter: 0.06, roughness: 0.92, height: 0.62 });
      } else {
        setHex(x, y, baseHex, { jitter: 0.07, roughness: 0.94, height: 0.5 });
      }
    }
  }
}

function paintMetalBlock(
  buffers: AtlasBuffers,
  tileId: VoxelTileId,
  baseHex: string,
  hiHex: string,
  loHex: string,
  roughness = 0.34,
  metalness = 0.72
): void {
  const { setHex } = createTilePainter(buffers, tileId);
  for (let y = 0; y < TILE_PX; y += 1) {
    for (let x = 0; x < TILE_PX; x += 1) {
      const isTopOrLeft = x === 0 || y === 0;
      const isBotOrRight = x === 15 || y === 15;
      const isBevel = x === 1 || y === 1;
      const isInnerEdge = x === 14 || y === 14;
      const isSheen = (x + y) === 9 || (x + y) === 10 || (x === 4 && y === 4);
      const isRivet =
        (x === 2 && y === 2) || (x === 13 && y === 2)
        || (x === 2 && y === 13) || (x === 13 && y === 13);
      if (isBotOrRight) {
        setHex(x, y, loHex, { jitter: 0.04, roughness: roughness + 0.12, metalness, height: 0.25 });
      } else if (isTopOrLeft || isSheen) {
        setHex(x, y, hiHex, { jitter: 0.05, roughness: Math.max(0.16, roughness - 0.1), metalness: Math.min(0.95, metalness + 0.1), height: 0.76 });
      } else if (isRivet) {
        setHex(x, y, loHex, { jitter: 0.04, roughness: roughness + 0.08, metalness, height: 0.84 });
      } else if (isBevel) {
        setHex(x, y, hiHex, { jitter: 0.05, roughness, metalness, height: 0.64 });
      } else if (isInnerEdge) {
        setHex(x, y, loHex, { jitter: 0.05, roughness: roughness + 0.06, metalness, height: 0.42 });
      } else {
        setHex(x, y, baseHex, { jitter: 0.055, roughness, metalness, height: 0.55 });
      }
    }
  }
}

function paintLogBark(
  buffers: AtlasBuffers,
  tileId: VoxelTileId,
  baseHex: string,
  darkHex: string,
  lightHex: string,
  horizontalSpeckles = false
): void {
  const { setHex } = createTilePainter(buffers, tileId);
  const seed = TILE_INDEX[tileId] * 67 + 23;
  for (let y = 0; y < TILE_PX; y += 1) {
    for (let x = 0; x < TILE_PX; x += 1) {
      if (horizontalSpeckles) {
        // 白桦木特征：浅奶白树皮 + 横向炭黑斑节
        const knot =
          (y === 3 && x >= 2 && x <= 5)
          || (y === 7 && x >= 9 && x <= 13)
          || (y === 11 && x >= 1 && x <= 4)
          || (y === 14 && x >= 10 && x <= 14)
          || (y === 5 && x === 12)
          || (y === 10 && x === 7);
        const crease = y % 4 === 0 && pixelNoise(seed, x, y) > 0.35;
        if (knot) {
          setHex(x, y, darkHex, { jitter: 0.06, roughness: 0.92, height: 0.28 });
        } else if (crease) {
          setHex(x, y, lightHex, { jitter: 0.05, roughness: 0.86, height: 0.44 });
        } else {
          setHex(x, y, baseHex, { jitter: 0.05, roughness: 0.84, height: 0.56 });
        }
      } else {
        const groove = x % 4 === 0 || (x % 4 === 2 && (y + x) % 5 === 0);
        const ridge = x % 4 === 1 && pixelNoise(seed, x, Math.floor(y / 2)) > 0.1;
        if (groove) {
          setHex(x, y, darkHex, { jitter: 0.06, roughness: 0.95, height: 0.26 });
        } else if (ridge) {
          setHex(x, y, lightHex, { jitter: 0.07, roughness: 0.86, height: 0.7 });
        } else {
          setHex(x, y, baseHex, { jitter: 0.07, roughness: 0.9, height: 0.5 });
        }
      }
    }
  }
}

function paintLogTop(
  buffers: AtlasBuffers,
  tileId: VoxelTileId,
  barkHex: string,
  ringLightHex: string,
  ringDarkHex: string
): void {
  const { setHex } = createTilePainter(buffers, tileId);
  for (let y = 0; y < TILE_PX; y += 1) {
    for (let x = 0; x < TILE_PX; x += 1) {
      const d = Math.max(Math.abs(x - 7.5), Math.abs(y - 7.5));
      if (d > 6.4) {
        setHex(x, y, barkHex, { jitter: 0.07, roughness: 0.92, height: 0.65 });
      } else if (Math.floor(d) % 2 === 0) {
        setHex(x, y, ringLightHex, { jitter: 0.07, roughness: 0.84, height: 0.54 });
      } else {
        setHex(x, y, ringDarkHex, { jitter: 0.07, roughness: 0.88, height: 0.42 });
      }
    }
  }
}

function paintLeaves(
  buffers: AtlasBuffers,
  tileId: VoxelTileId,
  brightHex: string,
  midHex: string,
  deepHex: string
): void {
  const { setHex, setPx } = createTilePainter(buffers, tileId);
  const seed = TILE_INDEX[tileId] * 109 + 5;
  for (let y = 0; y < TILE_PX; y += 1) {
    for (let x = 0; x < TILE_PX; x += 1) {
      const n = pixelNoise(seed, x, y);
      if (n < -0.74 && (x + y) % 2 === 0) {
        setPx(x, y, 0, 0, 0, 0, 0.9, 0, 0.1);
      } else if (n > 0.34) {
        setHex(x, y, brightHex, { jitter: 0.07, roughness: 0.84, height: 0.72 });
      } else if (n < -0.22) {
        setHex(x, y, deepHex, { jitter: 0.07, roughness: 0.92, height: 0.3 });
      } else {
        setHex(x, y, midHex, { jitter: 0.07, roughness: 0.88, height: 0.52 });
      }
    }
  }
}

function paintStoneBrickTile(buffers: AtlasBuffers, tileId: VoxelTileId, mossy: boolean): void {
  const { setHex } = createTilePainter(buffers, tileId);
  const seed = TILE_INDEX[tileId] * 79 + 3;
  for (let y = 0; y < TILE_PX; y += 1) {
    const topHalf = y < 8;
    for (let x = 0; x < TILE_PX; x += 1) {
      const mortarH = y === 0 || y === 8;
      const mortarV = topHalf ? x === 0 || x === 8 : x === 4 || x === 12;
      const highlight = y === 1 || y === 9;
      const shadowRow = y === 7 || y === 15;
      const mossHit =
        mossy
        && (
          ((mortarH || mortarV) && pixelNoise(seed + 7, x, y) > -0.15)
          || ((y === 1 || y === 7 || y === 9) && pixelNoise(seed + 13, x, y) > 0.42)
        );
      if (mossHit) {
        setHex(x, y, pixelNoise(seed, x, y) > 0 ? '#5c8f38' : '#436e27', {
          jitter: 0.08,
          roughness: 0.94,
          height: 0.46,
        });
      } else if (mortarH || mortarV) {
        setHex(x, y, '#585e6a', { jitter: 0.05, roughness: 0.96, height: 0.18 });
      } else if (highlight) {
        setHex(x, y, '#aeb5c0', { jitter: 0.06, roughness: 0.82, height: 0.72 });
      } else if (shadowRow) {
        setHex(x, y, '#7b828e', { jitter: 0.06, roughness: 0.88, height: 0.44 });
      } else {
        const crack = pixelNoise(seed + 31, x, y) < -0.78;
        setHex(x, y, crack ? '#6c727e' : '#9299a5', {
          jitter: 0.075,
          roughness: 0.86,
          height: crack ? 0.34 : 0.58,
        });
      }
    }
  }
}

function paintCrossPlantTile(
  buffers: AtlasBuffers,
  tileId: VoxelTileId,
  kind: 'tall_grass' | 'flower_red' | 'flower_yellow' | 'flower_blue' | 'sugar_cane'
): void {
  const { setHex, setPx } = createTilePainter(buffers, tileId);
  // 清空透明底
  for (let y = 0; y < TILE_PX; y += 1) {
    for (let x = 0; x < TILE_PX; x += 1) {
      setPx(x, y, 0, 0, 0, 0, 0.9, 0, 0.1);
    }
  }

  if (kind === 'tall_grass') {
    const blades: ReadonlyArray<{ x: number; topY: number; shade: string }> = [
      { x: 2, topY: 7, shade: '#4c9e2a' },
      { x: 3, topY: 5, shade: '#63b838' },
      { x: 5, topY: 4, shade: '#448f24' },
      { x: 6, topY: 6, shade: '#70c942' },
      { x: 8, topY: 3, shade: '#5eb534' },
      { x: 9, topY: 6, shade: '#479427' },
      { x: 11, topY: 5, shade: '#69bf3b' },
      { x: 13, topY: 7, shade: '#4d9c2b' },
    ];
    for (const blade of blades) {
      for (let y = blade.topY; y < TILE_PX; y += 1) {
        const swayX = y < blade.topY + 3 ? blade.x + (blade.x < 8 ? -1 : 1) : blade.x;
        setHex(Math.max(0, Math.min(15, swayX)), y, y < blade.topY + 2 ? '#7ad44b' : blade.shade, {
          jitter: 0.07,
          roughness: 0.88,
          height: 0.6,
        });
      }
    }
    return;
  }

  if (kind === 'sugar_cane') {
    const stalks = [3, 4, 8, 9, 12, 13];
    for (const sx of stalks) {
      const topY = sx <= 4 ? 1 : sx <= 9 ? 0 : 2;
      for (let y = topY; y < TILE_PX; y += 1) {
        const isNode = y % 5 === 2;
        const hex = isNode ? '#63a637' : (sx % 2 === 0 ? '#89d457' : '#73bf43');
        setHex(sx, y, hex, { jitter: 0.06, roughness: 0.82, height: 0.62 });
      }
    }
    return;
  }

  // 经典 Minecraft 十字茎叶 + 像素花冠（红罂粟 / 黄蒲公英 / 蓝兰花）
  for (let y = 8; y < TILE_PX; y += 1) {
    setHex(7, y, '#3d8523', { jitter: 0.06, roughness: 0.88 });
    setHex(8, y, '#52a332', { jitter: 0.06, roughness: 0.88 });
  }
  // 小叶片
  setHex(5, 11, '#58ad36');
  setHex(6, 12, '#49992b');
  setHex(9, 11, '#49992b');
  setHex(10, 10, '#58ad36');

  const petalMain =
    kind === 'flower_red' ? '#e53935' : kind === 'flower_yellow' ? '#ffd54f' : '#38bdf8';
  const petalLight =
    kind === 'flower_red' ? '#ff6f60' : kind === 'flower_yellow' ? '#fff176' : '#7dd3fc';
  const centerColor =
    kind === 'flower_red' ? '#2c1816' : kind === 'flower_yellow' ? '#f59e0b' : '#fef08a';

  for (let y = 4; y <= 8; y += 1) {
    for (let x = 5; x <= 10; x += 1) {
      const isCorner = (x === 5 || x === 10) && (y === 4 || y === 8);
      if (isCorner) continue;
      const isCenter = (x === 7 || x === 8) && (y === 6 || y === 7);
      const isTop = y === 4 || (y === 5 && (x === 6 || x === 9));
      setHex(x, y, isCenter ? centerColor : isTop ? petalLight : petalMain, {
        jitter: 0.06,
        roughness: 0.82,
        height: isCenter ? 0.72 : 0.62,
      });
    }
  }
}

/** 将每个 16×16 像素块外扩 8px 边缘夹紧衬边，彻底消除 mipmap 跨格渗色 */
function padAllTileGutters(buffers: AtlasBuffers): void {
  const allMaps = [buffers.albedo.data, buffers.pbr.data, buffers.bump.data, buffers.emissive.data];
  for (let row = 0; row < ATLAS_ROWS; row += 1) {
    for (let col = 0; col < ATLAS_COLS; col += 1) {
      const cellX = col * CELL_PX;
      const cellY = row * CELL_PX;
      const coreX = cellX + TILE_PAD;
      const coreY = cellY + TILE_PAD;

      for (let py = 0; py < CELL_PX; py += 1) {
        const inCoreY = py >= TILE_PAD && py < TILE_PAD + TILE_PX;
        const clampedY = Math.max(0, Math.min(TILE_PX - 1, py - TILE_PAD));
        const srcY = coreY + clampedY;
        const dstY = cellY + py;

        for (let px = 0; px < CELL_PX; px += 1) {
          if (inCoreY && px >= TILE_PAD && px < TILE_PAD + TILE_PX) continue;
          const clampedX = Math.max(0, Math.min(TILE_PX - 1, px - TILE_PAD));
          const srcX = coreX + clampedX;
          const dstX = cellX + px;
          const srcOff = (srcY * ATLAS_SIZE + srcX) * 4;
          const dstOff = (dstY * ATLAS_SIZE + dstX) * 4;
          for (let m = 0; m < allMaps.length; m += 1) {
            const arr = allMaps[m];
            arr[dstOff] = arr[srcOff];
            arr[dstOff + 1] = arr[srcOff + 1];
            arr[dstOff + 2] = arr[srcOff + 2];
            arr[dstOff + 3] = arr[srcOff + 3];
          }
        }
      }
    }
  }
}

function imageDataToCanvas(imageData: ImageData): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('无法创建 2D Canvas 上下文以生成 Minecraft 体素图集');
  }
  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

function buildAtlasCanvases(): {
  albedoCanvas: HTMLCanvasElement;
  pbrCanvas: HTMLCanvasElement;
  bumpCanvas: HTMLCanvasElement;
  emissiveCanvas: HTMLCanvasElement;
} {
  const probeCanvas = document.createElement('canvas');
  probeCanvas.width = ATLAS_SIZE;
  probeCanvas.height = ATLAS_SIZE;
  const ctx = probeCanvas.getContext('2d');
  if (!ctx) {
    throw new Error('无法创建 2D Canvas 上下文以生成 Minecraft 体素图集');
  }

  const buffers: AtlasBuffers = {
    albedo: ctx.createImageData(ATLAS_SIZE, ATLAS_SIZE),
    pbr: ctx.createImageData(ATLAS_SIZE, ATLAS_SIZE),
    bump: ctx.createImageData(ATLAS_SIZE, ATLAS_SIZE),
    emissive: ctx.createImageData(ATLAS_SIZE, ATLAS_SIZE),
  };

  // 0: 草方块顶面（鲜绿多层次草叶）
  paintNoiseBlock(buffers, 'grass_top', '#69bd38', '#7ed149', '#519e28', 0.9, 0.08);

  // 1: 草方块侧面（自然锯齿状绿草皮 + 深色土缘 + 鹅卵石泥土）
  {
    const { setHex } = createTilePainter(buffers, 'grass_side');
    const fringe = [4, 3, 5, 4, 3, 5, 4, 3, 4, 6, 4, 3, 5, 4, 3, 4];
    for (let y = 0; y < TILE_PX; y += 1) {
      for (let x = 0; x < TILE_PX; x += 1) {
        if (y < fringe[x]) {
          setHex(x, y, y === 0 ? '#79cf43' : '#5db02f', { roughness: 0.9, height: 0.62 });
        } else if (y === fringe[x]) {
          setHex(x, y, '#4e3823', { jitter: 0.06, roughness: 0.95, height: 0.32 });
        } else {
          const n = pixelNoise(31, x, y);
          const hex = n > 0.62 ? '#73533a' : n < -0.58 ? '#a47956' : '#8f6747';
          setHex(x, y, hex, { roughness: 0.94, height: n > 0.62 ? 0.64 : 0.45 });
        }
      }
    }
  }

  // 2: 泥土
  paintNoiseBlock(buffers, 'dirt', '#8f6747', '#a37855', '#6e4d33', 0.95, 0.085);

  // 3: 石头（横向层理岩石）
  {
    const { setHex } = createTilePainter(buffers, 'stone');
    for (let y = 0; y < TILE_PX; y += 1) {
      for (let x = 0; x < TILE_PX; x += 1) {
        const n = pixelNoise(43, Math.floor(x / 2), y);
        const hex = n > 0.42 ? '#a1a7b0' : n < -0.45 ? '#757b84' : '#8c929b';
        setHex(x, y, hex, { roughness: 0.88, height: n > 0.42 ? 0.66 : n < -0.45 ? 0.34 : 0.5 });
      }
    }
  }

  // 4: 石砖
  paintStoneBrickTile(buffers, 'stone_brick', false);

  // 5: 圆石
  {
    const { setHex } = createTilePainter(buffers, 'cobblestone');
    for (let y = 0; y < TILE_PX; y += 1) {
      for (let x = 0; x < TILE_PX; x += 1) {
        const row = Math.floor(y / 4);
        const shiftedX = (x + row * 2) % 5;
        const seam = (shiftedX === 0 && y % 4 < 3) || y % 4 === 0;
        const hi = y % 4 === 1 && shiftedX === 1;
        setHex(x, y, seam ? '#555b66' : hi ? '#a4abb6' : '#848a96', {
          roughness: seam ? 0.96 : 0.86,
          height: seam ? 0.2 : hi ? 0.72 : 0.56,
        });
      }
    }
  }

  // 6: 水方块（备用图集格，实际水层使用独立循环水贴图）
  {
    const { setHex } = createTilePainter(buffers, 'water');
    for (let y = 0; y < TILE_PX; y += 1) {
      for (let x = 0; x < TILE_PX; x += 1) {
        const ripple = (y === 3 || y === 11) && ((x >= 2 && x <= 7) || (x >= 11 && x <= 14));
        setHex(x, y, ripple ? '#74c5ff' : '#2d82e3', {
          alpha: 215,
          roughness: 0.08,
          metalness: 0.1,
          height: ripple ? 0.7 : 0.42,
        });
      }
    }
  }

  // 7: 沙子
  paintNoiseBlock(buffers, 'sand', '#e4d69c', '#f0e4b4', '#cbb97b', 0.92, 0.075);

  // 8~9: 橡木 / 云杉木板
  paintPlanks(buffers, 'oak_planks', '#c7995e', '#d9ae74', '#b5864c', '#8b6336');
  paintPlanks(buffers, 'spruce_planks', '#855d38', '#9c7047', '#744f2e', '#573a1f');

  // 10~11: 橡木原木侧面与年轮顶面
  paintLogBark(buffers, 'oak_log_side', '#7b5c38', '#543e23', '#916e45', false);
  paintLogTop(buffers, 'oak_log_top', '#694e2f', '#cfa870', '#a6804d');

  // 12: 橡树叶
  paintLeaves(buffers, 'oak_leaves', '#63bd3b', '#489e2b', '#2f761d');

  // 13: 玻璃方块（像素框 + 对角高光 + 透亮中心）
  {
    const { setHex } = createTilePainter(buffers, 'glass');
    for (let y = 0; y < TILE_PX; y += 1) {
      for (let x = 0; x < TILE_PX; x += 1) {
        const isBorder = x === 0 || x === 15 || y === 0 || y === 15;
        const isGlint =
          (x === 3 && y === 4) || (x === 4 && y === 3)
          || (x === 4 && y === 5) || (x === 5 && y === 4)
          || (x === 11 && y === 12) || (x === 12 && y === 11);
        if (isBorder) {
          setHex(x, y, '#dff5ff', { jitter: 0.04, alpha: 242, roughness: 0.14, metalness: 0.1, height: 0.72 });
        } else if (isGlint) {
          setHex(x, y, '#ffffff', { jitter: 0.03, alpha: 215, roughness: 0.06, metalness: 0.14, height: 0.62 });
        } else {
          setHex(x, y, '#a6e0ff', { jitter: 0.04, alpha: 52, roughness: 0.08, metalness: 0.08, height: 0.5 });
        }
      }
    }
  }

  // 14: 书架（双层阴影凹槽 + 彩色精装书脊）
  {
    const { setHex, setPx } = createTilePainter(buffers, 'bookshelf');
    const bookColors = ['#c53030', '#2b6cb0', '#2f855a', '#d69e2e', '#805ad5', '#e2e8f0', '#dd6b20', '#0d9488'];
    for (let y = 0; y < TILE_PX; y += 1) {
      for (let x = 0; x < TILE_PX; x += 1) {
        if (y <= 1 || y === 7 || y === 8 || y >= 14) {
          const isLip = y === 1 || y === 8 || y === 14;
          setHex(x, y, isLip ? '#8c6438' : '#c09258', { roughness: 0.84, height: isLip ? 0.68 : 0.78 });
        } else if (y === 2 || y === 9) {
          // 隔板下方自然阴影缝
          setHex(x, y, '#38291d', { jitter: 0.05, roughness: 0.96, height: 0.22 });
        } else {
          const shelfRow = y < 7 ? 0 : 1;
          const bookIdx = Math.floor(x / 2);
          const colorHex = bookColors[(bookIdx + shelfRow * 3) % bookColors.length];
          const isSpineGold = (y === 4 || y === 11) && bookIdx % 3 === 1 && x % 2 === 0;
          if (isSpineGold) {
            setHex(x, y, '#f4d35e', { jitter: 0.05, roughness: 0.45, metalness: 0.5, height: 0.58 });
          } else if (x % 2 === 0) {
            setHex(x, y, colorHex, { jitter: 0.07, roughness: 0.8, height: 0.54 });
          } else {
            const rgb = hexToRgb(colorHex);
            setPx(x, y, rgb.r * 0.76, rgb.g * 0.76, rgb.b * 0.76, 255, 0.88, 0, 0.42);
          }
        }
      }
    }
  }

  // 15: 橡木门上半
  {
    const { setHex } = createTilePainter(buffers, 'oak_door_top');
    for (let y = 0; y < TILE_PX; y += 1) {
      for (let x = 0; x < TILE_PX; x += 1) {
        const inWindow =
          ((x >= 3 && x <= 6) || (x >= 9 && x <= 12))
          && ((y >= 3 && y <= 6) || (y >= 9 && y <= 12));
        const isEdge = x === 0 || x === 15 || y === 0;
        if (inWindow) {
          setHex(x, y, '#b2e4ff', { jitter: 0.05, roughness: 0.14, metalness: 0.1, height: 0.32 });
        } else if (isEdge) {
          setHex(x, y, '#6b4b27', { roughness: 0.9, height: 0.72 });
        } else {
          setHex(x, y, '#ad8049', { roughness: 0.84, height: 0.6 });
        }
      }
    }
  }

  // 16: 橡木门下半
  {
    const { setHex } = createTilePainter(buffers, 'oak_door_bottom');
    for (let y = 0; y < TILE_PX; y += 1) {
      for (let x = 0; x < TILE_PX; x += 1) {
        const isHandle = (x === 12 || x === 13) && (y === 2 || y === 3);
        const isRecess = x >= 3 && x <= 12 && y >= 4 && y <= 12;
        const isEdge = x === 0 || x === 15 || y === 15;
        if (isHandle) {
          setHex(x, y, '#d8c27a', { roughness: 0.3, metalness: 0.75, height: 0.86 });
        } else if (isEdge) {
          setHex(x, y, '#6b4b27', { roughness: 0.9, height: 0.72 });
        } else if (isRecess) {
          setHex(x, y, '#926939', { roughness: 0.88, height: 0.36 });
        } else {
          setHex(x, y, '#b3854d', { roughness: 0.84, height: 0.62 });
        }
      }
    }
  }

  // 17~19: 铁块、金块、深灰铁块（带金属度与高光倒角）
  paintMetalBlock(buffers, 'iron_block', '#d6dde4', '#f1f5f9', '#99a3b0', 0.32, 0.78);
  paintMetalBlock(buffers, 'gold_block', '#f4c92d', '#fff08a', '#b98512', 0.24, 0.88);
  paintMetalBlock(buffers, 'dark_iron', '#3a424f', '#525c6e', '#212630', 0.42, 0.62);

  // 20: 灯笼（深铁笼框不发光，内部暖琥珀玻璃与明黄灯芯定向自发光）
  {
    const { setHex } = createTilePainter(buffers, 'lantern');
    for (let y = 0; y < TILE_PX; y += 1) {
      for (let x = 0; x < TILE_PX; x += 1) {
        const isOuterFrame = x <= 1 || x >= 14 || y <= 2 || y >= 13;
        const isCageBar = (x === 5 || x === 10) && y >= 3 && y <= 12;
        const isCore = x >= 6 && x <= 9 && y >= 5 && y <= 10;
        if (isOuterFrame || isCageBar) {
          setHex(x, y, '#2b313c', { roughness: 0.44, metalness: 0.68, height: 0.78 });
        } else if (isCore) {
          setHex(x, y, '#fff4b3', { roughness: 0.25, height: 0.5, emissiveHex: '#ffe985' });
        } else {
          setHex(x, y, '#f2a93b', { roughness: 0.3, height: 0.48, emissiveHex: '#e89524' });
        }
      }
    }
  }

  // 21: 点亮的红石灯（木色框不发光，内部暖光网格自发光）
  {
    const { setHex } = createTilePainter(buffers, 'redstone_lamp_on');
    for (let y = 0; y < TILE_PX; y += 1) {
      for (let x = 0; x < TILE_PX; x += 1) {
        const isBorder = x === 0 || x === 15 || y === 0 || y === 15;
        const isGrid = x === 7 || x === 8 || y === 7 || y === 8;
        const isCenter = x >= 4 && x <= 11 && y >= 4 && y <= 11;
        if (isBorder) {
          setHex(x, y, '#73471f', { roughness: 0.72, height: 0.74 });
        } else if (isGrid) {
          setHex(x, y, '#bf772a', { roughness: 0.55, height: 0.62, emissiveHex: '#8c5218' });
        } else if (isCenter) {
          setHex(x, y, '#fff7cc', { roughness: 0.25, height: 0.5, emissiveHex: '#ffefad' });
        } else {
          setHex(x, y, '#ffd46e', { roughness: 0.32, height: 0.5, emissiveHex: '#f5b841' });
        }
      }
    }
  }

  // 22: 熄灭的红石灯
  {
    const { setHex } = createTilePainter(buffers, 'redstone_lamp_off');
    for (let y = 0; y < TILE_PX; y += 1) {
      for (let x = 0; x < TILE_PX; x += 1) {
        const isBorder = x === 0 || x === 15 || y === 0 || y === 15;
        const isGrid = x === 7 || x === 8 || y === 7 || y === 8;
        if (isBorder) {
          setHex(x, y, '#47301b', { roughness: 0.82, height: 0.74 });
        } else if (isGrid) {
          setHex(x, y, '#5c3f24', { roughness: 0.78, height: 0.62 });
        } else {
          setHex(x, y, '#7d5b3b', { roughness: 0.68, height: 0.48 });
        }
      }
    }
  }

  // 23: 熄灭屏幕
  {
    const { setHex } = createTilePainter(buffers, 'screen_off');
    for (let y = 0; y < TILE_PX; y += 1) {
      for (let x = 0; x < TILE_PX; x += 1) {
        const isBorder = x === 0 || x === 15 || y === 0 || y === 15;
        const isGlint = (x === 2 && y === 3) || (x === 3 && y === 2);
        if (isBorder) {
          setHex(x, y, '#1c232e', { roughness: 0.45, metalness: 0.4, height: 0.65 });
        } else if (isGlint) {
          setHex(x, y, '#38485e', { roughness: 0.16, metalness: 0.2, height: 0.5 });
        } else {
          setHex(x, y, '#0e1520', { roughness: 0.22, metalness: 0.15, height: 0.46 });
        }
      }
    }
  }

  // 24~31, 40~41: 编织羊毛地毯/坐垫
  paintWool(buffers, 'wool_white', '#edeff0', '#d6dad6', '#f7f9f8');
  paintWool(buffers, 'wool_light_gray', '#a3a7a2', '#8a8e89', '#b8bcb7');
  paintWool(buffers, 'wool_cyan', '#1aa3a3', '#148282', '#26bcbc');
  paintWool(buffers, 'wool_blue', '#3b59ba', '#2d4699', '#4f6fd4');
  paintWool(buffers, 'wool_green', '#5fad1c', '#4b8c13', '#74c42b');
  paintWool(buffers, 'wool_red', '#ba342c', '#96261f', '#d4453d');
  paintWool(buffers, 'wool_yellow', '#f5cf38', '#d6ae22', '#ffe066');
  paintWool(buffers, 'wool_purple', '#8b37bd', '#70279c', '#a34cd6');
  paintWool(buffers, 'wool_orange', '#f08222', '#cc6714', '#ff993d');
  paintWool(buffers, 'wool_brown', '#825533', '#664023', '#996741');

  // 32~34: Minecraft 木箱
  {
    const paintChestFace = (tileId: VoxelTileId, hasLatch: boolean, hasSeam: boolean) => {
      const { setHex } = createTilePainter(buffers, tileId);
      for (let y = 0; y < TILE_PX; y += 1) {
        for (let x = 0; x < TILE_PX; x += 1) {
          const isBorder = x === 0 || x === 15 || y === 0 || y === 15;
          const isSeam = hasSeam && y === 5;
          const isLatch = hasLatch && x >= 7 && x <= 8 && y >= 4 && y <= 7;
          if (isLatch) {
            setHex(x, y, y === 4 ? '#f7eed2' : '#c8ced6', { roughness: 0.34, metalness: 0.72, height: 0.85 });
          } else if (isBorder || isSeam) {
            setHex(x, y, '#4a3118', { roughness: 0.92, height: 0.25 });
          } else {
            setHex(x, y, y % 3 === 0 ? '#a8763c' : '#c08b49', { roughness: 0.84, height: 0.56 });
          }
        }
      }
    };
    paintChestFace('chest_front', true, true);
    paintChestFace('chest_side', false, true);
    paintChestFace('chest_top', false, false);
  }

  // 35: 机械键盘顶面（清晰分层键帽 + 空格条 + 高亮 ESC）
  {
    const { setHex } = createTilePainter(buffers, 'keyboard_top');
    for (let y = 0; y < TILE_PX; y += 1) {
      for (let x = 0; x < TILE_PX; x += 1) {
        const isRim = x === 0 || x === 15 || y === 0 || y === 15;
        const isSpace = y >= 12 && y <= 13 && x >= 4 && x <= 11;
        const isKey = !isRim && y >= 2 && y <= 13 && x >= 2 && x <= 13 && y % 2 === 0 && x % 2 === 0;
        if (isRim) {
          setHex(x, y, '#232a36', { roughness: 0.55, metalness: 0.35, height: 0.72 });
        } else if (isSpace) {
          setHex(x, y, '#738199', { roughness: 0.62, height: 0.78 });
        } else if (isKey) {
          const isEsc = x === 2 && y === 2;
          const isEnter = x === 12 && y === 8;
          setHex(x, y, isEsc ? '#38e8ff' : isEnter ? '#60a5fa' : '#a8b5c9', {
            roughness: 0.58,
            height: 0.84,
            emissiveHex: isEsc ? '#38e8ff' : undefined,
          });
        } else {
          setHex(x, y, '#171d27', { roughness: 0.78, height: 0.32 });
        }
      }
    }
  }

  // 36: 红陶花盆
  paintNoiseBlock(buffers, 'terracotta', '#a46044', '#b87254', '#854a32', 0.86, 0.075);

  // 37: 白色陶瓷马克杯
  {
    const { setHex } = createTilePainter(buffers, 'mug_white');
    for (let y = 0; y < TILE_PX; y += 1) {
      for (let x = 0; x < TILE_PX; x += 1) {
        const isRim = y <= 1;
        setHex(x, y, isRim ? '#5e3c24' : '#f1f5f9', {
          jitter: 0.04,
          roughness: isRim ? 0.5 : 0.26,
          height: 0.58,
        });
      }
    }
  }

  // 38: 邮件包裹方块
  {
    const { setHex } = createTilePainter(buffers, 'mail_parcel');
    for (let y = 0; y < TILE_PX; y += 1) {
      for (let x = 0; x < TILE_PX; x += 1) {
        const isRibbon = x === 7 || x === 8 || y === 7 || y === 8;
        const isSeal = x >= 6 && x <= 9 && y >= 6 && y <= 9;
        const isEdge = x === 0 || x === 15 || y === 0 || y === 15;
        if (isSeal) {
          setHex(x, y, '#ef4444', { roughness: 0.5, height: 0.78 });
        } else if (isRibbon) {
          setHex(x, y, '#f8fafc', { roughness: 0.72, height: 0.68 });
        } else if (isEdge) {
          setHex(x, y, '#9c7448', { roughness: 0.9, height: 0.38 });
        } else {
          setHex(x, y, '#d8b07c', { roughness: 0.88, height: 0.52 });
        }
      }
    }
  }

  // 39: PC 机箱进风网孔
  {
    const { setHex } = createTilePainter(buffers, 'pc_mesh');
    for (let y = 0; y < TILE_PX; y += 1) {
      for (let x = 0; x < TILE_PX; x += 1) {
        const isBorder = x <= 1 || x >= 14 || y <= 1 || y >= 14;
        const isHole = !isBorder && (x + y) % 2 === 0;
        if (isBorder) {
          setHex(x, y, '#38414f', { roughness: 0.44, metalness: 0.62, height: 0.74 });
        } else if (isHole) {
          setHex(x, y, '#10151d', { roughness: 0.92, height: 0.16 });
        } else {
          setHex(x, y, '#29303d', { roughness: 0.48, metalness: 0.55, height: 0.56 });
        }
      }
    }
  }

  // 42~43: 经典十字草花（兼容原有小方块花与室外 X 型花卉）
  paintCrossPlantTile(buffers, 'flower_red', 'flower_red');
  paintCrossPlantTile(buffers, 'flower_yellow', 'flower_yellow');

  // 44: 石英块
  paintMetalBlock(buffers, 'quartz_block', '#eeebe2', '#faf8f2', '#d2ccbe', 0.42, 0.08);

  // 45: 深色橡木板
  paintPlanks(buffers, 'dark_oak_planks', '#54381e', '#694727', '#462e18', '#332010');

  // 46: 萤石（自发光）
  paintNoiseBlock(buffers, 'glowstone', '#f5ca56', '#fff4b3', '#b88228', 0.35, 0.08, true);

  // 47: 绿宝石块（宝石高光 + 微发光用于状态点缀）
  paintMetalBlock(buffers, 'emerald_block', '#2ecc71', '#7af2ad', '#1c8c4a', 0.22, 0.45);
  {
    // 为 emerald_block 写入自发光核心，供咖啡机就绪指示灯使用
    const idx = TILE_INDEX.emerald_block;
    const bx = (idx % ATLAS_COLS) * CELL_PX + TILE_PAD;
    const by = Math.floor(idx / ATLAS_COLS) * CELL_PX + TILE_PAD;
    for (let y = 2; y < 14; y += 1) {
      for (let x = 2; x < 14; x += 1) {
        const off = ((by + y) * ATLAS_SIZE + (bx + x)) * 4;
        buffers.emissive.data[off] = 68;
        buffers.emissive.data[off + 1] = 235;
        buffers.emissive.data[off + 2] = 132;
        buffers.emissive.data[off + 3] = 255;
      }
    }
  }

  // 48~51: 白桦木原木、木板与清脆白桦叶
  paintLogBark(buffers, 'birch_log_side', '#e3dfd3', '#2e3136', '#c9c4b6', true);
  paintLogTop(buffers, 'birch_log_top', '#dad5c7', '#e6d8b0', '#c7b689');
  paintPlanks(buffers, 'birch_planks', '#d9c68d', '#e8d8a5', '#c7b37a', '#9e8b59');
  paintLeaves(buffers, 'birch_leaves', '#74c947', '#58ab34', '#3b8222');

  // 52: 深板岩（浮空岛底部岩芯）
  {
    const { setHex } = createTilePainter(buffers, 'deepslate');
    for (let y = 0; y < TILE_PX; y += 1) {
      for (let x = 0; x < TILE_PX; x += 1) {
        const n = pixelNoise(521, Math.floor(x / 2), y);
        const hex = n > 0.35 ? '#5b616e' : n < -0.4 ? '#363b45' : '#474c57';
        setHex(x, y, hex, { roughness: 0.88, height: n > 0.35 ? 0.65 : 0.38 });
      }
    }
  }

  // 53: 苔石砖
  paintStoneBrickTile(buffers, 'mossy_stone_brick', true);

  // 54: 红砖块
  {
    const { setHex } = createTilePainter(buffers, 'bricks');
    for (let y = 0; y < TILE_PX; y += 1) {
      const row = Math.floor(y / 4);
      for (let x = 0; x < TILE_PX; x += 1) {
        const mortarH = y % 4 === 0;
        const mortarV = (x + (row % 2) * 4) % 8 === 0;
        if (mortarH || mortarV) {
          setHex(x, y, '#c2bcb2', { roughness: 0.94, height: 0.2 });
        } else {
          const brickShade = (row + Math.floor(x / 8)) % 2 === 0 ? '#a84b3e' : '#963f34';
          setHex(x, y, brickShade, { roughness: 0.88, height: 0.62 });
        }
      }
    }
  }

  // 55: 铜块（建筑屋檐/咖啡机点缀）
  paintMetalBlock(buffers, 'copper_block', '#c46c49', '#e3906b', '#8f492e', 0.3, 0.82);

  // 56~57: 云杉原木
  paintLogBark(buffers, 'spruce_log_side', '#4a341e', '#2e1f11', '#5e4328', false);
  paintLogTop(buffers, 'spruce_log_top', '#3d2a18', '#997449', '#755432');

  // 58~60: 室外 X 型高草、蓝兰花与水岸甘蔗
  paintCrossPlantTile(buffers, 'tall_grass', 'tall_grass');
  paintCrossPlantTile(buffers, 'flower_blue', 'flower_blue');
  paintCrossPlantTile(buffers, 'sugar_cane', 'sugar_cane');

  // 61: 墙面像素风景画（Minecraft 经典日落山海像素画）
  {
    const { setHex } = createTilePainter(buffers, 'painting_landscape');
    for (let y = 0; y < TILE_PX; y += 1) {
      for (let x = 0; x < TILE_PX; x += 1) {
        const isFrame = x === 0 || x === 15 || y === 0 || y === 15;
        if (isFrame) {
          setHex(x, y, '#5c3c1e', { roughness: 0.86, height: 0.8 });
        } else if (y <= 6) {
          const isSun = x >= 10 && x <= 12 && y >= 2 && y <= 4;
          setHex(x, y, isSun ? '#ffe66d' : y <= 3 ? '#4c8ed9' : '#f29f67', { jitter: 0.05, roughness: 0.78 });
        } else if (y <= 10) {
          const ridge = (x >= 2 && x <= 7 && y >= 10 - Math.abs(x - 4)) || (x >= 7 && x <= 13 && y >= 10 - Math.abs(x - 10));
          setHex(x, y, ridge ? '#46614d' : '#f7b267', { jitter: 0.06, roughness: 0.82 });
        } else {
          const glint = y === 12 && x >= 9 && x <= 13;
          setHex(x, y, glint ? '#ffe08a' : '#2c6fb8', { jitter: 0.05, roughness: 0.7 });
        }
      }
    }
  }

  // 62: 办公室体素白板（带架构方块图）
  {
    const { setHex } = createTilePainter(buffers, 'whiteboard');
    for (let y = 0; y < TILE_PX; y += 1) {
      for (let x = 0; x < TILE_PX; x += 1) {
        const isFrame = x === 0 || x === 15 || y === 0 || y === 15;
        const isTray = y === 14 && x >= 3 && x <= 12;
        const isBoxA = x >= 3 && x <= 6 && y >= 4 && y <= 6;
        const isBoxB = x >= 9 && x <= 12 && y >= 4 && y <= 6;
        const isArrow = y === 5 && (x === 7 || x === 8);
        const isLines = (y === 9 || y === 11) && x >= 3 && x <= 11 && x !== 8;
        if (isFrame) {
          setHex(x, y, '#6e7887', { roughness: 0.42, metalness: 0.65, height: 0.78 });
        } else if (isTray) {
          setHex(x, y, x <= 5 ? '#ef4444' : x <= 8 ? '#3b82f6' : '#334155', { roughness: 0.5, height: 0.7 });
        } else if (isBoxA) {
          setHex(x, y, '#38bdf8', { roughness: 0.35 });
        } else if (isBoxB) {
          setHex(x, y, '#4ade80', { roughness: 0.35 });
        } else if (isArrow || isLines) {
          setHex(x, y, '#475569', { roughness: 0.4 });
        } else {
          setHex(x, y, '#edf2f7', { jitter: 0.03, roughness: 0.28, height: 0.48 });
        }
      }
    }
  }

  // 63: 办公室软木便签墙（彩色像素便利贴）
  {
    const { setHex } = createTilePainter(buffers, 'corkboard');
    for (let y = 0; y < TILE_PX; y += 1) {
      for (let x = 0; x < TILE_PX; x += 1) {
        const isFrame = x === 0 || x === 15 || y === 0 || y === 15;
        const note1 = x >= 2 && x <= 5 && y >= 2 && y <= 5;
        const note2 = x >= 7 && x <= 10 && y >= 3 && y <= 6;
        const note3 = x >= 11 && x <= 13 && y >= 2 && y <= 5;
        const note4 = x >= 3 && x <= 6 && y >= 8 && y <= 11;
        const note5 = x >= 8 && x <= 12 && y >= 9 && y <= 12;
        if (isFrame) {
          setHex(x, y, '#694726', { roughness: 0.88, height: 0.78 });
        } else if (note1) {
          setHex(x, y, '#fde047', { jitter: 0.05, roughness: 0.82, height: 0.65 });
        } else if (note2) {
          setHex(x, y, '#67e8f9', { jitter: 0.05, roughness: 0.82, height: 0.65 });
        } else if (note3) {
          setHex(x, y, '#fda4af', { jitter: 0.05, roughness: 0.82, height: 0.65 });
        } else if (note4) {
          setHex(x, y, '#86efac', { jitter: 0.05, roughness: 0.82, height: 0.65 });
        } else if (note5) {
          setHex(x, y, '#f8fafc', { jitter: 0.04, roughness: 0.82, height: 0.65 });
        } else {
          setHex(x, y, '#b58450', { jitter: 0.09, roughness: 0.94, height: 0.44 });
        }
      }
    }
  }

  // 为所有 64 个图集格写入 8px 边缘夹紧衬边
  padAllTileGutters(buffers);

  return {
    albedoCanvas: imageDataToCanvas(buffers.albedo),
    pbrCanvas: imageDataToCanvas(buffers.pbr),
    bumpCanvas: imageDataToCanvas(buffers.bump),
    emissiveCanvas: imageDataToCanvas(buffers.emissive),
  };
}

/** 生成 32×32 无缝平铺 Minecraft 像素水贴图与微波纹高度图（支持零分配 UV 流动动画） */
function buildSeamlessWaterTextures(): {
  waterTexture: THREE.CanvasTexture;
  waterBumpTexture: THREE.CanvasTexture;
} {
  const size = 32;
  const colorCanvas = document.createElement('canvas');
  colorCanvas.width = size;
  colorCanvas.height = size;
  const bumpCanvas = document.createElement('canvas');
  bumpCanvas.width = size;
  bumpCanvas.height = size;

  const cCtx = colorCanvas.getContext('2d');
  const bCtx = bumpCanvas.getContext('2d');
  if (!cCtx || !bCtx) {
    throw new Error('无法创建水面 2D Canvas 上下文');
  }

  const cImg = cCtx.createImageData(size, size);
  const bImg = bCtx.createImageData(size, size);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const waveA = Math.sin(((x + y * 0.5) / size) * Math.PI * 4);
      const waveB = Math.cos(((x * 0.5 - y) / size) * Math.PI * 4);
      const n = pixelNoise(607, x % 16, y % 16);
      const crest = (waveA + waveB) * 0.5 + n * 0.25;
      const off = (y * size + x) * 4;

      if (crest > 0.65) {
        cImg.data[off] = 132;
        cImg.data[off + 1] = 212;
        cImg.data[off + 2] = 255;
        cImg.data[off + 3] = 225;
      } else if (crest > 0.15) {
        cImg.data[off] = 62;
        cImg.data[off + 1] = 152;
        cImg.data[off + 2] = 240;
        cImg.data[off + 3] = 205;
      } else {
        cImg.data[off] = 36;
        cImg.data[off + 1] = 114;
        cImg.data[off + 2] = 212;
        cImg.data[off + 3] = 198;
      }

      const h = clampByte((0.5 + crest * 0.38) * 255);
      bImg.data[off] = h;
      bImg.data[off + 1] = h;
      bImg.data[off + 2] = h;
      bImg.data[off + 3] = 255;
    }
  }

  cCtx.putImageData(cImg, 0, 0);
  bCtx.putImageData(bImg, 0, 0);

  const waterTexture = new THREE.CanvasTexture(colorCanvas);
  waterTexture.colorSpace = THREE.SRGBColorSpace;
  waterTexture.magFilter = THREE.NearestFilter;
  waterTexture.minFilter = THREE.LinearMipmapLinearFilter;
  waterTexture.wrapS = THREE.RepeatWrapping;
  waterTexture.wrapT = THREE.RepeatWrapping;
  waterTexture.generateMipmaps = true;
  waterTexture.userData.sharedVoxelTexture = true;
  waterTexture.needsUpdate = true;

  const waterBumpTexture = new THREE.CanvasTexture(bumpCanvas);
  waterBumpTexture.colorSpace = THREE.NoColorSpace;
  waterBumpTexture.magFilter = THREE.NearestFilter;
  waterBumpTexture.minFilter = THREE.LinearMipmapLinearFilter;
  waterBumpTexture.wrapS = THREE.RepeatWrapping;
  waterBumpTexture.wrapT = THREE.RepeatWrapping;
  waterBumpTexture.generateMipmaps = true;
  waterBumpTexture.userData.sharedVoxelTexture = true;
  waterBumpTexture.needsUpdate = true;

  return { waterTexture, waterBumpTexture };
}

/** 生成 64×64 柔边方形接触阴影贴图（用于工位桌椅、落地主机、角色脚底与室外树影的柔和落地感） */
function buildContactShadowTexture(): THREE.CanvasTexture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('无法创建接触阴影 2D Canvas 上下文');
  }

  const img = ctx.createImageData(size, size);
  const half = (size - 1) * 0.5;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const nx = Math.abs(x - half) / half;
      const ny = Math.abs(y - half) / half;
      // 圆角方形（squircle p=3）接触阴影，贴合 Minecraft 方块底部轮廓
      const d = Math.pow(nx * nx * nx + ny * ny * ny, 1 / 3);
      const falloff = Math.max(0, 1 - d);
      const alpha = falloff * falloff * (3 - 2 * falloff);
      const off = (y * size + x) * 4;
      img.data[off] = 10;
      img.data[off + 1] = 16;
      img.data[off + 2] = 28;
      img.data[off + 3] = clampByte(alpha * 255);
    }
  }
  ctx.putImageData(img, 0, 0);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = true;
  texture.userData.sharedVoxelTexture = true;
  texture.needsUpdate = true;
  return texture;
}

function configureAtlasTexture(
  canvas: HTMLCanvasElement,
  colorSpace: THREE.ColorSpace,
  anisotropy = 4
): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(canvas);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.colorSpace = colorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.anisotropy = anisotropy;
  texture.userData.sharedVoxelTexture = true;
  texture.needsUpdate = true;
  return texture;
}

export interface VoxelMaterialSet {
  atlasTexture: THREE.CanvasTexture;
  pbrTexture: THREE.CanvasTexture;
  bumpTexture: THREE.CanvasTexture;
  emissiveTexture: THREE.CanvasTexture;
  waterTexture: THREE.CanvasTexture;
  waterBumpTexture: THREE.CanvasTexture;
  contactShadowTexture: THREE.CanvasTexture;
  opaque: THREE.MeshStandardMaterial;
  cutout: THREE.MeshStandardMaterial;
  glass: THREE.MeshStandardMaterial;
  water: THREE.MeshStandardMaterial;
  emissive: THREE.MeshStandardMaterial;
  contactShadow: THREE.MeshBasicMaterial;
  syncTheme: (mode: OfficeSceneThemeMode) => void;
  setQualityTier: (tier: VoxelQualityTier, maxAnisotropy: number) => void;
  animateWater: (elapsedSec: number) => void;
  dispose: () => void;
}

function markShared(mat: THREE.Material): void {
  mat.userData.sharedVoxelMaterial = true;
}

export function createVoxelMaterialSet(): VoxelMaterialSet {
  const { albedoCanvas, pbrCanvas, bumpCanvas, emissiveCanvas } = buildAtlasCanvases();
  const atlasTexture = configureAtlasTexture(albedoCanvas, THREE.SRGBColorSpace, 4);
  const pbrTexture = configureAtlasTexture(pbrCanvas, THREE.NoColorSpace, 4);
  const bumpTexture = configureAtlasTexture(bumpCanvas, THREE.NoColorSpace, 4);
  const emissiveTexture = configureAtlasTexture(emissiveCanvas, THREE.SRGBColorSpace, 4);
  const { waterTexture, waterBumpTexture } = buildSeamlessWaterTextures();
  const contactShadowTexture = buildContactShadowTexture();

  const opaque = new THREE.MeshStandardMaterial({
    map: atlasTexture,
    roughnessMap: pbrTexture,
    metalnessMap: pbrTexture,
    bumpMap: bumpTexture,
    bumpScale: 0.018,
    roughness: 1.0,
    metalness: 1.0,
    envMapIntensity: 0.55,
    vertexColors: true,
  });

  const cutout = new THREE.MeshStandardMaterial({
    map: atlasTexture,
    roughness: 0.88,
    metalness: 0.0,
    envMapIntensity: 0.4,
    vertexColors: true,
    alphaTest: 0.45,
    side: THREE.DoubleSide,
  });

  const glass = new THREE.MeshStandardMaterial({
    map: atlasTexture,
    roughness: 0.1,
    metalness: 0.12,
    envMapIntensity: 1.35,
    vertexColors: true,
    transparent: true,
    opacity: 0.82,
    depthWrite: false,
  });

  const water = new THREE.MeshStandardMaterial({
    map: waterTexture,
    bumpMap: waterBumpTexture,
    bumpScale: 0.025,
    roughness: 0.08,
    metalness: 0.1,
    envMapIntensity: 1.55,
    vertexColors: true,
    transparent: true,
    opacity: 0.78,
    depthWrite: false,
  });

  const emissive = new THREE.MeshStandardMaterial({
    map: atlasTexture,
    roughnessMap: pbrTexture,
    metalnessMap: pbrTexture,
    roughness: 1.0,
    metalness: 1.0,
    vertexColors: true,
    emissive: new THREE.Color('#ffffff'),
    emissiveMap: emissiveTexture,
    emissiveIntensity: 1.35,
    envMapIntensity: 0.5,
  });

  const contactShadow = new THREE.MeshBasicMaterial({
    map: contactShadowTexture,
    transparent: true,
    opacity: 0.34,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -2,
  });

  markShared(opaque);
  markShared(cutout);
  markShared(glass);
  markShared(water);
  markShared(emissive);
  markShared(contactShadow);

  const syncTheme = (mode: OfficeSceneThemeMode): void => {
    const isDark = mode === 'dark';
    // 夜晚提升灯笼与红石灯自发光温暖度；白天收敛自发光使金属灯笼框与纹理保持实体层次
    emissive.emissiveIntensity = isDark ? 1.85 : 0.42;
    opaque.envMapIntensity = isDark ? 0.52 : 0.62;
    cutout.envMapIntensity = isDark ? 0.36 : 0.46;
    glass.opacity = isDark ? 0.76 : 0.84;
    glass.envMapIntensity = isDark ? 1.15 : 1.45;
    water.opacity = isDark ? 0.76 : 0.82;
    water.envMapIntensity = isDark ? 1.25 : 1.65;
    contactShadow.opacity = isDark ? 0.42 : 0.3;
  };

  const setQualityTier = (tier: VoxelQualityTier, maxAnisotropy: number): void => {
    const targetAniso = tier === 'high'
      ? Math.min(8, Math.max(4, maxAnisotropy))
      : tier === 'medium'
        ? Math.min(4, Math.max(2, maxAnisotropy))
        : 1;
    atlasTexture.anisotropy = targetAniso;
    pbrTexture.anisotropy = targetAniso;
    bumpTexture.anisotropy = targetAniso;
    emissiveTexture.anisotropy = targetAniso;
    waterTexture.anisotropy = targetAniso;

    const wantBump = tier !== 'low';
    const nextBumpMap = wantBump ? bumpTexture : null;
    if (opaque.bumpMap !== nextBumpMap) {
      opaque.bumpMap = nextBumpMap;
      opaque.bumpScale = tier === 'high' ? 0.018 : 0.012;
      opaque.needsUpdate = true;
    }
    const nextWaterBump = wantBump ? waterBumpTexture : null;
    if (water.bumpMap !== nextWaterBump) {
      water.bumpMap = nextWaterBump;
      water.needsUpdate = true;
    }
  };

  const animateWater = (elapsedSec: number): void => {
    waterTexture.offset.set(
      (elapsedSec * 0.055) % 1,
      (elapsedSec * 0.032) % 1
    );
    waterBumpTexture.offset.set(
      (-elapsedSec * 0.038 + 10) % 1,
      (elapsedSec * 0.046) % 1
    );
  };

  const dispose = (): void => {
    atlasTexture.dispose();
    pbrTexture.dispose();
    bumpTexture.dispose();
    emissiveTexture.dispose();
    waterTexture.dispose();
    waterBumpTexture.dispose();
    contactShadowTexture.dispose();
    opaque.dispose();
    cutout.dispose();
    glass.dispose();
    water.dispose();
    emissive.dispose();
    contactShadow.dispose();
  };

  return {
    atlasTexture,
    pbrTexture,
    bumpTexture,
    emissiveTexture,
    waterTexture,
    waterBumpTexture,
    contactShadowTexture,
    opaque,
    cutout,
    glass,
    water,
    emissive,
    contactShadow,
    syncTheme,
    setQualityTier,
    animateWater,
    dispose,
  };
}

let sharedMaterialSet: VoxelMaterialSet | null = null;
let sharedMaterialRefCount = 0;

/** 获取共享体素图集材质（用于场景内房间与所有工位合批复用的零额外开销） */
export function getSharedVoxelMaterialSet(): VoxelMaterialSet {
  if (!sharedMaterialSet) {
    sharedMaterialSet = createVoxelMaterialSet();
  }
  return sharedMaterialSet;
}

/** 引用计数获取共享体素材质集，与 releaseVoxelMaterialSet 成对调用 */
export function acquireVoxelMaterialSet(): VoxelMaterialSet {
  sharedMaterialRefCount += 1;
  return getSharedVoxelMaterialSet();
}

/** 释放共享体素材质集引用；最后一个持有者退出时自动销毁 GPU 资源 */
export function releaseVoxelMaterialSet(): void {
  sharedMaterialRefCount = Math.max(0, sharedMaterialRefCount - 1);
  if (sharedMaterialRefCount === 0 && sharedMaterialSet) {
    sharedMaterialSet.dispose();
    sharedMaterialSet = null;
  }
}

export function isSharedVoxelMaterial(material: THREE.Material): boolean {
  return Boolean(material.userData.sharedVoxelMaterial);
}

export function isSharedVoxelTexture(texture: THREE.Texture): boolean {
  return Boolean(texture.userData.sharedVoxelTexture);
}
