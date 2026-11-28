import * as THREE from 'three';
import {
  computeBayGridMetrics,
  getOfficeScenePalette,
  type OfficeScenePalette,
  type OfficeSceneSyncState,
} from './office-scene-types';
import {
  createRoomTerminalBundle,
  createWallPlaqueBundle,
  updateRoomTerminalTexture,
  updateWallPlaqueTexture,
  type CanvasTextureBundle,
} from './office-scene-textures';
import {
  getSharedVoxelMaterialSet,
  isSharedVoxelMaterial,
  type VoxelTileId,
} from './office-voxel-atlas';
import {
  mergeVoxelGeometries,
  snapToVoxel,
  VoxelBoxBuilder,
  VoxelGrid,
  type VoxelBlockSpec,
  type VoxelFaceDir,
} from './office-voxel-builder';
import {
  addBirchTreeToGrid,
  addBookshelfColumnToGrid,
  addOakTreeToGrid,
  createBatchedContactShadowGeometry,
  createVoxelLanternGeometry,
} from './office-voxel-kit';
import type {
  CoffeeStationAnchor,
  RoomWalkLayout,
  WorldRect2D,
} from './office-voxel-behaviour';

/**
 * Minecraft 体素办公室建筑与浮空生物群落构建器：
 * - 自然阶梯浮空岛基底（gy = -5 深板岩龙骨 → -4/-3 岩石悬崖 → -2 泥土层 → -1 室外草坪与室内拼接木地板）。
 * - 橡树与白桦树混交庭院、流动水面沙岸池塘 + 甘蔗芦苇 + X 型高草野花 + 圆石步道与栅栏灯柱。
 * - 四向独立合批墙体（含苔石砖基础、橡木柱、窗台花箱、室内装饰画/软木板/白板）+ 阶梯悬挑屋檐与红石吊灯。
 * - 智能室内外剖切：进入室内近距读屏时四面墙与屋顶完整呈现沉浸空间；室外环绕仅剖切挡视线的迎面外墙。
 */

export type OfficeWallDirection = 'px' | 'nx' | 'pz' | 'nz';

export type OfficeRoomWallGroups = Record<OfficeWallDirection, THREE.Group>;

export interface OfficeRoomRig {
  root: THREE.Group;
  dynamicWorldGroup: THREE.Group;
  wallGroups: OfficeRoomWallGroups;
  roofGroup: THREE.Group;
  roofEaveGroups: OfficeRoomWallGroups;
  plaqueGroup: THREE.Group;
  roomTerminalGroup: THREE.Group;
  roomTerminalScreen: THREE.Mesh;
  plaqueBundle: CanvasTextureBundle;
  terminalBundle: CanvasTextureBundle;
  plaqueScreenMaterial: THREE.MeshBasicMaterial;
  terminalScreenMaterial: THREE.MeshBasicMaterial;
  terminalStatusMaterial: THREE.MeshBasicMaterial;
  lanternLightPositions: THREE.Vector3[];
  currentWidth: number;
  currentDepth: number;
  halfW: number;
  halfD: number;
  outerHalfWidth: number;
  outerHalfDepth: number;
  hiddenWallX: 'px' | 'nx';
  hiddenWallZ: 'pz' | 'nz';
  visibleWalls: Record<OfficeWallDirection, boolean>;
  coffeeStation: CoffeeStationAnchor;
  walkLayout: RoomWalkLayout;
}

const WALL_DIRECTIONS: readonly OfficeWallDirection[] = ['px', 'nx', 'pz', 'nz'];
const ROOM_CENTER_Y = 0.85;
const WALL_CUTAWAY_MARGIN = 0.32;
const WALL_HYSTERESIS = 0.28;
const ROOF_HIDE_ELEVATION_RAD = THREE.MathUtils.degToRad(50);

const MIN_HALF_W = 4;
const MIN_HALF_D = 3;
const DEFAULT_INIT_WIDTH = 9.0;
const DEFAULT_INIT_DEPTH = 6.8;
const YARD_EXTEND = 5;

const GRASS_BLOCK: VoxelBlockSpec = {
  tiles: { top: 'grass_top', side: 'grass_side', bottom: 'dirt' },
  layer: 'opaque',
};

const DIRT_BLOCK: VoxelBlockSpec = {
  tiles: 'dirt',
  layer: 'opaque',
};

const STONE_BLOCK: VoxelBlockSpec = {
  tiles: 'stone',
  layer: 'opaque',
};

const DEEPSLATE_BLOCK: VoxelBlockSpec = {
  tiles: 'deepslate',
  layer: 'opaque',
};

const STONE_BRICK_BLOCK: VoxelBlockSpec = {
  tiles: 'stone_brick',
  layer: 'opaque',
};

const MOSSY_STONE_BRICK_BLOCK: VoxelBlockSpec = {
  tiles: 'mossy_stone_brick',
  layer: 'opaque',
};

const COBBLESTONE_BLOCK: VoxelBlockSpec = {
  tiles: 'cobblestone',
  layer: 'opaque',
};

const SAND_BLOCK: VoxelBlockSpec = {
  tiles: 'sand',
  layer: 'opaque',
};

const WATER_BLOCK: VoxelBlockSpec = {
  tiles: 'water',
  layer: 'water',
  occludes: false,
};

const GLASS_BLOCK: VoxelBlockSpec = {
  tiles: 'glass',
  layer: 'glass',
  occludes: false,
};

const OAK_PLANKS_BLOCK: VoxelBlockSpec = {
  tiles: 'oak_planks',
  layer: 'opaque',
};

const BIRCH_PLANKS_BLOCK: VoxelBlockSpec = {
  tiles: 'birch_planks',
  layer: 'opaque',
};

const SPRUCE_PLANKS_BLOCK: VoxelBlockSpec = {
  tiles: 'spruce_planks',
  layer: 'opaque',
};

const OAK_LOG_VERTICAL: VoxelBlockSpec = {
  tiles: { top: 'oak_log_top', bottom: 'oak_log_top', side: 'oak_log_side' },
  layer: 'opaque',
};

const OAK_LOG_HORIZONTAL_X: VoxelBlockSpec = {
  tiles: {
    px: 'oak_log_top',
    nx: 'oak_log_top',
    py: 'oak_log_side',
    ny: 'oak_log_side',
    pz: 'oak_log_side',
    nz: 'oak_log_side',
  },
  layer: 'opaque',
};

function computeHalfExtent(size: number, minHalf: number): number {
  return Math.max(minHalf, Math.ceil(size / 2));
}

function isSideWallMullion(idx: number, length: number): boolean {
  if (length === 10) {
    return idx === 3 || idx === 6;
  }
  return (idx + 1) % 3 === 0 && idx <= length - 2;
}

function hashGridCoord(x: number, z: number): number {
  let h = (x * 374761393 + z * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/** 按 1 格整数边界切分平板与横梁，确保每个表面均保持 1:1 像素密度且剔除内部相接面 */
function addTiledSlab(
  builder: VoxelBoxBuilder,
  minX: number,
  maxX: number,
  minY: number,
  maxY: number,
  minZ: number,
  maxZ: number,
  tile: VoxelTileId,
  extraHidden?: Partial<Record<VoxelFaceDir, boolean>>
): void {
  const xSplits: number[] = [minX];
  for (let x = Math.floor(minX) + 1; x < maxX - 1e-4; x += 1) {
    if (x > minX + 1e-4) xSplits.push(x);
  }
  xSplits.push(maxX);

  const zSplits: number[] = [minZ];
  for (let z = Math.floor(minZ) + 1; z < maxZ - 1e-4; z += 1) {
    if (z > minZ + 1e-4) zSplits.push(z);
  }
  zSplits.push(maxZ);

  for (let ix = 0; ix < xSplits.length - 1; ix += 1) {
    const x0 = xSplits[ix];
    const x1 = xSplits[ix + 1];
    for (let iz = 0; iz < zSplits.length - 1; iz += 1) {
      const z0 = zSplits[iz];
      const z1 = zSplits[iz + 1];
      builder.addBox({
        minX: x0,
        minY,
        minZ: z0,
        maxX: x1,
        maxY,
        maxZ: z1,
        tiles: tile,
        hiddenFaces: {
          nx: ix > 0 || extraHidden?.nx === true,
          px: ix < xSplits.length - 2 || extraHidden?.px === true,
          nz: iz > 0 || extraHidden?.nz === true,
          pz: iz < zSplits.length - 2 || extraHidden?.pz === true,
          py: extraHidden?.py === true,
          ny: extraHidden?.ny === true,
        },
      });
    }
  }
}

/** 释放动态世界容器中的几何体与非共享材质（绝不销毁共享图集材质与保留的持久子节点） */
function clearDynamicWorldGroup(
  group: THREE.Group,
  preserveChildren?: ReadonlySet<THREE.Object3D>
): void {
  const disposedGeometries = new Set<THREE.BufferGeometry>();
  const disposedMaterials = new Set<THREE.Material>();

  const children = [...group.children];
  for (const child of children) {
    if (preserveChildren?.has(child)) continue;
    group.remove(child);
    child.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      if (obj.geometry instanceof THREE.BufferGeometry && !disposedGeometries.has(obj.geometry)) {
        disposedGeometries.add(obj.geometry);
        obj.geometry.dispose();
      }
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const mat of mats) {
        if (
          mat instanceof THREE.Material
          && !isSharedVoxelMaterial(mat)
          && !disposedMaterials.has(mat)
        ) {
          disposedMaterials.add(mat);
          mat.dispose();
        }
      }
    });
  }
}

