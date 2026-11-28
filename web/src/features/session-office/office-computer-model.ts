import * as THREE from 'three';
import type { SessionAvailability } from './session-office-types';
import type { OfficeScenePalette } from './office-scene-types';
import { getSharedVoxelMaterialSet, type VoxelTileId } from './office-voxel-atlas';
import {
  createSolidColorVoxelGeometry,
  VoxelBoxBuilder,
} from './office-voxel-builder';

/**
 * Minecraft 体素桌面计算机与外设组件：
 * - 严格轴对齐方块几何（零球体/圆柱/曲面），全部静态不透明部件合批为 1 个 PBR 共享图集 Mesh。
 * - PC 塔式主机原生定位在桌子右侧后方地毯（x ∈ [0.375, 0.625], y ∈ [0.03125, 0.46875], z ∈ [-0.75, -0.375]），
 *   与行走避障网格完全对齐、任意显示器偏航角零遮挡，且保留侧透玻璃与内部硬件微雕。
 * - 桌面外设：编织桌垫、双层阶梯机械键盘（强调色 ESC / Enter）、体素鼠标、咖啡杯、红陶花盆（多品种植被）与小笔记本。
 */

export interface DesktopComputerRig {
  root: THREE.Group;
  powerLedMaterial: THREE.MeshBasicMaterial;
  /** 确定性呼吸灯初始相位，避免相邻工位完全同步闪烁 */
  pulsePhase: number;
}

const DESK_TOP_Y = 0.746;
const CARPET_TOP_Y = 0.03125;
const MAT_HEIGHT = 0.015625;
const MAT_TOP_Y = DESK_TOP_Y + MAT_HEIGHT;

// 落地 PC 机箱外包络（严格对齐 office-voxel-behaviour 障碍矩形 x ∈ [0.375, 0.625], z ∈ [-0.75, -0.375]）
const PC_MIN_X = 0.375;
const PC_MAX_X = 0.625;
const PC_FOOT_H = 0.015625;
const PC_MIN_Y = CARPET_TOP_Y + PC_FOOT_H;
const PC_MAX_Y = CARPET_TOP_Y + 0.4375;
const PC_MIN_Z = -0.75;
const PC_MAX_Z = -0.375;

const PC_CAVITY_MIN_Y = PC_MIN_Y + 0.046875;
const PC_CAVITY_MAX_Y = PC_MAX_Y - 0.03125;

