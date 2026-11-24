import * as THREE from 'three';
import type { OfficeSceneThemeMode } from './office-scene-types';

/**
 * 程序化 Minecraft 16×16 像素贴图图集与共享材质集。
 * - 图集尺寸：8×8 格，每格 16×16 像素（总计 128×128），NearestFilter 硬像素无 mipmap。
 * - 每个纹理格均带确定性 ±8% 像素亮度抖动，呈现真实体素方块质感。
 */

export const ATLAS_COLS = 8;
export const ATLAS_ROWS = 8;
export const TILE_PX = 16;
export const ATLAS_SIZE = ATLAS_COLS * TILE_PX; // 128

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
  | 'emerald_block';

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
};

const UV_CACHE = new Map<VoxelTileId, TileUvRect>();

/** 获取图集内指定方块的 UV 矩形（含极小内缩防止 Nearest 边界渗色，兼容 flipY=true） */
export function getTileUvRect(tile: VoxelTileId): TileUvRect {
  const cached = UV_CACHE.get(tile);
  if (cached) return cached;

  const idx = TILE_INDEX[tile] ?? 0;
  const col = idx % ATLAS_COLS;
  const row = Math.floor(idx / ATLAS_COLS);
  const inset = 0.08;
  const u0 = (col * TILE_PX + inset) / ATLAS_SIZE;
  const u1 = ((col + 1) * TILE_PX - inset) / ATLAS_SIZE;
  const v1 = 1 - (row * TILE_PX + inset) / ATLAS_SIZE;
  const v0 = 1 - ((row + 1) * TILE_PX - inset) / ATLAS_SIZE;
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

type PixelWriter = (x: number, y: number, r: number, g: number, b: number, a?: number) => void;

function createTilePainter(
  imageData: ImageData,
  tileId: VoxelTileId
): { setPx: PixelWriter; setHex: (x: number, y: number, hex: string, jitter?: number, a?: number) => void } {
  const idx = TILE_INDEX[tileId];
  const baseX = (idx % ATLAS_COLS) * TILE_PX;
  const baseY = Math.floor(idx / ATLAS_COLS) * TILE_PX;
  const seed = idx * 97 + 13;

  const setPx: PixelWriter = (x, y, r, g, b, a = 255) => {
    if (x < 0 || x >= TILE_PX || y < 0 || y >= TILE_PX) return;
    const offset = ((baseY + y) * ATLAS_SIZE + (baseX + x)) * 4;
    imageData.data[offset] = clampByte(r);
    imageData.data[offset + 1] = clampByte(g);
    imageData.data[offset + 2] = clampByte(b);
    imageData.data[offset + 3] = clampByte(a);
  };

  const setHex = (x: number, y: number, hex: string, jitter = 0.08, a = 255) => {
    const rgb = hexToRgb(hex);
    const factor = 1 + pixelNoise(seed, x, y) * jitter;
    setPx(x, y, rgb.r * factor, rgb.g * factor, rgb.b * factor, a);
  };

  return { setPx, setHex };
}

function paintNoiseBlock(
  imageData: ImageData,
  tileId: VoxelTileId,
  baseHex: string,
  accentHex: string,
  accentRate: number,
  jitter = 0.08
): void {
  const { setHex } = createTilePainter(imageData, tileId);
  const seed = TILE_INDEX[tileId] * 131 + 7;
  for (let y = 0; y < TILE_PX; y += 1) {
    for (let x = 0; x < TILE_PX; x += 1) {
      const n = (pixelNoise(seed + 19, x, y) + 1) * 0.5;
      setHex(x, y, n < accentRate ? accentHex : baseHex, jitter);
    }
  }
}

function paintPlanks(
  imageData: ImageData,
  tileId: VoxelTileId,
  baseHex: string,
  lightHex: string,
  seamHex: string
): void {
  const { setHex } = createTilePainter(imageData, tileId);
  const seamRows = new Set([0, 4, 8, 12]);
  const jointCols = [0, 7, 13, 4];
  for (let y = 0; y < TILE_PX; y += 1) {
    const plankIdx = Math.floor(y / 4);
    const jointX = jointCols[plankIdx % jointCols.length];
    for (let x = 0; x < TILE_PX; x += 1) {
      if (seamRows.has(y) || x === jointX) {
        setHex(x, y, seamHex, 0.06);
      } else if (y % 4 === 1) {
        setHex(x, y, lightHex, 0.08);
      } else {
        setHex(x, y, baseHex, 0.08);
      }
    }
  }
}

function paintWool(imageData: ImageData, tileId: VoxelTileId, baseHex: string, shadeHex: string): void {
  const { setHex } = createTilePainter(imageData, tileId);
  for (let y = 0; y < TILE_PX; y += 1) {
    for (let x = 0; x < TILE_PX; x += 1) {
      const weave = (x + y * 2) % 4 === 0 || (x % 3 === 0 && y % 2 === 0);
      setHex(x, y, weave ? shadeHex : baseHex, 0.08);
    }
  }
}

function paintMetalBlock(
  imageData: ImageData,
  tileId: VoxelTileId,
  baseHex: string,
  hiHex: string,
  loHex: string
): void {
  const { setHex } = createTilePainter(imageData, tileId);
  for (let y = 0; y < TILE_PX; y += 1) {
    for (let x = 0; x < TILE_PX; x += 1) {
      const isTopOrLeft = x === 0 || y === 0;
      const isBotOrRight = x === 15 || y === 15;
      const isInnerFrame = x === 1 || y === 1 || x === 14 || y === 14;
      const isSheen = (x + y) === 10 || (x + y) === 11;
      if (isBotOrRight) {
        setHex(x, y, loHex, 0.06);
      } else if (isTopOrLeft || isSheen) {
        setHex(x, y, hiHex, 0.07);
      } else if (isInnerFrame) {
        setHex(x, y, baseHex, 0.08);
      } else {
        setHex(x, y, baseHex, 0.08);
      }
    }
  }
}

function buildAtlasCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = ATLAS_SIZE;
  canvas.height = ATLAS_SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('无法创建 2D Canvas 上下文以生成 Minecraft 体素图集');
  }
  const imageData = ctx.createImageData(ATLAS_SIZE, ATLAS_SIZE);

  // 0: 草方块顶面（鲜绿草皮 + 随机深浅草叶像素）
  paintNoiseBlock(imageData, 'grass_top', '#68ba38', '#54a329', 0.32, 0.08);

  // 1: 草方块侧面（上方 3~5 像素锯齿状草边 + 下方泥土）
  {
    const { setHex } = createTilePainter(imageData, 'grass_side');
    const fringe = [4, 3, 5, 4, 3, 4, 5, 3, 4, 5, 4, 3, 4, 5, 3, 4];
    for (let y = 0; y < TILE_PX; y += 1) {
      for (let x = 0; x < TILE_PX; x += 1) {
        if (y < fringe[x]) {
          setHex(x, y, y === 0 ? '#74c740' : '#5eb030', 0.08);
        } else if (y === fringe[x]) {
          setHex(x, y, '#4e3924', 0.06);
        } else {
          const pebble = pixelNoise(31, x, y) > 0.65;
          setHex(x, y, pebble ? '#78573d' : '#916849', 0.08);
        }
      }
    }
  }

  // 2: 泥土
  paintNoiseBlock(imageData, 'dirt', '#916849', '#755237', 0.28, 0.08);

  // 3: 石头（横向层理像素）
  {
    const { setHex } = createTilePainter(imageData, 'stone');
    for (let y = 0; y < TILE_PX; y += 1) {
      for (let x = 0; x < TILE_PX; x += 1) {
        const n = pixelNoise(43, Math.floor(x / 2), y);
        const hex = n > 0.45 ? '#9ba0a8' : n < -0.45 ? '#757a82' : '#898e96';
        setHex(x, y, hex, 0.08);
      }
    }
  }

  // 4: 石砖（经典交错大砖块 + 1px 深色灰缝）
  {
    const { setHex } = createTilePainter(imageData, 'stone_brick');
    for (let y = 0; y < TILE_PX; y += 1) {
      const topHalf = y < 8;
      for (let x = 0; x < TILE_PX; x += 1) {
        const mortarH = y === 0 || y === 8;
        const mortarV = topHalf ? x === 0 || x === 8 : x === 4 || x === 12;
        const highlight = y === 1 || y === 9;
        if (mortarH || mortarV) {
          setHex(x, y, '#5b606b', 0.06);
        } else if (highlight) {
          setHex(x, y, '#a8aeb8', 0.08);
        } else {
          setHex(x, y, '#8e949f', 0.08);
        }
      }
    }
  }

  // 5: 圆石（台阶/室外步道）
  {
    const { setHex } = createTilePainter(imageData, 'cobblestone');
    for (let y = 0; y < TILE_PX; y += 1) {
      for (let x = 0; x < TILE_PX; x += 1) {
        const seam = (x % 5 === 0 && y % 4 < 3) || (y % 4 === 0 && (x + Math.floor(y / 4) * 2) % 5 < 4);
        setHex(x, y, seam ? '#595d66' : '#858a94', 0.08);
      }
    }
  }

  // 6: 水方块（半透明像素蓝水 + 亮色波纹）
  {
    const { setHex } = createTilePainter(imageData, 'water');
    for (let y = 0; y < TILE_PX; y += 1) {
      for (let x = 0; x < TILE_PX; x += 1) {
        const ripple = (y === 3 || y === 11) && (x >= 2 && x <= 7 || x >= 11 && x <= 14);
        setHex(x, y, ripple ? '#64b8ff' : '#2e7fe0', 0.08, 215);
      }
    }
  }

  // 7: 沙子
  paintNoiseBlock(imageData, 'sand', '#e2d59b', '#cfc083', 0.25, 0.08);

  // 8: 橡木木板（明亮饱和经典蜂蜜橡木色）
  paintPlanks(imageData, 'oak_planks', '#c4965c', '#d6aa70', '#8f673a');

  // 9: 云杉木板
  paintPlanks(imageData, 'spruce_planks', '#855f3b', '#997049', '#5e4126');

  // 10: 橡木原木侧面（竖向树皮纹理）
  {
    const { setHex } = createTilePainter(imageData, 'oak_log_side');
    for (let y = 0; y < TILE_PX; y += 1) {
      for (let x = 0; x < TILE_PX; x += 1) {
        const stripe = x % 4 === 0 || (x % 4 === 2 && (y + x) % 5 === 0);
        setHex(x, y, stripe ? '#574126' : '#7a5c39', 0.08);
      }
    }
  }

  // 11: 橡木原木顶面（年轮）
  {
    const { setHex } = createTilePainter(imageData, 'oak_log_top');
    for (let y = 0; y < TILE_PX; y += 1) {
      for (let x = 0; x < TILE_PX; x += 1) {
        const d = Math.max(Math.abs(x - 7.5), Math.abs(y - 7.5));
        if (d > 6.4) {
          setHex(x, y, '#694f30', 0.08);
        } else if (Math.floor(d) % 2 === 0) {
          setHex(x, y, '#cca770', 0.08);
        } else {
          setHex(x, y, '#a4804e', 0.08);
        }
      }
    }
  }

  // 12: 树叶（饱和浓绿像素 + 少量透空像素缝）
  {
    const { setHex, setPx } = createTilePainter(imageData, 'oak_leaves');
    for (let y = 0; y < TILE_PX; y += 1) {
      for (let x = 0; x < TILE_PX; x += 1) {
        const n = pixelNoise(109, x, y);
        if (n < -0.78 && (x + y) % 2 === 0) {
          setPx(x, y, 0, 0, 0, 0);
        } else if (n > 0.35) {
          setHex(x, y, '#60b83a', 0.08);
        } else if (n < -0.25) {
          setHex(x, y, '#327820', 0.08);
        } else {
          setHex(x, y, '#479c2b', 0.08);
        }
      }
    }
  }

  // 13: 玻璃方块（像素白边 + 斜向高光像素 + 半透中心）
  {
    const { setHex } = createTilePainter(imageData, 'glass');
    for (let y = 0; y < TILE_PX; y += 1) {
      for (let x = 0; x < TILE_PX; x += 1) {
        const isBorder = x === 0 || x === 15 || y === 0 || y === 15;
        const isGlint =
          (x === 3 && y === 4) || (x === 4 && y === 3)
          || (x === 4 && y === 5) || (x === 5 && y === 4)
          || (x === 11 && y === 12) || (x === 12 && y === 11);
        if (isBorder) {
          setHex(x, y, '#d9f2ff', 0.06, 240);
        } else if (isGlint) {
          setHex(x, y, '#f4fbff', 0.04, 210);
        } else {
          setHex(x, y, '#9fdcff', 0.05, 60);
        }
      }
    }
  }

  // 14: 书架（上下橡木板 + 两排彩色像素书脊）
  {
    const { setHex, setPx } = createTilePainter(imageData, 'bookshelf');
    const bookColors = ['#b83227', '#2b6cb0', '#2f855a', '#d69e2e', '#805ad5', '#cbd5e0', '#c05621'];
    for (let y = 0; y < TILE_PX; y += 1) {
      for (let x = 0; x < TILE_PX; x += 1) {
        if (y <= 1 || y === 7 || y === 8 || y >= 14) {
          setHex(x, y, y === 1 || y === 8 || y === 14 ? '#8a6438' : '#b88b54', 0.07);
        } else {
          const shelfRow = y < 7 ? 0 : 1;
          const bookIdx = Math.floor(x / 2);
          if (x % 2 === 0 || (y === 2 && bookIdx % 3 === 0) || (y === 9 && bookIdx % 2 === 1)) {
            const colorHex = bookColors[(bookIdx + shelfRow * 3) % bookColors.length];
            setHex(x, y, colorHex, 0.08);
          } else {
            const colorHex = bookColors[(bookIdx + shelfRow * 3) % bookColors.length];
            const rgb = hexToRgb(colorHex);
            setPx(x, y, rgb.r * 0.78, rgb.g * 0.78, rgb.b * 0.78, 255);
          }
        }
      }
    }
  }

  // 15: 橡木门上半（经典 4 格门窗 + 橡木框）
  {
    const { setHex } = createTilePainter(imageData, 'oak_door_top');
    for (let y = 0; y < TILE_PX; y += 1) {
      for (let x = 0; x < TILE_PX; x += 1) {
        const inWindow =
          ((x >= 3 && x <= 6) || (x >= 9 && x <= 12))
          && ((y >= 3 && y <= 6) || (y >= 9 && y <= 12));
        const isEdge = x === 0 || x === 15 || y === 0;
        if (inWindow) {
          setHex(x, y, '#a4defc', 0.06);
        } else if (isEdge) {
          setHex(x, y, '#6e4d28', 0.06);
        } else {
          setHex(x, y, '#a87c47', 0.08);
        }
      }
    }
  }

  // 16: 橡木门下半（木镶板 + 铁把手）
  {
    const { setHex } = createTilePainter(imageData, 'oak_door_bottom');
    for (let y = 0; y < TILE_PX; y += 1) {
      for (let x = 0; x < TILE_PX; x += 1) {
        const isHandle = (x === 12 || x === 13) && (y === 2 || y === 3);
        const isRecess = x >= 3 && x <= 12 && y >= 4 && y <= 12;
        const isEdge = x === 0 || x === 15 || y === 15;
        if (isHandle) {
          setHex(x, y, '#3d444d', 0.05);
        } else if (isEdge) {
          setHex(x, y, '#6e4d28', 0.06);
        } else if (isRecess) {
          setHex(x, y, '#926939', 0.08);
        } else {
          setHex(x, y, '#b0834c', 0.08);
        }
      }
    }
  }

  // 17~19: 铁块、金块、深灰铁块
  paintMetalBlock(imageData, 'iron_block', '#d6dbe0', '#eef2f6', '#9ea6b0');
  paintMetalBlock(imageData, 'gold_block', '#f2c82e', '#ffea75', '#bd8b16');
  paintMetalBlock(imageData, 'dark_iron', '#3b424e', '#4f5868', '#232830');

  // 20: 灯笼（清晰深铁笼框 + 琥珀玻璃与暖黄灯芯，白天不发光亦可清晰辨识结构）
  {
    const { setHex } = createTilePainter(imageData, 'lantern');
    for (let y = 0; y < TILE_PX; y += 1) {
      for (let x = 0; x < TILE_PX; x += 1) {
        const isOuterFrame = x <= 1 || x >= 14 || y <= 2 || y >= 13;
        const isCageBar = (x === 5 || x === 10) && (y >= 3 && y <= 12);
        const isCore = x >= 6 && x <= 9 && y >= 5 && y <= 10;
        if (isOuterFrame || isCageBar) {
          setHex(x, y, '#2d333d', 0.07);
        } else if (isCore) {
          setHex(x, y, '#ffe985', 0.06);
        } else {
          setHex(x, y, '#e89d2c', 0.08);
        }
      }
    }
  }

  // 21: 点亮的红石灯
  {
    const { setHex } = createTilePainter(imageData, 'redstone_lamp_on');
    for (let y = 0; y < TILE_PX; y += 1) {
      for (let x = 0; x < TILE_PX; x += 1) {
        const isBorder = x === 0 || x === 15 || y === 0 || y === 15;
        const isGrid = x === 7 || x === 8 || y === 7 || y === 8;
        const isCenter = x >= 4 && x <= 11 && y >= 4 && y <= 11;
        if (isBorder) {
          setHex(x, y, '#7d4d22', 0.07);
        } else if (isGrid) {
          setHex(x, y, '#c97e30', 0.07);
        } else if (isCenter) {
          setHex(x, y, '#fff3b8', 0.06);
        } else {
          setHex(x, y, '#ffcf66', 0.08);
        }
      }
    }
  }

  // 22: 熄灭的红石灯
  {
    const { setHex } = createTilePainter(imageData, 'redstone_lamp_off');
    for (let y = 0; y < TILE_PX; y += 1) {
      for (let x = 0; x < TILE_PX; x += 1) {
        const isBorder = x === 0 || x === 15 || y === 0 || y === 15;
        const isGrid = x === 7 || x === 8 || y === 7 || y === 8;
        if (isBorder) {
          setHex(x, y, '#47301b', 0.07);
        } else if (isGrid) {
          setHex(x, y, '#5c3f24', 0.07);
        } else {
          setHex(x, y, '#7d5b3b', 0.08);
        }
      }
    }
  }

  // 23: 熄灭屏幕
  {
    const { setHex } = createTilePainter(imageData, 'screen_off');
    for (let y = 0; y < TILE_PX; y += 1) {
      for (let x = 0; x < TILE_PX; x += 1) {
        const isBorder = x === 0 || x === 15 || y === 0 || y === 15;
        const isGlint = (x === 2 && y === 3) || (x === 3 && y === 2);
        if (isBorder) {
          setHex(x, y, '#1b222c', 0.06);
        } else if (isGlint) {
          setHex(x, y, '#364559', 0.06);
        } else {
          setHex(x, y, '#101620', 0.08);
        }
      }
    }
  }

  // 24~31, 40~41: 多种羊毛
  paintWool(imageData, 'wool_white', '#eceee9', '#d7dad2');
  paintWool(imageData, 'wool_light_gray', '#a3a59e', '#8c8f88');
  paintWool(imageData, 'wool_cyan', '#199d9d', '#148282');
  paintWool(imageData, 'wool_blue', '#3b58b8', '#2f4799');
  paintWool(imageData, 'wool_green', '#60ad1b', '#4d8f14');
  paintWool(imageData, 'wool_red', '#b8322a', '#96251f');
  paintWool(imageData, 'wool_yellow', '#f5cf38', '#d9b125');
  paintWool(imageData, 'wool_purple', '#8b35bd', '#72279e');
  paintWool(imageData, 'wool_orange', '#f08222', '#cf6b16');
  paintWool(imageData, 'wool_brown', '#825533', '#694326');

  // 32~34: Minecraft 木箱（邮件托盘）
  {
    const paintChestFace = (tileId: VoxelTileId, hasLatch: boolean, hasSeam: boolean) => {
      const { setHex } = createTilePainter(imageData, tileId);
      for (let y = 0; y < TILE_PX; y += 1) {
        for (let x = 0; x < TILE_PX; x += 1) {
          const isBorder = x === 0 || x === 15 || y === 0 || y === 15;
          const isSeam = hasSeam && y === 5;
          const isLatch = hasLatch && x >= 7 && x <= 8 && y >= 4 && y <= 7;
          if (isLatch) {
            setHex(x, y, y === 4 ? '#f2e8c9' : '#c8ccd4', 0.06);
          } else if (isBorder || isSeam) {
            setHex(x, y, '#4a3118', 0.06);
          } else {
            setHex(x, y, y % 3 === 0 ? '#a8763c' : '#be8947', 0.08);
          }
        }
      }
    };
    paintChestFace('chest_front', true, true);
    paintChestFace('chest_side', false, true);
    paintChestFace('chest_top', false, false);
  }

  // 35: 方块键盘顶面（像素键帽阵列）
  {
    const { setHex } = createTilePainter(imageData, 'keyboard_top');
    for (let y = 0; y < TILE_PX; y += 1) {
      for (let x = 0; x < TILE_PX; x += 1) {
        const isRim = x === 0 || x === 15 || y === 0 || y === 15;
        const isSpace = y >= 12 && y <= 13 && x >= 4 && x <= 11;
        const isKey = !isRim && y >= 2 && y <= 13 && x >= 2 && x <= 13 && (y % 2 === 0) && (x % 2 === 0);
        if (isRim) {
          setHex(x, y, '#252b36', 0.06);
        } else if (isSpace) {
          setHex(x, y, '#6b778c', 0.06);
        } else if (isKey) {
          setHex(x, y, x === 2 && y === 2 ? '#38e8ff' : '#9aa6b8', 0.08);
        } else {
          setHex(x, y, '#1c222c', 0.07);
        }
      }
    }
  }

  // 36: 红陶花盆
  paintNoiseBlock(imageData, 'terracotta', '#a15f44', '#864c34', 0.28, 0.08);

  // 37: 白色马克杯
  {
    const { setHex } = createTilePainter(imageData, 'mug_white');
    for (let y = 0; y < TILE_PX; y += 1) {
      for (let x = 0; x < TILE_PX; x += 1) {
        setHex(x, y, y <= 1 ? '#5c3c24' : '#eef3f8', 0.06);
      }
    }
  }

  // 38: 邮件包裹方块（牛皮纸 + 彩带封签）
  {
    const { setHex } = createTilePainter(imageData, 'mail_parcel');
    for (let y = 0; y < TILE_PX; y += 1) {
      for (let x = 0; x < TILE_PX; x += 1) {
        const isRibbon = x === 7 || x === 8 || y === 7 || y === 8;
        const isSeal = x >= 6 && x <= 9 && y >= 6 && y <= 9;
        const isEdge = x === 0 || x === 15 || y === 0 || y === 15;
        if (isSeal) {
          setHex(x, y, '#ef4444', 0.06);
        } else if (isRibbon) {
          setHex(x, y, '#f8fafc', 0.06);
        } else if (isEdge) {
          setHex(x, y, '#9c7448', 0.06);
        } else {
          setHex(x, y, '#d8b07c', 0.08);
        }
      }
    }
  }

  // 39: PC 机箱网孔面板
  {
    const { setHex } = createTilePainter(imageData, 'pc_mesh');
    for (let y = 0; y < TILE_PX; y += 1) {
      for (let x = 0; x < TILE_PX; x += 1) {
        const isBorder = x <= 1 || x >= 14 || y <= 1 || y >= 14;
        const isHole = !isBorder && (x + y) % 2 === 0;
        if (isBorder) {
          setHex(x, y, '#38404d', 0.07);
        } else if (isHole) {
          setHex(x, y, '#141922', 0.06);
        } else {
          setHex(x, y, '#2a313d', 0.08);
        }
      }
    }
  }

  // 42~43: 红花与黄花（桌面花盆点缀）
  paintNoiseBlock(imageData, 'flower_red', '#e53e3e', '#f56565', 0.4, 0.08);
  paintNoiseBlock(imageData, 'flower_yellow', '#f6e05e', '#ecc94b', 0.4, 0.08);

  // 44: 石英块
  paintMetalBlock(imageData, 'quartz_block', '#ece8de', '#f7f5ee', '#cfc9bc');

  // 45: 深色橡木板
  paintPlanks(imageData, 'dark_oak_planks', '#54381e', '#654426', '#3a2513');

  // 46: 萤石
  paintNoiseBlock(imageData, 'glowstone', '#f5ca56', '#fff2a6', 0.38, 0.08);

  // 47: 绿宝石块
  paintMetalBlock(imageData, 'emerald_block', '#2ecc71', '#6ef0a4', '#1e944f');

  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

