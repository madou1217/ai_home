import * as THREE from 'three';
import {
  createSolidColorVoxelGeometry,
  VoxelBoxBuilder,
  VoxelGrid,
  type SolidColorBoxInput,
} from './office-voxel-builder';

/**
 * 可复用的 Minecraft 体素套件：
 * - 方块橡树（原木树干 + 阶梯树冠）
 * - 书架柱
 * - 12 根长方体拼成的发光描边方框（工位选中框 / 显示器编辑框）
 * - Minecraft 风格木箱（邮件托盘）
 * - 吊挂灯笼（铁框 + 暖光芯）
 * - 方块云群、方块太阳/月亮、方块星点
 * - 3 段直线折线脉冲轨道与粒子采样器
 */

function seededNext(state: { value: number }): number {
  state.value = (Math.imul(state.value, 1664525) + 1013904223) >>> 0;
  return state.value / 4294967296;
}

/** 在整数网格中种植一棵经典 Minecraft 橡树 */
export function addOakTreeToGrid(
  grid: VoxelGrid,
  tx: number,
  baseY: number,
  tz: number,
  trunkHeight = 4,
  seed = 17
): void {
  const rng = { value: seed >>> 0 };
  const logSpec = {
    tiles: { top: 'oak_log_top' as const, bottom: 'oak_log_top' as const, side: 'oak_log_side' as const },
    layer: 'opaque' as const,
  };
  const leafSpec = {
    tiles: 'oak_leaves' as const,
    layer: 'cutout' as const,
    occludes: false,
  };

  for (let y = 0; y < trunkHeight; y += 1) {
    grid.set(tx, baseY + y, tz, logSpec);
  }

  const canopyBase = baseY + trunkHeight - 1;
  // 底部两层 5×5（去掉四角增强方块树冠轮廓）
  for (let dy = 0; dy <= 1; dy += 1) {
    for (let dx = -2; dx <= 2; dx += 1) {
      for (let dz = -2; dz <= 2; dz += 1) {
        if (dx === 0 && dz === 0 && dy === 0) continue;
        const isCorner = Math.abs(dx) === 2 && Math.abs(dz) === 2;
        if (isCorner && (dy === 1 || seededNext(rng) > 0.35)) continue;
        grid.set(tx + dx, canopyBase + dy, tz + dz, leafSpec);
      }
    }
  }
  // 第 3 层 3×3
  for (let dx = -1; dx <= 1; dx += 1) {
    for (let dz = -1; dz <= 1; dz += 1) {
      const isCorner = Math.abs(dx) === 1 && Math.abs(dz) === 1;
      if (isCorner && seededNext(rng) > 0.55) continue;
      grid.set(tx + dx, canopyBase + 2, tz + dz, leafSpec);
    }
  }
  // 顶层十字冠
  grid.set(tx, canopyBase + 3, tz, leafSpec);
  grid.set(tx - 1, canopyBase + 3, tz, leafSpec);
  grid.set(tx + 1, canopyBase + 3, tz, leafSpec);
  grid.set(tx, canopyBase + 3, tz - 1, leafSpec);
  grid.set(tx, canopyBase + 3, tz + 1, leafSpec);
}

/** 在整数网格中放置一列书架 */
export function addBookshelfColumnToGrid(
  grid: VoxelGrid,
  x: number,
  baseY: number,
  z: number,
  height = 2
): void {
  const shelfSpec = {
    tiles: { top: 'oak_planks' as const, bottom: 'oak_planks' as const, side: 'bookshelf' as const },
    layer: 'opaque' as const,
  };
  for (let dy = 0; dy < height; dy += 1) {
    grid.set(x, baseY + dy, z, shelfSpec);
  }
}

/**
 * 用 12 根细长轴对齐方体拼成一个发光描边方框（合批为 1 个 BufferGeometry）。
 * 方框围绕原点居中于 X/Z，底部从 y = 0 到 y = height（或居中于 Y，由 centerY 控制）。
 */
