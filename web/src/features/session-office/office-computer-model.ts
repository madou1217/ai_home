import * as THREE from 'three';
import type { SessionAvailability } from './session-office-types';
import type { OfficeScenePalette } from './office-scene-types';
import {
  normalizeOfficeRgbColor,
  type OfficeComputerPowerState,
} from './office-computer-state';
import { getSharedVoxelMaterialSet } from './office-voxel-atlas';
import {
  createSolidColorVoxelGeometry,
  VoxelBoxBuilder,
  type SolidColorBoxInput,
} from './office-voxel-builder';

/**
 * Minecraft 体素桌面计算机组件：
 * - 严格轴对齐方块几何（零圆柱/球体/圆环/挤压/曲线，零任意旋转）。
 * - 全部静态不透明部件合批为 1 个共享图集 Mesh；玻璃侧窗、RGB 灯条、电源灯各占 1 个 Mesh（合计仅 4 Draw Calls）。
 */

export interface DesktopComputerRig {
  root: THREE.Group;
  rgbMaterial: THREE.MeshBasicMaterial;
  powerLedMaterial: THREE.MeshBasicMaterial;
  powerState: OfficeComputerPowerState;
  rgbEnabled: boolean;
  rgbColor: THREE.Color;
  /** 会话退出态下的 RGB 低亮标记 */
  rgbDimmed: boolean;
  /** 确定性呼吸灯初始相位，避免相邻工位完全同步闪烁 */
  pulsePhase: number;
}

const DESK_TOP_Y = 0.746;
const MAT_HEIGHT = 0.015625;
const MAT_TOP_Y = DESK_TOP_Y + MAT_HEIGHT;

// PC 机箱外包络（位于桌面前左角，开口与玻璃窗朝向 +X 桌面与等距视角）
const PC_MIN_X = -0.96875;
const PC_MAX_X = -0.71875;
const PC_MIN_Y = DESK_TOP_Y;
const PC_MAX_Y = DESK_TOP_Y + 0.4375;
const PC_MIN_Z = 0.0625;
const PC_MAX_Z = 0.4375;

const PC_CAVITY_MIN_Y = PC_MIN_Y + 0.046875;
const PC_CAVITY_MAX_Y = PC_MAX_Y - 0.03125;

const RGB_OFF_HEX = '#262f3d';
const POWER_LED_OFF_HEX = '#374151';

