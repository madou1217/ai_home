import * as THREE from 'three';
import type { OfficeSessionItem } from './session-office-types';
import type { OfficeScenePalette } from './office-scene-types';
import {
  DEFAULT_OFFICE_COMPUTER_PREFERENCES,
  type OfficeComputerPreferences,
} from './office-computer-state';
import {
  createDeskBadgeBundle,
  updateDeskBadgeTexture,
  type CanvasTextureBundle,
} from './office-scene-textures';
import {
  animateOfficeCharacter,
  createOfficeCharacter,
  disposeOfficeCharacter,
  updateOfficeCharacter,
  type OfficeCharacterRig,
} from './office-character';
import {
  animateDesktopComputerRig,
  createDesktopComputerRig,
  syncDesktopComputerRig,
  type DesktopComputerRig,
} from './office-computer-model';
import {
  createMonitorAssemblyRig,
  DESK_SURFACE_Y,
  syncMonitorAssemblyRig,
  type MonitorAssemblyRig,
} from './office-monitor-rig';
import { getSharedVoxelMaterialSet, type VoxelTileId } from './office-voxel-atlas';
import { VoxelBoxBuilder } from './office-voxel-builder';
import { createWireframeBoxGeometry } from './office-voxel-kit';
import {
  SEAT_FACING_YAW,
  SEAT_LOCAL_X,
  SEAT_LOCAL_Z,
  type CharacterPoseOutput,
} from './office-voxel-behaviour';

/**
 * Minecraft 体素工位组装模块：
 * - 橡木木板书桌（桌面顶面严格维持 DESK_SURFACE_Y = 0.746）+ 方块椅子 + 羊毛地毯合批构建（1 Draw Call）。
 * - 12 根细长方体拼成的发光选中方框；悬停仅提亮材质不改几何形状。
 * - 完整保留 `hitKind` / `sessionKey` / `monitorIndex` 拾取标签树。
 */

const CARPET_TOP_Y = 0.03125;
const CHAIR_SEAT_TOP_Y = 0.375;
const CHAIR_CENTER_X = 0.5625;
const CHAIR_CENTER_Z = 0;

const SCRATCH_FRAME_COLOR = new THREE.Color();
const FRAME_SOFTEN_BASE = new THREE.Color('#3b738f');

const CARPET_WOOL_TILES: readonly VoxelTileId[] = [
  'wool_cyan',
  'wool_blue',
  'wool_green',
  'wool_purple',
  'wool_orange',
  'wool_yellow',
];

export interface OfficeStationRig {
  sessionKey: string;
  root: THREE.Group;
  targetPosition: THREE.Vector3;
  monitorAssembly: MonitorAssemblyRig;
  screenMesh: THREE.Mesh;
  computerRig: DesktopComputerRig;
  selectionFrameMesh: THREE.Mesh;
  character: OfficeCharacterRig;
  badgeBundle: CanvasTextureBundle;
  furnitureMaterial: THREE.MeshLambertMaterial;
  selectionFrameMaterial: THREE.MeshBasicMaterial;
  phaseOffset: number;
}

export interface StationSyncOptions {
  isSelected: boolean;
  isHovered: boolean;
  preferences: OfficeComputerPreferences;
  rasterVersion: number;
}