/** 构建贴墙项目铭牌（深橡木立体描边框 + 无光晕洗白清晰牌面） */
function buildPlaqueGroup(
  plaqueScreenMaterial: THREE.Material,
  opaqueVoxelMaterial: THREE.Material
): THREE.Group {
  const plaqueGroup = new THREE.Group();
  const builder = new VoxelBoxBuilder();

  addTiledSlab(builder, -0.9375, 0.9375, -0.375, 0.375, 0, 0.0625, 'dark_oak_planks', { nz: true });
  // 上下细金装饰饰条
  builder.addBox({
    minX: -0.9375,
    minY: 0.34375,
    minZ: 0.0625,
    maxX: 0.9375,
    maxY: 0.375,
    maxZ: 0.085,
    tiles: 'gold_block',
    occludes: false,
    hiddenFaces: { nz: true },
  });
  builder.addBox({
    minX: -0.9375,
    minY: -0.375,
    minZ: 0.0625,
    maxX: 0.9375,
    maxY: -0.34375,
    maxZ: 0.085,
    tiles: 'gold_block',
    occludes: false,
    hiddenFaces: { nz: true },
  });

  const frameMesh = new THREE.Mesh(builder.build(false), opaqueVoxelMaterial);
  frameMesh.castShadow = false;
  frameMesh.receiveShadow = true;
  plaqueGroup.add(frameMesh);

  const screenMesh = new THREE.Mesh(new THREE.PlaneGeometry(1.78, 0.625), plaqueScreenMaterial);
  screenMesh.position.set(0, 0, 0.066);
  plaqueGroup.add(screenMesh);

  return plaqueGroup;
}

/** 构建贴墙房间终端监视屏（深铁立体框 + 无光晕洗白清晰屏幕 + 顶部状态块） */
function buildRoomTerminalGroup(
  terminalScreenMaterial: THREE.Material,
  terminalStatusMaterial: THREE.MeshBasicMaterial,
  opaqueVoxelMaterial: THREE.Material
): { group: THREE.Group; screenMesh: THREE.Mesh } {
  const group = new THREE.Group();
  const builder = new VoxelBoxBuilder();

  addTiledSlab(builder, -0.75, 0.75, -0.4375, 0.4375, 0, 0.0625, 'dark_iron', { nz: true });

  const bodyMesh = new THREE.Mesh(builder.build(false), opaqueVoxelMaterial);
  bodyMesh.castShadow = false;
  bodyMesh.receiveShadow = true;
  group.add(bodyMesh);

  const screenMesh = new THREE.Mesh(new THREE.PlaneGeometry(1.375, 0.75), terminalScreenMaterial);
  screenMesh.position.set(0, 0, 0.066);
  group.add(screenMesh);

  const statusCube = new THREE.Mesh(
    new THREE.BoxGeometry(0.1875, 0.0625, 0.0625),
    terminalStatusMaterial
  );
  statusCube.position.set(0, 0.46875, 0.03125);
  group.add(statusCube);

  return { group, screenMesh };
}

/** 填充自然阶梯浮空岛、室内拼接木地板、书架、流动水池、橡树/白桦树与四向独立墙体 */
function populateRoomVoxelGrids(
  baseGrid: VoxelGrid,
  wallGrids: Record<OfficeWallDirection, VoxelGrid>,
  halfW: number,
  halfD: number
): { treeCenters: Array<{ x: number; z: number }>; pondBounds: WorldRect2D } {
  const yardMinX = -halfW - (YARD_EXTEND + 1);
  const yardMaxX = halfW + YARD_EXTEND;
  const yardMinZ = -halfD - (YARD_EXTEND + 1);
  const yardMaxZ = halfD + YARD_EXTEND;

  // 1. 雕刻阶梯状 Minecraft 浮空天空岛底层（gy = -5 深板岩龙骨 → -4/-3 岩石崖壁 → -2 泥土 → -1 草皮）
  for (let z = yardMinZ; z <= yardMaxZ; z += 1) {
    for (let x = yardMinX; x <= yardMaxX; x += 1) {
      const edgeDistX = Math.min(x - yardMinX, yardMaxX - x);
      const edgeDistZ = Math.min(z - yardMinZ, yardMaxZ - z);
      const minEdge = Math.min(edgeDistX, edgeDistZ);
      const cornerSum = edgeDistX + edgeDistZ;
      const noise = hashGridCoord(x, z);

      // 裁切最外四角 1 格，形成柔和的岛屿自然轮廓
      if (cornerSum === 0) continue;

      // gy = -1 草皮顶层
      baseGrid.set(x, -1, z, GRASS_BLOCK);

      // gy = -2 泥土层（外缘保持紧实悬崖感）
      if (cornerSum >= 2 || noise > 0.35) {
        baseGrid.set(x, -2, z, DIRT_BLOCK);
      }

      // gy = -3 岩石层（内缩 1 格 + 边缘随机圆石露头）
      if (minEdge >= 1 || (cornerSum >= 3 && noise > 0.52)) {
        baseGrid.set(x, -3, z, noise > 0.72 ? COBBLESTONE_BLOCK : STONE_BLOCK);
      }

      // gy = -4 深层岩石与深板岩（内缩 2 格形成锥形岛底）
      if (minEdge >= 2 && cornerSum >= 5) {
        baseGrid.set(x, -4, z, noise > 0.45 ? DEEPSLATE_BLOCK : STONE_BLOCK);
      }

      // gy = -5 中心深板岩龙骨（内缩 4 格）
      if (minEdge >= 4 && cornerSum >= 9 && noise > 0.22) {
        baseGrid.set(x, -5, z, DEEPSLATE_BLOCK);
      }
    }
  }

  // 2. 建筑外墙地基（gy = -1，混入少量苔石砖增强建筑岁月质感）
  const setFoundation = (x: number, z: number) => {
    const mossy = hashGridCoord(x * 3 + 7, z * 5 + 11) > 0.78;
    baseGrid.set(x, -1, z, mossy ? MOSSY_STONE_BRICK_BLOCK : STONE_BRICK_BLOCK);
  };
  for (let x = -halfW - 1; x <= halfW; x += 1) {
    setFoundation(x, -halfD - 1);
    setFoundation(x, halfD);
  }
  for (let z = -halfD; z <= halfD - 1; z += 1) {
    setFoundation(-halfW - 1, z);
    setFoundation(halfW, z);
  }

  // 3. 室内分层拼接木地板（gy = -1）：云杉深框 + 橡木/白桦明快中央走道 + 镶嵌工位区
  for (let z = -halfD; z <= halfD - 1; z += 1) {
    for (let x = -halfW; x <= halfW - 1; x += 1) {
      const isBorder = x === -halfW || x === halfW - 1 || z === -halfD || z === halfD - 1;
      const isAisle = x === -1 || x === 0;
      if (isBorder) {
        baseGrid.set(x, -1, z, SPRUCE_PLANKS_BLOCK);
      } else if (isAisle) {
        const checker = ((x + z) & 1) === 0;
        baseGrid.set(x, -1, z, checker ? BIRCH_PLANKS_BLOCK : OAK_PLANKS_BLOCK);
      } else {
        const isInlay = Math.abs(x) % 2 === 0 && Math.abs(z) % 2 === 0;
        baseGrid.set(x, -1, z, isInlay ? SPRUCE_PLANKS_BLOCK : OAK_PLANKS_BLOCK);
      }
    }
  }

  // 室内常驻家具：后左内侧书架角（高度 2）
  addBookshelfColumnToGrid(baseGrid, -halfW + 1, 0, -halfD, 2);
  addBookshelfColumnToGrid(baseGrid, -halfW + 2, 0, -halfD, 2);

  // 前墙门廊与庭院圆石步道（gy = -1）
  const frontZ = halfD;
  const gapStart = Math.max(-halfW + 4, -1);
  const gapEnd = Math.min(halfW - 1, gapStart + 1);
  baseGrid.set(-halfW + 1, -1, frontZ, COBBLESTONE_BLOCK);
  for (let x = gapStart; x <= gapEnd; x += 1) {
    baseGrid.set(x, -1, frontZ, COBBLESTONE_BLOCK);
  }
  baseGrid.fill(-halfW, -1, frontZ + 1, -halfW + 3, -1, frontZ + 2, COBBLESTONE_BLOCK);
  baseGrid.fill(gapStart, -1, frontZ + 1, gapEnd, -1, frontZ + 3, COBBLESTONE_BLOCK);
  // 连接门廊与中央拱口的前院石径
  baseGrid.fill(-halfW + 1, -1, frontZ + 2, gapEnd, -1, frontZ + 2, COBBLESTONE_BLOCK);

  // 室外前右草坪 3×2 浅水池（沙岸围边 + 流动像素水面）
  const poolMinX = halfW + 2;
  const poolMaxX = halfW + 4;
  const poolMinZ = halfD + 1;
  const poolMaxZ = halfD + 2;
  baseGrid.fill(poolMinX - 1, -1, poolMinZ - 1, poolMaxX + 1, -1, poolMaxZ + 1, SAND_BLOCK);
  baseGrid.fill(poolMinX, -1, poolMinZ, poolMaxX, -1, poolMaxZ, WATER_BLOCK);

  // 室外 4 棵混交树林（2 棵橡树 + 2 棵白桦树，错落高度增加生物群落层次）
  const treeDefs: ReadonlyArray<{ x: number; z: number; kind: 'oak' | 'birch'; h: number; seed: number }> = [
    { x: -halfW - 4, z: -halfD - 4, kind: 'oak', h: 4, seed: 101 },
    { x: -halfW - 4, z: halfD + 2, kind: 'birch', h: 5, seed: 207 },
    { x: halfW + 3, z: -halfD - 4, kind: 'birch', h: 5, seed: 313 },
    { x: halfW + 3, z: -1, kind: 'oak', h: 3, seed: 419 },
  ];
  for (const tree of treeDefs) {
    if (tree.kind === 'birch') {
      addBirchTreeToGrid(baseGrid, tree.x, 0, tree.z, tree.h, tree.seed);
    } else {
      addOakTreeToGrid(baseGrid, tree.x, 0, tree.z, tree.h, tree.seed);
    }
  }

  // 4. 后墙（-Z 墙，z = -halfD - 1，含苔石砖底缘 + 橡木角柱 + 中央 2×2 观景窗）
  const backZ = -halfD - 1;
  for (let y = 0; y <= 3; y += 1) {
    for (let x = -halfW; x <= halfW - 1; x += 1) {
      const isMossy = y === 0 && hashGridCoord(x + 11, y + 3) > 0.72;
      wallGrids.nz.set(x, y, backZ, isMossy ? MOSSY_STONE_BRICK_BLOCK : STONE_BRICK_BLOCK);
    }
  }
  wallGrids.nz.fill(-halfW - 1, 0, backZ, -halfW - 1, 3, backZ, OAK_LOG_VERTICAL);
  wallGrids.nz.fill(halfW, 0, backZ, halfW, 3, backZ, OAK_LOG_VERTICAL);
  wallGrids.nz.fill(-1, 1, backZ, 0, 2, backZ, GLASS_BLOCK);

  // 5 & 6. 左右落地大玻璃窗墙（-X 与 +X）
  const leftX = -halfW - 1;
  const rightX = halfW;
  const sideWallLen = halfD * 2;
  for (let idx = 0; idx < sideWallLen; idx += 1) {
    const z = -halfD + idx;
    const mossyL = hashGridCoord(leftX, z * 7) > 0.75;
    const mossyR = hashGridCoord(rightX, z * 7) > 0.75;
    wallGrids.nx.set(leftX, 0, z, mossyL ? MOSSY_STONE_BRICK_BLOCK : STONE_BRICK_BLOCK);
    wallGrids.nx.set(leftX, 3, z, STONE_BRICK_BLOCK);
    wallGrids.px.set(rightX, 0, z, mossyR ? MOSSY_STONE_BRICK_BLOCK : STONE_BRICK_BLOCK);
    wallGrids.px.set(rightX, 3, z, STONE_BRICK_BLOCK);
    if (isSideWallMullion(idx, sideWallLen)) {
      wallGrids.nx.set(leftX, 1, z, OAK_LOG_VERTICAL);
      wallGrids.nx.set(leftX, 2, z, OAK_LOG_VERTICAL);
      wallGrids.px.set(rightX, 1, z, OAK_LOG_VERTICAL);
      wallGrids.px.set(rightX, 2, z, OAK_LOG_VERTICAL);
    } else {
      wallGrids.nx.set(leftX, 1, z, GLASS_BLOCK);
      wallGrids.nx.set(leftX, 2, z, GLASS_BLOCK);
      wallGrids.px.set(rightX, 1, z, GLASS_BLOCK);
      wallGrids.px.set(rightX, 2, z, GLASS_BLOCK);
    }
  }

  // 7. 前墙（+Z 墙，入户门洞 + 2 格拱口 + 大玻璃窗）
  wallGrids.pz.fill(-halfW - 1, 0, frontZ, -halfW - 1, 3, frontZ, OAK_LOG_VERTICAL);
  wallGrids.pz.fill(halfW, 0, frontZ, halfW, 3, frontZ, OAK_LOG_VERTICAL);
  for (let x = -halfW; x <= halfW - 1; x += 1) {
    if (x === -halfW + 1) {
      wallGrids.pz.set(x, 2, frontZ, OAK_LOG_HORIZONTAL_X);
      wallGrids.pz.set(x, 3, frontZ, STONE_BRICK_BLOCK);
    } else if (x >= gapStart && x <= gapEnd) {
      wallGrids.pz.set(x, 2, frontZ, OAK_LOG_HORIZONTAL_X);
      wallGrids.pz.set(x, 3, frontZ, STONE_BRICK_BLOCK);
    } else if (x === -halfW || x === -halfW + 2 || x === halfW - 1) {
      wallGrids.pz.fill(x, 0, frontZ, x, 3, frontZ, STONE_BRICK_BLOCK);
    } else {
      wallGrids.pz.set(x, 0, frontZ, STONE_BRICK_BLOCK);
      wallGrids.pz.set(x, 1, frontZ, GLASS_BLOCK);
      wallGrids.pz.set(x, 2, frontZ, GLASS_BLOCK);
      wallGrids.pz.set(x, 3, frontZ, STONE_BRICK_BLOCK);
    }
  }

  return {
    treeCenters: treeDefs.map((t) => ({ x: t.x + 0.5, z: t.z + 0.5 })),
    pondBounds: {
      minX: poolMinX - 1,
      maxX: poolMaxX + 2,
      minZ: poolMinZ - 1,
      maxZ: poolMaxZ + 2,
    },
  };
}

