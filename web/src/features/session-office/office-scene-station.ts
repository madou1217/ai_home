import * as THREE from 'three';
import type { OfficeSessionItem } from './session-office-types';
import type { OfficeMonitorIndex, OfficeScenePalette } from './office-scene-types';
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
  createDualMonitorAssemblyRig,
  DESK_SURFACE_Y,
  syncDualMonitorAssemblyRig,
  type DualMonitorAssemblyRig,
} from './office-monitor-rig';
import { getSharedVoxelMaterialSet, type VoxelTileId } from './office-voxel-atlas';
import { createSolidColorVoxelGeometry, VoxelBoxBuilder } from './office-voxel-builder';
import {
  createRectilinearPulseGuideGeometry,
  createVoxelChestGeometry,
  createWireframeBoxGeometry,
  sampleRectilinearPath,
} from './office-voxel-kit';

/**
 * Minecraft 体素工位组装模块：
 * - 橡木木板书桌（桌面顶面严格维持 DESK_SURFACE_Y = 0.746）+ 方块椅子 + 羊毛地毯合批构建（1 Draw Call）。
 * - Minecraft 木箱邮件托盘 + InstancedMesh 悬浮上下弹跳邮件包裹（最多 1 Draw Call）+ 3 段直线折线脉冲粒子。
 * - 12 根细长方体拼成的发光选中方框；悬停仅提亮材质不改几何形状。
 * - 完整保留 `hitKind` / `sessionKey` / `monitorIndex` 拾取标签树。
 */

const CARPET_TOP_Y = 0.03125;
const CHAIR_SEAT_TOP_Y = 0.375;
const CHAIR_CENTER_X = 0.5625;
const CHAIR_CENTER_Z = 0;

const PARCEL_BASE_Y = [0.28125, 0.375, 0.46875] as const;

const PULSE_WAYPOINTS: readonly [THREE.Vector3, THREE.Vector3, THREE.Vector3, THREE.Vector3] = [
  new THREE.Vector3(-0.125, 0.234375, 0),
  new THREE.Vector3(-0.125, 0.5625, 0),
  new THREE.Vector3(0.125, 0.5625, 0),
  new THREE.Vector3(0.125, 0.234375, 0),
];

const SCRATCH_PULSE_POS = new THREE.Vector3();
const SCRATCH_PARCEL_MATRIX = new THREE.Matrix4();
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
  monitorAssembly: DualMonitorAssemblyRig;
  screenMesh: THREE.Mesh;
  computerRig: DesktopComputerRig;
  mailTrayGroup: THREE.Group;
  mailPacketsMesh: THREE.InstancedMesh;
  visiblePacketCount: number;
  trayLedMesh: THREE.Mesh;
  pulseGuideMesh: THREE.Mesh;
  pulseCubeMesh: THREE.Mesh;
  selectionFrameMesh: THREE.Mesh;
  character: OfficeCharacterRig;
  badgeBundle: CanvasTextureBundle;
  furnitureMaterial: THREE.MeshLambertMaterial;
  selectionFrameMaterial: THREE.MeshBasicMaterial;
  trayLedMaterial: THREE.MeshBasicMaterial;
  pulseGuideMaterial: THREE.MeshBasicMaterial;
  pulseCubeMaterial: THREE.MeshBasicMaterial;
  hasActivePulse: boolean;
  hasPendingMail: boolean;
  phaseOffset: number;
}

export interface StationSyncOptions {
  isSelected: boolean;
  isHovered: boolean;
  preferences: OfficeComputerPreferences;
  rasterVersion: number;
  isEditingThisStation: boolean;
  activeEditMonitorIndex: OfficeMonitorIndex;
}