function hashKey(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * 在不修改禁止文件 office-computer-model.ts 的前提下，将桌面上的 PC 机箱（含侧透玻璃、RGB 灯条与电源灯）
 * 精准平移至桌子侧后方地面地毯（x ∈ [0.375, 0.625], y ∈ [0.03125, 0.46875], z ∈ [-0.75, -0.375]）：
 * - 严格避开桌腿、椅子、显示器与键盘鼠标；
 * - 任意正视屏幕视角（含全范围偏航角）均保证整块屏幕零遮挡；
 * - 完整保留机箱原有合批 Draw Call、RGB/电源灯效材质与 station 拾取标签。
 */
const ORIGINAL_PC_MIN_X = -0.98;
const ORIGINAL_PC_MAX_X = -0.7;
const ORIGINAL_PC_MIN_Y = DESK_SURFACE_Y - 0.01;
const ORIGINAL_PC_MAX_Y = DESK_SURFACE_Y + 0.48;
const ORIGINAL_PC_MIN_Z = 0.04;
const ORIGINAL_PC_MAX_Z = 0.46;

const PC_RELOCATE_DX = 1.34375; // [-0.96875, -0.71875] -> [+0.375, +0.625]
const PC_RELOCATE_DY = CARPET_TOP_Y - DESK_SURFACE_Y; // 落于地毯顶面 y = 0.03125
const PC_RELOCATE_DZ = -0.8125; // [+0.0625, +0.4375] -> [-0.75, -0.375]

function relocateDesktopPcTowerToFloor(computerRig: DesktopComputerRig): void {
  computerRig.root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    const pos = obj.geometry.getAttribute('position');
    if (!(pos instanceof THREE.BufferAttribute)) return;

    let moved = false;
    for (let i = 0; i < pos.count; i += 1) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      if (
        x >= ORIGINAL_PC_MIN_X
        && x <= ORIGINAL_PC_MAX_X
        && y >= ORIGINAL_PC_MIN_Y
        && y <= ORIGINAL_PC_MAX_Y
        && z >= ORIGINAL_PC_MIN_Z
        && z <= ORIGINAL_PC_MAX_Z
      ) {
        pos.setXYZ(i, x + PC_RELOCATE_DX, y + PC_RELOCATE_DY, z + PC_RELOCATE_DZ);
        moved = true;
      }
    }

    if (moved) {
      pos.needsUpdate = true;
      obj.geometry.computeBoundingBox();
      obj.geometry.computeBoundingSphere();
    }
  });
}

function tagPickableTree(
  object: THREE.Object3D,
  sessionKey: string,
  hitKind: 'station' | 'monitor',
  preserveShadowFlags = false
): void {
  object.traverse((child) => {
    child.userData.sessionKey = sessionKey;
    child.userData.hitKind = hitKind;
    if (!preserveShadowFlags && child instanceof THREE.Mesh && !child.userData.noShadow) {
      child.castShadow = true;
      child.receiveShadow = true;
    }
  });
}