/** 构建后墙右侧手工体素咖啡台与浓缩咖啡机（并入房间合批，0 额外 Draw Call） */
function appendCoffeeMachineCounter(
  opaqueBuilder: VoxelBoxBuilder,
  emissiveBuilder: VoxelBoxBuilder,
  halfW: number,
  halfD: number
): CoffeeStationAnchor {
  const cx = snapToVoxel(halfW - 1.5);
  const backZ = -halfD;
  const minX = cx - 0.5;
  const maxX = cx + 0.5;
  const minZ = backZ;
  const maxZ = backZ + 0.75;

  // 1. 深色橡木柜体 + 实木台面 + 金属拉手
  opaqueBuilder.addBox({
    minX,
    minY: 0,
    minZ,
    maxX,
    maxY: 0.75,
    maxZ: backZ + 0.6875,
    tiles: 'dark_oak_planks',
    floorY: 0,
    hiddenFaces: { ny: true, nz: true },
  });
  opaqueBuilder.addBox({
    minX,
    minY: 0.75,
    minZ,
    maxX,
    maxY: 0.875,
    maxZ,
    tiles: { top: 'oak_planks', side: 'spruce_planks', bottom: 'spruce_planks' },
    hiddenFaces: { nz: true },
  });
  opaqueBuilder.addBox({
    minX: cx - 0.125,
    minY: 0.4375,
    minZ: backZ + 0.6875,
    maxX: cx + 0.125,
    maxY: 0.5,
    maxZ: backZ + 0.71875,
    tiles: 'iron_block',
    occludes: false,
    hiddenFaces: { nz: true },
  });

  // 2. 铁+铜体素意式咖啡机
  const mMinX = cx - 0.375;
  const mMaxX = cx + 0.1875;
  opaqueBuilder.addBox({
    minX: mMinX,
    minY: 0.875,
    minZ: backZ + 0.0625,
    maxX: mMaxX,
    maxY: 1.5625,
    maxZ: backZ + 0.3125,
    tiles: 'dark_iron',
    floorY: 0.875,
    hiddenFaces: { ny: true },
  });
  opaqueBuilder.addBox({
    minX: mMinX,
    minY: 1.3125,
    minZ: backZ + 0.3125,
    maxX: mMaxX,
    maxY: 1.5625,
    maxZ: backZ + 0.5625,
    tiles: { top: 'copper_block', side: 'dark_iron', bottom: 'dark_iron' },
    hiddenFaces: { nz: true },
  });
  // 顶部咖啡豆仓
  opaqueBuilder.addBox({
    minX: cx - 0.25,
    minY: 1.5625,
    minZ: backZ + 0.125,
    maxX: cx + 0.0625,
    maxY: 1.6875,
    maxZ: backZ + 0.375,
    tiles: { top: 'wool_brown', side: 'dark_oak_planks', bottom: 'dark_oak_planks' },
    hiddenFaces: { ny: true },
  });
  // 不锈钢滴水盘 + 双出水口
  opaqueBuilder.addBox({
    minX: mMinX,
    minY: 0.875,
    minZ: backZ + 0.3125,
    maxX: mMaxX,
    maxY: 0.9375,
    maxZ: backZ + 0.5625,
    tiles: 'iron_block',
    floorY: 0.875,
    hiddenFaces: { ny: true, nz: true },
  });
  opaqueBuilder.addBox({
    minX: cx - 0.1875,
    minY: 1.21875,
    minZ: backZ + 0.4375,
    maxX: cx - 0.125,
    maxY: 1.3125,
    maxZ: backZ + 0.5,
    tiles: 'iron_block',
    occludes: false,
    hiddenFaces: { py: true },
  });
  opaqueBuilder.addBox({
    minX: cx - 0.0625,
    minY: 1.21875,
    minZ: backZ + 0.4375,
    maxX: cx,
    maxY: 1.3125,
    maxZ: backZ + 0.5,
    tiles: 'iron_block',
    occludes: false,
    hiddenFaces: { py: true },
  });

  // 3. 发光状态显示屏与就绪绿灯（并入 room-base-emissive）
  emissiveBuilder.addBox({
    minX: cx - 0.3125,
    minY: 1.375,
    minZ: backZ + 0.5625,
    maxX: cx - 0.0625,
    maxY: 1.5,
    maxZ: backZ + 0.59375,
    tiles: 'glowstone',
    tint: '#5ef2ff',
    occludes: false,
    hiddenFaces: { nz: true },
  });
  emissiveBuilder.addBox({
    minX: cx + 0.03125,
    minY: 1.40625,
    minZ: backZ + 0.5625,
    maxX: cx + 0.125,
    maxY: 1.46875,
    maxZ: backZ + 0.59375,
    tiles: 'emerald_block',
    occludes: false,
    hiddenFaces: { nz: true },
  });

  // 4. 台面右侧双叠白瓷马克杯
  opaqueBuilder.addBox({
    minX: cx + 0.25,
    minY: 0.875,
    minZ: backZ + 0.375,
    maxX: cx + 0.375,
    maxY: 1.0,
    maxZ: backZ + 0.5,
    tiles: { side: 'mug_white', top: 'wool_brown', bottom: 'mug_white' },
    floorY: 0.875,
    hiddenFaces: { ny: true },
  });
  opaqueBuilder.addBox({
    minX: cx + 0.25,
    minY: 0.875,
    minZ: backZ + 0.15625,
    maxX: cx + 0.375,
    maxY: 1.0,
    maxZ: backZ + 0.28125,
    tiles: { side: 'mug_white', top: 'mug_white', bottom: 'mug_white' },
    floorY: 0.875,
    hiddenFaces: { ny: true },
  });

  return {
    anchorX: cx,
    anchorZ: backZ + 0.375,
    interactX: cx,
    interactZ: backZ + 1.25,
    facingYaw: Math.PI,
    footprint: { minX, maxX, minZ, maxZ },
  };
}