/** 基于工位强调色计算确定性 32 位哈希（FNV-1a） */
function hashAccentString(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** 确定性选择花盆花朵像素纹理（红花 / 黄花） */
function pickFlowerTile(accentHex: string): 'flower_red' | 'flower_yellow' {
  return hashAccentString(accentHex) % 2 === 0 ? 'flower_red' : 'flower_yellow';
}

/** 构建体素 PC 机箱结构框架与内部主板/显卡/散热器/内存块 */
function appendVoxelPcTower(
  opaqueBuilder: VoxelBoxBuilder,
  glassBuilder: VoxelBoxBuilder
): void {
  // 1. 厚重深铁结构外框（底部、顶部、-X 实心背板、-Z 后板、+Z 前立柱与内凹网孔面板）
  opaqueBuilder.addBox({
    minX: PC_MIN_X,
    minY: PC_MIN_Y,
    minZ: PC_MIN_Z,
    maxX: PC_MAX_X,
    maxY: PC_CAVITY_MIN_Y,
    maxZ: PC_MAX_Z,
    tiles: 'dark_iron',
    floorY: DESK_TOP_Y,
    hiddenFaces: { ny: true },
  });

  opaqueBuilder.addBox({
    minX: PC_MIN_X,
    minY: PC_CAVITY_MAX_Y,
    minZ: PC_MIN_Z,
    maxX: PC_MAX_X,
    maxY: PC_MAX_Y,
    maxZ: PC_MAX_Z,
    tiles: 'dark_iron',
  });

  // 实心右侧背板（-X）
  opaqueBuilder.addBox({
    minX: PC_MIN_X,
    minY: PC_CAVITY_MIN_Y,
    minZ: 0.09375,
    maxX: -0.9375,
    maxY: PC_CAVITY_MAX_Y,
    maxZ: 0.40625,
    tiles: 'dark_iron',
    hiddenFaces: { py: true, ny: true, pz: true, nz: true },
  });

  // 后部 I/O 挡板壁（-Z）
  opaqueBuilder.addBox({
    minX: PC_MIN_X,
    minY: PC_CAVITY_MIN_Y,
    minZ: PC_MIN_Z,
    maxX: PC_MAX_X,
    maxY: PC_CAVITY_MAX_Y,
    maxZ: 0.09375,
    tiles: 'dark_iron',
    hiddenFaces: { py: true, ny: true },
  });

  // 前部左右立柱（+Z，围出内凹进风网孔与 +X 侧窗边框）
  opaqueBuilder.addBox({
    minX: PC_MIN_X,
    minY: PC_CAVITY_MIN_Y,
    minZ: 0.40625,
    maxX: -0.9375,
    maxY: PC_CAVITY_MAX_Y,
    maxZ: PC_MAX_Z,
    tiles: 'dark_iron',
    hiddenFaces: { py: true, ny: true },
  });

  opaqueBuilder.addBox({
    minX: -0.75,
    minY: PC_CAVITY_MIN_Y,
    minZ: 0.40625,
    maxX: PC_MAX_X,
    maxY: PC_CAVITY_MAX_Y,
    maxZ: PC_MAX_Z,
    tiles: 'dark_iron',
    hiddenFaces: { py: true, ny: true },
  });

  // 前脸进风网孔面板（+Z 使用 pc_mesh 纹理）
  opaqueBuilder.addBox({
    minX: -0.9375,
    minY: PC_CAVITY_MIN_Y,
    minZ: 0.40625,
    maxX: -0.75,
    maxY: PC_CAVITY_MAX_Y,
    maxZ: 0.4296875,
    tiles: { pz: 'pc_mesh', all: 'dark_iron' },
    hiddenFaces: { py: true, ny: true, px: true, nx: true },
  });

  // 2. 机箱腔体内部可见方块硬件
  // 底部电源仓罩
  opaqueBuilder.addBox({
    minX: -0.9375,
    minY: PC_CAVITY_MIN_Y,
    minZ: 0.09375,
    maxX: -0.765625,
    maxY: PC_MIN_Y + 0.109375,
    maxZ: 0.34375,
    tiles: 'dark_iron',
    tint: '#2a313d',
    hiddenFaces: { ny: true, nx: true, nz: true },
  });

  // 深色石砖主板基板
  opaqueBuilder.addBox({
    minX: -0.9375,
    minY: PC_MIN_Y + 0.125,
    minZ: 0.109375,
    maxX: -0.90625,
    maxY: PC_MIN_Y + 0.375,
    maxZ: 0.359375,
    tiles: 'stone_brick',
    tint: '#3c4a5c',
    hiddenFaces: { nx: true },
  });

  // 铁块 CPU 塔式风冷散热块
  opaqueBuilder.addBox({
    minX: -0.90625,
    minY: PC_MIN_Y + 0.265625,
    minZ: 0.140625,
    maxX: -0.8125,
    maxY: PC_MIN_Y + 0.359375,
    maxZ: 0.234375,
    tiles: 'iron_block',
    occludes: false,
    hiddenFaces: { nx: true },
  });

  // 2 根双通道内存方块条
  const ramZOffsets: readonly [number, number] = [0.265625, 0.296875];
  for (let i = 0; i < ramZOffsets.length; i += 1) {
    const z0 = ramZOffsets[i];
    opaqueBuilder.addBox({
      minX: -0.90625,
      minY: PC_MIN_Y + 0.25,
      minZ: z0,
      maxX: -0.84375,
      maxY: PC_MIN_Y + 0.359375,
      maxZ: z0 + 0.015625,
      tiles: { px: 'iron_block', all: 'dark_iron' },
      occludes: false,
      hiddenFaces: { nx: true },
    });
  }

  // 金铁配色独立显卡大砖块（顶面铁背板 + 朝窗面金块装甲）
  opaqueBuilder.addBox({
    minX: -0.90625,
    minY: PC_MIN_Y + 0.15625,
    minZ: 0.109375,
    maxX: -0.78125,
    maxY: PC_MIN_Y + 0.21875,
    maxZ: 0.34375,
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

  // 3. 侧透玻璃窗（+X 面向桌面与视角，仅输出外表面消除半透重绘）
  glassBuilder.addBox({
    minX: -0.734375,
    minY: PC_CAVITY_MIN_Y,
    minZ: 0.09375,
    maxX: -0.7265625,
    maxY: PC_CAVITY_MAX_Y,
    maxZ: 0.40625,
    tiles: 'glass',
    occludes: false,
    hiddenFaces: { py: true, ny: true, pz: true, nz: true, nx: true },
  });
}

/** 构建体素桌垫、机械键盘（含强调色 ESC 键帽）与方块鼠标 */
function appendVoxelDeskPeripherals(
  opaqueBuilder: VoxelBoxBuilder,
  safeAccentHex: string
): void {
  // 1. 轴对齐羊毛桌垫（深石板灰染色）
  opaqueBuilder.addBox({
    minX: -0.125,
    minY: DESK_TOP_Y,
    minZ: -0.375,
    maxX: 0.25,
    maxY: MAT_TOP_Y,
    maxZ: 0.25,
    tiles: 'wool_light_gray',
    tint: '#2c384a',
    occludes: false,
    floorY: DESK_TOP_Y,
    hiddenFaces: { ny: true },
  });

  // 2. 体素键盘主体（面向 +X 员工就座方向）
  opaqueBuilder.addBox({
    minX: -0.0625,
    minY: MAT_TOP_Y,
    minZ: -0.1875,
    maxX: 0.125,
    maxY: MAT_TOP_Y + 0.0625,
    maxZ: 0.21875,
    tiles: {
      top: 'keyboard_top',
      bottom: 'dark_iron',
      side: 'dark_iron',
    },
    floorY: MAT_TOP_Y,
    hiddenFaces: { ny: true },
  });

  // 键盘左上角强调色 ESC 凸起体素键帽
  opaqueBuilder.addBox({
    minX: -0.046875,
    minY: MAT_TOP_Y + 0.0625,
    minZ: 0.171875,
    maxX: -0.015625,
    maxY: MAT_TOP_Y + 0.078125,
    maxZ: 0.203125,
    tiles: 'wool_white',
    tint: safeAccentHex,
    occludes: false,
    hiddenFaces: { ny: true },
  });

  // 3. 位于键盘右侧（-Z）的体素鼠标 + 顶部铁色滚轮像素块
  opaqueBuilder.addBox({
    minX: -0.0625,
    minY: MAT_TOP_Y,
    minZ: -0.34375,
    maxX: 0.0625,
    maxY: MAT_TOP_Y + 0.0625,
    maxZ: -0.25,
    tiles: 'dark_iron',
    floorY: MAT_TOP_Y,
    hiddenFaces: { ny: true },
  });

  opaqueBuilder.addBox({
    minX: -0.046875,
    minY: MAT_TOP_Y + 0.0625,
    minZ: -0.3125,
    maxX: -0.015625,
    maxY: MAT_TOP_Y + 0.078125,
    maxZ: -0.28125,
    tiles: 'iron_block',
    occludes: false,
    hiddenFaces: { ny: true },
  });
}

/** 构建桌面 Minecraft 经典小摆件：白色咖啡马克杯 + 红陶盆栽小花 */
function appendVoxelDesktopProps(
  opaqueBuilder: VoxelBoxBuilder,
  safeAccentHex: string
): void {
  // 1. 桌面边缘体素咖啡马克杯 + 侧把手
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
    maxX: -0.25,
    maxY: DESK_TOP_Y + 0.09375,
    maxZ: 0.421875,
    tiles: 'mug_white',
    occludes: false,
    hiddenFaces: { nx: true },
  });

  // 2. 桌面后左角红陶花盆 + 绿叶花茎 + 确定性红/黄方块花朵
  opaqueBuilder.addBox({
    minX: -0.9375,
    minY: DESK_TOP_Y,
    minZ: -0.4375,
    maxX: -0.75,
    maxY: DESK_TOP_Y + 0.1875,
    maxZ: -0.25,
    tiles: {
      side: 'terracotta',
      top: 'dirt',
      bottom: 'terracotta',
    },
    floorY: DESK_TOP_Y,
    hiddenFaces: { ny: true },
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
    minY: DESK_TOP_Y + 0.3125,
    minZ: -0.40625,
    maxX: -0.78125,
    maxY: DESK_TOP_Y + 0.375,
    maxZ: -0.28125,
    tiles: pickFlowerTile(safeAccentHex),
    occludes: false,
  });
}

/** 构建合批 RGB 发光体素灯条（机箱前竖条 + 显卡侧灯条 + 内存顶灯 + 键盘前灯条） */
function buildRgbAccentGeometry(): THREE.BufferGeometry {
  const rgbBoxes: SolidColorBoxInput[] = [
    // 机箱前脸右侧竖向 RGB 灯柱
    {
      minX: -0.7734375,
      minY: PC_MIN_Y + 0.0625,
      minZ: 0.4296875,
      maxX: -0.7578125,
      maxY: PC_MIN_Y + 0.390625,
      maxZ: PC_MAX_Z,
      shadeFaces: false,
    },
    // 显卡侧边水平 RGB 灯条（透过玻璃窗可见）
    {
      minX: -0.78125,
      minY: PC_MIN_Y + 0.1875,
      minZ: 0.140625,
      maxX: -0.765625,
      maxY: PC_MIN_Y + 0.203125,
      maxZ: 0.3125,
      shadeFaces: false,
    },
    // 2 根内存条正面微光 RGB 灯边
    {
      minX: -0.84375,
      minY: PC_MIN_Y + 0.2578125,
      minZ: 0.265625,
      maxX: -0.8359375,
      maxY: PC_MIN_Y + 0.3515625,
      maxZ: 0.28125,
      shadeFaces: false,
    },
    {
      minX: -0.84375,
      minY: PC_MIN_Y + 0.2578125,
      minZ: 0.296875,
      maxX: -0.8359375,
      maxY: PC_MIN_Y + 0.3515625,
      maxZ: 0.3125,
      shadeFaces: false,
    },
    // 键盘前缘低矮 RGB 氛围条
    {
      minX: 0.125,
      minY: MAT_TOP_Y,
      minZ: -0.171875,
      maxX: 0.1328125,
      maxY: MAT_TOP_Y + 0.015625,
      maxZ: 0.203125,
      shadeFaces: false,
    },
  ];
  return createSolidColorVoxelGeometry(rgbBoxes);
}

/** 构建机箱顶前角方块电源指示灯几何 */
function buildPowerLedGeometry(): THREE.BufferGeometry {
  return createSolidColorVoxelGeometry([
    {
      minX: -0.78125,
      minY: PC_MAX_Y,
      minZ: 0.375,
      maxX: -0.75,
      maxY: PC_MAX_Y + 0.015625,
      maxZ: 0.40625,
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
  const safeAccentHex = normalizeOfficeRgbColor(accentHex, palette.accentHex);

  const opaqueBuilder = new VoxelBoxBuilder();
  const glassBuilder = new VoxelBoxBuilder();

  appendVoxelPcTower(opaqueBuilder, glassBuilder);
  appendVoxelDeskPeripherals(opaqueBuilder, safeAccentHex);
  appendVoxelDesktopProps(opaqueBuilder, safeAccentHex);

  // Draw Call 1: 全部静态不透明体素部件（机箱 + 内部硬件 + 桌垫 + 键鼠 + 咖啡杯 + 盆栽）
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

  // Draw Call 3: 工位独立 RGB 灯条材质与几何
  const rgbMaterial = new THREE.MeshBasicMaterial({
    color: safeAccentHex,
  });
  const rgbMesh = new THREE.Mesh(buildRgbAccentGeometry(), rgbMaterial);
  rgbMesh.name = 'voxel-computer-rgb';
  rgbMesh.castShadow = false;
  rgbMesh.receiveShadow = false;
  rgbMesh.userData.noShadow = true;
  root.add(rgbMesh);

  // Draw Call 4: 工位独立电源指示灯材质与几何
  const powerLedMaterial = new THREE.MeshBasicMaterial({
    color: palette.successHex,
  });
  const powerLedMesh = new THREE.Mesh(buildPowerLedGeometry(), powerLedMaterial);
  powerLedMesh.name = 'voxel-computer-power-led';
  powerLedMesh.castShadow = false;
  powerLedMesh.receiveShadow = false;
  powerLedMesh.userData.noShadow = true;
  root.add(powerLedMesh);

  const initialPhase = ((hashAccentString(safeAccentHex) % 628) / 100);

  return {
    root,
    rgbMaterial,
    powerLedMaterial,
    powerState: 'on',
    rgbEnabled: true,
    rgbColor: new THREE.Color(safeAccentHex),
    rgbDimmed: false,
    pulsePhase: initialPhase,
  };
}

export function syncDesktopComputerRig(
  rig: DesktopComputerRig,
  power: OfficeComputerPowerState,
  rgbEnabled: boolean,
  rgbColorHex: string,
  availability: SessionAvailability,
  palette: OfficeScenePalette
): void {
  rig.powerState = power;
  rig.rgbEnabled = rgbEnabled;
  rig.rgbDimmed = availability === 'exited';

  const normalizedHex = normalizeOfficeRgbColor(rgbColorHex);
  rig.rgbColor.set(normalizedHex);

  // RGB 灯光同步：开机且开启 RGB 时显示主色（退出态柔暗），否则暗灰熄灭
  if (power === 'on' && rgbEnabled) {
    rig.rgbMaterial.color.copy(rig.rgbColor);
    if (rig.rgbDimmed) {
      rig.rgbMaterial.color.multiplyScalar(0.55);
    }
  } else {
    rig.rgbMaterial.color.set(RGB_OFF_HEX);
  }

  // 机箱顶前角电源状态灯同步
  let ledHex = palette.accentHex;
  if (power === 'off') {
    ledHex = POWER_LED_OFF_HEX;
  } else if (availability === 'interactive') {
    ledHex = palette.successHex;
  } else if (availability === 'unavailable') {
    ledHex = palette.warningHex;
  } else if (availability === 'exited') {
    ledHex = palette.screenMutedHex;
  }
  rig.powerLedMaterial.color.set(ledHex);
}

export function animateDesktopComputerRig(
  rig: DesktopComputerRig,
  elapsedSec: number,
  dtSec: number,
  reducedMotion: boolean
): void {
  if (rig.powerState !== 'on' || !rig.rgbEnabled) {
    return;
  }

  const baseScale = rig.rgbDimmed ? 0.55 : 1.0;
  if (reducedMotion) {
    rig.rgbMaterial.color.copy(rig.rgbColor).multiplyScalar(baseScale);
    return;
  }

  // 温和呼吸亮度调制（0.76 ~ 1.00），零临时对象分配
  const safeDt = Number.isFinite(dtSec) && dtSec > 0 ? Math.min(dtSec, 0.1) : 0;
  if (safeDt > 0) {
    rig.pulsePhase = (rig.pulsePhase + safeDt * 0.15) % (Math.PI * 2);
  }
  const timeSec = Number.isFinite(elapsedSec) ? elapsedSec : 0;
  const wave = Math.sin(timeSec * 2.1 + rig.pulsePhase);
  const pulseFactor = baseScale * (0.88 + wave * 0.12);
  rig.rgbMaterial.color.copy(rig.rgbColor).multiplyScalar(pulseFactor);
}