export function createWireframeBoxGeometry(
  width: number,
  height: number,
  depth: number,
  thickness = 0.03125,
  centerY = false
): THREE.BufferGeometry {
  const hw = width * 0.5;
  const hd = depth * 0.5;
  const yMin = centerY ? -height * 0.5 : 0;
  const yMax = centerY ? height * 0.5 : height;
  const t = thickness;
  const ht = t * 0.5;

  const bars: SolidColorBoxInput[] = [
    // 底面 4 边
    { minX: -hw - ht, minY: yMin, minZ: -hd - ht, maxX: hw + ht, maxY: yMin + t, maxZ: -hd + ht, shadeFaces: false },
    { minX: -hw - ht, minY: yMin, minZ: hd - ht, maxX: hw + ht, maxY: yMin + t, maxZ: hd + ht, shadeFaces: false },
    { minX: -hw - ht, minY: yMin, minZ: -hd + ht, maxX: -hw + ht, maxY: yMin + t, maxZ: hd - ht, shadeFaces: false },
    { minX: hw - ht, minY: yMin, minZ: -hd + ht, maxX: hw + ht, maxY: yMin + t, maxZ: hd - ht, shadeFaces: false },
    // 顶面 4 边
    { minX: -hw - ht, minY: yMax - t, minZ: -hd - ht, maxX: hw + ht, maxY: yMax, maxZ: -hd + ht, shadeFaces: false },
    { minX: -hw - ht, minY: yMax - t, minZ: hd - ht, maxX: hw + ht, maxY: yMax, maxZ: hd + ht, shadeFaces: false },
    { minX: -hw - ht, minY: yMax - t, minZ: -hd + ht, maxX: -hw + ht, maxY: yMax, maxZ: hd - ht, shadeFaces: false },
    { minX: hw - ht, minY: yMax - t, minZ: -hd + ht, maxX: hw + ht, maxY: yMax, maxZ: hd - ht, shadeFaces: false },
    // 4 根立柱
    { minX: -hw - ht, minY: yMin + t, minZ: -hd - ht, maxX: -hw + ht, maxY: yMax - t, maxZ: -hd + ht, shadeFaces: false },
    { minX: hw - ht, minY: yMin + t, minZ: -hd - ht, maxX: hw + ht, maxY: yMax - t, maxZ: -hd + ht, shadeFaces: false },
    { minX: -hw - ht, minY: yMin + t, minZ: hd - ht, maxX: -hw + ht, maxY: yMax - t, maxZ: hd + ht, shadeFaces: false },
    { minX: hw - ht, minY: yMin + t, minZ: hd - ht, maxX: hw + ht, maxY: yMax - t, maxZ: hd + ht, shadeFaces: false },
  ];

  return createSolidColorVoxelGeometry(bars);
}

/** 构建经典 Minecraft 木箱几何（箱体 + 正面突出锁扣，底部位于 y = 0） */
export function createVoxelChestGeometry(
  width = 0.25,
  height = 0.25,
  depth = 0.25
): THREE.BufferGeometry {
  const builder = new VoxelBoxBuilder();
  const hw = width * 0.5;
  const hd = depth * 0.5;
  builder.addBox({
    minX: -hw,
    minY: 0,
    minZ: -hd,
    maxX: hw,
    maxY: height,
    maxZ: hd,
    tiles: {
      pz: 'chest_front',
      nz: 'chest_side',
      px: 'chest_side',
      nx: 'chest_side',
      py: 'chest_top',
      ny: 'chest_top',
    },
    floorY: 0,
  });
  // 正面锁扣凸块
  const latchW = 0.0625;
  const latchH = 0.0625;
  builder.addBox({
    minX: -latchW * 0.5,
    minY: height * 0.52,
    minZ: hd,
    maxX: latchW * 0.5,
    maxY: height * 0.52 + latchH,
    maxZ: hd + 0.03125,
    tiles: 'iron_block',
    occludes: false,
  });
  return builder.build(true);
}

/** 构建悬吊灯笼几何（返回铁链顶盖框架几何 + 发光核心几何，原点在悬挂点顶部） */
export function createVoxelLanternGeometry(chainLength = 0.5): {
  frameGeo: THREE.BufferGeometry;
  glowGeo: THREE.BufferGeometry;
} {
  const frameBuilder = new VoxelBoxBuilder();
  // 细长铁链立柱
  frameBuilder.addBox({
    minX: -0.03125,
    minY: -chainLength,
    minZ: -0.03125,
    maxX: 0.03125,
    maxY: 0,
    maxZ: 0.03125,
    tiles: 'dark_iron',
  });
  // 灯笼顶帽
  frameBuilder.addBox({
    minX: -0.125,
    minY: -chainLength - 0.0625,
    minZ: -0.125,
    maxX: 0.125,
    maxY: -chainLength,
    maxZ: 0.125,
    tiles: 'dark_iron',
  });
  // 灯笼底托
  frameBuilder.addBox({
    minX: -0.1875,
    minY: -chainLength - 0.375,
    minZ: -0.1875,
    maxX: 0.1875,
    maxY: -chainLength - 0.3125,
    maxZ: 0.1875,
    tiles: 'dark_iron',
  });

  const glowBuilder = new VoxelBoxBuilder();
  glowBuilder.addBox({
    minX: -0.15625,
    minY: -chainLength - 0.3125,
    minZ: -0.15625,
    maxX: 0.15625,
    maxY: -chainLength - 0.0625,
    maxZ: 0.15625,
    tiles: 'lantern',
  });

  return {
    frameGeo: frameBuilder.build(false),
    glowGeo: glowBuilder.build(false),
  };
}