/** 构建子体素建筑细部、墙面装饰、窗台花箱、室外 X 型花草与吊挂灯笼 */
function buildSubVoxelDetails(
  halfW: number,
  halfD: number
): {
  baseOpaqueGeo: THREE.BufferGeometry;
  baseCutoutGeo: THREE.BufferGeometry;
  baseEmissiveGeo: THREE.BufferGeometry;
  wallDetailGeos: Record<OfficeWallDirection, THREE.BufferGeometry | null>;
  wallNzEmissiveGeo: THREE.BufferGeometry;
  roofEaveGeos: Record<OfficeWallDirection, THREE.BufferGeometry>;
  roofCoreOpaqueGeo: THREE.BufferGeometry;
  roofCoreEmissiveGeo: THREE.BufferGeometry;
  lanternLightPositions: [THREE.Vector3, THREE.Vector3];
  coffeeStation: CoffeeStationAnchor;
} {
  const eaveBuilders: Record<OfficeWallDirection, VoxelBoxBuilder> = {
    px: new VoxelBoxBuilder(),
    nx: new VoxelBoxBuilder(),
    pz: new VoxelBoxBuilder(),
    nz: new VoxelBoxBuilder(),
  };
  const wallDetailBuilders: Record<OfficeWallDirection, VoxelBoxBuilder> = {
    px: new VoxelBoxBuilder(),
    nx: new VoxelBoxBuilder(),
    pz: new VoxelBoxBuilder(),
    nz: new VoxelBoxBuilder(),
  };
  const wallNzEmissiveBuilder = new VoxelBoxBuilder();
  const roofCoreBuilder = new VoxelBoxBuilder();
  const roofDetailBuilder = new VoxelBoxBuilder();
  const roofEmissiveBuilder = new VoxelBoxBuilder();
  const baseDetailBuilder = new VoxelBoxBuilder();
  const baseCutoutBuilder = new VoxelBoxBuilder();
  const baseEmissiveDetailBuilder = new VoxelBoxBuilder();

  // 0. 室内咖啡台与书架顶小摆件
  const coffeeStation = appendCoffeeMachineCounter(
    baseDetailBuilder,
    baseEmissiveDetailBuilder,
    halfW,
    halfD
  );

  // 书架顶部（y = 2.0）红陶小盆栽 + 铜色小书档
  const shelfX = -halfW + 1.5;
  const shelfZ = -halfD + 0.5;
  baseDetailBuilder.addCenteredBox(shelfX - 0.15, 2.09375, shelfZ, 0.1875, 0.1875, 0.1875, {
    side: 'terracotta',
    top: 'dirt',
    bottom: 'terracotta',
  }, { floorY: 2.0 });
  baseCutoutBuilder.addCrossPlant(shelfX - 0.15, 2.1875, shelfZ, 0.28, 0.32, 'flower_blue');

  // 1. 室内四面墙木质踢脚线与墙面建筑装饰（随各自墙组同步显隐）
  // -Z 后墙：窗台木条 + 窗两侧壁灯托架
  addTiledSlab(wallDetailBuilders.nz, -halfW, halfW, 0, 0.125, -halfD, -halfD + 0.0625, 'dark_oak_planks', { ny: true, nz: true });
  addTiledSlab(wallDetailBuilders.nz, -1.125, 1.125, 0.9375, 1.0625, -halfD, -halfD + 0.125, 'spruce_planks', { nz: true });
  // 后墙窗口两侧壁灯（深铁支架 + 暖光灯笼芯）
  for (const sx of [-1.25, 1.25] as const) {
    wallDetailBuilders.nz.addCenteredBox(sx, 2.28, -halfD + 0.09, 0.09, 0.06, 0.18, 'dark_iron', { occludes: false });
    wallDetailBuilders.nz.addCenteredBox(sx, 2.16, -halfD + 0.15, 0.14, 0.04, 0.14, 'dark_iron', { occludes: false });
    wallNzEmissiveBuilder.addCenteredBox(sx, 2.06, -halfD + 0.15, 0.12, 0.16, 0.12, 'lantern', { occludes: false });
  }

  // -X 左墙：室内踢脚线 + 窗台装饰 + 室外窗台花箱 + 像素日落风景画（挂在窗柱上）
  addTiledSlab(wallDetailBuilders.nx, -halfW, -halfW + 0.0625, 0, 0.125, -halfD, halfD, 'dark_oak_planks', { ny: true, nx: true });
  // 外墙窗台云杉托架 + 花盆
  const leftWindowZ = [-halfD + 1.5, halfD - 1.5];
  for (const wz of leftWindowZ) {
    wallDetailBuilders.nx.addBox({
      minX: -halfW - 1.28125,
      minY: 0.78125,
      minZ: wz - 0.5,
      maxX: -halfW - 1.0,
      maxY: 0.96875,
      maxZ: wz + 0.5,
      tiles: { top: 'dirt', side: 'spruce_planks', bottom: 'spruce_planks' },
      hiddenFaces: { px: true },
    });
  }
  // 左墙窗柱内侧挂一幅小巧 Minecraft 软木便签板与像素风景画
  wallDetailBuilders.nx.addBox({
    minX: -halfW,
    minY: 1.5,
    minZ: -0.5,
    maxX: -halfW + 0.0625,
    maxY: 2.375,
    maxZ: 0.5,
    tiles: { px: 'corkboard', all: 'dark_oak_planks' },
    occludes: false,
    hiddenFaces: { nx: true },
  });

  // +X 右墙：室内踢脚线 + 挂墙体素架构白板
  addTiledSlab(wallDetailBuilders.px, halfW - 0.0625, halfW, 0, 0.125, -halfD, halfD, 'dark_oak_planks', { ny: true, px: true });
  wallDetailBuilders.px.addBox({
    minX: halfW - 0.0625,
    minY: 1.5,
    minZ: -0.625,
    maxX: halfW,
    maxY: 2.375,
    maxZ: 0.625,
    tiles: { nx: 'whiteboard', all: 'dark_iron' },
    occludes: false,
    hiddenFaces: { px: true },
  });

  // 2. 四向阶梯悬挑屋檐（云杉 + 橡木 + 深橡木三层轮廓，互不重叠，按墙体可见性同步显隐）
  addTiledSlab(eaveBuilders.nz, -halfW - 1.5, halfW + 1.5, 4.0, 4.3125, -halfD - 1.5, -halfD - 1.0, 'spruce_planks');
  addTiledSlab(eaveBuilders.nz, -halfW - 1.0, halfW + 1.0, 4.0, 4.5, -halfD - 1.0, -halfD + 0.5, 'oak_planks');
  addTiledSlab(eaveBuilders.nz, -halfW - 1.0, halfW + 1.0, 4.5, 4.8125, -halfD - 1.0, -halfD, 'dark_oak_planks', { ny: true });

  addTiledSlab(eaveBuilders.pz, -halfW - 1.5, halfW + 1.5, 4.0, 4.3125, halfD + 1.0, halfD + 1.5, 'spruce_planks');
  addTiledSlab(eaveBuilders.pz, -halfW - 1.0, halfW + 1.0, 4.0, 4.5, halfD - 0.5, halfD + 1.0, 'oak_planks');
  addTiledSlab(eaveBuilders.pz, -halfW - 1.0, halfW + 1.0, 4.5, 4.8125, halfD, halfD + 1.0, 'dark_oak_planks', { ny: true });

  addTiledSlab(eaveBuilders.nx, -halfW - 1.5, -halfW - 1.0, 4.0, 4.3125, -halfD - 1.0, halfD + 1.0, 'spruce_planks');
  addTiledSlab(eaveBuilders.nx, -halfW - 1.0, -halfW + 0.5, 4.0, 4.5, -halfD + 0.5, halfD - 0.5, 'oak_planks');
  addTiledSlab(eaveBuilders.nx, -halfW - 1.0, -halfW, 4.5, 4.8125, -halfD, halfD, 'dark_oak_planks', { ny: true });

  addTiledSlab(eaveBuilders.px, halfW + 1.0, halfW + 1.5, 4.0, 4.3125, -halfD - 1.0, halfD + 1.0, 'spruce_planks');
  addTiledSlab(eaveBuilders.px, halfW - 0.5, halfW + 1.0, 4.0, 4.5, -halfD + 0.5, halfD - 0.5, 'oak_planks');
  addTiledSlab(eaveBuilders.px, halfW, halfW + 1.0, 4.5, 4.8125, -halfD, halfD, 'dark_oak_planks', { ny: true });

  // 前左入户门雨棚双阶梯小檐（归入 +Z 墙体组）
  addTiledSlab(wallDetailBuilders.pz, -halfW, -halfW + 3, 3.0, 3.25, halfD, halfD + 1.5, 'spruce_planks');
  addTiledSlab(wallDetailBuilders.pz, -halfW, -halfW + 3, 3.25, 3.4375, halfD, halfD + 0.75, 'dark_oak_planks', { ny: true });

  // 3. 横跨房间的橡木天花横梁 + 纵梁（归入 roofGroup）
  const beamSpecs: Array<{ zCenter: number }> = [
    { zCenter: -halfD + 1.625 },
    { zCenter: halfD >= 4 ? -0.125 : 0.625 },
  ];
  if (halfD >= 4) {
    beamSpecs.push({ zCenter: halfD - 1.875 });
  }

  for (const beam of beamSpecs) {
    const z0 = beam.zCenter - 0.125;
    const z1 = beam.zCenter + 0.125;
    addTiledSlab(roofCoreBuilder, -halfW, halfW, 3.875, 4.125, z0, z1, 'oak_planks');
  }
  // 中心纵向脊梁
  addTiledSlab(roofCoreBuilder, -0.125, 0.125, 4.125, 4.3125, -halfD, halfD, 'spruce_planks');

  // 4. 天花垂吊发光红石灯
  const lampCoords: Array<{ x: number; z: number }> = [
    { x: snapToVoxel(-Math.max(1.25, halfW * 0.35)), z: beamSpecs[0].zCenter },
    { x: snapToVoxel(Math.max(1.25, halfW * 0.4)), z: beamSpecs[0].zCenter },
    { x: snapToVoxel(-Math.max(0.75, halfW * 0.25)), z: beamSpecs[1].zCenter },
  ];
  if (halfW >= 5) {
    lampCoords.push({
      x: snapToVoxel(Math.min(halfW - 1.75, halfW * 0.35)),
      z: beamSpecs[1].zCenter,
    });
  }

  for (const lamp of lampCoords) {
    roofDetailBuilder.addCenteredBox(lamp.x, 3.8125, lamp.z, 0.0625, 0.125, 0.0625, 'dark_iron', { occludes: false });
    roofDetailBuilder.addCenteredBox(lamp.x, 3.75, lamp.z, 0.1875, 0.0625, 0.1875, 'dark_iron', { occludes: false });
    roofEmissiveBuilder.addBox({
      minX: lamp.x - 0.25,
      minY: 3.25,
      minZ: lamp.z - 0.25,
      maxX: lamp.x + 0.25,
      maxY: 3.75,
      maxZ: lamp.z + 0.25,
      tiles: 'redstone_lamp_on',
    });
  }

  // 5. 经典 Minecraft 2 格高微内凹橡木门（归入 +Z 墙体组）
  const doorMinX = -halfW + 1;
  const doorMaxX = -halfW + 2;
  const doorMinZ = halfD + 0.28125;
  const doorMaxZ = halfD + 0.46875;
  wallDetailBuilders.pz.addBox({
    minX: doorMinX,
    minY: 0,
    minZ: doorMinZ,
    maxX: doorMaxX,
    maxY: 1,
    maxZ: doorMaxZ,
    tiles: {
      pz: 'oak_door_bottom',
      nz: 'oak_door_bottom',
      px: 'oak_planks',
      nx: 'oak_planks',
      py: 'oak_planks',
      ny: 'oak_planks',
    },
    hiddenFaces: { py: true, ny: true },
    floorY: 0,
  });
  wallDetailBuilders.pz.addBox({
    minX: doorMinX,
    minY: 1,
    minZ: doorMinZ,
    maxX: doorMaxX,
    maxY: 2,
    maxZ: doorMaxZ,
    tiles: {
      pz: 'oak_door_top',
      nz: 'oak_door_top',
      px: 'oak_planks',
      nx: 'oak_planks',
      py: 'oak_planks',
      ny: 'oak_planks',
    },
    hiddenFaces: { py: true, ny: true },
  });

  // 6. 门廊原木灯柱 + 前院矮木栅栏段（常驻室外层）
  const postX = -halfW + 2.6875;
  const postZ = halfD + 1.6875;
  baseDetailBuilder.addBox({
    minX: postX - 0.1875,
    minY: 0,
    minZ: postZ - 0.1875,
    maxX: postX + 0.1875,
    maxY: 0.25,
    maxZ: postZ + 0.1875,
    tiles: 'stone_brick',
    floorY: 0,
  });
  baseDetailBuilder.addBox({
    minX: postX - 0.125,
    minY: 0.25,
    minZ: postZ - 0.125,
    maxX: postX + 0.125,
    maxY: 2.625,
    maxZ: postZ + 0.125,
    tiles: { top: 'oak_log_top', bottom: 'oak_log_top', side: 'oak_log_side' },
  });
  baseDetailBuilder.addBox({
    minX: postX - 0.5625,
    minY: 2.375,
    minZ: postZ - 0.09375,
    maxX: postX - 0.125,
    maxY: 2.5625,
    maxZ: postZ + 0.09375,
    tiles: 'spruce_planks',
    hiddenFaces: { px: true },
  });

  // 庭院左侧装饰橡木栅栏（3 根立柱 + 双横档）
  const fenceZ = halfD + 3.5;
  const fenceXs = [-halfW - 2.5, -halfW - 1.5, -halfW - 0.5];
  for (let i = 0; i < fenceXs.length; i += 1) {
    const fx = fenceXs[i];
    baseDetailBuilder.addCenteredBox(fx, 0.4375, fenceZ, 0.1875, 0.875, 0.1875, 'oak_planks', {
      floorY: 0,
      hiddenFaces: { ny: true },
    });
    if (i < fenceXs.length - 1) {
      const midX = (fx + fenceXs[i + 1]) * 0.5;
      baseDetailBuilder.addCenteredBox(midX, 0.6875, fenceZ, 0.8125, 0.125, 0.09375, 'spruce_planks', { occludes: false });
      baseDetailBuilder.addCenteredBox(midX, 0.34375, fenceZ, 0.8125, 0.125, 0.09375, 'spruce_planks', { occludes: false });
    }
  }

  // 7. 吊挂灯笼：室内吊挂灯笼归入 roofGroup，门廊灯笼归入常驻层
  const indoorLanternX = snapToVoxel(Math.max(0.75, halfW - 2.25));
  const indoorLanternZ = beamSpecs[0].zCenter;
  const indoorLanternHangY = 3.875;
  const indoorLantern = createVoxelLanternGeometry(0.45);
  indoorLantern.frameGeo.translate(indoorLanternX, indoorLanternHangY, indoorLanternZ);
  indoorLantern.glowGeo.translate(indoorLanternX, indoorLanternHangY, indoorLanternZ);

  const porchLanternX = postX - 0.4375;
  const porchLanternZ = postZ;
  const porchLanternHangY = 2.375;
  const porchLantern = createVoxelLanternGeometry(0.1875);
  porchLantern.frameGeo.translate(porchLanternX, porchLanternHangY, porchLanternZ);
  porchLantern.glowGeo.translate(porchLanternX, porchLanternHangY, porchLanternZ);

  const lanternLightPositions: [THREE.Vector3, THREE.Vector3] = [
    new THREE.Vector3(snapToVoxel(-Math.max(1.25, halfW * 0.36)), 3.05, -0.25),
    new THREE.Vector3(snapToVoxel(Math.max(1.25, halfW * 0.36)), 3.05, 0.35),
  ];

  // 8. 室外 Minecraft 经典 X 型高草、三色野花与池畔甘蔗芦苇（合批于 cutout 层，0 额外 Draw Call）
  const outdoorFlora: ReadonlyArray<{ x: number; z: number; tile: VoxelTileId; w: number; h: number }> = [
    { x: -halfW - 2.5, z: halfD + 2.5, tile: 'flower_red', w: 0.56, h: 0.58 },
    { x: -halfW - 1.5, z: halfD + 4.4, tile: 'flower_yellow', w: 0.54, h: 0.56 },
    { x: -halfW + 0.5, z: halfD + 4.2, tile: 'flower_blue', w: 0.56, h: 0.6 },
    { x: -0.5, z: halfD + 4.1, tile: 'tall_grass', w: 0.68, h: 0.64 },
    { x: 1.5, z: halfD + 4.3, tile: 'flower_red', w: 0.56, h: 0.58 },
    { x: halfW - 0.5, z: halfD + 3.6, tile: 'flower_yellow', w: 0.54, h: 0.56 },
    { x: halfW + 2.5, z: halfD + 4.2, tile: 'tall_grass', w: 0.72, h: 0.66 },
    { x: halfW + 4.4, z: halfD + 4.3, tile: 'flower_blue', w: 0.56, h: 0.6 },
    { x: halfW + 2.4, z: 1.5, tile: 'tall_grass', w: 0.68, h: 0.62 },
    { x: halfW + 4.2, z: 2.2, tile: 'flower_red', w: 0.56, h: 0.58 },
    { x: halfW + 1.6, z: -halfD + 1.4, tile: 'tall_grass', w: 0.68, h: 0.62 },
    { x: -halfW - 2.6, z: -1.5, tile: 'flower_yellow', w: 0.56, h: 0.58 },
    { x: -halfW - 3.2, z: 0.6, tile: 'tall_grass', w: 0.7, h: 0.65 },
    { x: -halfW - 2.1, z: -halfD - 2.4, tile: 'flower_blue', w: 0.56, h: 0.6 },
    { x: halfW + 2.1, z: -halfD - 2.2, tile: 'tall_grass', w: 0.7, h: 0.64 },
    // 池畔沙岸甘蔗芦苇（高挑两节）
    { x: halfW + 1.5, z: halfD + 0.5, tile: 'sugar_cane', w: 0.62, h: 1.05 },
    { x: halfW + 5.3, z: halfD + 1.4, tile: 'sugar_cane', w: 0.62, h: 1.25 },
    { x: halfW + 5.1, z: halfD + 2.6, tile: 'sugar_cane', w: 0.62, h: 0.92 },
  ];

  for (const item of outdoorFlora) {
    baseCutoutBuilder.addCrossPlant(
      snapToVoxel(item.x),
      0,
      snapToVoxel(item.z),
      item.w,
      item.h,
      item.tile
    );
  }

  const roofCoreBeamGeo = roofCoreBuilder.build(false);
  const roofDetailGeo = roofDetailBuilder.build(false);
  const roofLampGeo = roofEmissiveBuilder.build(false);
  const baseDetailGeo = baseDetailBuilder.build(true);
  const baseCutoutGeo = baseCutoutBuilder.build(false);
  const baseEmissiveDetailGeo = baseEmissiveDetailBuilder.build(false);
  const wallNzEmissiveGeo = wallNzEmissiveBuilder.build(false);

  const wallDetailGeos: Record<OfficeWallDirection, THREE.BufferGeometry | null> = {
    px: wallDetailBuilders.px.build(true),
    nx: wallDetailBuilders.nx.build(true),
    pz: wallDetailBuilders.pz.build(true),
    nz: wallDetailBuilders.nz.build(true),
  };

  const roofEaveGeos: Record<OfficeWallDirection, THREE.BufferGeometry> = {
    px: eaveBuilders.px.build(false),
    nx: eaveBuilders.nx.build(false),
    pz: eaveBuilders.pz.build(false),
    nz: eaveBuilders.nz.build(false),
  };

  const baseOpaqueGeo = mergeVoxelGeometries([baseDetailGeo, porchLantern.frameGeo]);
  const baseEmissiveGeo = mergeVoxelGeometries([porchLantern.glowGeo, baseEmissiveDetailGeo]);

  const roofCoreOpaqueGeo = mergeVoxelGeometries([
    roofCoreBeamGeo,
    roofDetailGeo,
    indoorLantern.frameGeo,
  ]);
  const roofCoreEmissiveGeo = mergeVoxelGeometries([
    roofLampGeo,
    indoorLantern.glowGeo,
  ]);

  roofCoreBeamGeo.dispose();
  roofDetailGeo.dispose();
  roofLampGeo.dispose();
  baseDetailGeo.dispose();
  baseEmissiveDetailGeo.dispose();
  indoorLantern.frameGeo.dispose();
  indoorLantern.glowGeo.dispose();
  porchLantern.frameGeo.dispose();
  porchLantern.glowGeo.dispose();

  return {
    baseOpaqueGeo,
    baseCutoutGeo,
    baseEmissiveGeo,
    wallDetailGeos,
    wallNzEmissiveGeo,
    roofEaveGeos,
    roofCoreOpaqueGeo,
    roofCoreEmissiveGeo,
    lanternLightPositions,
    coffeeStation,
  };
}

