import * as THREE from 'three';
import type { OfficeSessionItem } from './session-office-types';
import type { OfficeScenePalette } from './office-scene-types';
import {
  DEFAULT_OFFICE_MONITOR_TRANSFORM,
  type OfficeComputerPowerState,
  type OfficeMonitorTransform,
} from './office-computer-state';
import {
  createMonitorScreenBundle,
  updateMonitorScreenTexture,
  type CanvasTextureBundle,
} from './office-scene-textures';
import { getSharedVoxelMaterialSet } from './office-voxel-atlas';
import { VoxelBoxBuilder } from './office-voxel-builder';

/**
 * Minecraft 体素单显示器组件：
 * - 厚实深灰方块边框外壳 + 实时 2D Canvas 像素风屏幕（NearestFilter）。
 * - 桌沿方块夹具、方形立柱与正交体素支臂合批为 1 个 Mesh。
 * - 每工位独立 transform；yaw 由 3D 场景中按住显示器拖动直接修改。
 */

export const DESK_SURFACE_Y = 0.746;

/** 显示平面尺寸（1.05 × 0.65625 ≈ 16:10，对应 1024×640） */
export const MONITOR_SCREEN_WIDTH = 1.05;
export const MONITOR_SCREEN_HEIGHT = 0.65625;
export const MONITOR_SCREEN_CENTER_OFFSET_Y = 0.53125;

const MONITOR_BEZEL_RIM = 0.0625;
const MONITOR_HOUSING_HALF_W = MONITOR_SCREEN_WIDTH * 0.5 + MONITOR_BEZEL_RIM;
const MONITOR_HOUSING_HALF_H = MONITOR_SCREEN_HEIGHT * 0.5 + MONITOR_BEZEL_RIM;

const ARM_HUB_X = -0.46;
const ARM_HUB_Z = -0.58;

const MAST_TOP_Y = 0.84375;
const COLLAR_MIN_LOCAL_Y = 0.125;
const COLLAR_MAX_LOCAL_Y = 0.8125;

const VESA_BACK_OFFSET_Z = -0.203125;
const ARM_SEGMENT_EPS = 0.01;

const LED_STANDBY_HEX = '#8a5a10';
const LED_EXITED_HEX = '#475569';

export interface SingleMonitorRig {
  monitorGroup: THREE.Group;
  screenMesh: THREE.Mesh;
  screenBundle: CanvasTextureBundle;
  screenMaterial: THREE.MeshLambertMaterial;
  powerLedMaterial: THREE.MeshBasicMaterial;
  currentTransform: OfficeMonitorTransform;
}

export interface MonitorAssemblyRig {
  root: THREE.Group;
  mountBaseGroup: THREE.Group;
  armStructureMesh: THREE.Mesh;
  monitor: SingleMonitorRig;
  lastArmSignature: string;
}

function tagMonitorTree(object: THREE.Object3D, sessionKey: string): void {
  object.traverse((child) => {
    child.userData.sessionKey = sessionKey;
    child.userData.hitKind = 'monitor';
    if (child instanceof THREE.Mesh && !child.userData.noShadow) {
      child.castShadow = true;
      child.receiveShadow = true;
    }
  });
}

function tagStationTree(object: THREE.Object3D, sessionKey: string): void {
  object.traverse((child) => {
    child.userData.sessionKey = sessionKey;
    child.userData.hitKind = 'station';
    if (child instanceof THREE.Mesh && !child.userData.noShadow) {
      child.castShadow = true;
      child.receiveShadow = true;
    }
  });
}