/** 构建漂浮在天空中的 Minecraft 方块云群（单次合批 Draw Call） */
export function createBlockyCloudGeometry(
  spanX = 56,
  spanZ = 56,
  cloudCount = 16,
  seed = 2026
): THREE.BufferGeometry {
  const rng = { value: seed >>> 0 };
  const boxes: SolidColorBoxInput[] = [];

  for (let i = 0; i < cloudCount; i += 1) {
    const cx = (seededNext(rng) - 0.5) * spanX;
    const cz = (seededNext(rng) - 0.5) * spanZ;
    const cy = Math.floor(seededNext(rng) * 3) * 0.5;
    const w = 3 + Math.floor(seededNext(rng) * 5);
    const d = 2 + Math.floor(seededNext(rng) * 3);
    const h = 0.75;

    boxes.push({
      minX: cx - w * 0.5,
      minY: cy,
      minZ: cz - d * 0.5,
      maxX: cx + w * 0.5,
      maxY: cy + h,
      maxZ: cz + d * 0.5,
      color: '#ffffff',
      shadeFaces: true,
    });

    // 附加侧翼方块，还原经典不规则长条方块云造型
    if (seededNext(rng) > 0.3) {
      const wingW = Math.max(2, Math.floor(w * 0.6));
      const wingD = Math.max(1, Math.floor(d * 0.7));
      const offX = (seededNext(rng) > 0.5 ? 1 : -1) * (w * 0.25);
      const offZ = (seededNext(rng) > 0.5 ? 1 : -1) * (d * 0.5);
      boxes.push({
        minX: cx + offX - wingW * 0.5,
        minY: cy,
        minZ: cz + offZ - wingD * 0.5,
        maxX: cx + offX + wingW * 0.5,
        maxY: cy + h,
        maxZ: cz + offZ + wingD * 0.5,
        color: '#ffffff',
        shadeFaces: true,
      });
    }
  }

  return createSolidColorVoxelGeometry(boxes);
}

/** 构建夜晚高空方块星点群（单次合批 Draw Call） */
export function createStarFieldGeometry(
  minRadius = 28,
  maxRadius = 42,
  count = 88,
  seed = 9001
): THREE.BufferGeometry {
  const rng = { value: seed >>> 0 };
  const boxes: SolidColorBoxInput[] = [];

  for (let i = 0; i < count; i += 1) {
    const theta = seededNext(rng) * Math.PI * 2;
    const elev = 0.28 + seededNext(rng) * 1.12;
    const dist = minRadius + seededNext(rng) * (maxRadius - minRadius);
    const x = Math.cos(theta) * Math.cos(elev) * dist;
    const y = Math.sin(elev) * dist + 4;
    const z = Math.sin(theta) * Math.cos(elev) * dist;
    const size = seededNext(rng) > 0.75 ? 0.25 : 0.16;
    const half = size * 0.5;
    boxes.push({
      minX: x - half,
      minY: y - half,
      minZ: z - half,
      maxX: x + half,
      maxY: y + half,
      maxZ: z + half,
      color: seededNext(rng) > 0.8 ? '#cfe6ff' : '#ffffff',
      shadeFaces: false,
    });
  }

  return createSolidColorVoxelGeometry(boxes);
}

/** 构建 3 段直线折线轨道几何（替代旧 CatmullRom 弧线，全部轴对齐长方体） */
export function createRectilinearPulseGuideGeometry(
  points: readonly [THREE.Vector3, THREE.Vector3, THREE.Vector3, THREE.Vector3],
  thickness = 0.015625
): THREE.BufferGeometry {
  const boxes: SolidColorBoxInput[] = [];
  const half = thickness * 0.5;
  for (let i = 0; i < 3; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    boxes.push({
      minX: Math.min(a.x, b.x) - half,
      minY: Math.min(a.y, b.y) - half,
      minZ: Math.min(a.z, b.z) - half,
      maxX: Math.max(a.x, b.x) + half,
      maxY: Math.max(a.y, b.y) + half,
      maxZ: Math.max(a.z, b.z) + half,
      shadeFaces: false,
    });
  }
  return createSolidColorVoxelGeometry(boxes);
}

/** 沿 3 段直线折线按长度比例线性采样位置 */
export function sampleRectilinearPath(
  points: readonly [THREE.Vector3, THREE.Vector3, THREE.Vector3, THREE.Vector3],
  u: number,
  out: THREE.Vector3
): THREE.Vector3 {
  const len0 = points[0].distanceTo(points[1]);
  const len1 = points[1].distanceTo(points[2]);
  const len2 = points[2].distanceTo(points[3]);
  const total = Math.max(1e-5, len0 + len1 + len2);
  const clamped = ((u % 1) + 1) % 1;
  const dist = clamped * total;

  if (dist <= len0) {
    const t = len0 > 1e-5 ? dist / len0 : 0;
    return out.lerpVectors(points[0], points[1], t);
  }
  if (dist <= len0 + len1) {
    const t = len1 > 1e-5 ? (dist - len0) / len1 : 0;
    return out.lerpVectors(points[1], points[2], t);
  }
  const t = len2 > 1e-5 ? (dist - len0 - len1) / len2 : 0;
  return out.lerpVectors(points[2], points[3], t);
}