function applyStoredWallVisibility(rig: OfficeRoomRig): void {
  for (const dir of WALL_DIRECTIONS) {
    const visible = rig.visibleWalls[dir];
    rig.wallGroups[dir].visible = visible;
    rig.roofEaveGroups[dir].visible = visible;
  }
}

/** 根据房间尺寸重建体素世界网格，并同步四向墙体、屋顶、接触阴影与贴墙铭牌/终端 */
function rebuildRoomWorldGeometry(
  rig: OfficeRoomRig,
  roomWidth: number,
  roomDepth: number
): void {
  const halfW = computeHalfExtent(roomWidth, MIN_HALF_W);
  const halfD = computeHalfExtent(roomDepth, MIN_HALF_D);

  rig.currentWidth = roomWidth;
  rig.currentDepth = roomDepth;
  rig.halfW = halfW;
  rig.halfD = halfD;
  rig.outerHalfWidth = halfW + YARD_EXTEND + 1;
  rig.outerHalfDepth = halfD + YARD_EXTEND + 1;

  const preserveNz = new Set<THREE.Object3D>([rig.plaqueGroup, rig.roomTerminalGroup]);
  const preserveRoof = new Set<THREE.Object3D>([
    rig.roofEaveGroups.px,
    rig.roofEaveGroups.nx,
    rig.roofEaveGroups.pz,
    rig.roofEaveGroups.nz,
  ]);

  clearDynamicWorldGroup(rig.dynamicWorldGroup);
  clearDynamicWorldGroup(rig.wallGroups.px);
  clearDynamicWorldGroup(rig.wallGroups.nx);
  clearDynamicWorldGroup(rig.wallGroups.pz);
  clearDynamicWorldGroup(rig.wallGroups.nz, preserveNz);
  clearDynamicWorldGroup(rig.roofGroup, preserveRoof);
  for (const dir of WALL_DIRECTIONS) {
    clearDynamicWorldGroup(rig.roofEaveGroups[dir]);
  }

  const voxelMaterials = getSharedVoxelMaterialSet();
  const baseGrid = new VoxelGrid();
  const wallGrids: Record<OfficeWallDirection, VoxelGrid> = {
    px: new VoxelGrid(),
    nx: new VoxelGrid(),
    pz: new VoxelGrid(),
    nz: new VoxelGrid(),
  };
  const { treeCenters, pondBounds } = populateRoomVoxelGrids(baseGrid, wallGrids, halfW, halfD);

  const baseGeos = baseGrid.buildGeometries();
  const baseAoOccluder = (x: number, y: number, z: number): boolean => baseGrid.hasOccluding(x, y, z);
  const subDetails = buildSubVoxelDetails(halfW, halfD);

  // 1. 常驻不透明层（浮空岛地形 + 地板 + 书架 + 咖啡台 + 树干 + 灯柱 + 栅栏）
  const opaqueParts: THREE.BufferGeometry[] = [];
  if (baseGeos.opaque) opaqueParts.push(baseGeos.opaque);
  opaqueParts.push(subDetails.baseOpaqueGeo);
  const mergedOpaque = mergeVoxelGeometries(opaqueParts);
  for (const part of opaqueParts) part.dispose();
  const opaqueMesh = new THREE.Mesh(mergedOpaque, voxelMaterials.opaque);
  opaqueMesh.name = 'room-base-opaque';
  opaqueMesh.castShadow = true;
  opaqueMesh.receiveShadow = true;
  rig.dynamicWorldGroup.add(opaqueMesh);

  // 2. 镂空植被层（树叶 + X 型野花高草 + 水岸甘蔗）
  const cutoutParts: THREE.BufferGeometry[] = [];
  if (baseGeos.cutout) cutoutParts.push(baseGeos.cutout);
  if (subDetails.baseCutoutGeo.getAttribute('position').count > 0) {
    cutoutParts.push(subDetails.baseCutoutGeo);
  } else {
    subDetails.baseCutoutGeo.dispose();
  }
  if (cutoutParts.length > 0) {
    const mergedCutout = mergeVoxelGeometries(cutoutParts);
    for (const part of cutoutParts) part.dispose();
    const cutoutMesh = new THREE.Mesh(mergedCutout, voxelMaterials.cutout);
    cutoutMesh.name = 'room-flora-cutout';
    cutoutMesh.castShadow = true;
    cutoutMesh.receiveShadow = true;
    rig.dynamicWorldGroup.add(cutoutMesh);
  }

  // 3. 流动半透明水池（水面下沉 0.125 格呈现经典 Minecraft 池岸深度）
  if (baseGeos.water) {
    baseGeos.water.translate(0, -0.125, 0);
    const waterMesh = new THREE.Mesh(baseGeos.water, voxelMaterials.water);
    waterMesh.name = 'room-pond-water';
    waterMesh.receiveShadow = true;
    waterMesh.renderOrder = 1;
    rig.dynamicWorldGroup.add(waterMesh);
  }

  // 4. 常驻自发光体素（门廊灯笼与咖啡机发光屏）
  const baseEmissiveParts: THREE.BufferGeometry[] = [];
  if (baseGeos.emissive) baseEmissiveParts.push(baseGeos.emissive);
  baseEmissiveParts.push(subDetails.baseEmissiveGeo);
  const mergedBaseEmissive = mergeVoxelGeometries(baseEmissiveParts);
  for (const part of baseEmissiveParts) part.dispose();
  const baseEmissiveMesh = new THREE.Mesh(mergedBaseEmissive, voxelMaterials.emissive);
  baseEmissiveMesh.name = 'room-base-emissive';
  rig.dynamicWorldGroup.add(baseEmissiveMesh);

  // 4b. 室外树木、书架、咖啡台与灯柱的合批柔和接触阴影（1 Draw Call）
  const shadowQuads: Array<{ cx: number; cz: number; width: number; depth: number; y?: number }> = [
    // 后左书架阴影
    { cx: -halfW + 2.0, cz: -halfD + 0.55, width: 2.3, depth: 1.25, y: 0.006 },
    // 咖啡台阴影
    {
      cx: subDetails.coffeeStation.anchorX,
      cz: subDetails.coffeeStation.anchorZ + 0.05,
      width: 1.3,
      depth: 0.96,
      y: 0.006,
    },
    // 门廊灯柱阴影
    { cx: -halfW + 2.6875, cz: halfD + 1.6875, width: 0.72, depth: 0.72, y: 0.006 },
  ];
  for (const tree of treeCenters) {
    shadowQuads.push({ cx: tree.x, cz: tree.z, width: 3.1, depth: 3.1, y: 0.008 });
  }
  const roomShadowMesh = new THREE.Mesh(
    createBatchedContactShadowGeometry(shadowQuads),
    voxelMaterials.contactShadow
  );
  roomShadowMesh.name = 'room-contact-shadows';
  roomShadowMesh.renderOrder = 1;
  rig.dynamicWorldGroup.add(roomShadowMesh);

  // 5. 四向独立墙体（±X / ±Z），每组按不透明/玻璃/自发光合批
  for (const dir of WALL_DIRECTIONS) {
    const wallGeos = wallGrids[dir].buildGeometries({ x: 0, y: 0, z: 0 }, baseAoOccluder);
    const wallGroup = rig.wallGroups[dir];

    const detailGeo = subDetails.wallDetailGeos[dir];
    const opaqueWallParts: THREE.BufferGeometry[] = [];
    if (wallGeos.opaque) opaqueWallParts.push(wallGeos.opaque);
    if (detailGeo && detailGeo.getAttribute('position').count > 0) {
      opaqueWallParts.push(detailGeo);
    } else if (detailGeo) {
      detailGeo.dispose();
    }

    if (opaqueWallParts.length > 0) {
      const mergedWall = mergeVoxelGeometries(opaqueWallParts);
      for (const part of opaqueWallParts) part.dispose();
      const wallOpaqueMesh = new THREE.Mesh(mergedWall, voxelMaterials.opaque);
      wallOpaqueMesh.name = `room-wall-${dir}-opaque`;
      wallOpaqueMesh.castShadow = true;
      wallOpaqueMesh.receiveShadow = true;
      wallGroup.add(wallOpaqueMesh);
    }

    if (wallGeos.glass) {
      const wallGlassMesh = new THREE.Mesh(wallGeos.glass, voxelMaterials.glass);
      wallGlassMesh.name = `room-wall-${dir}-glass`;
      wallGlassMesh.renderOrder = 2;
      wallGroup.add(wallGlassMesh);
    }

    if (dir === 'nz' && subDetails.wallNzEmissiveGeo.getAttribute('position').count > 0) {
      const nzEmissiveMesh = new THREE.Mesh(subDetails.wallNzEmissiveGeo, voxelMaterials.emissive);
      nzEmissiveMesh.name = 'room-wall-nz-emissive';
      wallGroup.add(nzEmissiveMesh);
    } else if (dir === 'nz') {
      subDetails.wallNzEmissiveGeo.dispose();
    }
  }

  // 6. 独立屋顶层（四向阶梯檐口 + 梁架/红石灯/室内灯笼）
  for (const dir of WALL_DIRECTIONS) {
    const eaveMesh = new THREE.Mesh(subDetails.roofEaveGeos[dir], voxelMaterials.opaque);
    eaveMesh.name = `room-roof-eave-${dir}`;
    eaveMesh.castShadow = true;
    eaveMesh.receiveShadow = true;
    rig.roofEaveGroups[dir].add(eaveMesh);
  }

  const roofCoreOpaqueMesh = new THREE.Mesh(subDetails.roofCoreOpaqueGeo, voxelMaterials.opaque);
  roofCoreOpaqueMesh.name = 'room-roof-core-opaque';
  roofCoreOpaqueMesh.castShadow = true;
  roofCoreOpaqueMesh.receiveShadow = true;
  rig.roofGroup.add(roofCoreOpaqueMesh);

  const roofCoreEmissiveMesh = new THREE.Mesh(subDetails.roofCoreEmissiveGeo, voxelMaterials.emissive);
  roofCoreEmissiveMesh.name = 'room-roof-core-emissive';
  rig.roofGroup.add(roofCoreEmissiveMesh);

  // 同步灯笼光源位置与可通行障碍元数据
  rig.lanternLightPositions.length = 0;
  rig.lanternLightPositions.push(
    subDetails.lanternLightPositions[0],
    subDetails.lanternLightPositions[1]
  );
  rig.coffeeStation = subDetails.coffeeStation;
  const staticObstacles: WorldRect2D[] = [
    {
      minX: -halfW + 1,
      maxX: -halfW + 3,
      minZ: -halfD,
      maxZ: -halfD + 1,
    },
    pondBounds,
  ];
  rig.walkLayout = {
    halfW,
    halfD,
    coffeeStation: subDetails.coffeeStation,
    staticObstacles,
  };

  // 后墙（-Z）中央窗左右两侧贴墙面板
  const leftBayCenterX = snapToVoxel((-halfW - 1.0) * 0.5);
  const rightBayCenterX = snapToVoxel((1.0 + halfW) * 0.5);
  rig.plaqueGroup.position.set(leftBayCenterX, 2.6875, -halfD);
  rig.roomTerminalGroup.position.set(rightBayCenterX, 2.6875, -halfD);

  applyStoredWallVisibility(rig);
}

