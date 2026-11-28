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
  addBookshelfColumnToGrid,
  addOakTreeToGrid,
  createVoxelLanternGeometry,
} from './office-voxel-kit';
import type {
  CoffeeStationAnchor,
  RoomWalkLayout,
  WorldRect2D,
} from './office-voxel-behaviour';

/**
 * Minecraft 体素办公室房间与室外景观构建器：
 * - 室内地板顶面严格对齐 y = 0（地板方块位于整数网格 gy = -1），四周扩展 5 格室外草坪与草-土-石浮空崖壁。
 * - 四面墙体按 ±X / ±Z 拆分为 4 组独立合批网格（各自保留门/窗缺口与材质分层），屋顶与檐口归入独立 roofGroup。
 * - 支持按相机方位角与仰角（> 55° 隐藏屋顶）每帧零重建动态剖切，始终保留阴影、按需渲染与地面/家具/树/水池常驻可见。
 * - 铭牌与房间邮件终端紧贴后墙（-Z 墙）内表面，随 -Z 墙同步显隐且隐藏时不参与 raycast 拾取。
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
  plaqueScreenMaterial: THREE.MeshLambertMaterial;
  terminalScreenMaterial: THREE.MeshLambertMaterial;
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
  coffeeStation: CoffeeStationAnchor;
  walkLayout: RoomWalkLayout;
}

const WALL_DIRECTIONS: readonly OfficeWallDirection[] = ['px', 'nx', 'pz', 'nz'];
const ROOM_CENTER_Y = 0.75;
const WALL_AXIS_HYSTERESIS = 0.12;
const ROOF_HIDE_ELEVATION_RAD = THREE.MathUtils.degToRad(55);

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

const STONE_BRICK_BLOCK: VoxelBlockSpec = {
  tiles: 'stone_brick',
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

function isLeftWallMullion(idx: number, length: number): boolean {
  if (length === 10) {
    return idx === 3 || idx === 6;
  }
  return (idx + 1) % 3 === 0 && idx <= length - 2;
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

/** 构建贴墙项目铭牌（尺寸 1.875 × 0.75 ≤ 2×1 体素，紧贴墙面 z ∈ [0, 0.0625]） */
function buildPlaqueGroup(
  plaqueScreenMaterial: THREE.MeshLambertMaterial,
  opaqueVoxelMaterial: THREE.MeshLambertMaterial
): THREE.Group {
  const plaqueGroup = new THREE.Group();
  const builder = new VoxelBoxBuilder();

  // 1.875 × 0.75 × 0.0625 深橡木贴墙底框，背面 z = 0 紧贴石砖墙面
  addTiledSlab(builder, -0.9375, 0.9375, -0.375, 0.375, 0, 0.0625, 'dark_oak_planks', { nz: true });

  const frameMesh = new THREE.Mesh(builder.build(false), opaqueVoxelMaterial);
  frameMesh.castShadow = false;
  frameMesh.receiveShadow = true;
  plaqueGroup.add(frameMesh);

  const screenMesh = new THREE.Mesh(new THREE.PlaneGeometry(1.75, 0.625), plaqueScreenMaterial);
  screenMesh.position.set(0, 0, 0.064);
  plaqueGroup.add(screenMesh);

  return plaqueGroup;
}

/** 构建贴墙房间邮件终端面板（尺寸 1.50 × 0.875 ≤ 2×1 体素，紧贴墙面 z ∈ [0, 0.0625]） */
function buildRoomTerminalGroup(
  terminalScreenMaterial: THREE.MeshLambertMaterial,
  terminalStatusMaterial: THREE.MeshBasicMaterial,
  opaqueVoxelMaterial: THREE.MeshLambertMaterial
): { group: THREE.Group; screenMesh: THREE.Mesh } {
  const group = new THREE.Group();
  const builder = new VoxelBoxBuilder();

  // 1.50 × 0.875 × 0.0625 深铁块贴墙嵌板（背面 z = 0 贴合后墙，不向地面悬空突出）
  addTiledSlab(builder, -0.75, 0.75, -0.4375, 0.4375, 0, 0.0625, 'dark_iron', { nz: true });

  const bodyMesh = new THREE.Mesh(builder.build(false), opaqueVoxelMaterial);
  bodyMesh.castShadow = false;
  bodyMesh.receiveShadow = true;
  group.add(bodyMesh);

  // 严格贴合面板前表面的像素终端屏幕
  const screenMesh = new THREE.Mesh(new THREE.PlaneGeometry(1.375, 0.75), terminalScreenMaterial);
  screenMesh.position.set(0, 0, 0.064);
  group.add(screenMesh);

  // 嵌入顶框的紧凑状态指示体素方块（保持整体突出 ≤ 0.0625）
  const statusCube = new THREE.Mesh(
    new THREE.BoxGeometry(0.1875, 0.0625, 0.0625),
    terminalStatusMaterial
  );
  statusCube.position.set(0, 0.46875, 0.03125);
  group.add(statusCube);

  return { group, screenMesh };
}