/** 构建显示器合批体素外壳（背板、4 条内凹前边框、后背凸包、VESA 铁块及摄像头）。 */
function createMonitorHousingGeometry(): THREE.BufferGeometry {
  const builder = new VoxelBoxBuilder();
  const cy = MONITOR_SCREEN_CENTER_OFFSET_Y;
  const halfW = MONITOR_HOUSING_HALF_W;
  const halfH = MONITOR_HOUSING_HALF_H;
  const rim = MONITOR_BEZEL_RIM;

  builder.addBox({
    minX: -halfW,
    minY: cy - halfH,
    minZ: -0.125,
    maxX: halfW,
    maxY: cy + halfH,
    maxZ: -0.015625,
    tiles: { pz: 'screen_off', all: 'dark_iron' },
  });

  builder.addBox({
    minX: -halfW,
    minY: cy + halfH - rim,
    minZ: -0.015625,
    maxX: halfW,
    maxY: cy + halfH,
    maxZ: 0.0234375,
    tiles: 'dark_iron',
    hiddenFaces: { nz: true },
  });
  builder.addBox({
    minX: -halfW,
    minY: cy - halfH,
    minZ: -0.015625,
    maxX: halfW,
    maxY: cy - halfH + rim,
    maxZ: 0.0234375,
    tiles: 'dark_iron',
    hiddenFaces: { nz: true },
  });
  builder.addBox({
    minX: -halfW,
    minY: cy - halfH + rim,
    minZ: -0.015625,
    maxX: -halfW + rim,
    maxY: cy + halfH - rim,
    maxZ: 0.0234375,
    tiles: 'dark_iron',
    hiddenFaces: { nz: true, py: true, ny: true },
  });
  builder.addBox({
    minX: halfW - rim,
    minY: cy - halfH + rim,
    minZ: -0.015625,
    maxX: halfW,
    maxY: cy + halfH - rim,
    maxZ: 0.0234375,
    tiles: 'dark_iron',
    hiddenFaces: { nz: true, py: true, ny: true },
  });

  builder.addBox({
    minX: -0.234375,
    minY: cy - 0.171875,
    minZ: -0.203125,
    maxX: 0.234375,
    maxY: cy + 0.171875,
    maxZ: -0.125,
    tiles: 'dark_iron',
    hiddenFaces: { pz: true },
  });

  builder.addBox({
    minX: -0.09375,
    minY: cy - 0.09375,
    minZ: -0.25,
    maxX: 0.09375,
    maxY: cy + 0.09375,
    maxZ: -0.203125,
    tiles: 'iron_block',
    hiddenFaces: { pz: true },
  });

  // 顶部居中方块摄像头砖块
  builder.addBox({
    minX: -0.078125,
    minY: cy + halfH,
    minZ: -0.0625,
    maxX: 0.078125,
    maxY: cy + halfH + 0.078125,
    maxZ: 0.0234375,
    tiles: 'dark_iron',
    hiddenFaces: { ny: true },
  });
  builder.addBox({
    minX: -0.0234375,
    minY: cy + halfH + 0.015625,
    minZ: 0.0234375,
    maxX: 0.0234375,
    maxY: cy + halfH + 0.0625,
    maxZ: 0.046875,
    tiles: { pz: 'screen_off', all: 'iron_block' },
    occludes: false,
    hiddenFaces: { nz: true },
  });

  return builder.build(true);
}