/** 切换屋顶与吊灯层可见性（零场景重建） */
export function setOfficeRoomRoofVisible(rig: OfficeRoomRig, visible: boolean): void {
  rig.roofGroup.visible = visible;
}

/**
 * 智能室内外动态剖切（零几何重建、保留阴影与按需渲染）：
 * - 当相机进入房间内部近距浏览/读屏时，保留全部四面墙与屋顶，提供完整沉浸式 Minecraft 室内体验，
 *   彻底避免贴近显示器时背后墙壁突然消失露天空的穿帮。
 * - 当相机位于室外环绕或走廊视角时，仅隐藏实际挡在相机外侧方向的墙体（带滞回防抖），
 *   例如走廊正视仅隐藏 +Z 前墙，等距斜视隐藏 +X/+Z 两墙，俯瞰仰角 > 50° 时隐藏屋顶组。
 */
export function updateOfficeRoomDynamicCulling(
  rig: OfficeRoomRig,
  cameraPosition: THREE.Vector3,
  _targetPosition?: THREE.Vector3
): boolean {
  const cx = cameraPosition.x;
  const cy = cameraPosition.y;
  const cz = cameraPosition.z;

  const innerW = rig.halfW - 0.15;
  const innerD = rig.halfD - 0.15;
  const isInsideRoom =
    Math.abs(cx) < innerW
    && Math.abs(cz) < innerD
    && cy > -0.2
    && cy < 3.9;

  const hideThreshX = rig.halfW - WALL_CUTAWAY_MARGIN;
  const showThreshX = hideThreshX - WALL_HYSTERESIS;
  const hideThreshZ = rig.halfD - WALL_CUTAWAY_MARGIN;
  const showThreshZ = hideThreshZ - WALL_HYSTERESIS;

  let nextVisiblePx: boolean;
  let nextVisibleNx: boolean;
  let nextVisiblePz: boolean;
  let nextVisibleNz: boolean;
  let roofVisible: boolean;

  if (isInsideRoom) {
    // 室内近距阅读：四面墙与屋顶全部保持可见
    nextVisiblePx = true;
    nextVisibleNx = true;
    nextVisiblePz = true;
    nextVisibleNz = true;
    roofVisible = true;
  } else {
    // 室外智能剖切：仅隐藏相机越过该墙外侧剖切面的迎面墙体
    nextVisiblePx = rig.visibleWalls.px ? cx <= hideThreshX : cx < showThreshX;
    nextVisibleNx = rig.visibleWalls.nx ? cx >= -hideThreshX : cx > -showThreshX;
    nextVisiblePz = rig.visibleWalls.pz ? cz <= hideThreshZ : cz < showThreshZ;
    nextVisibleNz = rig.visibleWalls.nz ? cz >= -hideThreshZ : cz > -showThreshZ;

    // 俯视仰角过高且相机高于屋檐时隐藏屋顶组
    const horizDist = Math.hypot(cx, cz);
    const elevationRad = Math.atan2(cy - ROOM_CENTER_Y, horizDist);
    roofVisible = !(cy > 4.25 && elevationRad > ROOF_HIDE_ELEVATION_RAD);
  }

  if (cx > 0.12) rig.hiddenWallX = 'px';
  else if (cx < -0.12) rig.hiddenWallX = 'nx';
  if (cz > 0.12) rig.hiddenWallZ = 'pz';
  else if (cz < -0.12) rig.hiddenWallZ = 'nz';

  rig.visibleWalls.px = nextVisiblePx;
  rig.visibleWalls.nx = nextVisibleNx;
  rig.visibleWalls.pz = nextVisiblePz;
  rig.visibleWalls.nz = nextVisibleNz;

  let changed = false;
  for (const dir of WALL_DIRECTIONS) {
    const visible = rig.visibleWalls[dir];
    if (rig.wallGroups[dir].visible !== visible) {
      rig.wallGroups[dir].visible = visible;
      changed = true;
    }
    if (rig.roofEaveGroups[dir].visible !== visible) {
      rig.roofEaveGroups[dir].visible = visible;
      changed = true;
    }
  }

  if (rig.roofGroup.visible !== roofVisible) {
    rig.roofGroup.visible = roofVisible;
    changed = true;
  }

  return changed;
}

