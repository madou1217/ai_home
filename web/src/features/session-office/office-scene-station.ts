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
  type MonitorScreenLod,
} from './office-scene-textures';
import {
  animateOfficeCharacter,
  createOfficeCharacter,
  disposeOfficeCharacter,
  updateOfficeCharacter,
  type OfficeCharacterRig,
} from './office-character';
import {
  createDesktopComputerRig,
  syncDesktopComputerRig,
  type DesktopComputerRig,
} from './office-computer-model';
import {
  createMonitorAssemblyRig,
  DESK_SURFACE_Y,
  setMonitorScreenLod,
  syncMonitorAssemblyRig,
  writeMonitorScreenCenterWorld,
  type MonitorAssemblyRig,
} from './office-monitor-rig';
import {
  getSharedVoxelMaterialSet,
  type VoxelQualityTier,
  type VoxelTileId,
} from './office-voxel-atlas';
import { VoxelBoxBuilder } from './office-voxel-builder';
import {
  createBatchedContactShadowGeometry,
  createStationSelectionFrameGeometry,
} from './office-voxel-kit';
import {
  SEAT_FACING_YAW,
  SEAT_LOCAL_X,
  SEAT_LOCAL_Z,
  type CharacterPoseOutput,
} from './office-voxel-behaviour';

/**
 * Minecraft 体素工位组装模块：
 * - 橡木木板书桌（含左侧双抽屉柜体与深铁脚垫，桌面严格保持 DESK_SURFACE_Y = 0.746）+
 *   立体腰靠方块椅 + 编织羊毛地毯合批构建（1 Draw Call）。
 * - 内置桌底、椅底与落地机箱底部的合批接触阴影面片（1 Draw Call），让工位稳稳落地。
 * - 贴地式发光四角选中围框（createStationSelectionFrameGeometry）：远景一目了然，近距读屏零遮挡。
 * - 完整保留 `hitKind` / `sessionKey` 拾取树。
 */

const CARPET_TOP_Y = 0.03125;
const CHAIR_SEAT_TOP_Y = 0.375;
const CHAIR_CENTER_X = 0.5625;
const CHAIR_CENTER_Z = 0;

const SCRATCH_FRAME_COLOR = new THREE.Color();
const FRAME_SOFTEN_BASE = new THREE.Color('#387494');

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
  contactShadowMesh: THREE.Mesh;
  character: OfficeCharacterRig;
  badgeBundle: CanvasTextureBundle;
  furnitureMaterial: THREE.MeshStandardMaterial;
  selectionFrameMaterial: THREE.MeshBasicMaterial;
  phaseOffset: number;
}

