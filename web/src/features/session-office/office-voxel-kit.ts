import * as THREE from 'three';
import {
  createSolidColorVoxelGeometry,
  VoxelBoxBuilder,
  VoxelGrid,
  type SolidColorBoxInput,
} from './office-voxel-builder';

/**
 * 可复用的 Minecraft 体素套件：
 * - 方块橡树与白桦树（原木树干 + 分层阶梯树冠）
 * - 书架柱
 * - 地面贴地发光工位选中角标框（不遮挡近距读屏视野）与传统 12 棱描边框
 * - Minecraft 风格木箱与精细铁链吊挂灯笼
 * - 阶梯分层方块云群、远空星点与接触阴影合批面片
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
  // 底部两层 5×5（去掉部分四角形成自然方块层次）
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

/** 在整数网格中种植一棵轻盈明快的 Minecraft 白桦树 */
export function addBirchTreeToGrid(
  grid: VoxelGrid,
  tx: number,
  baseY: number,
  tz: number,
  trunkHeight = 5,
  seed = 73
): void {
  const rng = { value: seed >>> 0 };
  const logSpec = {
    tiles: { top: 'birch_log_top' as const, bottom: 'birch_log_top' as const, side: 'birch_log_side' as const },
    layer: 'opaque' as const,
  };
  const leafSpec = {
    tiles: 'birch_leaves' as const,
    layer: 'cutout' as const,
    occludes: false,
  };

  for (let y = 0; y < trunkHeight; y += 1) {
    grid.set(tx, baseY + y, tz, logSpec);
  }

  const canopyBase = baseY + trunkHeight - 2;
  for (let dy = 0; dy <= 1; dy += 1) {
    for (let dx = -2; dx <= 2; dx += 1) {
      for (let dz = -2; dz <= 2; dz += 1) {
        if (dx === 0 && dz === 0) continue;
        const isCorner = Math.abs(dx) === 2 && Math.abs(dz) === 2;
        if (isCorner && (dy === 1 || seededNext(rng) > 0.45)) continue;
        grid.set(tx + dx, canopyBase + dy, tz + dz, leafSpec);
      }
    }
  }
  for (let dx = -1; dx <= 1; dx += 1) {
    for (let dz = -1; dz <= 1; dz += 1) {
      if (dx === 0 && dz === 0) continue;
      if (Math.abs(dx) === 1 && Math.abs(dz) === 1 && seededNext(rng) > 0.4) continue;
      grid.set(tx + dx, canopyBase + 2, tz + dz, leafSpec);
    }
  }
  grid.set(tx, canopyBase + 2, tz, leafSpec);
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
 * 构建贴地式工位高亮围框 + 四角低矮发光立标（合批为 1 个 BufferGeometry）：
 * - 在等距/全景/走廊视角下清晰标示当前选中的工位边界；
 * - 绝不向高空伸出遮挡显示器屏幕的横杆，近距读屏也能保持优雅。
 */
export function createStationSelectionFrameGeometry(
  width: number,
  depth: number,
  barThickness = 0.028,
  cornerPostHeight = 0.14
): THREE.BufferGeometry {
  const hw = width * 0.5;
  const hd = depth * 0.5;
  const t = barThickness;
  const ht = t * 0.5;
  const y0 = 0.036;
  const y1 = y0 + t * 0.72;
  const cornerSpan = Math.min(0.32, Math.min(width, depth) * 0.22);

  const bars: SolidColorBoxInput[] = [
    // 四边贴地发光围框
    { minX: -hw - ht, minY: y0, minZ: -hd - ht, maxX: hw + ht, maxY: y1, maxZ: -hd + ht, shadeFaces: false },
    { minX: -hw - ht, minY: y0, minZ: hd - ht, maxX: hw + ht, maxY: y1, maxZ: hd + ht, shadeFaces: false },
    { minX: -hw - ht, minY: y0, minZ: -hd + ht, maxX: -hw + ht, maxY: y1, maxZ: hd - ht, shadeFaces: false },
    { minX: hw - ht, minY: y0, minZ: -hd + ht, maxX: hw + ht, maxY: y1, maxZ: hd - ht, shadeFaces: false },
    // 四角加厚 L 型折角护块与低矮立柱，强化 Minecraft 体素选择框质感
    { minX: -hw - t, minY: y0, minZ: -hd - t, maxX: -hw + cornerSpan, maxY: y1 + 0.012, maxZ: -hd + ht, shadeFaces: false },
    { minX: -hw - t, minY: y0, minZ: -hd - t, maxX: -hw + ht, maxY: y1 + 0.012, maxZ: -hd + cornerSpan, shadeFaces: false },
    { minX: hw - cornerSpan, minY: y0, minZ: -hd - t, maxX: hw + t, maxY: y1 + 0.012, maxZ: -hd + ht, shadeFaces: false },
    { minX: hw - ht, minY: y0, minZ: -hd - t, maxX: hw + t, maxY: y1 + 0.012, maxZ: -hd + cornerSpan, shadeFaces: false },
    { minX: -hw - t, minY: y0, minZ: hd - ht, maxX: -hw + cornerSpan, maxY: y1 + 0.012, maxZ: hd + t, shadeFaces: false },
    { minX: -hw - t, minY: y0, minZ: hd - cornerSpan, maxX: -hw + ht, maxY: y1 + 0.012, maxZ: hd + t, shadeFaces: false },
    { minX: hw - cornerSpan, minY: y0, minZ: hd - ht, maxX: hw + t, maxY: y1 + 0.012, maxZ: hd + t, shadeFaces: false },
    { minX: hw - ht, minY: y0, minZ: hd - cornerSpan, maxX: hw + t, maxY: y1 + 0.012, maxZ: hd + t, shadeFaces: false },
    // 四角低矮体素标柱
    { minX: -hw - t, minY: y1, minZ: -hd - t, maxX: -hw + ht, maxY: y0 + cornerPostHeight, maxZ: -hd + ht, shadeFaces: false },
    { minX: hw - ht, minY: y1, minZ: -hd - t, maxX: hw + t, maxY: y0 + cornerPostHeight, maxZ: -hd + ht, shadeFaces: false },
    { minX: -hw - t, minY: y1, minZ: hd - ht, maxX: -hw + ht, maxY: y0 + cornerPostHeight, maxZ: hd + t, shadeFaces: false },
    { minX: hw - ht, minY: y1, minZ: hd - ht, maxX: hw + t, maxY: y0 + cornerPostHeight, maxZ: hd + t, shadeFaces: false },
  ];

  return createSolidColorVoxelGeometry(bars);
}

/**
 * 用 12 根细长轴对齐方体拼成一个发光描边方框（合批为 1 个 BufferGeometry）。
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
    { minX: -hw - ht, minY: yMin, minZ: -hd - ht, maxX: hw + ht, maxY: yMin + t, maxZ: -hd + ht, shadeFaces: false },
    { minX: -hw - ht, minY: yMin, minZ: hd - ht, maxX: hw + ht, maxY: yMin + t, maxZ: hd + ht, shadeFaces: false },
    { minX: -hw - ht, minY: yMin, minZ: -hd + ht, maxX: -hw + ht, maxY: yMin + t, maxZ: hd - ht, shadeFaces: false },
    { minX: hw - ht, minY: yMin, minZ: -hd + ht, maxX: hw + ht, maxY: yMin + t, maxZ: hd - ht, shadeFaces: false },
    { minX: -hw - ht, minY: yMax - t, minZ: -hd - ht, maxX: hw + ht, maxY: yMax, maxZ: -hd + ht, shadeFaces: false },
    { minX: -hw - ht, minY: yMax - t, minZ: hd - ht, maxX: hw + ht, maxY: yMax, maxZ: hd + ht, shadeFaces: false },
    { minX: -hw - ht, minY: yMax - t, minZ: -hd + ht, maxX: -hw + ht, maxY: yMax, maxZ: hd - ht, shadeFaces: false },
    { minX: hw - ht, minY: yMax - t, minZ: -hd + ht, maxX: hw + ht, maxY: yMax, maxZ: hd - ht, shadeFaces: false },
    { minX: -hw - ht, minY: yMin + t, minZ: -hd - ht, maxX: -hw + ht, maxY: yMax - t, maxZ: -hd + ht, shadeFaces: false },
    { minX: hw - ht, minY: yMin + t, minZ: -hd - ht, maxX: hw + ht, maxY: yMax - t, maxZ: -hd + ht, shadeFaces: false },
    { minX: -hw - ht, minY: yMin + t, minZ: hd - ht, maxX: -hw + ht, maxY: yMax - t, maxZ: hd + ht, shadeFaces: false },
    { minX: hw - ht, minY: yMin + t, minZ: hd - ht, maxX: hw + ht, maxY: yMax - t, maxZ: hd + ht, shadeFaces: false },
  ];

  return createSolidColorVoxelGeometry(bars);
}

/** 构建合批的静态平面接触阴影几何（若干贴地矩形面片合批为 1 次 Draw Call） */
export function createBatchedContactShadowGeometry(
  quads: ReadonlyArray<{ cx: number; cz: number; width: number; depth: number; y?: number }>
): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  for (let i = 0; i < quads.length; i += 1) {
    const q = quads[i];
    const hw = q.width * 0.5;
    const hd = q.depth * 0.5;
    const y = q.y ?? 0.006;
    const base = positions.length / 3;

    positions.push(
      q.cx - hw, y, q.cz + hd,
      q.cx + hw, y, q.cz + hd,
      q.cx + hw, y, q.cz - hd,
      q.cx - hw, y, q.cz - hd
    );
    normals.push(0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0);
    uvs.push(0, 0, 1, 0, 1, 1, 0, 1);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
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

/** 构建精细 Minecraft 吊挂灯笼几何（分段铁链 + 阶梯顶帽 + 笼框底座 + 发光灯芯） */
export function createVoxelLanternGeometry(chainLength = 0.5): {
  frameGeo: THREE.BufferGeometry;
  glowGeo: THREE.BufferGeometry;
} {
  const frameBuilder = new VoxelBoxBuilder();
  // 铁链分段节环
  const linkStep = 0.125;
  const linkCount = Math.max(1, Math.round(chainLength / linkStep));
  for (let i = 0; i < linkCount; i += 1) {
    const yTop = -i * (chainLength / linkCount);
    const yBot = -(i + 1) * (chainLength / linkCount);
    const wideX = i % 2 === 0;
    frameBuilder.addBox({
      minX: wideX ? -0.046875 : -0.0234375,
      minY: yBot,
      minZ: wideX ? -0.0234375 : -0.046875,
      maxX: wideX ? 0.046875 : 0.0234375,
      maxY: yTop,
      maxZ: wideX ? 0.0234375 : 0.046875,
      tiles: 'dark_iron',
      occludes: false,
    });
  }
  // 阶梯状灯笼提环与顶帽
  frameBuilder.addBox({
    minX: -0.09375,
    minY: -chainLength - 0.046875,
    minZ: -0.09375,
    maxX: 0.09375,
    maxY: -chainLength,
    maxZ: 0.09375,
    tiles: 'dark_iron',
  });
  frameBuilder.addBox({
    minX: -0.15625,
    minY: -chainLength - 0.09375,
    minZ: -0.15625,
    maxX: 0.15625,
    maxY: -chainLength - 0.046875,
    maxZ: 0.15625,
    tiles: 'dark_iron',
  });
  // 灯笼底托与四角立筋
  frameBuilder.addBox({
    minX: -0.1875,
    minY: -chainLength - 0.40625,
    minZ: -0.1875,
    maxX: 0.1875,
    maxY: -chainLength - 0.34375,
    maxZ: 0.1875,
    tiles: 'dark_iron',
  });
  const cornerOff = 0.140625;
  for (const sx of [-1, 1] as const) {
    for (const sz of [-1, 1] as const) {
      frameBuilder.addCenteredBox(
        sx * cornerOff,
        -chainLength - 0.21875,
        sz * cornerOff,
        0.046875,
        0.25,
        0.046875,
        'dark_iron',
        { occludes: false }
      );
    }
  }

  const glowBuilder = new VoxelBoxBuilder();
  glowBuilder.addBox({
    minX: -0.140625,
    minY: -chainLength - 0.34375,
    minZ: -0.140625,
    maxX: 0.140625,
    maxY: -chainLength - 0.09375,
    maxZ: 0.140625,
    tiles: 'lantern',
  });

  return {
    frameGeo: frameBuilder.build(false),
    glowGeo: glowBuilder.build(false),
  };
}

/** 构建漂浮在岛屿外侧环带中的双层立体 Minecraft 方块云群（单次合批 Draw Call） */
export function createBlockyCloudRingGeometry(
  minVertexRadius: number,
  maxVertexRadius: number,
  cloudCount = 12,
  seed = 2026
): THREE.BufferGeometry {
  const rng = { value: seed >>> 0 };
  const boxes: SolidColorBoxInput[] = [];
  const safeMinCenterR = Math.max(9, minVertexRadius + 2.8);
  const safeMaxCenterR = Math.max(safeMinCenterR + 5, maxVertexRadius - 2.4);
  const radiusSpan = safeMaxCenterR - safeMinCenterR;
  const count = Math.max(1, cloudCount);
  const sectorStep = (Math.PI * 2) / count;

  for (let i = 0; i < count; i += 1) {
    const angle = i * sectorStep + (seededNext(rng) - 0.5) * sectorStep * 0.6;
    const radial = safeMinCenterR + seededNext(rng) * radiusSpan;
    const cx = Math.cos(angle) * radial;
    const cz = Math.sin(angle) * radial;
    const cy = (seededNext(rng) - 0.5) * 1.8;
    const w = 2.0 + seededNext(rng) * 1.9;
    const d = 1.2 + seededNext(rng) * 1.1;
    const h = 0.48;

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

    // 侧翼延伸体素块
    if (seededNext(rng) > 0.25) {
      const wingW = Math.max(1.0, w * (0.45 + seededNext(rng) * 0.2));
      const wingD = Math.max(0.8, d * (0.52 + seededNext(rng) * 0.2));
      const offX = (seededNext(rng) > 0.5 ? 1 : -1) * (w * 0.24);
      const offZ = (seededNext(rng) > 0.5 ? 1 : -1) * (d * 0.36);
      boxes.push({
        minX: cx + offX - wingW * 0.5,
        minY: cy,
        minZ: cz + offZ - wingD * 0.5,
        maxX: cx + offX + wingW * 0.5,
        maxY: cy + h,
        maxZ: cz + offZ + wingD * 0.5,
        color: '#f5f9ff',
        shadeFaces: true,
      });
    }

    // 顶层微凸云冠，呈现经典立体方块云体积感
    if (seededNext(rng) > 0.45) {
      const capW = w * 0.52;
      const capD = d * 0.55;
      boxes.push({
        minX: cx - capW * 0.5,
        minY: cy + h,
        minZ: cz - capD * 0.5,
        maxX: cx + capW * 0.5,
        maxY: cy + h + 0.3,
        maxZ: cz + capD * 0.5,
        color: '#ffffff',
        shadeFaces: true,
      });
    }
  }

  return createSolidColorVoxelGeometry(boxes);
}

/** 兼容入口：按外侧环带规则生成方块云几何 */
export function createBlockyCloudGeometry(
  spanX = 56,
  spanZ = 56,
  cloudCount = 16,
  seed = 2026
): THREE.BufferGeometry {
  const outer = Math.max(24, Math.max(spanX, spanZ) * 0.65);
  const inner = Math.max(16, outer * 0.5);
  return createBlockyCloudRingGeometry(inner, outer, cloudCount, seed);
}

/** 构建夜晚高空方块星点群（单次合批 Draw Call，含暖白/浅蓝星色层次） */
export function createStarFieldGeometry(
  minRadius = 28,
  maxRadius = 42,
  count = 110,
  seed = 9001
): THREE.BufferGeometry {
  const rng = { value: seed >>> 0 };
  const boxes: SolidColorBoxInput[] = [];

  for (let i = 0; i < count; i += 1) {
    const theta = seededNext(rng) * Math.PI * 2;
    const elev = 0.22 + seededNext(rng) * 1.18;
    const dist = minRadius + seededNext(rng) * (maxRadius - minRadius);
    const x = Math.cos(theta) * Math.cos(elev) * dist;
    const y = Math.sin(elev) * dist + 4;
    const z = Math.sin(theta) * Math.cos(elev) * dist;
    const size = seededNext(rng) > 0.78 ? 0.3 : seededNext(rng) > 0.4 ? 0.2 : 0.14;
    const half = size * 0.5;
    const tintRoll = seededNext(rng);
    const color = tintRoll > 0.82 ? '#bae6fd' : tintRoll > 0.66 ? '#fef3c7' : '#ffffff';
    boxes.push({
      minX: x - half,
      minY: y - half,
      minZ: z - half,
      maxX: x + half,
      maxY: y + half,
      maxZ: z + half,
      color,
      shadeFaces: false,
    });
  }

  return createSolidColorVoxelGeometry(boxes);
}

/** 构建 3 段直线折线轨道几何（轴对齐长方体） */
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