export function createOfficeRoomRig(
  palette: OfficeScenePalette,
  anisotropy: number
): OfficeRoomRig {
  const root = new THREE.Group();
  const dynamicWorldGroup = new THREE.Group();
  dynamicWorldGroup.name = 'room-dynamic-world';

  const wallGroups: OfficeRoomWallGroups = {
    px: new THREE.Group(),
    nx: new THREE.Group(),
    pz: new THREE.Group(),
    nz: new THREE.Group(),
  };
  wallGroups.px.name = 'room-wall-group-px';
  wallGroups.nx.name = 'room-wall-group-nx';
  wallGroups.pz.name = 'room-wall-group-pz';
  wallGroups.nz.name = 'room-wall-group-nz';

  const roofGroup = new THREE.Group();
  roofGroup.name = 'room-roof-group';

  const roofEaveGroups: OfficeRoomWallGroups = {
    px: new THREE.Group(),
    nx: new THREE.Group(),
    pz: new THREE.Group(),
    nz: new THREE.Group(),
  };
  roofEaveGroups.px.name = 'room-roof-eave-group-px';
  roofEaveGroups.nx.name = 'room-roof-eave-group-nx';
  roofEaveGroups.pz.name = 'room-roof-eave-group-pz';
  roofEaveGroups.nz.name = 'room-roof-eave-group-nz';

  root.add(dynamicWorldGroup);
  for (const dir of WALL_DIRECTIONS) {
    root.add(wallGroups[dir]);
    roofGroup.add(roofEaveGroups[dir]);
  }
  root.add(roofGroup);

  const voxelMaterials = getSharedVoxelMaterialSet();
  voxelMaterials.syncTheme(palette.mode);

  const plaqueBundle = createWallPlaqueBundle(anisotropy);
  const terminalBundle = createRoomTerminalBundle(anisotropy);

  // 贴墙告示牌与房间监视屏采用无光照洗白的 MeshBasicMaterial(toneMapped: false) 确保字迹清晰锐利
  const plaqueScreenMaterial = new THREE.MeshBasicMaterial({
    map: plaqueBundle.texture,
    toneMapped: false,
  });

  const terminalScreenMaterial = new THREE.MeshBasicMaterial({
    map: terminalBundle.texture,
    toneMapped: false,
  });

  const terminalStatusMaterial = new THREE.MeshBasicMaterial({
    color: palette.accentHex,
    toneMapped: false,
  });

  const plaqueGroup = buildPlaqueGroup(plaqueScreenMaterial, voxelMaterials.opaque);
  wallGroups.nz.add(plaqueGroup);

  const terminalBuilt = buildRoomTerminalGroup(
    terminalScreenMaterial,
    terminalStatusMaterial,
    voxelMaterials.opaque
  );
  wallGroups.nz.add(terminalBuilt.group);

  const rig: OfficeRoomRig = {
    root,
    dynamicWorldGroup,
    wallGroups,
    roofGroup,
    roofEaveGroups,
    plaqueGroup,
    roomTerminalGroup: terminalBuilt.group,
    roomTerminalScreen: terminalBuilt.screenMesh,
    plaqueBundle,
    terminalBundle,
    plaqueScreenMaterial,
    terminalScreenMaterial,
    terminalStatusMaterial,
    lanternLightPositions: [],
    currentWidth: 0,
    currentDepth: 0,
    halfW: MIN_HALF_W,
    halfD: MIN_HALF_D,
    outerHalfWidth: 0,
    outerHalfDepth: 0,
    hiddenWallX: 'px',
    hiddenWallZ: 'pz',
    visibleWalls: {
      px: false,
      nx: true,
      pz: false,
      nz: true,
    },
    coffeeStation: {
      anchorX: MIN_HALF_W - 1.5,
      anchorZ: -MIN_HALF_D + 0.375,
      interactX: MIN_HALF_W - 1.5,
      interactZ: -MIN_HALF_D + 1.25,
      facingYaw: Math.PI,
      footprint: {
        minX: MIN_HALF_W - 2,
        maxX: MIN_HALF_W - 1,
        minZ: -MIN_HALF_D,
        maxZ: -MIN_HALF_D + 0.75,
      },
    },
    walkLayout: {
      halfW: MIN_HALF_W,
      halfD: MIN_HALF_D,
      coffeeStation: {
        anchorX: MIN_HALF_W - 1.5,
        anchorZ: -MIN_HALF_D + 0.375,
        interactX: MIN_HALF_W - 1.5,
        interactZ: -MIN_HALF_D + 1.25,
        facingYaw: Math.PI,
        footprint: {
          minX: MIN_HALF_W - 2,
          maxX: MIN_HALF_W - 1,
          minZ: -MIN_HALF_D,
          maxZ: -MIN_HALF_D + 0.75,
        },
      },
      staticObstacles: [],
    },
  };

  rebuildRoomWorldGeometry(rig, DEFAULT_INIT_WIDTH, DEFAULT_INIT_DEPTH);
  return rig;
}