export interface StationSyncOptions {
  isSelected: boolean;
  isHovered: boolean;
  preferences: OfficeComputerPreferences;
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

/** 合批构建橡木书桌（含双抽屉底柜）、立体方块椅与羊毛地毯底座（1 次 Draw Call） */
function buildVoxelFurnitureGeometry(carpetTile: VoxelTileId): THREE.BufferGeometry {
  const builder = new VoxelBoxBuilder();

  // 1. 编织羊毛地毯底座（x ∈ [-1.1875, 0.9375], z ∈ [-0.75, 0.8125], y ∈ [0, 0.03125]）
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

  // 地毯前缘镶金装饰条
  builder.addBox({
    minX: -0.5,
    minY: CARPET_TOP_Y,
    minZ: 0.75,
    maxX: 0.25,
    maxY: CARPET_TOP_Y + 0.015625,
    maxZ: 0.8125,
    tiles: 'gold_block',
    occludes: false,
  });

  // 2. 橡木书桌桌面（4 条实木拼板，顶面精确保持 DESK_SURFACE_Y = 0.746）
  const deskBottomY = DESK_SURFACE_Y - 0.0625; // 0.6835
  const plankStrips: Array<[number, number, VoxelTileId]> = [
    [-0.6875, -0.375, 'oak_planks'],
    [-0.375, -0.0625, 'oak_planks'],
    [-0.0625, 0.21875, 'oak_planks'],
    [0.21875, 0.5, 'oak_planks'],
  ];
  for (const [z0, z1, tile] of plankStrips) {
    builder.addBox({
      minX: -1.0,
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

  // 书桌后挡板与走线槽
  builder.addBox({
    minX: -0.875,
    minY: deskBottomY - 0.140625,
    minZ: -0.65625,
    maxX: 0.1875,
    maxY: deskBottomY,
    maxZ: -0.59375,
    tiles: 'spruce_planks',
  });

  // 左侧桌下紧凑双抽屉柜（x ∈ [-0.9375, -0.5625]，完全远离角色腿部空间）
  builder.addBox({
    minX: -0.9375,
    minY: CARPET_TOP_Y + 0.03125,
    minZ: -0.5625,
    maxX: -0.5625,
    maxY: deskBottomY,
    maxZ: 0.34375,
    tiles: { px: 'spruce_planks', pz: 'oak_planks', all: 'dark_oak_planks' },
    floorY: CARPET_TOP_Y,
  });
  // 抽屉金属拉手（上下两层，面向 +Z 前侧）
  builder.addBox({
    minX: -0.8125,
    minY: 0.46875,
    minZ: 0.34375,
    maxX: -0.6875,
    maxY: 0.5,
    maxZ: 0.375,
    tiles: 'iron_block',
    occludes: false,
    hiddenFaces: { nz: true },
  });
  builder.addBox({
    minX: -0.8125,
    minY: 0.21875,
    minZ: 0.34375,
    maxX: -0.6875,
    maxY: 0.25,
    maxZ: 0.375,
    tiles: 'iron_block',
    occludes: false,
    hiddenFaces: { nz: true },
  });

  // 书桌 4 根方形原木桌腿 + 底部深铁护脚套
  const legCorners: Array<[number, number]> = [
    [-1.0, -0.6875],
    [0.1875, -0.6875],
    [-1.0, 0.375],
    [0.1875, 0.375],
  ];
  for (const [lx, lz] of legCorners) {
    builder.addBox({
      minX: lx,
      minY: CARPET_TOP_Y,
      minZ: lz,
      maxX: lx + 0.125,
      maxY: CARPET_TOP_Y + 0.0625,
      maxZ: lz + 0.125,
      tiles: 'dark_iron',
      floorY: CARPET_TOP_Y,
      hiddenFaces: { ny: true, py: true },
    });
    builder.addBox({
      minX: lx,
      minY: CARPET_TOP_Y + 0.0625,
      minZ: lz,
      maxX: lx + 0.125,
      maxY: deskBottomY,
      maxZ: lz + 0.125,
      tiles: {
        side: 'oak_log_side',
        top: 'oak_log_top',
        bottom: 'oak_log_top',
      },
      hiddenFaces: { ny: true },
    });
  }

  // 桌面正前方的深色橡木铭牌底框
  builder.addBox({
    minX: -0.5625,
    minY: deskBottomY - 0.03125,
    minZ: 0.5,
    maxX: -0.1875,
    maxY: DESK_SURFACE_Y,
    maxZ: 0.53125,
    tiles: 'dark_oak_planks',
  });

  // 3. 立体方块办公椅（中心位于 x = 0.5625, z = 0，椅面顶高 exact 0.375）
  const seatMinX = CHAIR_CENTER_X - 0.25; // 0.3125
  const seatMaxX = CHAIR_CENTER_X + 0.25; // 0.8125
  const seatMinZ = CHAIR_CENTER_Z - 0.25; // -0.25
  const seatMaxZ = CHAIR_CENTER_Z + 0.25; // 0.25
  const seatBottomY = CHAIR_SEAT_TOP_Y - 0.0625; // 0.3125

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

  // 椅子 4 条方腿与脚轮块
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
      maxY: CARPET_TOP_Y + 0.046875,
      maxZ: cz + 0.0625,
      tiles: 'dark_iron',
      floorY: CARPET_TOP_Y,
      hiddenFaces: { ny: true, py: true },
    });
    builder.addBox({
      minX: cx,
      minY: CARPET_TOP_Y + 0.046875,
      minZ: cz,
      maxX: cx + 0.0625,
      maxY: seatBottomY,
      maxZ: cz + 0.0625,
      tiles: 'dark_oak_planks',
      hiddenFaces: { ny: true },
    });
  }

  // 椅子靠背（外层木框架 + 内嵌软垫腰靠，紧贴角色后背零穿模）
  builder.addBox({
    minX: seatMaxX - 0.0625,
    minY: CHAIR_SEAT_TOP_Y,
    minZ: seatMinZ,
    maxX: seatMaxX,
    maxY: CHAIR_SEAT_TOP_Y + 0.5625,
    maxZ: seatMaxZ,
    tiles: {
      nx: carpetTile,
      side: 'oak_planks',
      top: 'spruce_planks',
      bottom: 'spruce_planks',
    },
  });
  // 头枕收边条
  builder.addBox({
    minX: seatMaxX - 0.0625,
    minY: CHAIR_SEAT_TOP_Y + 0.5625,
    minZ: seatMinZ + 0.0625,
    maxX: seatMaxX,
    maxY: CHAIR_SEAT_TOP_Y + 0.625,
    maxZ: seatMaxZ - 0.0625,
    tiles: 'spruce_planks',
    hiddenFaces: { ny: true },
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

/** 合批生成工位桌底、椅底与落地机箱底部的柔和接触阴影 */
function buildStationContactShadowGeometry(): THREE.BufferGeometry {
  return createBatchedContactShadowGeometry([
    // 书桌阴影
    { cx: -0.34375, cz: -0.09375, width: 1.56, depth: 1.4, y: CARPET_TOP_Y + 0.004 },
    // 座椅阴影
    { cx: CHAIR_CENTER_X, cz: CHAIR_CENTER_Z, width: 0.72, depth: 0.74, y: CARPET_TOP_Y + 0.004 },
    // 落地机箱阴影
    { cx: 0.5, cz: -0.5625, width: 0.42, depth: 0.52, y: CARPET_TOP_Y + 0.004 },
  ]);
}

export function createWorkstationPod(
  session: OfficeSessionItem,
  palette: OfficeScenePalette,
  anisotropy = 4,
  tier: VoxelQualityTier = 'high'
): OfficeStationRig {
  const shared = getSharedVoxelMaterialSet();
  const root = new THREE.Group();

  // 每工位独立 PBR 材质复用共享像素图集与贴图，使悬停仅轻柔提亮本工位
  const furnitureMaterial = new THREE.MeshStandardMaterial({
    map: shared.atlasTexture,
    roughnessMap: shared.pbrTexture,
    metalnessMap: shared.pbrTexture,
    bumpMap: tier !== 'low' ? shared.bumpTexture : null,
    bumpScale: tier === 'high' ? 0.016 : 0.01,
    roughness: 1.0,
    metalness: 1.0,
    envMapIntensity: 0.55,
    vertexColors: true,
  });

  const selectionFrameMaterial = new THREE.MeshBasicMaterial({
    color: palette.accentHex,
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
    toneMapped: false,
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

  // 1b. 桌椅与机箱落地接触阴影（合批 1 Draw Call）
  const contactShadowMesh = new THREE.Mesh(
    buildStationContactShadowGeometry(),
    shared.contactShadow
  );
  contactShadowMesh.userData.noShadow = true;
  contactShadowMesh.renderOrder = 1;
  root.add(contactShadowMesh);

  // 桌面正前方的像素工位铭牌面
  const badgeBundle = createDeskBadgeBundle(anisotropy);
  const badgeFaceMat = new THREE.MeshBasicMaterial({
    map: badgeBundle.texture,
    toneMapped: false,
  });
  const badgeFace = new THREE.Mesh(new THREE.PlaneGeometry(0.34, 0.084), badgeFaceMat);
  badgeFace.position.set(-0.375, DESK_SURFACE_Y - 0.047, 0.533);
  badgeFace.userData.sessionKey = session.sessionKey;
  badgeFace.userData.hitKind = 'station';
  badgeFace.userData.noShadow = true;
  root.add(badgeFace);

  // 2. 贴地式发光工位围框（紧贴地毯边缘 + 四角低矮体素标柱，清晰标示工位且永不遮挡屏幕）
  const selectionFrameGeo = createStationSelectionFrameGeometry(2.2, 1.64, 0.028, 0.16);
  const selectionFrameMesh = new THREE.Mesh(selectionFrameGeo, selectionFrameMaterial);
  selectionFrameMesh.position.set(-0.125, 0, 0.03125);
  selectionFrameMesh.visible = false;
  selectionFrameMesh.userData.noShadow = true;
  selectionFrameMesh.userData.sessionKey = session.sessionKey;
  selectionFrameMesh.userData.hitKind = 'station';
  root.add(selectionFrameMesh);

  // 3. Minecraft 体素 PC 主机（原生位于桌旁地面）+ 键鼠 + 咖啡杯/花盆/笔记本
  const computerRig = createDesktopComputerRig(
    palette,
    session.persona.deskAccent || palette.accentHex
  );
  tagPickableTree(computerRig.root, session.sessionKey, 'station', true);
  root.add(computerRig.root);

  // 4. Minecraft Steve 立体皮肤角色
  const character = createOfficeCharacter(session, palette);
  character.root.position.set(CHAIR_CENTER_X, 0, CHAIR_CENTER_Z);
  character.root.rotation.y = -Math.PI / 2;
  root.add(character.root);

  // 5. Minecraft 体素单显示器组件（支持双档高清 LOD）
  const monitorAssembly = createMonitorAssemblyRig(
    session.sessionKey,
    anisotropy,
    palette,
    tier
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
    contactShadowMesh,
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
  });

  return rig;
}

export function getStationMonitorScreenMesh(rig: OfficeStationRig): THREE.Mesh | null {
  return rig.monitorAssembly.monitor.screenMesh;
}

export function writeStationMonitorCenterWorld(
  rig: OfficeStationRig,
  out: THREE.Vector3
): THREE.Vector3 {
  return writeMonitorScreenCenterWorld(rig.monitorAssembly, rig.root.position, out);
}

export function setStationScreenLod(
  rig: OfficeStationRig,
  lod: MonitorScreenLod,
  tier: VoxelQualityTier,
  session: OfficeSessionItem,
  isSelected: boolean,
  palette: OfficeScenePalette,
  anisotropy: number
): boolean {
  return setMonitorScreenLod(
    rig.monitorAssembly,
    lod,
    tier,
    session,
    isSelected,
    palette,
    anisotropy
  );
}

export function syncStationQualityTier(rig: OfficeStationRig, tier: VoxelQualityTier): void {
  const shared = getSharedVoxelMaterialSet();
  const nextBump = tier !== 'low' ? shared.bumpTexture : null;
  if (rig.furnitureMaterial.bumpMap !== nextBump) {
    rig.furnitureMaterial.bumpMap = nextBump;
    rig.furnitureMaterial.bumpScale = tier === 'high' ? 0.016 : 0.01;
    rig.furnitureMaterial.needsUpdate = true;
  }
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
  const { isSelected, isHovered, preferences } = options;

  // 悬停轻柔提亮（不改变任何几何）
  if (isHovered) {
    rig.furnitureMaterial.emissive.set(palette.mode === 'dark' ? '#1e3046' : '#262418');
  } else {
    rig.furnitureMaterial.emissive.set('#000000');
  }
  rig.furnitureMaterial.envMapIntensity = palette.mode === 'dark' ? 0.5 : 0.6;

  syncDesktopComputerRig(rig.computerRig, session.availability, palette);

  syncMonitorAssemblyRig(rig.monitorAssembly, session, isSelected, palette, {
    transform: preferences.monitor,
  });

  updateDeskBadgeTexture(
    rig.badgeBundle,
    session.persona.badgeCode,
    session.persona.deskAccent || palette.accentHex,
    palette
  );

  updateOfficeCharacter(rig.character, session, palette);

  SCRATCH_FRAME_COLOR.set(palette.accentHex).lerp(FRAME_SOFTEN_BASE, isHovered ? 0.08 : 0.2);
  rig.selectionFrameMaterial.color.copy(SCRATCH_FRAME_COLOR);
  rig.selectionFrameMaterial.opacity = isHovered ? 0.94 : 0.8;
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
}