export interface VoxelMaterialSet {
  atlasTexture: THREE.CanvasTexture;
  opaque: THREE.MeshLambertMaterial;
  cutout: THREE.MeshLambertMaterial;
  glass: THREE.MeshLambertMaterial;
  water: THREE.MeshLambertMaterial;
  emissive: THREE.MeshLambertMaterial;
  syncTheme: (mode: OfficeSceneThemeMode) => void;
  dispose: () => void;
}

function markShared(mat: THREE.Material): void {
  mat.userData.sharedVoxelMaterial = true;
}

export function createVoxelMaterialSet(): VoxelMaterialSet {
  const canvas = buildAtlasCanvas();
  const atlasTexture = new THREE.CanvasTexture(canvas);
  atlasTexture.magFilter = THREE.NearestFilter;
  atlasTexture.minFilter = THREE.NearestFilter;
  atlasTexture.generateMipmaps = false;
  atlasTexture.colorSpace = THREE.SRGBColorSpace;
  atlasTexture.wrapS = THREE.ClampToEdgeWrapping;
  atlasTexture.wrapT = THREE.ClampToEdgeWrapping;
  atlasTexture.userData.sharedVoxelTexture = true;
  atlasTexture.needsUpdate = true;

  const opaque = new THREE.MeshLambertMaterial({
    map: atlasTexture,
    vertexColors: true,
  });

  const cutout = new THREE.MeshLambertMaterial({
    map: atlasTexture,
    vertexColors: true,
    alphaTest: 0.5,
    side: THREE.DoubleSide,
  });

  const glass = new THREE.MeshLambertMaterial({
    map: atlasTexture,
    vertexColors: true,
    transparent: true,
    opacity: 0.82,
    depthWrite: false,
  });

  const water = new THREE.MeshLambertMaterial({
    map: atlasTexture,
    vertexColors: true,
    transparent: true,
    opacity: 0.74,
    depthWrite: false,
  });

  const emissive = new THREE.MeshLambertMaterial({
    map: atlasTexture,
    vertexColors: true,
    emissive: new THREE.Color('#ffffff'),
    emissiveMap: atlasTexture,
    emissiveIntensity: 0.85,
  });

  markShared(opaque);
  markShared(cutout);
  markShared(glass);
  markShared(water);
  markShared(emissive);

  const syncTheme = (mode: OfficeSceneThemeMode): void => {
    // 白天压低自发光使灯笼/红石灯呈现清晰实体轮廓；夜晚高自发光提供暖色亮点
    emissive.emissiveIntensity = mode === 'dark' ? 1.25 : 0.16;
    glass.opacity = mode === 'dark' ? 0.78 : 0.84;
    water.opacity = mode === 'dark' ? 0.72 : 0.78;
  };

  const dispose = (): void => {
    atlasTexture.dispose();
    opaque.dispose();
    cutout.dispose();
    glass.dispose();
    water.dispose();
    emissive.dispose();
  };

  return {
    atlasTexture,
    opaque,
    cutout,
    glass,
    water,
    emissive,
    syncTheme,
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