/** 桌沿夹具、立柱与严格 0° 轴对齐曼哈顿支臂合批为单一 BufferGeometry。 */
function buildMergedArmStructureGeometry(transform: OfficeMonitorTransform): THREE.BufferGeometry {
  const builder = new VoxelBoxBuilder();

  builder.addBox({
    minX: ARM_HUB_X - 0.09375,
    minY: DESK_SURFACE_Y,
    minZ: ARM_HUB_Z - 0.09375,
    maxX: ARM_HUB_X + 0.09375,
    maxY: DESK_SURFACE_Y + 0.046875,
    maxZ: ARM_HUB_Z + 0.09375,
    tiles: 'iron_block',
    floorY: DESK_SURFACE_Y,
  });
  builder.addBox({
    minX: ARM_HUB_X - 0.0625,
    minY: DESK_SURFACE_Y - 0.109375,
    minZ: ARM_HUB_Z - 0.09375,
    maxX: ARM_HUB_X + 0.0625,
    maxY: DESK_SURFACE_Y,
    maxZ: ARM_HUB_Z - 0.046875,
    tiles: 'dark_iron',
    hiddenFaces: { py: true },
  });
  builder.addBox({
    minX: ARM_HUB_X - 0.0625,
    minY: DESK_SURFACE_Y - 0.109375,
    minZ: ARM_HUB_Z - 0.046875,
    maxX: ARM_HUB_X + 0.0625,
    maxY: DESK_SURFACE_Y - 0.0625,
    maxZ: ARM_HUB_Z + 0.046875,
    tiles: 'iron_block',
    hiddenFaces: { nz: true },
  });
  builder.addBox({
    minX: ARM_HUB_X - 0.046875,
    minY: DESK_SURFACE_Y + 0.046875,
    minZ: ARM_HUB_Z - 0.046875,
    maxX: ARM_HUB_X + 0.046875,
    maxY: DESK_SURFACE_Y + MAST_TOP_Y,
    maxZ: ARM_HUB_Z + 0.046875,
    tiles: 'dark_iron',
    hiddenFaces: { ny: true, py: true },
  });
  builder.addBox({
    minX: ARM_HUB_X - 0.0625,
    minY: DESK_SURFACE_Y + MAST_TOP_Y,
    minZ: ARM_HUB_Z - 0.0625,
    maxX: ARM_HUB_X + 0.0625,
    maxY: DESK_SURFACE_Y + MAST_TOP_Y + 0.046875,
    maxZ: ARM_HUB_Z + 0.0625,
    tiles: 'iron_block',
  });

  const worldMonitorY = DESK_SURFACE_Y + transform.y;
  const sinY = Math.sin(transform.yaw);
  const cosY = Math.cos(transform.yaw);
  const vesaX = transform.x + sinY * VESA_BACK_OFFSET_Z;
  const vesaZ = transform.z + cosY * VESA_BACK_OFFSET_Z;
  const vesaY = worldMonitorY + MONITOR_SCREEN_CENTER_OFFSET_Y;

  const collarY = Math.max(
    DESK_SURFACE_Y + COLLAR_MIN_LOCAL_Y,
    Math.min(DESK_SURFACE_Y + COLLAR_MAX_LOCAL_Y, vesaY)
  );
  builder.addCenteredBox(ARM_HUB_X, collarY, ARM_HUB_Z, 0.140625, 0.125, 0.140625, 'iron_block');

  const spanX = Math.abs(vesaX - ARM_HUB_X);
  const spanZ = Math.abs(vesaZ - ARM_HUB_Z);
  const showArmX = spanX >= ARM_SEGMENT_EPS;
  const showArmZ = spanZ >= ARM_SEGMENT_EPS;
  const midX = (ARM_HUB_X + vesaX) * 0.5;
  const midZ = (ARM_HUB_Z + vesaZ) * 0.5;
  const armBarThickness = 0.0875;
  const elbowSize = 0.125;

  const elbowALocalZ = (vesaX - transform.x) * sinY + (ARM_HUB_Z - transform.z) * cosY;
  const elbowBLocalZ = (ARM_HUB_X - transform.x) * sinY + (vesaZ - transform.z) * cosY;
  const useXFirst = elbowALocalZ <= elbowBLocalZ;

  if (useXFirst) {
    if (showArmX) {
      builder.addCenteredBox(midX, collarY, ARM_HUB_Z, spanX, armBarThickness, armBarThickness, 'dark_iron');
    }
    if (showArmX && showArmZ) {
      builder.addCenteredBox(vesaX, collarY, ARM_HUB_Z, elbowSize, elbowSize, elbowSize, 'iron_block');
    }
    if (showArmZ) {
      builder.addCenteredBox(vesaX, collarY, midZ, armBarThickness, armBarThickness, spanZ, 'dark_iron');
    }
  } else {
    if (showArmZ) {
      builder.addCenteredBox(ARM_HUB_X, collarY, midZ, armBarThickness, armBarThickness, spanZ, 'dark_iron');
    }
    if (showArmX && showArmZ) {
      builder.addCenteredBox(ARM_HUB_X, collarY, vesaZ, elbowSize, elbowSize, elbowSize, 'iron_block');
    }
    if (showArmX) {
      builder.addCenteredBox(midX, collarY, vesaZ, spanX, armBarThickness, armBarThickness, 'dark_iron');
    }
  }

  const dropY = Math.abs(vesaY - collarY);
  if (dropY >= ARM_SEGMENT_EPS) {
    builder.addCenteredBox(vesaX, (collarY + vesaY) * 0.5, vesaZ, armBarThickness, dropY, armBarThickness, 'dark_iron');
  }

  return builder.build(false);
}

function buildArmSignature(transform: OfficeMonitorTransform): string {
  return `${transform.x.toFixed(3)},${transform.y.toFixed(3)},${transform.z.toFixed(3)},${transform.yaw.toFixed(3)}`;
}

function buildSingleMonitorUnit(
  sessionKey: string,
  anisotropy: number,
  palette: OfficeScenePalette
): SingleMonitorRig {
  const sharedMaterials = getSharedVoxelMaterialSet();
  const screenBundle = createMonitorScreenBundle(anisotropy);
  const screenMaterial = new THREE.MeshLambertMaterial({
    map: screenBundle.texture,
    emissive: new THREE.Color('#ffffff'),
    emissiveMap: screenBundle.texture,
    emissiveIntensity: palette.mode === 'dark' ? 1.15 : 0.96,
  });

  const powerLedMaterial = new THREE.MeshBasicMaterial({ color: palette.successHex });
  const monitorGroup = new THREE.Group();

  const housingMesh = new THREE.Mesh(createMonitorHousingGeometry(), sharedMaterials.opaque);
  monitorGroup.add(housingMesh);

  const screenMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(MONITOR_SCREEN_WIDTH, MONITOR_SCREEN_HEIGHT),
    screenMaterial
  );
  screenMesh.position.set(0, MONITOR_SCREEN_CENTER_OFFSET_Y, -0.008);
  screenMesh.userData.noShadow = true;
  monitorGroup.add(screenMesh);

  const powerLedMesh = new THREE.Mesh(
    new THREE.BoxGeometry(0.0625, 0.03125, 0.018),
    powerLedMaterial
  );
  powerLedMesh.position.set(
    MONITOR_HOUSING_HALF_W - 0.140625,
    MONITOR_SCREEN_CENTER_OFFSET_Y - MONITOR_HOUSING_HALF_H + MONITOR_BEZEL_RIM * 0.5,
    0.028
  );
  powerLedMesh.userData.noShadow = true;
  monitorGroup.add(powerLedMesh);

  tagMonitorTree(monitorGroup, sessionKey);

  return {
    monitorGroup,
    screenMesh,
    screenBundle,
    screenMaterial,
    powerLedMaterial,
    currentTransform: { ...DEFAULT_OFFICE_MONITOR_TRANSFORM },
  };
}