/** 合批构建橡木书桌、方块椅子与羊毛地毯底座（1 次 Draw Call） */
function buildVoxelFurnitureGeometry(carpetTile: VoxelTileId): THREE.BufferGeometry {
  const builder = new VoxelBoxBuilder();

  // 1. 羊毛地毯底座（x ∈ [-1.1875, 0.9375], z ∈ [-0.75, 0.8125], y ∈ [0, 0.03125]）
  builder.addBox({
    minX: -1.1875,
    minY: 0,
    minZ: -0.75,
    maxX: 0.9375,
    maxY: CARPET_TOP_Y,
    maxZ: 0.8125,
    tiles: {
      top: carpetTile,
      side: 'wool_light_gray',
      bottom: 'wool_light_gray',
    },
    occludes: false,
    floorY: 0,
  });

  // 地毯前缘镶边色带（合批于地毯内，0 额外 Draw Call）
  builder.addBox({
    minX: -0.50,
    minY: CARPET_TOP_Y,
    minZ: 0.75,
    maxX: 0.25,
    maxY: CARPET_TOP_Y + 0.015625,
    maxZ: 0.8125,
    tiles: 'gold_block',
    occludes: false,
  });

  // 2. 橡木书桌桌面（4 条拼板，顶面精确保持 DESK_SURFACE_Y = 0.746，后沿延展至 -0.6875 稳妥承托显示器）
  const deskBottomY = DESK_SURFACE_Y - 0.0625; // 0.6835
  const plankStrips: Array<[number, number, VoxelTileId]> = [
    [-0.6875, -0.375, 'oak_planks'],
    [-0.375, -0.0625, 'oak_planks'],
    [-0.0625, 0.21875, 'oak_planks'],
    [0.21875, 0.50, 'oak_planks'],
  ];
  for (const [z0, z1, tile] of plankStrips) {
    builder.addBox({
      minX: -1.00,
      minY: deskBottomY,
      minZ: z0,
      maxX: 0.3125,
      maxY: DESK_SURFACE_Y,
      maxZ: z1,
      tiles: {
        top: tile,
        bottom: 'spruce_planks',
        side: 'spruce_planks',
      },
    });
  }

  // 书桌后挡板（加深结构立体感与下方暗角 AO）
  builder.addBox({
    minX: -0.875,
    minY: deskBottomY - 0.125,
    minZ: -0.65625,
    maxX: 0.1875,
    maxY: deskBottomY,
    maxZ: -0.59375,
    tiles: 'spruce_planks',
  });

  // 书桌 4 根方形原木桌腿（0.125 × 0.65225 × 0.125，落于地毯顶面之上）
  const legCorners: Array<[number, number]> = [
    [-1.00, -0.6875],
    [0.1875, -0.6875],
    [-1.00, 0.375],
    [0.1875, 0.375],
  ];
  for (const [lx, lz] of legCorners) {
    builder.addBox({
      minX: lx,
      minY: CARPET_TOP_Y,
      minZ: lz,
      maxX: lx + 0.125,
      maxY: deskBottomY,
      maxZ: lz + 0.125,
      tiles: {
        side: 'oak_log_side',
        top: 'oak_log_top',
        bottom: 'oak_log_top',
      },
      floorY: CARPET_TOP_Y,
    });
  }

  // 桌面正前方的深色橡木铭牌底框（同步放大以匹配 48px 铭牌字号）
  builder.addBox({
    minX: -0.5625,
    minY: deskBottomY - 0.03125,
    minZ: 0.50,
    maxX: -0.1875,
    maxY: DESK_SURFACE_Y,
    maxZ: 0.53125,
    tiles: 'dark_oak_planks',
  });

  // 3. 方块椅子（中心位于 x = 0.5625, z = 0，面朝 -X 书桌，椅面顶高 exact 0.375）
  const seatMinX = CHAIR_CENTER_X - 0.25; // 0.3125
  const seatMaxX = CHAIR_CENTER_X + 0.25; // 0.8125
  const seatMinZ = CHAIR_CENTER_Z - 0.25; // -0.25
  const seatMaxZ = CHAIR_CENTER_Z + 0.25; // 0.25
  const seatBottomY = CHAIR_SEAT_TOP_Y - 0.0625; // 0.3125

  // 椅面（橡木底座 + 羊毛坐垫）
  builder.addBox({
    minX: seatMinX,
    minY: seatBottomY,
    minZ: seatMinZ,
    maxX: seatMaxX,
    maxY: CHAIR_SEAT_TOP_Y,
    maxZ: seatMaxZ,
    tiles: {
      top: carpetTile,
      side: 'spruce_planks',
      bottom: 'spruce_planks',
    },
  });

  // 椅子 4 条方腿
  const chairLegs: Array<[number, number]> = [
    [seatMinX, seatMinZ],
    [seatMaxX - 0.0625, seatMinZ],
    [seatMinX, seatMaxZ - 0.0625],
    [seatMaxX - 0.0625, seatMaxZ - 0.0625],
  ];
  for (const [cx, cz] of chairLegs) {
    builder.addBox({
      minX: cx,
      minY: CARPET_TOP_Y,
      minZ: cz,
      maxX: cx + 0.0625,
      maxY: seatBottomY,
      maxZ: cz + 0.0625,
      tiles: 'dark_oak_planks',
      floorY: CARPET_TOP_Y,
    });
  }

  // 椅子靠背（位于 +X 背侧，紧贴角色后背）
  builder.addBox({
    minX: seatMaxX - 0.0625,
    minY: CHAIR_SEAT_TOP_Y,
    minZ: seatMinZ,
    maxX: seatMaxX,
    maxY: CHAIR_SEAT_TOP_Y + 0.5625,
    maxZ: seatMaxZ,
    tiles: {
      side: 'oak_planks',
      top: 'spruce_planks',
      bottom: 'spruce_planks',
    },
  });

  // 椅子左右方块扶手
  for (const side of [-1, 1] as const) {
    const az0 = side < 0 ? seatMinZ - 0.0625 : seatMaxZ;
    const az1 = side < 0 ? seatMinZ : seatMaxZ + 0.0625;
    builder.addBox({
      minX: seatMinX + 0.125,
      minY: CHAIR_SEAT_TOP_Y + 0.125,
      minZ: az0,
      maxX: seatMaxX,
      maxY: CHAIR_SEAT_TOP_Y + 0.1875,
      maxZ: az1,
      tiles: 'spruce_planks',
    });
    builder.addBox({
      minX: seatMinX + 0.125,
      minY: seatBottomY,
      minZ: az0,
      maxX: seatMinX + 0.1875,
      maxY: CHAIR_SEAT_TOP_Y + 0.125,
      maxZ: az1,
      tiles: 'dark_oak_planks',
    });
  }

  return builder.build(true);
}