function hashKey(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function tagPickableTree(
  object: THREE.Object3D,
  sessionKey: string,
  hitKind: 'station' | 'monitor' | 'mail-tray',
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

function updateParcelInstanceMatrices(
  mesh: THREE.InstancedMesh,
  count: number,
  elapsedSec: number,
  phaseOffset: number,
  reducedMotion: boolean
): void {
  for (let i = 0; i < count; i += 1) {
    const bob = reducedMotion
      ? 0
      : Math.sin(elapsedSec * 3.1 + phaseOffset + i * 0.9) * 0.022;
    SCRATCH_PARCEL_MATRIX.makeTranslation(0, PARCEL_BASE_Y[i] + bob, 0);
    mesh.setMatrixAt(i, SCRATCH_PARCEL_MATRIX);
  }
  mesh.instanceMatrix.needsUpdate = true;
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

  // 2. 橡木书桌桌面（3 条拼板，顶面精确保持 DESK_SURFACE_Y = 0.746，厚 0.0625）
  const deskBottomY = DESK_SURFACE_Y - 0.0625; // 0.6835
  const plankStrips: Array<[number, number, VoxelTileId]> = [
    [-0.50, -0.1875, 'oak_planks'],
    [-0.1875, 0.1875, 'oak_planks'],
    [0.1875, 0.50, 'oak_planks'],
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
    minZ: -0.46875,
    maxX: 0.1875,
    maxY: deskBottomY,
    maxZ: -0.40625,
    tiles: 'spruce_planks',
  });

  // 书桌 4 根方形原木桌腿（0.125 × 0.65225 × 0.125，落于地毯顶面之上）
  const legCorners: Array<[number, number]> = [
    [-1.00, -0.50],
    [0.1875, -0.50],
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

  // 桌面正前方的深色橡木铭牌底框
  builder.addBox({
    minX: -0.50,
    minY: deskBottomY - 0.015625,
    minZ: 0.50,
    maxX: -0.25,
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

/** 构建 Minecraft 木箱邮件托盘、合批悬浮包裹与 3 段折线脉冲信号 */
function buildVoxelMailTray(
  sessionKey: string,
  trayLedMaterial: THREE.MeshBasicMaterial,
  pulseGuideMaterial: THREE.MeshBasicMaterial,
  pulseCubeMaterial: THREE.MeshBasicMaterial
): {
  mailTrayGroup: THREE.Group;
  mailPacketsMesh: THREE.InstancedMesh;
  trayLedMesh: THREE.Mesh;
  pulseGuideMesh: THREE.Mesh;
  pulseCubeMesh: THREE.Mesh;
} {
  const shared = getSharedVoxelMaterialSet();
  const mailTrayGroup = new THREE.Group();
  mailTrayGroup.position.set(0.125, DESK_SURFACE_Y, 0.375);

  // Minecraft 经典木箱主体
  const chestGeo = createVoxelChestGeometry(0.25, 0.21875, 0.21875);
  const chestMesh = new THREE.Mesh(chestGeo, shared.opaque);
  mailTrayGroup.add(chestMesh);

  // 箱体前缘像素状态指示方块（仅在有待处理或脉冲邮件时显示）
  const ledGeo = createSolidColorVoxelGeometry([
    {
      minX: -0.0625,
      minY: 0.03125,
      minZ: 0.109375,
      maxX: 0.0625,
      maxY: 0.0625,
      maxZ: 0.125,
      shadeFaces: false,
    },
  ]);
  const trayLedMesh = new THREE.Mesh(ledGeo, trayLedMaterial);
  trayLedMesh.visible = false;
  trayLedMesh.userData.noShadow = true;
  mailTrayGroup.add(trayLedMesh);

  // 1~3 个悬浮小邮件包裹方块（合批为 1 个 InstancedMesh，弹跳由正弦垂直位移驱动）
  const parcelBuilder = new VoxelBoxBuilder();
  parcelBuilder.addBox({
    minX: -0.0625,
    minY: -0.03125,
    minZ: -0.046875,
    maxX: 0.0625,
    maxY: 0.03125,
    maxZ: 0.046875,
    tiles: 'mail_parcel',
  });
  const sharedParcelGeo = parcelBuilder.build(false);
  const mailPacketsMesh = new THREE.InstancedMesh(
    sharedParcelGeo,
    shared.opaque,
    PARCEL_BASE_Y.length
  );
  mailPacketsMesh.count = 0;
  mailPacketsMesh.visible = false;
  updateParcelInstanceMatrices(mailPacketsMesh, PARCEL_BASE_Y.length, 0, 0, true);
  mailTrayGroup.add(mailPacketsMesh);

  // 3 段直线折线轨道（全部轴对齐长方体）
  const guideGeo = createRectilinearPulseGuideGeometry(PULSE_WAYPOINTS, 0.015625);
  const pulseGuideMesh = new THREE.Mesh(guideGeo, pulseGuideMaterial);
  pulseGuideMesh.visible = false;
  pulseGuideMesh.userData.noShadow = true;
  mailTrayGroup.add(pulseGuideMesh);

  // 沿 3 段折线运动的发光方块粒子
  const cubeGeo = createSolidColorVoxelGeometry([
    {
      minX: -0.03125,
      minY: -0.03125,
      minZ: -0.03125,
      maxX: 0.03125,
      maxY: 0.03125,
      maxZ: 0.03125,
      shadeFaces: false,
    },
  ]);
  const pulseCubeMesh = new THREE.Mesh(cubeGeo, pulseCubeMaterial);
  pulseCubeMesh.visible = false;
  pulseCubeMesh.userData.noShadow = true;
  mailTrayGroup.add(pulseCubeMesh);

  tagPickableTree(mailTrayGroup, sessionKey, 'mail-tray');

  return {
    mailTrayGroup,
    mailPacketsMesh,
    trayLedMesh,
    pulseGuideMesh,
    pulseCubeMesh,
  };
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

  const trayLedMaterial = new THREE.MeshBasicMaterial({
    color: palette.accentHex,
  });

  const pulseGuideMaterial = new THREE.MeshBasicMaterial({
    color: palette.accentHex,
    transparent: true,
    opacity: 0.65,
  });

  const pulseCubeMaterial = new THREE.MeshBasicMaterial({
    color: palette.accentHex,
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

  // 桌面正前方的像素工位铭牌面
  const badgeBundle = createDeskBadgeBundle(anisotropy);
  const badgeFaceMat = new THREE.MeshBasicMaterial({ map: badgeBundle.texture });
  const badgeFace = new THREE.Mesh(new THREE.PlaneGeometry(0.23, 0.068), badgeFaceMat);
  badgeFace.position.set(-0.375, DESK_SURFACE_Y - 0.039, 0.533);
  badgeFace.userData.sessionKey = session.sessionKey;
  badgeFace.userData.hitKind = 'station';
  badgeFace.userData.noShadow = true;
  root.add(badgeFace);

  // 2. 选中态发光描边方框（12 根细棱条紧凑贴合「桌面 + 显示器」，不包裹椅子与角色头顶空间）
  // 桌面范围 x ∈ [-1.00, 0.3125]（宽 1.3125）、z ∈ [-0.50, 0.50]（深 1.00），y ∈ [0.66, 1.40]
  const selectionFrameGeo = createWireframeBoxGeometry(1.40, 0.74, 1.08, 0.012, false);
  const selectionFrameMesh = new THREE.Mesh(selectionFrameGeo, selectionFrameMaterial);
  selectionFrameMesh.position.set(-0.34375, 0.66, 0);
  selectionFrameMesh.visible = false;
  selectionFrameMesh.userData.noShadow = true;
  selectionFrameMesh.userData.sessionKey = session.sessionKey;
  selectionFrameMesh.userData.hitKind = 'station';
  root.add(selectionFrameMesh);

  // 3. Minecraft 体素 PC 主机、方块键鼠与杯子/花盆小装饰
  const computerRig = createDesktopComputerRig(
    palette,
    session.persona.deskAccent || palette.accentHex
  );
  tagPickableTree(computerRig.root, session.sessionKey, 'station', true);
  root.add(computerRig.root);

  // 4. Minecraft Steve 比例角色（坐于方块椅上，精准旋转 -90° 朝向书桌）
  const character = createOfficeCharacter(session, palette);
  character.root.position.set(CHAIR_CENTER_X, 0, CHAIR_CENTER_Z);
  character.root.rotation.y = -Math.PI / 2;
  root.add(character.root);

  // 5. Minecraft 体素单/双显示器组件
  const monitorAssembly = createDualMonitorAssemblyRig(
    session.sessionKey,
    anisotropy,
    palette
  );
  root.add(monitorAssembly.root);

  // 6. Minecraft 木箱邮件托盘 + 悬浮包裹 + 3 段直线脉冲
  const {
    mailTrayGroup,
    mailPacketsMesh,
    trayLedMesh,
    pulseGuideMesh,
    pulseCubeMesh,
  } = buildVoxelMailTray(
    session.sessionKey,
    trayLedMaterial,
    pulseGuideMaterial,
    pulseCubeMaterial
  );
  root.add(mailTrayGroup);

  const rig: OfficeStationRig = {
    sessionKey: session.sessionKey,
    root,
    targetPosition: new THREE.Vector3(),
    monitorAssembly,
    screenMesh: monitorAssembly.monitors[0].screenMesh,
    computerRig,
    mailTrayGroup,
    mailPacketsMesh,
    visiblePacketCount: 0,
    trayLedMesh,
    pulseGuideMesh,
    pulseCubeMesh,
    selectionFrameMesh,
    character,
    badgeBundle,
    furnitureMaterial,
    selectionFrameMaterial,
    trayLedMaterial,
    pulseGuideMaterial,
    pulseCubeMaterial,
    hasActivePulse: false,
    hasPendingMail: false,
    phaseOffset: character.phaseOffset,
  };

  syncWorkstationPod(rig, session, palette, {
    isSelected: false,
    isHovered: false,
    preferences: DEFAULT_OFFICE_COMPUTER_PREFERENCES,
    rasterVersion: 0,
    isEditingThisStation: false,
    activeEditMonitorIndex: 0,
  });

  return rig;
}

export function getStationMonitorScreenMesh(
  rig: OfficeStationRig,
  monitorIndex: OfficeMonitorIndex = 0
): THREE.Mesh | null {
  if (monitorIndex === 1 && rig.monitorAssembly.dualMonitor) {
    return rig.monitorAssembly.monitors[1].screenMesh;
  }
  return rig.monitorAssembly.monitors[0]?.screenMesh ?? null;
}

export function disposeStationTextureBundles(rig: OfficeStationRig): void {
  rig.badgeBundle.texture.dispose();
  for (const monitor of rig.monitorAssembly.monitors) {
    monitor.screenBundle.texture.dispose();
  }
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
    isEditingThisStation,
    activeEditMonitorIndex,
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

  // 同步单/双显示器位姿、壁纸光栅化与实时预览屏幕
  syncDualMonitorAssemblyRig(rig.monitorAssembly, session, isSelected, palette, {
    power: preferences.power,
    wallpaper: preferences.wallpaper,
    dualMonitor: preferences.dualMonitor,
    transforms: preferences.monitors,
    rasterVersion,
    isEditingThisStation,
    activeEditMonitorIndex,
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

  // 木箱悬浮邮件包裹方块（InstancedMesh 单次 Draw Call）
  const totalMailIndicator = session.pendingCount + session.inboxCount;
  const visiblePackets = session.pendingCount > 0 || session.inboxCount > 0
    ? Math.min(PARCEL_BASE_Y.length, Math.max(1, Math.ceil(totalMailIndicator / 2)))
    : 0;
  rig.visiblePacketCount = visiblePackets;
  rig.mailPacketsMesh.count = visiblePackets;
  rig.mailPacketsMesh.visible = visiblePackets > 0;
  if (visiblePackets > 0) {
    updateParcelInstanceMatrices(rig.mailPacketsMesh, visiblePackets, 0, rig.phaseOffset, true);
  }

  const hasPulse = session.activity.recentPulse;
  const hasPending = session.pendingCount > 0 || session.activity.unreadOrDeliveredCount > 0;
  rig.hasActivePulse = hasPulse;
  rig.hasPendingMail = hasPending;

  let mailSignalHex = palette.accentHex;
  if (session.activity.failedCount > 0) {
    mailSignalHex = palette.dangerHex;
  } else if (session.pendingCount > 0) {
    mailSignalHex = palette.warningHex;
  } else if (session.activity.kind === 'outgoing') {
    mailSignalHex = palette.violetHex;
  }

  rig.trayLedMaterial.color.set(mailSignalHex);
  rig.trayLedMesh.visible = hasPulse || hasPending;
  rig.pulseGuideMaterial.color.set(mailSignalHex);
  rig.pulseCubeMaterial.color.set(mailSignalHex);

  const showPulse = hasPulse || session.pendingCount > 0;
  rig.pulseGuideMesh.visible = showPulse;
  rig.pulseCubeMesh.visible = showPulse;
  if (showPulse) {
    sampleRectilinearPath(PULSE_WAYPOINTS, 0.5, SCRATCH_PULSE_POS);
    rig.pulseCubeMesh.position.copy(SCRATCH_PULSE_POS);
  }
}

export function animateWorkstationPod(
  rig: OfficeStationRig,
  elapsedSec: number,
  dtSec: number,
  reducedMotion: boolean
): void {
  if (reducedMotion) {
    rig.root.position.copy(rig.targetPosition);
  } else {
    const lerpAlpha = 1 - Math.exp(-Math.min(0.1, dtSec) * 10);
    rig.root.position.lerp(rig.targetPosition, lerpAlpha);
  }

  animateOfficeCharacter(rig.character, elapsedSec, reducedMotion);
  animateDesktopComputerRig(rig.computerRig, elapsedSec, dtSec, reducedMotion);

  // 悬浮邮件包裹正弦弹跳（reducedMotion 时保持静止）
  if (rig.visiblePacketCount > 0 && rig.mailPacketsMesh.visible) {
    updateParcelInstanceMatrices(
      rig.mailPacketsMesh,
      rig.visiblePacketCount,
      elapsedSec,
      rig.phaseOffset,
      reducedMotion
    );
  }

  // 活跃脉冲：方块粒子沿 3 段直线折线路径运动
  if (rig.pulseCubeMesh.visible) {
    const u = reducedMotion
      ? 0.5
      : ((elapsedSec * (rig.hasActivePulse ? 0.9 : 0.45) + rig.phaseOffset * 0.2) % 1);
    sampleRectilinearPath(PULSE_WAYPOINTS, u, SCRATCH_PULSE_POS);
    rig.pulseCubeMesh.position.copy(SCRATCH_PULSE_POS);
  }
}