export function createMonitorAssemblyRig(
  sessionKey: string,
  anisotropy: number,
  palette: OfficeScenePalette
): MonitorAssemblyRig {
  const root = new THREE.Group();
  const sharedMaterials = getSharedVoxelMaterialSet();

  const mountBaseGroup = new THREE.Group();
  const armStructureMesh = new THREE.Mesh(
    buildMergedArmStructureGeometry(DEFAULT_OFFICE_MONITOR_TRANSFORM),
    sharedMaterials.opaque
  );
  mountBaseGroup.add(armStructureMesh);
  tagStationTree(mountBaseGroup, sessionKey);
  root.add(mountBaseGroup);

  const monitor = buildSingleMonitorUnit(sessionKey, anisotropy, palette);
  root.add(monitor.monitorGroup);

  const rig: MonitorAssemblyRig = {
    root,
    mountBaseGroup,
    armStructureMesh,
    monitor,
    lastArmSignature: buildArmSignature(DEFAULT_OFFICE_MONITOR_TRANSFORM),
  };

  applyMonitorTransform(rig, DEFAULT_OFFICE_MONITOR_TRANSFORM);
  return rig;
}

export function applyMonitorTransform(rig: MonitorAssemblyRig, transform: OfficeMonitorTransform): void {
  rig.monitor.currentTransform = { ...transform };
  rig.monitor.monitorGroup.position.set(transform.x, DESK_SURFACE_Y + transform.y, transform.z);
  rig.monitor.monitorGroup.rotation.set(0, transform.yaw, 0);

  const sig = buildArmSignature(transform);
  if (sig !== rig.lastArmSignature) {
    rig.lastArmSignature = sig;
    rig.armStructureMesh.geometry.dispose();
    rig.armStructureMesh.geometry = buildMergedArmStructureGeometry(transform);
  }
}

/** 计算显示器在世界空间中的屏幕上沿目标点与正面朝向法线（供 focusStation 精准对准）。 */
export function computeMonitorFocusAnchor(
  rig: MonitorAssemblyRig,
  stationWorldPos: THREE.Vector3
): { screenTopTarget: THREE.Vector3; screenForward: THREE.Vector3 } {
  const t = rig.monitor.currentTransform;
  const centerY = DESK_SURFACE_Y + t.y + MONITOR_SCREEN_CENTER_OFFSET_Y;
  const topY = centerY + MONITOR_SCREEN_HEIGHT * 0.5;
  return {
    screenTopTarget: new THREE.Vector3(
      stationWorldPos.x + t.x,
      stationWorldPos.y + topY,
      stationWorldPos.z + t.z
    ),
    screenForward: new THREE.Vector3(Math.sin(t.yaw), 0, Math.cos(t.yaw)).normalize(),
  };
}

export function syncMonitorAssemblyRig(
  rig: MonitorAssemblyRig,
  session: OfficeSessionItem,
  isSelected: boolean,
  palette: OfficeScenePalette,
  options: {
    power: OfficeComputerPowerState;
    transform: OfficeMonitorTransform;
  }
): void {
  applyMonitorTransform(rig, options.transform);
  const unit = rig.monitor;
  const isDark = palette.mode === 'dark';

  updateMonitorScreenTexture(unit.screenBundle, session, isSelected, palette, {
    power: options.power,
  });

  if (options.power === 'off') {
    unit.screenMaterial.emissiveIntensity = isDark ? 0.12 : 0.1;
    unit.powerLedMaterial.color.set(LED_STANDBY_HEX);
    return;
  }

  if (session.availability === 'exited') {
    unit.screenMaterial.emissiveIntensity = isDark ? 1.0 : 0.68;
    unit.powerLedMaterial.color.set(LED_EXITED_HEX);
  } else if (session.availability === 'unavailable') {
    unit.screenMaterial.emissiveIntensity = isDark ? 1.05 : 0.84;
    unit.powerLedMaterial.color.set(palette.warningHex);
  } else {
    unit.screenMaterial.emissiveIntensity = isDark
      ? (isSelected ? 1.25 : 1.12)
      : (isSelected ? 1.08 : 0.96);
    unit.powerLedMaterial.color.set(
      session.availability === 'interactive' ? palette.successHex : palette.accentHex
    );
  }
}