export function createWorkstationPod(
  session: OfficeSessionItem,
  palette: OfficeScenePalette,
  anisotropy = 1
): OfficeStationRig {
  const shared = getSharedVoxelMaterialSet();
  const root = new THREE.Group();

  // 每工位独立 Lambert 材质复用共享像素图集，使悬停仅提亮本工位而不改变形状
  const furnitureMaterial = new THREE.MeshLambertMaterial({
    map: shared.atlasTexture,
    vertexColors: true,
  });

  const selectionFrameMaterial = new THREE.MeshBasicMaterial({
    color: palette.accentHex,
    transparent: true,
    opacity: 0.72,
    depthWrite: false,
  });

  // 1. 书桌 + 椅子 + 羊毛地毯底座（单次合批）
  const carpetTile = CARPET_WOOL_TILES[hashKey(session.sessionKey) % CARPET_WOOL_TILES.length];
  const furnitureMesh = new THREE.Mesh(
    buildVoxelFurnitureGeometry(carpetTile),
    furnitureMaterial
  );
  furnitureMesh.castShadow = true;
  furnitureMesh.receiveShadow = true;
  furnitureMesh.userData.sessionKey = session.sessionKey;
  furnitureMesh.userData.hitKind = 'station';
  root.add(furnitureMesh);

  // 桌面正前方的像素工位铭牌面（尺寸 0.34 × 0.084，同步放大字号且保持从属于主显示器）
  const badgeBundle = createDeskBadgeBundle(anisotropy);
  const badgeFaceMat = new THREE.MeshBasicMaterial({ map: badgeBundle.texture });
  const badgeFace = new THREE.Mesh(new THREE.PlaneGeometry(0.34, 0.084), badgeFaceMat);
  badgeFace.position.set(-0.375, DESK_SURFACE_Y - 0.047, 0.533);
  badgeFace.userData.sessionKey = session.sessionKey;
  badgeFace.userData.hitKind = 'station';
  badgeFace.userData.noShadow = true;
  root.add(badgeFace);

  // 2. 选中态发光描边方框（12 根细棱条紧凑包覆放大后的桌面与显示器，不裁剪屏幕顶边与摄像头）
  const selectionFrameGeo = createWireframeBoxGeometry(1.44, 1.14, 1.26, 0.014, false);
  const selectionFrameMesh = new THREE.Mesh(selectionFrameGeo, selectionFrameMaterial);
  selectionFrameMesh.position.set(-0.34375, 0.64, -0.09375);
  selectionFrameMesh.visible = false;
  selectionFrameMesh.userData.noShadow = true;
  selectionFrameMesh.userData.sessionKey = session.sessionKey;
  selectionFrameMesh.userData.hitKind = 'station';
  root.add(selectionFrameMesh);

  // 3. Minecraft 体素 PC 主机（挪至桌旁侧后方地面避免遮挡屏幕）、方块键鼠与杯子/花盆小装饰
  const computerRig = createDesktopComputerRig(
    palette,
    session.persona.deskAccent || palette.accentHex
  );
  relocateDesktopPcTowerToFloor(computerRig);
  tagPickableTree(computerRig.root, session.sessionKey, 'station', true);
  root.add(computerRig.root);

  // 4. Minecraft Steve 比例角色（坐于方块椅上，精准旋转 -90° 朝向书桌）
  const character = createOfficeCharacter(session, palette);
  character.root.position.set(CHAIR_CENTER_X, 0, CHAIR_CENTER_Z);
  character.root.rotation.y = -Math.PI / 2;
  root.add(character.root);

  // 5. Minecraft 体素单显示器组件
  const monitorAssembly = createMonitorAssemblyRig(
    session.sessionKey,
    anisotropy,
    palette
  );
  root.add(monitorAssembly.root);

  const rig: OfficeStationRig = {
    sessionKey: session.sessionKey,
    root,
    targetPosition: new THREE.Vector3(),
    monitorAssembly,
    screenMesh: monitorAssembly.monitor.screenMesh,
    computerRig,
    selectionFrameMesh,
    character,
    badgeBundle,
    furnitureMaterial,
    selectionFrameMaterial,
    phaseOffset: character.phaseOffset,
  };

  syncWorkstationPod(rig, session, palette, {
    isSelected: false,
    isHovered: false,
    preferences: DEFAULT_OFFICE_COMPUTER_PREFERENCES,
    rasterVersion: 0,
  });

  return rig;
}