/** 基于工位强调色计算确定性 32 位哈希（FNV-1a） */
function hashAccentString(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function pickDeskFlowerTile(accentHex: string): VoxelTileId {
  const mod = hashAccentString(accentHex) % 3;
  if (mod === 0) return 'wool_red';
  if (mod === 1) return 'wool_yellow';
  return 'wool_cyan';
}

/** 在桌旁右后方地面原生构建体素 PC 塔式主机（含橡胶垫脚、前网孔、内部硬件与侧透玻璃窗） */
function appendFloorVoxelPcTower(
  opaqueBuilder: VoxelBoxBuilder,
  glassBuilder: VoxelBoxBuilder,
  safeAccentHex: string
): void {
  // 0. 四个橡胶方块支脚（坐落于地毯 y = 0.03125）
  const feet: Array<[number, number]> = [
    [PC_MIN_X + 0.015625, PC_MIN_Z + 0.015625],
    [PC_MAX_X - 0.0625, PC_MIN_Z + 0.015625],
    [PC_MIN_X + 0.015625, PC_MAX_Z - 0.0625],
    [PC_MAX_X - 0.0625, PC_MAX_Z - 0.0625],
  ];
  for (const [fx, fz] of feet) {
    opaqueBuilder.addBox({
      minX: fx,
      minY: CARPET_TOP_Y,
      minZ: fz,
      maxX: fx + 0.046875,
      maxY: PC_MIN_Y,
      maxZ: fz + 0.046875,
      tiles: 'dark_iron',
      tint: '#1d222b',
      floorY: CARPET_TOP_Y,
      hiddenFaces: { ny: true, py: true },
    });
  }

  // 1. 深铁结构外框（底盘、顶盖含散热网孔、-X 实心背板、-Z 后 I/O 面板、+Z 前立柱）
  opaqueBuilder.addBox({
    minX: PC_MIN_X,
    minY: PC_MIN_Y,
    minZ: PC_MIN_Z,
    maxX: PC_MAX_X,
    maxY: PC_CAVITY_MIN_Y,
    maxZ: PC_MAX_Z,
    tiles: 'dark_iron',
    floorY: CARPET_TOP_Y,
  });

  opaqueBuilder.addBox({
    minX: PC_MIN_X,
    minY: PC_CAVITY_MAX_Y,
    minZ: PC_MIN_Z,
    maxX: PC_MAX_X,
    maxY: PC_MAX_Y,
    maxZ: PC_MAX_Z,
    tiles: { py: 'pc_mesh', all: 'dark_iron' },
  });

  // 实心左侧背板（-X）
  opaqueBuilder.addBox({
    minX: PC_MIN_X,
    minY: PC_CAVITY_MIN_Y,
    minZ: PC_MIN_Z + 0.03125,
    maxX: PC_MIN_X + 0.03125,
    maxY: PC_CAVITY_MAX_Y,
    maxZ: PC_MAX_Z - 0.03125,
    tiles: 'dark_iron',
    hiddenFaces: { py: true, ny: true, pz: true, nz: true },
  });

  // 后部 I/O 壁（-Z）
  opaqueBuilder.addBox({
    minX: PC_MIN_X,
    minY: PC_CAVITY_MIN_Y,
    minZ: PC_MIN_Z,
    maxX: PC_MAX_X,
    maxY: PC_CAVITY_MAX_Y,
    maxZ: PC_MIN_Z + 0.03125,
    tiles: 'dark_iron',
    hiddenFaces: { py: true, ny: true },
  });

  // 前脸左右立柱（+Z）
  opaqueBuilder.addBox({
    minX: PC_MIN_X,
    minY: PC_CAVITY_MIN_Y,
    minZ: PC_MAX_Z - 0.03125,
    maxX: PC_MIN_X + 0.03125,
    maxY: PC_CAVITY_MAX_Y,
    maxZ: PC_MAX_Z,
    tiles: 'dark_iron',
    hiddenFaces: { py: true, ny: true },
  });
  opaqueBuilder.addBox({
    minX: PC_MAX_X - 0.03125,
    minY: PC_CAVITY_MIN_Y,
    minZ: PC_MAX_Z - 0.03125,
    maxX: PC_MAX_X,
    maxY: PC_CAVITY_MAX_Y,
    maxZ: PC_MAX_Z,
    tiles: 'dark_iron',
    hiddenFaces: { py: true, ny: true },
  });

  // 前脸进风网孔面板（+Z）
  opaqueBuilder.addBox({
    minX: PC_MIN_X + 0.03125,
    minY: PC_CAVITY_MIN_Y,
    minZ: PC_MAX_Z - 0.03125,
    maxX: PC_MAX_X - 0.03125,
    maxY: PC_CAVITY_MAX_Y,
    maxZ: PC_MAX_Z - 0.0078125,
    tiles: { pz: 'pc_mesh', all: 'dark_iron' },
    hiddenFaces: { py: true, ny: true, px: true, nx: true },
  });

  // 2. 机箱内部可见体素硬件
  // 底部电源仓罩
  opaqueBuilder.addBox({
    minX: PC_MIN_X + 0.03125,
    minY: PC_CAVITY_MIN_Y,
    minZ: PC_MIN_Z + 0.03125,
    maxX: PC_MAX_X - 0.046875,
    maxY: PC_MIN_Y + 0.109375,
    maxZ: PC_MAX_Z - 0.09375,
    tiles: 'dark_iron',
    tint: '#29303c',
    hiddenFaces: { ny: true, nx: true, nz: true },
  });

  // 深色石砖主板基板
  opaqueBuilder.addBox({
    minX: PC_MIN_X + 0.03125,
    minY: PC_MIN_Y + 0.125,
    minZ: PC_MIN_Z + 0.046875,
    maxX: PC_MIN_X + 0.0625,
    maxY: PC_MIN_Y + 0.36,
    maxZ: PC_MAX_Z - 0.078125,
    tiles: 'deepslate',
    tint: '#3c4a5c',
    hiddenFaces: { nx: true },
  });

  // 铁+铜 CPU 塔式风冷散热块
  opaqueBuilder.addBox({
    minX: PC_MIN_X + 0.0625,
    minY: PC_MIN_Y + 0.25,
    minZ: PC_MIN_Z + 0.078125,
    maxX: PC_MIN_X + 0.15625,
    maxY: PC_MIN_Y + 0.34375,
    maxZ: PC_MIN_Z + 0.171875,
    tiles: { py: 'copper_block', all: 'iron_block' },
    occludes: false,
    hiddenFaces: { nx: true },
  });

  // 双通道内存条（顶部强调色马甲）
  const ramOffsets: readonly [number, number] = [0.203125, 0.234375];
  for (let i = 0; i < ramOffsets.length; i += 1) {
    const z0 = PC_MIN_Z + ramOffsets[i];
    opaqueBuilder.addBox({
      minX: PC_MIN_X + 0.0625,
      minY: PC_MIN_Y + 0.234375,
      minZ: z0,
      maxX: PC_MIN_X + 0.125,
      maxY: PC_MIN_Y + 0.34375,
      maxZ: z0 + 0.015625,
      tiles: { px: 'wool_white', all: 'dark_iron' },
      tint: safeAccentHex,
      occludes: false,
      hiddenFaces: { nx: true },
    });
  }

  // 金铁配色独立显卡砖块
  opaqueBuilder.addBox({
    minX: PC_MIN_X + 0.0625,
    minY: PC_MIN_Y + 0.140625,
    minZ: PC_MIN_Z + 0.046875,
    maxX: PC_MIN_X + 0.1875,
    maxY: PC_MIN_Y + 0.203125,
    maxZ: PC_MAX_Z - 0.09375,
    tiles: {
      py: 'iron_block',
      px: 'gold_block',
      pz: 'gold_block',
      ny: 'dark_iron',
      nz: 'dark_iron',
      nx: 'dark_iron',
    },
    occludes: false,
    hiddenFaces: { nx: true },
  });

  // 3. 侧透玻璃窗（+X 朝向等距视角与走廊，仅输出外表面）
  glassBuilder.addBox({
    minX: PC_MAX_X - 0.015625,
    minY: PC_CAVITY_MIN_Y,
    minZ: PC_MIN_Z + 0.03125,
    maxX: PC_MAX_X - 0.0078125,
    maxY: PC_CAVITY_MAX_Y,
    maxZ: PC_MAX_Z - 0.03125,
    tiles: 'glass',
    occludes: false,
    hiddenFaces: { py: true, ny: true, pz: true, nz: true, nx: true },
  });
}

/** 构建体素桌垫、分层机械键盘（含强调色 ESC / Enter 键帽）与方块鼠标 */
function appendVoxelDeskPeripherals(
  opaqueBuilder: VoxelBoxBuilder,
  safeAccentHex: string
): void {
  // 1. 深石板灰羊毛大桌垫 + 四周缝线微边
  opaqueBuilder.addBox({
    minX: -0.140625,
    minY: DESK_TOP_Y,
    minZ: -0.390625,
    maxX: 0.25,
    maxY: MAT_TOP_Y,
    maxZ: 0.265625,
    tiles: 'wool_light_gray',
    tint: '#253142',
    occludes: false,
    floorY: DESK_TOP_Y,
    hiddenFaces: { ny: true },
  });

  // 2. 分层体素机械键盘（铝制底座 + 键帽台 + 强调色 ESC 与 Enter）
  opaqueBuilder.addBox({
    minX: -0.078125,
    minY: MAT_TOP_Y,
    minZ: -0.203125,
    maxX: 0.125,
    maxY: MAT_TOP_Y + 0.03125,
    maxZ: 0.21875,
    tiles: 'dark_iron',
    floorY: MAT_TOP_Y,
    hiddenFaces: { ny: true },
  });
  opaqueBuilder.addBox({
    minX: -0.0625,
    minY: MAT_TOP_Y + 0.03125,
    minZ: -0.1875,
    maxX: 0.109375,
    maxY: MAT_TOP_Y + 0.0625,
    maxZ: 0.203125,
    tiles: {
      top: 'keyboard_top',
      bottom: 'dark_iron',
      side: 'dark_iron',
    },
    hiddenFaces: { ny: true },
  });

  // ESC 强调色凸起体素键帽
  opaqueBuilder.addBox({
    minX: -0.046875,
    minY: MAT_TOP_Y + 0.0625,
    minZ: 0.15625,
    maxX: -0.015625,
    maxY: MAT_TOP_Y + 0.078125,
    maxZ: 0.1875,
    tiles: 'wool_white',
    tint: safeAccentHex,
    occludes: false,
    hiddenFaces: { ny: true },
  });

  // 3. 位于键盘右侧（-Z）的体素鼠标 + 金属滚轮
  opaqueBuilder.addBox({
    minX: -0.0625,
    minY: MAT_TOP_Y,
    minZ: -0.359375,
    maxX: 0.0625,
    maxY: MAT_TOP_Y + 0.046875,
    maxZ: -0.25,
    tiles: 'dark_iron',
    floorY: MAT_TOP_Y,
    hiddenFaces: { ny: true },
  });
  opaqueBuilder.addBox({
    minX: -0.046875,
    minY: MAT_TOP_Y + 0.046875,
    minZ: -0.34375,
    maxX: 0.046875,
    maxY: MAT_TOP_Y + 0.0625,
    maxZ: -0.265625,
    tiles: 'dark_iron',
    tint: '#4c5769',
    occludes: false,
    hiddenFaces: { ny: true },
  });
  opaqueBuilder.addBox({
    minX: -0.046875,
    minY: MAT_TOP_Y + 0.0625,
    minZ: -0.3203125,
    maxX: -0.015625,
    maxY: MAT_TOP_Y + 0.078125,
    maxZ: -0.2890625,
    tiles: 'iron_block',
    occludes: false,
    hiddenFaces: { ny: true },
  });
}

/** 构建桌面 Minecraft 经典小摆件：白色咖啡杯 + 红陶花盆 + 便携笔记本与笔 */
function appendVoxelDesktopProps(
  opaqueBuilder: VoxelBoxBuilder,
  safeAccentHex: string
): void {
  // 1. 桌面边缘白色陶瓷马克杯 + 侧把手
  opaqueBuilder.addBox({
    minX: -0.4375,
    minY: DESK_TOP_Y,
    minZ: 0.34375,
    maxX: -0.3125,
    maxY: DESK_TOP_Y + 0.125,
    maxZ: 0.46875,
    tiles: {
      side: 'mug_white',
      top: 'wool_brown',
      bottom: 'mug_white',
    },
    floorY: DESK_TOP_Y,
    hiddenFaces: { ny: true },
  });
  opaqueBuilder.addBox({
    minX: -0.3125,
    minY: DESK_TOP_Y + 0.03125,
    minZ: 0.390625,
    maxX: -0.265625,
    maxY: DESK_TOP_Y + 0.09375,
    maxZ: 0.421875,
    tiles: 'mug_white',
    occludes: false,
    hiddenFaces: { nx: true },
  });

  // 2. 桌面后左角红陶花盆（带盆沿台阶）+ 翠绿叶茎 + 确定性多彩体素花冠
  opaqueBuilder.addBox({
    minX: -0.921875,
    minY: DESK_TOP_Y,
    minZ: -0.421875,
    maxX: -0.765625,
    maxY: DESK_TOP_Y + 0.140625,
    maxZ: -0.265625,
    tiles: {
      side: 'terracotta',
      top: 'dirt',
      bottom: 'terracotta',
    },
    floorY: DESK_TOP_Y,
    hiddenFaces: { ny: true },
  });
  opaqueBuilder.addBox({
    minX: -0.9375,
    minY: DESK_TOP_Y + 0.140625,
    minZ: -0.4375,
    maxX: -0.75,
    maxY: DESK_TOP_Y + 0.1875,
    maxZ: -0.25,
    tiles: {
      side: 'terracotta',
      top: 'dirt',
      bottom: 'terracotta',
    },
  });
  opaqueBuilder.addBox({
    minX: -0.875,
    minY: DESK_TOP_Y + 0.1875,
    minZ: -0.375,
    maxX: -0.8125,
    maxY: DESK_TOP_Y + 0.3125,
    maxZ: -0.3125,
    tiles: 'oak_leaves',
    occludes: false,
    hiddenFaces: { ny: true, py: true },
  });
  opaqueBuilder.addBox({
    minX: -0.90625,
    minY: DESK_TOP_Y + 0.296875,
    minZ: -0.40625,
    maxX: -0.78125,
    maxY: DESK_TOP_Y + 0.375,
    maxZ: -0.28125,
    tiles: pickDeskFlowerTile(safeAccentHex),
    occludes: false,
  });

  // 3. 桌前左角小巧体素笔记本 + 强调色封皮书脊 + 金属笔
  opaqueBuilder.addBox({
    minX: -0.9375,
    minY: DESK_TOP_Y,
    minZ: 0.1875,
    maxX: -0.6875,
    maxY: DESK_TOP_Y + 0.03125,
    maxZ: 0.421875,
    tiles: { top: 'quartz_block', side: 'wool_white', bottom: 'dark_oak_planks' },
    floorY: DESK_TOP_Y,
    hiddenFaces: { ny: true },
  });
  opaqueBuilder.addBox({
    minX: -0.9375,
    minY: DESK_TOP_Y,
    minZ: 0.1875,
    maxX: -0.90625,
    maxY: DESK_TOP_Y + 0.0390625,
    maxZ: 0.421875,
    tiles: 'wool_white',
    tint: safeAccentHex,
    occludes: false,
    hiddenFaces: { ny: true },
  });
  opaqueBuilder.addBox({
    minX: -0.65625,
    minY: DESK_TOP_Y,
    minZ: 0.21875,
    maxX: -0.6328125,
    maxY: DESK_TOP_Y + 0.0234375,
    maxZ: 0.390625,
    tiles: 'gold_block',
    occludes: false,
    hiddenFaces: { ny: true },
  });
}

/** 构建落地机箱顶前角方块电源指示灯几何 */
function buildPowerLedGeometry(): THREE.BufferGeometry {
  return createSolidColorVoxelGeometry([
    {
      minX: PC_MAX_X - 0.0625,
      minY: PC_MAX_Y,
      minZ: PC_MAX_Z - 0.0625,
      maxX: PC_MAX_X - 0.03125,
      maxY: PC_MAX_Y + 0.015625,
      maxZ: PC_MAX_Z - 0.03125,
      shadeFaces: false,
    },
  ]);
}

export function createDesktopComputerRig(
  palette: OfficeScenePalette,
  accentHex: string
): DesktopComputerRig {
  const root = new THREE.Group();
  const sharedMaterials = getSharedVoxelMaterialSet();
  const safeAccentHex = accentHex || palette.accentHex;

  const opaqueBuilder = new VoxelBoxBuilder();
  const glassBuilder = new VoxelBoxBuilder();

  appendFloorVoxelPcTower(opaqueBuilder, glassBuilder, safeAccentHex);
  appendVoxelDeskPeripherals(opaqueBuilder, safeAccentHex);
  appendVoxelDesktopProps(opaqueBuilder, safeAccentHex);

  // Draw Call 1: 静态不透明体素部件（落地机箱 + 内部硬件 + 桌垫 + 键鼠 + 咖啡杯 + 花盆 + 笔记本）
  const opaqueMesh = new THREE.Mesh(opaqueBuilder.build(true), sharedMaterials.opaque);
  opaqueMesh.name = 'voxel-computer-opaque';
  opaqueMesh.castShadow = true;
  opaqueMesh.receiveShadow = true;
  root.add(opaqueMesh);

  // Draw Call 2: 机箱玻璃侧窗
  const glassMesh = new THREE.Mesh(glassBuilder.build(false), sharedMaterials.glass);
  glassMesh.name = 'voxel-computer-glass';
  glassMesh.castShadow = false;
  glassMesh.receiveShadow = false;
  glassMesh.userData.noShadow = true;
  root.add(glassMesh);

  // Draw Call 3: 工位独立电源指示灯
  const powerLedMaterial = new THREE.MeshBasicMaterial({
    color: palette.successHex,
    toneMapped: false,
  });
  const powerLedMesh = new THREE.Mesh(buildPowerLedGeometry(), powerLedMaterial);
  powerLedMesh.name = 'voxel-computer-power-led';
  powerLedMesh.castShadow = false;
  powerLedMesh.receiveShadow = false;
  powerLedMesh.userData.noShadow = true;
  root.add(powerLedMesh);

  const initialPhase = (hashAccentString(safeAccentHex) % 628) / 100;

  return {
    root,
    powerLedMaterial,
    pulsePhase: initialPhase,
  };
}

export function syncDesktopComputerRig(
  rig: DesktopComputerRig,
  availability: SessionAvailability,
  palette: OfficeScenePalette
): void {
  let ledHex = palette.accentHex;
  if (availability === 'interactive') {
    ledHex = palette.successHex;
  } else if (availability === 'unavailable') {
    ledHex = palette.warningHex;
  } else if (availability === 'exited') {
    ledHex = palette.screenMutedHex;
  }
  rig.powerLedMaterial.color.set(ledHex);
}