/** 填充常驻地形、室内地板、室内书架、水池、4 棵橡树及 4 组独立朝向墙体（±X / ±Z） */
function populateRoomVoxelGrids(
  baseGrid: VoxelGrid,
  wallGrids: Record<OfficeWallDirection, VoxelGrid>,
  halfW: number,
  halfD: number
): void {
  const yardMinX = -halfW - (YARD_EXTEND + 1);
  const yardMaxX = halfW + YARD_EXTEND;
  const yardMinZ = -halfD - (YARD_EXTEND + 1);
  const yardMaxZ = halfD + YARD_EXTEND;

  // 1. 浮空岛底层：gy = -3 石头崖底，gy = -2 泥土层，gy = -1 默认室外草方块（永远可见）
  baseGrid.fill(yardMinX, -3, yardMinZ, yardMaxX, -3, yardMaxZ, STONE_BLOCK);
  baseGrid.fill(yardMinX, -2, yardMinZ, yardMaxX, -2, yardMaxZ, DIRT_BLOCK);
  baseGrid.fill(yardMinX, -1, yardMinZ, yardMaxX, -1, yardMaxZ, GRASS_BLOCK);

  // 2. 建筑外墙地基（gy = -1，墙体动态隐藏后地面依然保持完整石砖底座无空洞）
  baseGrid.fill(-halfW - 1, -1, -halfD - 1, halfW, -1, -halfD - 1, STONE_BRICK_BLOCK);
  baseGrid.fill(-halfW - 1, -1, halfD, halfW, -1, halfD, STONE_BRICK_BLOCK);
  baseGrid.fill(-halfW - 1, -1, -halfD, -halfW - 1, -1, halfD - 1, STONE_BRICK_BLOCK);
  baseGrid.fill(halfW, -1, -halfD, halfW, -1, halfD - 1, STONE_BRICK_BLOCK);

  // 3. 室内木板地板（gy = -1）：云杉边框 + 中央棋盘格走廊 + 橡木/云杉镶嵌工区地板
  for (let z = -halfD; z <= halfD - 1; z += 1) {
    for (let x = -halfW; x <= halfW - 1; x += 1) {
      const isBorder = x === -halfW || x === halfW - 1 || z === -halfD || z === halfD - 1;
      const isAisle = x === -1 || x === 0;
      if (isBorder) {
        baseGrid.set(x, -1, z, SPRUCE_PLANKS_BLOCK);
      } else if (isAisle) {
        const checker = ((x + z) & 1) === 0;
        baseGrid.set(x, -1, z, checker ? SPRUCE_PLANKS_BLOCK : OAK_PLANKS_BLOCK);
      } else {
        const isInlay = (Math.abs(x) % 2 === 0) && (Math.abs(z) % 2 === 0);
        baseGrid.set(x, -1, z, isInlay ? SPRUCE_PLANKS_BLOCK : OAK_PLANKS_BLOCK);
      }
    }
  }

  // 室内常驻家具：后左内侧书架（高度 2，不随墙体隐藏）
  addBookshelfColumnToGrid(baseGrid, -halfW + 1, 0, -halfD, 2);
  addBookshelfColumnToGrid(baseGrid, -halfW + 2, 0, -halfD, 2);

  // 前墙门廊与通行口圆石铺地（gy = -1，常驻可见）
  const frontZ = halfD;
  const gapStart = Math.max(-halfW + 4, -1);
  const gapEnd = Math.min(halfW - 1, gapStart + 1);
  baseGrid.set(-halfW + 1, -1, frontZ, COBBLESTONE_BLOCK);
  for (let x = gapStart; x <= gapEnd; x += 1) {
    baseGrid.set(x, -1, frontZ, COBBLESTONE_BLOCK);
  }
  baseGrid.fill(-halfW, -1, frontZ + 1, -halfW + 3, -1, frontZ + 2, COBBLESTONE_BLOCK);
  baseGrid.fill(gapStart, -1, frontZ + 1, gapEnd, -1, frontZ + 2, COBBLESTONE_BLOCK);

  // 室外前右草坪 3×2 浅水池（沙边围岸，底面 gy = -2 泥土，常驻可见）
  const poolMinX = halfW + 2;
  const poolMaxX = halfW + 4;
  const poolMinZ = halfD + 1;
  const poolMaxZ = halfD + 2;
  baseGrid.fill(poolMinX - 1, -1, poolMinZ - 1, poolMaxX + 1, -1, poolMaxZ + 1, SAND_BLOCK);
  baseGrid.fill(poolMinX, -1, poolMinZ, poolMaxX, -1, poolMaxZ, WATER_BLOCK);

  // 室外 4 棵 Minecraft 经典橡树（常驻可见）
  addOakTreeToGrid(baseGrid, -halfW - 4, 0, -halfD - 4, 4, 101);
  addOakTreeToGrid(baseGrid, -halfW - 4, 0, halfD + 2, 3, 207);
  addOakTreeToGrid(baseGrid, halfW + 3, 0, -halfD - 4, 4, 313);
  addOakTreeToGrid(baseGrid, halfW + 3, 0, -1, 3, 419);

  // 4. 后墙（-Z 墙，z = -halfD - 1，完整 4 格高 gy = 0..3，含左右角柱与中央 2×2 玻璃窗缺口）
  const backZ = -halfD - 1;
  wallGrids.nz.fill(-halfW, 0, backZ, halfW - 1, 3, backZ, STONE_BRICK_BLOCK);
  wallGrids.nz.fill(-halfW - 1, 0, backZ, -halfW - 1, 3, backZ, OAK_LOG_VERTICAL);
  wallGrids.nz.fill(halfW, 0, backZ, halfW, 3, backZ, OAK_LOG_VERTICAL);
  wallGrids.nz.fill(-1, 1, backZ, 0, 2, backZ, GLASS_BLOCK);

  // 5. 左墙（-X 墙，x = -halfW - 1，完整 4 格高 gy = 0..3）：石砖窗台 + 高玻璃窗 + 原木窗棂 + 石砖顶梁
  const leftX = -halfW - 1;
  const sideWallLen = halfD * 2;
  for (let idx = 0; idx < sideWallLen; idx += 1) {
    const z = -halfD + idx;
    wallGrids.nx.set(leftX, 0, z, STONE_BRICK_BLOCK);
    wallGrids.nx.set(leftX, 3, z, STONE_BRICK_BLOCK);
    if (isLeftWallMullion(idx, sideWallLen)) {
      wallGrids.nx.set(leftX, 1, z, OAK_LOG_VERTICAL);
      wallGrids.nx.set(leftX, 2, z, OAK_LOG_VERTICAL);
    } else {
      wallGrids.nx.set(leftX, 1, z, GLASS_BLOCK);
      wallGrids.nx.set(leftX, 2, z, GLASS_BLOCK);
    }
  }

  // 6. 右墙（+X 墙，x = halfW，对称 4 格高玻璃窗墙；默认等距视口下由动态剖切隐藏，绕到 -X 侧时显示）
  const rightX = halfW;
  for (let idx = 0; idx < sideWallLen; idx += 1) {
    const z = -halfD + idx;
    wallGrids.px.set(rightX, 0, z, STONE_BRICK_BLOCK);
    wallGrids.px.set(rightX, 3, z, STONE_BRICK_BLOCK);
    if (isLeftWallMullion(idx, sideWallLen)) {
      wallGrids.px.set(rightX, 1, z, OAK_LOG_VERTICAL);
      wallGrids.px.set(rightX, 2, z, OAK_LOG_VERTICAL);
    } else {
      wallGrids.px.set(rightX, 1, z, GLASS_BLOCK);
      wallGrids.px.set(rightX, 2, z, GLASS_BLOCK);
    }
  }

  // 7. 前墙（+Z 墙，z = halfD，完整 4 格高含前左入户门洞、2 格通行拱口与右侧玻璃窗；面向相机时动态隐藏）
  wallGrids.pz.fill(-halfW - 1, 0, frontZ, -halfW - 1, 3, frontZ, OAK_LOG_VERTICAL);
  wallGrids.pz.fill(halfW, 0, frontZ, halfW, 3, frontZ, OAK_LOG_VERTICAL);
  for (let x = -halfW; x <= halfW - 1; x += 1) {
    if (x === -halfW + 1) {
      // 入户门洞（gy = 0..1 留空容纳子体素橡木门，gy = 2 原木门楣，gy = 3 石砖过梁）
      wallGrids.pz.set(x, 2, frontZ, OAK_LOG_HORIZONTAL_X);
      wallGrids.pz.set(x, 3, frontZ, STONE_BRICK_BLOCK);
    } else if (x >= gapStart && x <= gapEnd) {
      // 开放通行拱口（gy = 0..1 留空，gy = 2 原木门楣，gy = 3 石砖过梁）
      wallGrids.pz.set(x, 2, frontZ, OAK_LOG_HORIZONTAL_X);
      wallGrids.pz.set(x, 3, frontZ, STONE_BRICK_BLOCK);
    } else if (
      x === -halfW
      || x === -halfW + 2
      || x === halfW - 1
    ) {
      wallGrids.pz.fill(x, 0, frontZ, x, 3, frontZ, STONE_BRICK_BLOCK);
    } else {
      // 其余前墙开间做成石砖窗台 + 2 格高玻璃窗 + 石砖顶梁
      wallGrids.pz.set(x, 0, frontZ, STONE_BRICK_BLOCK);
      wallGrids.pz.set(x, 1, frontZ, GLASS_BLOCK);
      wallGrids.pz.set(x, 2, frontZ, GLASS_BLOCK);
      wallGrids.pz.set(x, 3, frontZ, STONE_BRICK_BLOCK);
    }
  }
}