export function getStationMonitorScreenMesh(rig: OfficeStationRig): THREE.Mesh | null {
  return rig.monitorAssembly.monitor.screenMesh;
}

export function disposeStationTextureBundles(rig: OfficeStationRig): void {
  rig.badgeBundle.texture.dispose();
  rig.monitorAssembly.monitor.screenBundle.texture.dispose();
  disposeOfficeCharacter(rig.character);
}

export function syncWorkstationPod(
  rig: OfficeStationRig,
  session: OfficeSessionItem,
  palette: OfficeScenePalette,
  options: StationSyncOptions
): void {
  const {
    isSelected,
    isHovered,
    preferences,
    rasterVersion,
  } = options;

  // 悬停提亮（绝不修改几何形状）
  if (isHovered) {
    rig.furnitureMaterial.emissive.set(palette.mode === 'dark' ? '#243448' : '#2a2a1e');
  } else {
    rig.furnitureMaterial.emissive.set('#000000');
  }

  // 同步主机电源、RGB 灯效与键鼠状态
  syncDesktopComputerRig(
    rig.computerRig,
    preferences.power,
    preferences.rgbEnabled,
    preferences.rgbColor,
    session.availability,
    palette
  );

  // 同步显示器位姿、壁纸光栅化与实时预览屏幕
  syncMonitorAssemblyRig(rig.monitorAssembly, session, isSelected, palette, {
    power: preferences.power,
    wallpaper: preferences.wallpaper,
    transform: preferences.monitor,
    rasterVersion,
  });

  updateDeskBadgeTexture(
    rig.badgeBundle,
    session.persona.badgeCode,
    session.persona.deskAccent || palette.accentHex,
    palette
  );

  // 同步 Steve 角色状态与配饰
  updateOfficeCharacter(rig.character, session, palette);

  // 12 边选中描边方框（紧凑包住桌面与显示器，适度柔化亮度以免遮挡视线）
  SCRATCH_FRAME_COLOR.set(palette.accentHex).lerp(FRAME_SOFTEN_BASE, isHovered ? 0.1 : 0.28);
  rig.selectionFrameMaterial.color.copy(SCRATCH_FRAME_COLOR);
  rig.selectionFrameMaterial.opacity = isHovered ? 0.88 : 0.72;
  rig.selectionFrameMesh.visible = isSelected;

  }

export function animateWorkstationPod(
  rig: OfficeStationRig,
  elapsedSec: number,
  dtSec: number,
  reducedMotion: boolean,
  behaviourPose?: CharacterPoseOutput | null
): void {
  if (reducedMotion) {
    rig.root.position.copy(rig.targetPosition);
  } else {
    const lerpAlpha = 1 - Math.exp(-Math.min(0.1, dtSec) * 10);
    rig.root.position.lerp(rig.targetPosition, lerpAlpha);
  }

  if (!reducedMotion && behaviourPose && behaviourPose.phase !== 'seated') {
    rig.character.root.position.set(
      behaviourPose.worldX - rig.root.position.x,
      0,
      behaviourPose.worldZ - rig.root.position.z
    );
    rig.character.root.rotation.y = behaviourPose.yaw;
  } else {
    rig.character.root.position.set(SEAT_LOCAL_X, 0, SEAT_LOCAL_Z);
    rig.character.root.rotation.y = SEAT_FACING_YAW;
  }

  animateOfficeCharacter(rig.character, elapsedSec, reducedMotion, behaviourPose);
  animateDesktopComputerRig(rig.computerRig, elapsedSec, dtSec, reducedMotion);
}
