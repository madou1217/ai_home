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

/**
 * Minecraft 体素办公室房间与室外景观构建器：
 * - 室内地板顶面严格对齐 y = 0（地板方块位于整数网格 gy = -1），四周扩展 5 格室外草坪与草-土-石浮空崖壁。
 * - 使用 VoxelGrid 自动隐藏面剔除、四档 AO 与方向明暗分层，并按渲染层合批以将 Draw Call 降至最低。
 * - 独立维护 roofGroup 屋顶层，支持全景俯瞰（overview）模式即时隐藏/恢复而不重建场景或破坏阴影。
 * - 铭牌与房间邮件终端均紧贴后墙内表面（厚度 ≤ 0.0625，尺寸 ≤ 2×1 体素），高挂于工位视线之上。
 */

export interface OfficeRoomRig {
  root: THREE.Group;
  dynamicWorldGroup: THREE.Group;
  roofGroup: THREE.Group;
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
  outerHalfWidth: number;
  outerHalfDepth: number;
}

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

const SCRATCH_STATUS_COLOR = new THREE.Color();
const WHITE_COLOR = new THREE.Color('#ffffff');

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

/** 释放动态世界容器中的几何体与非共享材质（绝不销毁共享图集材质） */
function clearDynamicWorldGroup(group: THREE.Group): void {
  const disposedGeometries = new Set<THREE.BufferGeometry>();
  const disposedMaterials = new Set<THREE.Material>();

  const children = [...group.children];
  for (const child of children) {
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

  // 所有子节点均写入房间邮箱点击命中标记
  group.traverse((obj) => {
    obj.userData.hitKind = 'room-mailbox';
  });

  return { group, screenMesh };
}

/** 填充浮空岛地形、室内木板地面、四面墙体、书架、水池与 4 棵橡树至整数体素网格 */
function populateRoomVoxelGrid(grid: VoxelGrid, halfW: number, halfD: number): void {
  const yardMinX = -halfW - (YARD_EXTEND + 1);
  const yardMaxX = halfW + YARD_EXTEND;
  const yardMinZ = -halfD - (YARD_EXTEND + 1);
  const yardMaxZ = halfD + YARD_EXTEND;

  // 1. 浮空岛底层：gy = -3 石头崖底，gy = -2 泥土层，gy = -1 默认室外草方块
  grid.fill(yardMinX, -3, yardMinZ, yardMaxX, -3, yardMaxZ, STONE_BLOCK);
  grid.fill(yardMinX, -2, yardMinZ, yardMaxX, -2, yardMaxZ, DIRT_BLOCK);
  grid.fill(yardMinX, -1, yardMinZ, yardMaxX, -1, yardMaxZ, GRASS_BLOCK);

  // 2. 建筑外墙地基（gy = -1）
  grid.fill(-halfW - 1, -1, -halfD - 1, halfW, -1, -halfD - 1, STONE_BRICK_BLOCK);
  grid.fill(-halfW - 1, -1, halfD, halfW, -1, halfD, STONE_BRICK_BLOCK);
  grid.fill(-halfW - 1, -1, -halfD, -halfW - 1, -1, halfD - 1, STONE_BRICK_BLOCK);
  grid.fill(halfW, -1, -halfD, halfW, -1, halfD - 1, STONE_BRICK_BLOCK);

  // 3. 室内木板地板（gy = -1）：云杉边框 + 中央棋盘格走廊 + 橡木/云杉镶嵌工区地板
  for (let z = -halfD; z <= halfD - 1; z += 1) {
    for (let x = -halfW; x <= halfW - 1; x += 1) {
      const isBorder = x === -halfW || x === halfW - 1 || z === -halfD || z === halfD - 1;
      const isAisle = x === -1 || x === 0;
      if (isBorder) {
        grid.set(x, -1, z, SPRUCE_PLANKS_BLOCK);
      } else if (isAisle) {
        const checker = ((x + z) & 1) === 0;
        grid.set(x, -1, z, checker ? SPRUCE_PLANKS_BLOCK : OAK_PLANKS_BLOCK);
      } else {
        const isInlay = (Math.abs(x) % 2 === 0) && (Math.abs(z) % 2 === 0);
        grid.set(x, -1, z, isInlay ? SPRUCE_PLANKS_BLOCK : OAK_PLANKS_BLOCK);
      }
    }
  }

  // 4. 后墙（z = -halfD - 1，完整 4 格高 gy = 0..3）
  const backZ = -halfD - 1;
  grid.fill(-halfW, 0, backZ, halfW - 1, 3, backZ, STONE_BRICK_BLOCK);
  // 后左、后右橡木原木角柱
  grid.fill(-halfW - 1, 0, backZ, -halfW - 1, 3, backZ, OAK_LOG_VERTICAL);
  grid.fill(halfW, 0, backZ, halfW, 3, backZ, OAK_LOG_VERTICAL);

  // 后墙中央 2×2 玻璃窗（世界 x ∈ [-1, +1]），将左右两面实心石砖墙体清晰分隔给铭牌与邮件终端
  grid.fill(-1, 1, backZ, 0, 2, backZ, GLASS_BLOCK);

  // 后左内侧书架（高度 2，紧贴后墙内侧，位于左墙铭牌下方且不遮挡铭牌）
  addBookshelfColumnToGrid(grid, -halfW + 1, 0, -halfD, 2);
  addBookshelfColumnToGrid(grid, -halfW + 2, 0, -halfD, 2);

  // 5. 左墙（x = -halfW - 1，完整 4 格高 gy = 0..3）：石砖窗台 + 高玻璃窗 + 原木窗棂 + 石砖顶梁
  const leftX = -halfW - 1;
  const leftWallLen = halfD * 2;
  for (let idx = 0; idx < leftWallLen; idx += 1) {
    const z = -halfD + idx;
    grid.set(leftX, 0, z, STONE_BRICK_BLOCK);
    grid.set(leftX, 3, z, STONE_BRICK_BLOCK);
    if (isLeftWallMullion(idx, leftWallLen)) {
      grid.set(leftX, 1, z, OAK_LOG_VERTICAL);
      grid.set(leftX, 2, z, OAK_LOG_VERTICAL);
    } else {
      grid.set(leftX, 1, z, GLASS_BLOCK);
      grid.set(leftX, 2, z, GLASS_BLOCK);
    }
  }
  // 前左角柱（4 格高，与左墙无缝衔接）
  grid.fill(leftX, 0, halfD, leftX, 3, halfD, OAK_LOG_VERTICAL);

  // 6. 前墙切面（z = halfD）：前左入户门框 + 圆石门廊 + 右侧低矮石砖矮墙与通道缺口
  const frontZ = halfD;
  // 门框左右 3 格高石砖门柱（-halfW 与 -halfW + 2），门洞顶部水平原木门楣（-halfW + 1, gy = 2）
  grid.fill(-halfW, 0, frontZ, -halfW, 2, frontZ, STONE_BRICK_BLOCK);
  grid.set(-halfW + 1, 2, frontZ, OAK_LOG_HORIZONTAL_X);
  grid.set(-halfW + 1, -1, frontZ, COBBLESTONE_BLOCK);
  grid.fill(-halfW + 2, 0, frontZ, -halfW + 2, 2, frontZ, STONE_BRICK_BLOCK);
  // 门框右侧过渡低矮石砖矮墙
  grid.set(-halfW + 3, 0, frontZ, STONE_BRICK_BLOCK);

  // 前右矮墙（gy = 0）并留出 2 格宽开放通行口，保证等距与走廊视角通透
  const gapStart = Math.max(-halfW + 4, -1);
  const gapEnd = Math.min(halfW - 1, gapStart + 1);
  for (let x = -halfW + 4; x <= halfW - 1; x += 1) {
    if (x >= gapStart && x <= gapEnd) {
      grid.set(x, -1, frontZ, COBBLESTONE_BLOCK);
    } else {
      grid.set(x, 0, frontZ, STONE_BRICK_BLOCK);
    }
  }

  // 圆石入户门廊（z = halfD + 1..2）与开放通道石阶连接
  grid.fill(-halfW, -1, frontZ + 1, -halfW + 3, -1, frontZ + 2, COBBLESTONE_BLOCK);
  grid.fill(gapStart, -1, frontZ + 1, gapEnd, -1, frontZ + 2, COBBLESTONE_BLOCK);

  // 7. 右墙切面（x = halfW）：仅 1 格高石砖矮墙 + 前右 2 格角柱，100% 不遮挡等距视角
  grid.fill(halfW, 0, -halfD, halfW, 0, halfD - 1, STONE_BRICK_BLOCK);
  grid.fill(halfW, 0, halfD, halfW, 1, halfD, OAK_LOG_VERTICAL);

  // 8. 前右草坪 3×2 浅水池（沙边围岸，底面保持 gy = -2 泥土形成清晰池底）
  const poolMinX = halfW + 2;
  const poolMaxX = halfW + 4;
  const poolMinZ = halfD + 1;
  const poolMaxZ = halfD + 2;
  grid.fill(poolMinX - 1, -1, poolMinZ - 1, poolMaxX + 1, -1, poolMaxZ + 1, SAND_BLOCK);
  grid.fill(poolMinX, -1, poolMinZ, poolMaxX, -1, poolMaxZ, WATER_BLOCK);

  // 9. 室外 4 棵 Minecraft 经典橡树（避开墙体、屋檐、水池及等距镜头视线）
  addOakTreeToGrid(grid, -halfW - 4, 0, -halfD - 4, 4, 101);
  addOakTreeToGrid(grid, -halfW - 4, 0, halfD + 2, 3, 207);
  addOakTreeToGrid(grid, halfW + 3, 0, -halfD - 4, 4, 313);
  addOakTreeToGrid(grid, halfW + 3, 0, -1, 3, 419);
}

/** 构建子体素建筑细部：拆分为常驻层（门/雨棚/室外灯柱与灯笼/花丛）与屋顶层（L 形屋面/横梁/吊挂红石灯与室内灯笼） */
function buildSubVoxelDetails(
  halfW: number,
  halfD: number
): {
  baseOpaqueGeo: THREE.BufferGeometry;
  baseEmissiveGeo: THREE.BufferGeometry;
  roofOpaqueGeo: THREE.BufferGeometry;
  roofEmissiveGeo: THREE.BufferGeometry;
  lanternLightPositions: [THREE.Vector3, THREE.Vector3];
} {
  const roofBuilder = new VoxelBoxBuilder();
  const roofDetailBuilder = new VoxelBoxBuilder();
  const roofEmissiveBuilder = new VoxelBoxBuilder();
  const baseDetailBuilder = new VoxelBoxBuilder();

  // 1. L 形悬挑切面屋顶（y = 4.0..4.5 橡木半砖 + 外圈云杉屋檐 + 顶脊收边 -> 归入 roofGroup）
  addTiledSlab(roofBuilder, -halfW - 1.5, halfW + 1.5, 4.0, 4.375, -halfD - 1.5, -halfD - 1.0, 'spruce_planks');
  addTiledSlab(roofBuilder, -halfW - 1.5, -halfW - 1.0, 4.0, 4.375, -halfD - 1.0, halfD + 1.5, 'spruce_planks');
  addTiledSlab(roofBuilder, halfW + 1.0, halfW + 1.5, 4.0, 4.375, -halfD - 1.0, -halfD + 1.5, 'spruce_planks');
  addTiledSlab(roofBuilder, -halfW - 1.0, -halfW + 1.5, 4.0, 4.375, halfD + 1.0, halfD + 1.5, 'spruce_planks');

  addTiledSlab(roofBuilder, -halfW - 1.0, halfW + 1.0, 4.0, 4.5, -halfD - 1.0, -halfD + 1.5, 'oak_planks');
  addTiledSlab(roofBuilder, -halfW - 1.0, -halfW + 1.5, 4.0, 4.5, -halfD + 1.5, halfD + 1.0, 'oak_planks');

  addTiledSlab(roofBuilder, -halfW - 1.0, halfW + 1.0, 4.5, 4.75, -halfD - 1.0, -halfD, 'spruce_planks', { ny: true });
  addTiledSlab(roofBuilder, -halfW - 1.0, -halfW, 4.5, 4.75, -halfD, halfD + 1.0, 'spruce_planks', { ny: true });

  // 前左入户门雨棚小檐（常驻外墙，俯视时位于外侧不遮挡工位）
  addTiledSlab(baseDetailBuilder, -halfW, -halfW + 3, 3.0, 3.25, halfD, halfD + 1.5, 'spruce_planks');

  // 2. 横跨房间的橡木天花横梁（归入 roofGroup，俯瞰模式随屋顶一并隐藏）
  const beamSpecs: Array<{ zCenter: number; rightX: number }> = [
    { zCenter: -halfD + 1.625, rightX: halfW },
    { zCenter: halfD >= 4 ? -0.125 : 0.625, rightX: halfW - 1.0 },
  ];
  if (halfD >= 4) {
    beamSpecs.push({ zCenter: halfD - 1.875, rightX: 0.5 });
  }

  for (const beam of beamSpecs) {
    const z0 = beam.zCenter - 0.125;
    const z1 = beam.zCenter + 0.125;
    addTiledSlab(roofBuilder, -halfW, -halfW + 1.5, 3.75, 4.0, z0, z1, 'spruce_planks', { py: true });
    addTiledSlab(roofBuilder, -halfW + 1.5, beam.rightX, 3.875, 4.125, z0, z1, 'oak_planks');
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

  // 4. 经典 Minecraft 2 格高微内凹橡木门（常驻建筑层）
  const doorMinX = -halfW + 1;
  const doorMaxX = -halfW + 2;
  const doorMinZ = halfD + 0.28125;
  const doorMaxZ = halfD + 0.46875;
  baseDetailBuilder.addBox({
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
  baseDetailBuilder.addBox({
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
  const indoorLanternZ = -halfD + 0.875;
  const indoorLanternHangY = 4.0;
  const indoorLantern = createVoxelLanternGeometry(0.5);
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

  const roofSlabGeo = roofBuilder.build(false);
  const roofDetailGeo = roofDetailBuilder.build(false);
  const roofLampGeo = roofEmissiveBuilder.build(false);
  const baseDetailGeo = baseDetailBuilder.build(true);
  const flowerGeo = flowerBuilder.build(false);

  const baseOpaqueGeo = mergeVoxelGeometries([
    baseDetailGeo,
    flowerGeo,
    porchLantern.frameGeo,
  ]);
  const baseEmissiveGeo = porchLantern.glowGeo;

  const roofOpaqueGeo = mergeVoxelGeometries([
    roofSlabGeo,
    roofDetailGeo,
    indoorLantern.frameGeo,
  ]);
  const roofEmissiveGeo = mergeVoxelGeometries([
    roofLampGeo,
    indoorLantern.glowGeo,
  ]);

  roofSlabGeo.dispose();
  roofDetailGeo.dispose();
  roofLampGeo.dispose();
  baseDetailGeo.dispose();
  flowerGeo.dispose();
  indoorLantern.frameGeo.dispose();
  indoorLantern.glowGeo.dispose();
  porchLantern.frameGeo.dispose();

  return {
    baseOpaqueGeo,
    baseEmissiveGeo,
    roofOpaqueGeo,
    roofEmissiveGeo,
    lanternLightPositions,
  };
}

/** 根据房间尺寸重建体素世界网格，并同步屋顶层、贴墙铭牌、贴墙邮件终端与灯笼点光源位置 */
function rebuildRoomWorldGeometry(
  rig: OfficeRoomRig,
  roomWidth: number,
  roomDepth: number
): void {
  const halfW = computeHalfExtent(roomWidth, MIN_HALF_W);
  const halfD = computeHalfExtent(roomDepth, MIN_HALF_D);

  rig.currentWidth = roomWidth;
  rig.currentDepth = roomDepth;
  rig.outerHalfWidth = halfW + YARD_EXTEND + 1;
  rig.outerHalfDepth = halfD + YARD_EXTEND + 1;

  clearDynamicWorldGroup(rig.dynamicWorldGroup);
  clearDynamicWorldGroup(rig.roofGroup);

  const voxelMaterials = getSharedVoxelMaterialSet();
  const grid = new VoxelGrid();
  populateRoomVoxelGrid(grid, halfW, halfD);
  const gridGeos = grid.buildGeometries();

  const subDetails = buildSubVoxelDetails(halfW, halfD);

  // 1. 常驻不透明建筑层（地形 + 墙体 + 地板 + 门廊 + 室外灯柱 + 花丛 -> 单次 Draw Call）
  const opaqueParts: THREE.BufferGeometry[] = [];
  if (gridGeos.opaque) opaqueParts.push(gridGeos.opaque);
  opaqueParts.push(subDetails.baseOpaqueGeo);
  const mergedOpaque = mergeVoxelGeometries(opaqueParts);
  for (const part of opaqueParts) {
    part.dispose();
  }
  const opaqueMesh = new THREE.Mesh(mergedOpaque, voxelMaterials.opaque);
  opaqueMesh.castShadow = true;
  opaqueMesh.receiveShadow = true;
  rig.dynamicWorldGroup.add(opaqueMesh);

  // 2. 树叶镂空层（cutout）
  if (gridGeos.cutout) {
    const cutoutMesh = new THREE.Mesh(gridGeos.cutout, voxelMaterials.cutout);
    cutoutMesh.castShadow = true;
    cutoutMesh.receiveShadow = true;
    rig.dynamicWorldGroup.add(cutoutMesh);
  }

  // 3. 半透明水池（水面下沉 0.125 格呈现经典 Minecraft 凹陷池岸质感）
  if (gridGeos.water) {
    gridGeos.water.translate(0, -0.125, 0);
    const waterMesh = new THREE.Mesh(gridGeos.water, voxelMaterials.water);
    waterMesh.receiveShadow = true;
    waterMesh.renderOrder = 1;
    rig.dynamicWorldGroup.add(waterMesh);
  }

  // 4. 窗户半透明玻璃层
  if (gridGeos.glass) {
    const glassMesh = new THREE.Mesh(gridGeos.glass, voxelMaterials.glass);
    glassMesh.renderOrder = 2;
    rig.dynamicWorldGroup.add(glassMesh);
  }

  // 5. 常驻室外自发光体素（门廊灯笼暖光芯）
  const baseEmissiveParts: THREE.BufferGeometry[] = [];
  if (gridGeos.emissive) baseEmissiveParts.push(gridGeos.emissive);
  baseEmissiveParts.push(subDetails.baseEmissiveGeo);
  const mergedBaseEmissive = mergeVoxelGeometries(baseEmissiveParts);
  for (const part of baseEmissiveParts) {
    part.dispose();
  }
  const baseEmissiveMesh = new THREE.Mesh(mergedBaseEmissive, voxelMaterials.emissive);
  rig.dynamicWorldGroup.add(baseEmissiveMesh);

  // 6. 独立屋顶层（overview 俯瞰时可直接整体隐藏，切回等距/走廊立即恢复，无需重建几何）
  const roofOpaqueMesh = new THREE.Mesh(subDetails.roofOpaqueGeo, voxelMaterials.opaque);
  roofOpaqueMesh.castShadow = true;
  roofOpaqueMesh.receiveShadow = true;
  rig.roofGroup.add(roofOpaqueMesh);

  const roofEmissiveMesh = new THREE.Mesh(subDetails.roofEmissiveGeo, voxelMaterials.emissive);
  rig.roofGroup.add(roofEmissiveMesh);

  // 同步两处室内暖色灯笼点光源世界坐标
  rig.lanternLightPositions.length = 0;
  rig.lanternLightPositions.push(
    subDetails.lanternLightPositions[0],
    subDetails.lanternLightPositions[1]
  );

  // 同步两块贴墙面板位置（分别落在中央窗左右两侧的实心石砖墙面上，z = -halfD，高度 2.6875 不挡工位）
  const leftBayCenterX = snapToVoxel((-halfW - 1.0) * 0.5);
  const rightBayCenterX = snapToVoxel((1.0 + halfW) * 0.5);
  rig.plaqueGroup.position.set(leftBayCenterX, 2.6875, -halfD);
  rig.roomTerminalGroup.position.set(rightBayCenterX, 2.6875, -halfD);
}

/** 切换屋顶与吊灯层可见性（零场景重建，专用于全景俯瞰预设透视室内） */
export function setOfficeRoomRoofVisible(rig: OfficeRoomRig, visible: boolean): void {
  rig.roofGroup.visible = visible;
}

export function createOfficeRoomRig(
  palette: OfficeScenePalette,
  anisotropy: number
): OfficeRoomRig {
  const root = new THREE.Group();
  const dynamicWorldGroup = new THREE.Group();
  const roofGroup = new THREE.Group();
  root.add(dynamicWorldGroup);
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

  const plaqueGroup = buildPlaqueGroup(plaqueScreenMaterial, voxelMaterials.opaque);
  root.add(plaqueGroup);

  const terminalBuilt = buildRoomTerminalGroup(
    terminalScreenMaterial,
    terminalStatusMaterial,
    voxelMaterials.opaque
  );
  root.add(terminalBuilt.group);

  const rig: OfficeRoomRig = {
    root,
    dynamicWorldGroup,
    roofGroup,
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
    outerHalfWidth: 0,
    outerHalfDepth: 0,
  };

  rebuildRoomWorldGeometry(rig, DEFAULT_INIT_WIDTH, DEFAULT_INIT_DEPTH);
  return rig;
}

export function syncOfficeRoomRig(
  rig: OfficeRoomRig,
  state: OfficeSceneSyncState,
  palette?: OfficeScenePalette,
  roomWidth?: number,
  roomDepth?: number,
  isTerminalHovered?: boolean
): void {
  const resolvedPalette = palette ?? getOfficeScenePalette(state.theme);
  let resolvedWidth = roomWidth;
  let resolvedDepth = roomDepth;
  if (resolvedWidth === undefined || resolvedDepth === undefined) {
    const metrics = computeBayGridMetrics(state.sessions.length);
    resolvedWidth = resolvedWidth ?? metrics.roomWidth;
    resolvedDepth = resolvedDepth ?? metrics.roomDepth;
  }
  const hovered = Boolean(isTerminalHovered);

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

  // 全景俯瞰时即时隐藏屋顶层，等距与走廊模式恢复显示
  rig.roofGroup.visible = state.cameraPreset !== 'overview';

  getSharedVoxelMaterialSet().syncTheme(resolvedPalette.mode);

  rig.plaqueScreenMaterial.emissiveIntensity = resolvedPalette.mode === 'dark' ? 0.92 : 0.72;
  rig.terminalScreenMaterial.emissiveIntensity = hovered ? 1.25 : 0.9;

  // 根据房间实时邮件脉冲与待投状态同步终端顶部体素状态灯，悬停时向高亮方向提亮
  const statusBaseHex = state.hasRecentPulse
    ? resolvedPalette.successHex
    : state.pendingMailCount > 0
      ? resolvedPalette.warningHex
      : resolvedPalette.accentHex;
  SCRATCH_STATUS_COLOR.set(statusBaseHex);
  if (hovered) {
    SCRATCH_STATUS_COLOR.lerp(WHITE_COLOR, 0.42);
  }
  rig.terminalStatusMaterial.color.copy(SCRATCH_STATUS_COLOR);

  updateWallPlaqueTexture(rig.plaqueBundle, state, resolvedPalette);
  updateRoomTerminalTexture(rig.terminalBundle, state, resolvedPalette);
}

export function disposeOfficeRoomRig(rig: OfficeRoomRig): void {
  const disposedGeometries = new Set<THREE.BufferGeometry>();
  const disposedMaterials = new Set<THREE.Material>();

  clearDynamicWorldGroup(rig.dynamicWorldGroup);
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