/**
 * 构建靠后墙（-Z）右侧空位的体素咖啡台与咖啡机，全部并入房间基础合批网格（0 额外 Draw Call）：
 * - 深色橡木柜体 + 橡木台面 + 深铁/铁块咖啡机机身 + 咖啡豆仓 + 双出水口 + 接水托盘 + 备用马克杯；
 * - 正面电子屏与绿色就绪指示灯并入 room-base-emissive；
 * - 顶部高度 1.6875，严格低于后墙房间邮件终端（底沿 2.25），正面留出 1 格开阔交互点且不遮挡工位与走道。
 */
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

  // 1. 木质咖啡台底柜与台面（宽 1.00 × 深 0.75 × 高 0.875）
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
  // 柜门铁色拉手
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

  // 2. 铁/深铁体素咖啡机机身（靠台面左侧偏中，留出右侧摆杯空间）
  const mMinX = cx - 0.375;
  const mMaxX = cx + 0.1875;
  // 后立柱机身
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
  // 顶部前探冲煮头
  opaqueBuilder.addBox({
    minX: mMinX,
    minY: 1.3125,
    minZ: backZ + 0.3125,
    maxX: mMaxX,
    maxY: 1.5625,
    maxZ: backZ + 0.5625,
    tiles: { top: 'iron_block', side: 'dark_iron', bottom: 'dark_iron' },
    hiddenFaces: { nz: true },
  });
  // 顶部咖啡豆仓（深木框 + 咖啡豆棕顶面）
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
  // 底部不锈钢接水滴盘
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
  // 双咖啡出水嘴（从冲煮头下沿垂下）
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

  // 3. 咖啡机正面发光小屏与绿色工作指示灯（并入 room-base-emissive）
  emissiveBuilder.addBox({
    minX: cx - 0.3125,
    minY: 1.375,
    minZ: backZ + 0.5625,
    maxX: cx - 0.0625,
    maxY: 1.5,
    maxZ: backZ + 0.59375,
    tiles: 'wool_cyan',
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

  // 4. 台面右侧摆放的白色备用马克杯
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

  return {
    anchorX: cx,
    anchorZ: backZ + 0.375,
    interactX: cx,
    interactZ: backZ + 1.25,
    facingYaw: Math.PI,
    footprint: { minX, maxX, minZ, maxZ },
  };
}

/** 构建子体素建筑细部：拆分为常驻室外层、+Z 墙附属门与雨棚、四向屋檐与天花核心横梁/灯具 */
function buildSubVoxelDetails(
  halfW: number,
  halfD: number
): {
  baseOpaqueGeo: THREE.BufferGeometry;
  baseEmissiveGeo: THREE.BufferGeometry;
  wallPzDetailGeo: THREE.BufferGeometry;
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
  const roofCoreBuilder = new VoxelBoxBuilder();
  const roofDetailBuilder = new VoxelBoxBuilder();
  const roofEmissiveBuilder = new VoxelBoxBuilder();
  const wallPzDetailBuilder = new VoxelBoxBuilder();
  const baseDetailBuilder = new VoxelBoxBuilder();
  const baseEmissiveDetailBuilder = new VoxelBoxBuilder();

  // 0. 室内靠后墙（-Z）右侧体素咖啡台与咖啡机（与房间基础合批，零额外 Draw Call）
  const coffeeStation = appendCoffeeMachineCounter(
    baseDetailBuilder,
    baseEmissiveDetailBuilder,
    halfW,
    halfD
  );

  // 1. 四向悬挑屋檐（互不重叠，按墙体可见性同步显隐，仰角 > 55° 时随 roofGroup 整体隐藏）
  // -Z 屋檐（全宽，含后角悬挑）
  addTiledSlab(eaveBuilders.nz, -halfW - 1.5, halfW + 1.5, 4.0, 4.375, -halfD - 1.5, -halfD - 1.0, 'spruce_planks');
  addTiledSlab(eaveBuilders.nz, -halfW - 1.0, halfW + 1.0, 4.0, 4.5, -halfD - 1.0, -halfD + 0.5, 'oak_planks');
  addTiledSlab(eaveBuilders.nz, -halfW - 1.0, halfW + 1.0, 4.5, 4.75, -halfD - 1.0, -halfD, 'spruce_planks', { ny: true });

  // +Z 屋檐（全宽，含前角悬挑）
  addTiledSlab(eaveBuilders.pz, -halfW - 1.5, halfW + 1.5, 4.0, 4.375, halfD + 1.0, halfD + 1.5, 'spruce_planks');
  addTiledSlab(eaveBuilders.pz, -halfW - 1.0, halfW + 1.0, 4.0, 4.5, halfD - 0.5, halfD + 1.0, 'oak_planks');
  addTiledSlab(eaveBuilders.pz, -halfW - 1.0, halfW + 1.0, 4.5, 4.75, halfD, halfD + 1.0, 'spruce_planks', { ny: true });

  // -X 屋檐（夹在 -Z 与 +Z 屋檐之间，零重叠）
  addTiledSlab(eaveBuilders.nx, -halfW - 1.5, -halfW - 1.0, 4.0, 4.375, -halfD - 1.0, halfD + 1.0, 'spruce_planks');
  addTiledSlab(eaveBuilders.nx, -halfW - 1.0, -halfW + 0.5, 4.0, 4.5, -halfD + 0.5, halfD - 0.5, 'oak_planks');
  addTiledSlab(eaveBuilders.nx, -halfW - 1.0, -halfW, 4.5, 4.75, -halfD, halfD, 'spruce_planks', { ny: true });

  // +X 屋檐（对称夹在 -Z 与 +Z 屋檐之间，零重叠）
  addTiledSlab(eaveBuilders.px, halfW + 1.0, halfW + 1.5, 4.0, 4.375, -halfD - 1.0, halfD + 1.0, 'spruce_planks');
  addTiledSlab(eaveBuilders.px, halfW - 0.5, halfW + 1.0, 4.0, 4.5, -halfD + 0.5, halfD - 0.5, 'oak_planks');
  addTiledSlab(eaveBuilders.px, halfW, halfW + 1.0, 4.5, 4.75, -halfD, halfD, 'spruce_planks', { ny: true });

  // 前左入户门雨棚小檐（归入 +Z 墙体组，随 +Z 墙同步剖切）
  addTiledSlab(wallPzDetailBuilder, -halfW, -halfW + 3, 3.0, 3.25, halfD, halfD + 1.5, 'spruce_planks');

  // 2. 横跨房间的橡木天花横梁（归入 roofGroup，俯视仰角 > 55° 时整体隐藏）
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

  // 3. 从天花横梁垂吊的发光红石灯（归入 roofGroup）
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
    roofDetailBuilder.addCenteredBox(lamp.x, 3.8125, lamp.z, 0.0625, 0.125, 0.0625, 'dark_iron', {
      occludes: false,
    });
    roofDetailBuilder.addCenteredBox(lamp.x, 3.75, lamp.z, 0.1875, 0.0625, 0.1875, 'dark_iron', {
      occludes: false,
    });
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

  // 4. 经典 Minecraft 2 格高微内凹橡木门（归入 +Z 墙体组）
  const doorMinX = -halfW + 1;
  const doorMaxX = -halfW + 2;
  const doorMinZ = halfD + 0.28125;
  const doorMaxZ = halfD + 0.46875;
  wallPzDetailBuilder.addBox({
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
  wallPzDetailBuilder.addBox({
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

  // 5. 门廊外侧原木灯柱（常驻室外层）
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

  // 6. 两盏 Minecraft 吊挂灯笼：室内吊挂灯笼归入 roofGroup，室外门廊灯笼归入常驻层
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

  // 两盏暖色 PointLight 锚定在室内左右红石灯/工位上方，夜晚均匀照亮桌面、键鼠与角色，无死黑角落
  const lanternLightPositions: [THREE.Vector3, THREE.Vector3] = [
    new THREE.Vector3(snapToVoxel(-Math.max(1.25, halfW * 0.36)), 3.05, -0.25),
    new THREE.Vector3(snapToVoxel(Math.max(1.25, halfW * 0.36)), 3.05, 0.35),
  ];

  // 7. 室外草坪零星点缀的体素小红花与小黄花（0.25 方块花冠 + 细绿茎）
  const flowerSpots: ReadonlyArray<{ x: number; z: number; tile: 'flower_red' | 'flower_yellow' }> = [
    { x: -halfW - 2.5, z: halfD + 3.5, tile: 'flower_red' },
    { x: -halfW - 1.5, z: halfD + 4.5, tile: 'flower_yellow' },
    { x: -halfW + 0.5, z: halfD + 4.25, tile: 'flower_red' },
    { x: -0.5, z: halfD + 3.75, tile: 'flower_yellow' },
    { x: 1.5, z: halfD + 4.25, tile: 'flower_red' },
    { x: halfW - 0.5, z: halfD + 3.5, tile: 'flower_yellow' },
    { x: halfW + 2.5, z: halfD + 4.25, tile: 'flower_red' },
    { x: halfW + 4.5, z: halfD + 4.5, tile: 'flower_yellow' },
    { x: halfW + 2.5, z: 1.5, tile: 'flower_yellow' },
    { x: halfW + 4.25, z: 2.25, tile: 'flower_red' },
    { x: halfW + 1.5, z: -halfD + 1.5, tile: 'flower_red' },
    { x: -halfW - 2.5, z: -1.5, tile: 'flower_yellow' },
  ];

  const flowerBuilder = new VoxelBoxBuilder();
  for (const flower of flowerSpots) {
    const fx = snapToVoxel(flower.x);
    const fz = snapToVoxel(flower.z);
    flowerBuilder.addCenteredBox(fx, 0.0625, fz, 0.0625, 0.125, 0.0625, 'grass_top', {
      occludes: false,
      hiddenFaces: { py: true, ny: true },
    });
    flowerBuilder.addCenteredBox(fx, 0.25, fz, 0.25, 0.25, 0.25, flower.tile, {
      occludes: false,
    });
  }

  const roofCoreBeamGeo = roofCoreBuilder.build(false);
  const roofDetailGeo = roofDetailBuilder.build(false);
  const roofLampGeo = roofEmissiveBuilder.build(false);
  const wallPzDetailGeo = wallPzDetailBuilder.build(true);
  const baseDetailGeo = baseDetailBuilder.build(true);
  const baseEmissiveDetailGeo = baseEmissiveDetailBuilder.build(false);
  const flowerGeo = flowerBuilder.build(false);

  const roofEaveGeos: Record<OfficeWallDirection, THREE.BufferGeometry> = {
    px: eaveBuilders.px.build(false),
    nx: eaveBuilders.nx.build(false),
    pz: eaveBuilders.pz.build(false),
    nz: eaveBuilders.nz.build(false),
  };

  const baseOpaqueGeo = mergeVoxelGeometries([
    baseDetailGeo,
    flowerGeo,
    porchLantern.frameGeo,
  ]);
  const baseEmissiveGeo = mergeVoxelGeometries([
    porchLantern.glowGeo,
    baseEmissiveDetailGeo,
  ]);

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
  flowerGeo.dispose();
  indoorLantern.frameGeo.dispose();
  indoorLantern.glowGeo.dispose();
  porchLantern.frameGeo.dispose();
  porchLantern.glowGeo.dispose();

  return {
    baseOpaqueGeo,
    baseEmissiveGeo,
    wallPzDetailGeo,
    roofEaveGeos,
    roofCoreOpaqueGeo,
    roofCoreEmissiveGeo,
    lanternLightPositions,
    coffeeStation,
  };
}

/** 同步四面墙体与对应檐口的当前隐藏状态（供重建几何后立即复原） */
function applyStoredWallVisibility(rig: OfficeRoomRig): void {
  for (const dir of WALL_DIRECTIONS) {
    const visible = dir !== rig.hiddenWallX && dir !== rig.hiddenWallZ;
    rig.wallGroups[dir].visible = visible;
    rig.roofEaveGroups[dir].visible = visible;
  }
}

/** 根据房间尺寸重建体素世界网格，并同步 4 组独立墙体、屋顶层、贴墙铭牌/终端与灯笼点光源位置 */
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
  populateRoomVoxelGrids(baseGrid, wallGrids, halfW, halfD);

  const baseGeos = baseGrid.buildGeometries();
  const baseAoOccluder = (x: number, y: number, z: number): boolean => baseGrid.hasOccluding(x, y, z);
  const subDetails = buildSubVoxelDetails(halfW, halfD);

  // 1. 常驻不透明建筑与景观层（地形 + 地板 + 书架 + 树干 + 室外灯柱 + 花丛，永远可见）
  const opaqueParts: THREE.BufferGeometry[] = [];
  if (baseGeos.opaque) opaqueParts.push(baseGeos.opaque);
  opaqueParts.push(subDetails.baseOpaqueGeo);
  const mergedOpaque = mergeVoxelGeometries(opaqueParts);
  for (const part of opaqueParts) {
    part.dispose();
  }
  const opaqueMesh = new THREE.Mesh(mergedOpaque, voxelMaterials.opaque);
  opaqueMesh.name = 'room-base-opaque';
  opaqueMesh.castShadow = true;
  opaqueMesh.receiveShadow = true;
  rig.dynamicWorldGroup.add(opaqueMesh);

  // 2. 树叶镂空层（cutout，永远可见）
  if (baseGeos.cutout) {
    const cutoutMesh = new THREE.Mesh(baseGeos.cutout, voxelMaterials.cutout);
    cutoutMesh.name = 'room-trees-cutout';
    cutoutMesh.castShadow = true;
    cutoutMesh.receiveShadow = true;
    rig.dynamicWorldGroup.add(cutoutMesh);
  }

  // 3. 半透明水池（水面下沉 0.125 格呈现经典 Minecraft 凹陷池岸质感，永远可见）
  if (baseGeos.water) {
    baseGeos.water.translate(0, -0.125, 0);
    const waterMesh = new THREE.Mesh(baseGeos.water, voxelMaterials.water);
    waterMesh.name = 'room-pond-water';
    waterMesh.receiveShadow = true;
    waterMesh.renderOrder = 1;
    rig.dynamicWorldGroup.add(waterMesh);
  }

  // 4. 常驻室外自发光体素（门廊灯笼暖光芯）
  const baseEmissiveParts: THREE.BufferGeometry[] = [];
  if (baseGeos.emissive) baseEmissiveParts.push(baseGeos.emissive);
  baseEmissiveParts.push(subDetails.baseEmissiveGeo);
  const mergedBaseEmissive = mergeVoxelGeometries(baseEmissiveParts);
  for (const part of baseEmissiveParts) {
    part.dispose();
  }
  const baseEmissiveMesh = new THREE.Mesh(mergedBaseEmissive, voxelMaterials.emissive);
  baseEmissiveMesh.name = 'room-base-emissive';
  rig.dynamicWorldGroup.add(baseEmissiveMesh);

  // 5. 四向独立墙体（±X / ±Z），每组按材质层合批（不透明石砖/原木 + 玻璃窗），各自保留门/窗缺口
  for (const dir of WALL_DIRECTIONS) {
    const wallGeos = wallGrids[dir].buildGeometries({ x: 0, y: 0, z: 0 }, baseAoOccluder);
    const wallGroup = rig.wallGroups[dir];

    let wallOpaqueGeo = wallGeos.opaque;
    if (dir === 'pz') {
      const pzParts: THREE.BufferGeometry[] = [];
      if (wallOpaqueGeo) pzParts.push(wallOpaqueGeo);
      pzParts.push(subDetails.wallPzDetailGeo);
      wallOpaqueGeo = mergeVoxelGeometries(pzParts);
      for (const part of pzParts) {
        part.dispose();
      }
    }

    if (wallOpaqueGeo) {
      const wallOpaqueMesh = new THREE.Mesh(wallOpaqueGeo, voxelMaterials.opaque);
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
  }

  // 6. 独立屋顶层（四向檐口 + 天花横梁/红石灯/室内灯笼，仰角 > 55° 时整体零重建隐藏）
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

  // 同步两处室内暖色灯笼点光源世界坐标与可通行障碍元数据（书架、咖啡台、室外水池）
  rig.lanternLightPositions.length = 0;
  rig.lanternLightPositions.push(
    subDetails.lanternLightPositions[0],
    subDetails.lanternLightPositions[1]
  );
  rig.coffeeStation = subDetails.coffeeStation;
  const staticObstacles: WorldRect2D[] = [
    // 后左内侧书架（x = -halfW + 1 .. -halfW + 2, z = -halfD）
    {
      minX: -halfW + 1,
      maxX: -halfW + 3,
      minZ: -halfD,
      maxZ: -halfD + 1,
    },
    // 室外前右浅水池（显式纳入不可通行列表）
    {
      minX: halfW + 1,
      maxX: halfW + 5,
      minZ: halfD,
      maxZ: halfD + 3,
    },
  ];
  rig.walkLayout = {
    halfW,
    halfD,
    coffeeStation: subDetails.coffeeStation,
    staticObstacles,
  };

  // 同步两块贴墙面板位置（挂在 -Z 后墙中央窗左右两侧实心石砖墙面上，z = -halfD，高度 2.6875 不挡工位）
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
 * 按相机相对房间中心的方位角与仰角动态剖切墙体与屋顶（零几何重建、保留阴影与按需渲染）：
 * - 隐藏朝向相机的两面墙（+X/-X 中近侧一面，+Z/-Z 中近侧一面）及对应悬挑屋檐；
 * - 相机相对中心仰角 > 55° 时隐藏屋顶组，其余朝向恢复显示。
 * 返回值表示本次更新是否改变了任意可见性状态。
 */
export function updateOfficeRoomDynamicCulling(
  rig: OfficeRoomRig,
  cameraPosition: THREE.Vector3
): boolean {
  const dx = cameraPosition.x;
  const dz = cameraPosition.z;

  if (dx > WALL_AXIS_HYSTERESIS) {
    rig.hiddenWallX = 'px';
  } else if (dx < -WALL_AXIS_HYSTERESIS) {
    rig.hiddenWallX = 'nx';
  }

  if (dz > WALL_AXIS_HYSTERESIS) {
    rig.hiddenWallZ = 'pz';
  } else if (dz < -WALL_AXIS_HYSTERESIS) {
    rig.hiddenWallZ = 'nz';
  }

  const horizDist = Math.hypot(dx, dz);
  const elevationRad = Math.atan2(cameraPosition.y - ROOM_CENTER_Y, horizDist);
  const roofVisible = elevationRad <= ROOF_HIDE_ELEVATION_RAD;

  let changed = false;
  for (const dir of WALL_DIRECTIONS) {
    const visible = dir !== rig.hiddenWallX && dir !== rig.hiddenWallZ;
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

  const plaqueScreenMaterial = new THREE.MeshLambertMaterial({
    map: plaqueBundle.texture,
    emissive: new THREE.Color('#ffffff'),
    emissiveMap: plaqueBundle.texture,
    emissiveIntensity: palette.mode === 'dark' ? 0.92 : 0.72,
  });

  const terminalScreenMaterial = new THREE.MeshLambertMaterial({
    map: terminalBundle.texture,
    emissive: new THREE.Color('#ffffff'),
    emissiveMap: terminalBundle.texture,
    emissiveIntensity: 0.9,
  });

  const terminalStatusMaterial = new THREE.MeshBasicMaterial({
    color: palette.accentHex,
  });

  // 铭牌与房间终端贴挂在 -Z 后墙内侧，随 -Z 墙同步隐藏并自动退出拾取
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
  // 仅当整数体素半宽/半深发生变化时才重建体素世界几何，避免无谓重建开销
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

  rig.plaqueScreenMaterial.emissiveIntensity = resolvedPalette.mode === 'dark' ? 0.92 : 0.72;
  rig.terminalScreenMaterial.emissiveIntensity = 0.9;
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