export function syncOfficeRoomRig(
  rig: OfficeRoomRig,
  state: OfficeSceneSyncState,
  palette?: OfficeScenePalette,
  roomWidth?: number,
  roomDepth?: number
): void {
  const resolvedPalette = palette ?? getOfficeScenePalette(state.theme);
  let resolvedWidth = roomWidth;
  let resolvedDepth = roomDepth;
  if (resolvedWidth === undefined || resolvedDepth === undefined) {
    const metrics = computeBayGridMetrics(state.sessions.length);
    resolvedWidth = resolvedWidth ?? metrics.roomWidth;
    resolvedDepth = resolvedDepth ?? metrics.roomDepth;
  }
  const nextHalfW = computeHalfExtent(resolvedWidth, MIN_HALF_W);
  const nextHalfD = computeHalfExtent(resolvedDepth, MIN_HALF_D);
  const prevHalfW = rig.currentWidth > 0 ? computeHalfExtent(rig.currentWidth, MIN_HALF_W) : 0;
  const prevHalfD = rig.currentDepth > 0 ? computeHalfExtent(rig.currentDepth, MIN_HALF_D) : 0;
  if (prevHalfW !== nextHalfW || prevHalfD !== nextHalfD) {
    rebuildRoomWorldGeometry(rig, resolvedWidth, resolvedDepth);
  } else {
    rig.currentWidth = resolvedWidth;
    rig.currentDepth = resolvedDepth;
  }

  getSharedVoxelMaterialSet().syncTheme(resolvedPalette.mode);

  rig.terminalStatusMaterial.color.set(resolvedPalette.accentHex);
  updateWallPlaqueTexture(rig.plaqueBundle, state, resolvedPalette);
  updateRoomTerminalTexture(rig.terminalBundle, state, resolvedPalette);
}

export function disposeOfficeRoomRig(rig: OfficeRoomRig): void {
  const disposedGeometries = new Set<THREE.BufferGeometry>();
  const disposedMaterials = new Set<THREE.Material>();

  clearDynamicWorldGroup(rig.dynamicWorldGroup);
  for (const dir of WALL_DIRECTIONS) {
    clearDynamicWorldGroup(rig.wallGroups[dir]);
    clearDynamicWorldGroup(rig.roofEaveGroups[dir]);
  }
  clearDynamicWorldGroup(rig.roofGroup);

  rig.root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    if (obj.geometry instanceof THREE.BufferGeometry && !disposedGeometries.has(obj.geometry)) {
      disposedGeometries.add(obj.geometry);
      obj.geometry.dispose();
    }
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
    for (const mat of mats) {
      if (
        mat instanceof THREE.Material
        && !isSharedVoxelMaterial(mat)
        && !disposedMaterials.has(mat)
      ) {
        disposedMaterials.add(mat);
        mat.dispose();
      }
    }
  });

  if (!disposedMaterials.has(rig.plaqueScreenMaterial)) {
    disposedMaterials.add(rig.plaqueScreenMaterial);
    rig.plaqueScreenMaterial.dispose();
  }
  if (!disposedMaterials.has(rig.terminalScreenMaterial)) {
    disposedMaterials.add(rig.terminalScreenMaterial);
    rig.terminalScreenMaterial.dispose();
  }
  if (!disposedMaterials.has(rig.terminalStatusMaterial)) {
    disposedMaterials.add(rig.terminalStatusMaterial);
    rig.terminalStatusMaterial.dispose();
  }

  rig.plaqueBundle.texture.dispose();
  rig.terminalBundle.texture.dispose();
}
