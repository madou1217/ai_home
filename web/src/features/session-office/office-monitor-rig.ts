import * as THREE from 'three';
import type { OfficeSessionItem } from './session-office-types';
import type { OfficeScenePalette } from './office-scene-types';
import {
  DEFAULT_OFFICE_MONITOR_TRANSFORM,
  type OfficeMonitorTransform,
} from './office-computer-state';
import {
  createMonitorScreenBundle,
  resizeMonitorScreenBundle,
  updateMonitorScreenTexture,
  type CanvasTextureBundle,
  type MonitorScreenLod,
} from './office-scene-textures';
import { getSharedVoxelMaterialSet, type VoxelQualityTier } from './office-voxel-atlas';
import { VoxelBoxBuilder } from './office-voxel-builder';

/**
 * Minecraft 体素单显示器组件：
 * - 雕刻深铁凹框外壳（带背部散热格栅、VESA 铁块、顶置像素摄像头）+ 零光晕洗白的清晰高对比 LCD 面板。
 * - 支持按相机距离平滑切换 standard / closeup 双档高清纹理 LOD（最高 2048×1280，各向异性最高 16x）。
 * - 桌沿夹具、立柱与严格正交体素支臂合批为 1 个 Mesh，拖动显示器实时同步支臂与偏航角。
 * - 精准输出世界空间屏幕中心点（screenCenterTarget）与正面法线（screenForward），聚焦时正视清晰可读。
 */

export const DESK_SURFACE_Y = 0.746;

/** 显示平面尺寸（1.05 × 0.65625 ≈ 16:10，对应 1024×640 / 2048×1280） */
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

const LED_EXITED_HEX = '#475569';

export interface SingleMonitorRig {
  monitorGroup: THREE.Group;
  screenMesh: THREE.Mesh;
  screenBundle: CanvasTextureBundle;
  screenMaterial: THREE.MeshBasicMaterial;
  powerLedMaterial: THREE.MeshBasicMaterial;
  webcamLedMaterial: THREE.MeshBasicMaterial;
  screenGlowMesh: THREE.Mesh;
  screenGlowMaterial: THREE.MeshBasicMaterial;
  currentTransform: OfficeMonitorTransform;
  currentLod: MonitorScreenLod;
  currentTier: VoxelQualityTier;
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

/** 构建显示器合批体素外壳（背板、内凹前边框、后背散热棱、VESA 铁块与顶置摄像头） */
function createMonitorHousingGeometry(): THREE.BufferGeometry {
  const builder = new VoxelBoxBuilder();
  const cy = MONITOR_SCREEN_CENTER_OFFSET_Y;
  const halfW = MONITOR_HOUSING_HALF_W;
  const halfH = MONITOR_HOUSING_HALF_H;
  const rim = MONITOR_BEZEL_RIM;

  // 主背板
  builder.addBox({
    minX: -halfW,
    minY: cy - halfH,
    minZ: -0.125,
    maxX: halfW,
    maxY: cy + halfH,
    maxZ: -0.015625,
    tiles: { pz: 'screen_off', all: 'dark_iron' },
  });

  // 四边内凹前边框（立体感更强的 0.043 深度）
  builder.addBox({
    minX: -halfW,
    minY: cy + halfH - rim,
    minZ: -0.015625,
    maxX: halfW,
    maxY: cy + halfH,
    maxZ: 0.028,
    tiles: 'dark_iron',
    hiddenFaces: { nz: true },
  });
  builder.addBox({
    minX: -halfW,
    minY: cy - halfH,
    minZ: -0.015625,
    maxX: halfW,
    maxY: cy - halfH + rim,
    maxZ: 0.028,
    tiles: 'dark_iron',
    hiddenFaces: { nz: true },
  });
  builder.addBox({
    minX: -halfW,
    minY: cy - halfH + rim,
    minZ: -0.015625,
    maxX: -halfW + rim,
    maxY: cy + halfH - rim,
    maxZ: 0.028,
    tiles: 'dark_iron',
    hiddenFaces: { nz: true, py: true, ny: true },
  });
  builder.addBox({
    minX: halfW - rim,
    minY: cy - halfH + rim,
    minZ: -0.015625,
    maxX: halfW,
    maxY: cy + halfH - rim,
    maxZ: 0.028,
    tiles: 'dark_iron',
    hiddenFaces: { nz: true, py: true, ny: true },
  });

  // 下巴细金属品牌条
  builder.addBox({
    minX: -0.125,
    minY: cy - halfH + 0.018,
    minZ: 0.028,
    maxX: 0.125,
    maxY: cy - halfH + 0.044,
    maxZ: 0.036,
    tiles: 'iron_block',
    occludes: false,
    hiddenFaces: { nz: true },
  });

  // 后背电子模块凸包（含通风网孔纹理）
  builder.addBox({
    minX: -0.28125,
    minY: cy - 0.1875,
    minZ: -0.203125,
    maxX: 0.28125,
    maxY: cy + 0.1875,
    maxZ: -0.125,
    tiles: { py: 'pc_mesh', nz: 'dark_iron', all: 'dark_iron' },
    hiddenFaces: { pz: true },
  });

  // VESA 金属快装座
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

  // 顶部居中方块摄像头 + 镜头框
  builder.addBox({
    minX: -0.09375,
    minY: cy + halfH,
    minZ: -0.0625,
    maxX: 0.09375,
    maxY: cy + halfH + 0.078125,
    maxZ: 0.028,
    tiles: 'dark_iron',
    hiddenFaces: { ny: true },
  });
  builder.addBox({
    minX: -0.0234375,
    minY: cy + halfH + 0.015625,
    minZ: 0.028,
    maxX: 0.0234375,
    maxY: cy + halfH + 0.0625,
    maxZ: 0.048,
    tiles: { pz: 'screen_off', all: 'iron_block' },
    occludes: false,
    hiddenFaces: { nz: true },
  });

  return builder.build(true);
}

/** 桌沿夹具、立柱与严格正交体素支臂合批为单一 BufferGeometry */
function buildMergedArmStructureGeometry(transform: OfficeMonitorTransform): THREE.BufferGeometry {
  const builder = new VoxelBoxBuilder();

  // 桌沿重型夹具与下锁扣
  builder.addBox({
    minX: ARM_HUB_X - 0.109375,
    minY: DESK_SURFACE_Y,
    minZ: ARM_HUB_Z - 0.09375,
    maxX: ARM_HUB_X + 0.109375,
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
  // 立柱 + 顶帽 + 理线环
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
  builder.addCenteredBox(ARM_HUB_X, DESK_SURFACE_Y + 0.24, ARM_HUB_Z - 0.055, 0.08, 0.045, 0.04, 'iron_block', {
    occludes: false,
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
  palette: OfficeScenePalette,
  tier: VoxelQualityTier
): SingleMonitorRig {
  const sharedMaterials = getSharedVoxelMaterialSet();
  const screenBundle = createMonitorScreenBundle(anisotropy, 'standard', tier);

  // 采用 MeshBasicMaterial + toneMapped: false 确保屏幕文字 1:1 sRGB 还原、零强光洗白与阴影噪点
  const screenMaterial = new THREE.MeshBasicMaterial({
    map: screenBundle.texture,
    color: '#ffffff',
    toneMapped: false,
  });

  const powerLedMaterial = new THREE.MeshBasicMaterial({
    color: palette.successHex,
    toneMapped: false,
  });
  const webcamLedMaterial = new THREE.MeshBasicMaterial({
    color: palette.accentHex,
    toneMapped: false,
  });
  const screenGlowMaterial = new THREE.MeshBasicMaterial({
    color: '#56ecff',
    transparent: true,
    opacity: palette.mode === 'dark' ? 0.08 : 0.0,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

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

  // 夜间投射到显示器正下方桌面的微弱屏幕余辉（零额外光源开销）
  const screenGlowMesh = new THREE.Mesh(new THREE.PlaneGeometry(0.92, 0.34), screenGlowMaterial);
  screenGlowMesh.rotation.x = -Math.PI / 2;
  screenGlowMesh.position.set(0, 0.012, 0.22);
  screenGlowMesh.userData.noShadow = true;
  screenGlowMesh.visible = palette.mode === 'dark';
  monitorGroup.add(screenGlowMesh);

  // 右下角电源指示灯
  const powerLedMesh = new THREE.Mesh(
    new THREE.BoxGeometry(0.056, 0.024, 0.016),
    powerLedMaterial
  );
  powerLedMesh.position.set(
    MONITOR_HOUSING_HALF_W - 0.140625,
    MONITOR_SCREEN_CENTER_OFFSET_Y - MONITOR_HOUSING_HALF_H + MONITOR_BEZEL_RIM * 0.5,
    0.032
  );
  powerLedMesh.userData.noShadow = true;
  monitorGroup.add(powerLedMesh);

  // 顶置摄像头旁微型青色工作指示像素
  const webcamLedMesh = new THREE.Mesh(
    new THREE.BoxGeometry(0.018, 0.018, 0.014),
    webcamLedMaterial
  );
  webcamLedMesh.position.set(
    0.052,
    MONITOR_SCREEN_CENTER_OFFSET_Y + MONITOR_HOUSING_HALF_H + 0.039,
    0.032
  );
  webcamLedMesh.userData.noShadow = true;
  monitorGroup.add(webcamLedMesh);

  tagMonitorTree(monitorGroup, sessionKey);

  return {
    monitorGroup,
    screenMesh,
    screenBundle,
    screenMaterial,
    powerLedMaterial,
    webcamLedMaterial,
    screenGlowMesh,
    screenGlowMaterial,
    currentTransform: { ...DEFAULT_OFFICE_MONITOR_TRANSFORM },
    currentLod: 'standard',
    currentTier: tier,
  };
}

export function createMonitorAssemblyRig(
  sessionKey: string,
  anisotropy: number,
  palette: OfficeScenePalette,
  tier: VoxelQualityTier = 'high'
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

  const monitor = buildSingleMonitorUnit(sessionKey, anisotropy, palette, tier);
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

/** 零分配填充显示器屏幕中心世界坐标（供每帧距离 LOD 判断） */
export function writeMonitorScreenCenterWorld(
  rig: MonitorAssemblyRig,
  stationWorldPos: THREE.Vector3,
  out: THREE.Vector3
): THREE.Vector3 {
  const t = rig.monitor.currentTransform;
  return out.set(
    stationWorldPos.x + t.x,
    stationWorldPos.y + DESK_SURFACE_Y + t.y + MONITOR_SCREEN_CENTER_OFFSET_Y,
    stationWorldPos.z + t.z
  );
}

/** 计算显示器在世界空间中的屏幕中心点、上沿锚点与正面法线（供 focusStation 正视对准） */
export function computeMonitorFocusAnchor(
  rig: MonitorAssemblyRig,
  stationWorldPos: THREE.Vector3
): {
  screenCenterTarget: THREE.Vector3;
  screenTopTarget: THREE.Vector3;
  screenForward: THREE.Vector3;
} {
  const t = rig.monitor.currentTransform;
  const centerY = DESK_SURFACE_Y + t.y + MONITOR_SCREEN_CENTER_OFFSET_Y;
  const topY = centerY + MONITOR_SCREEN_HEIGHT * 0.5;
  const wx = stationWorldPos.x + t.x;
  const wz = stationWorldPos.z + t.z;
  return {
    screenCenterTarget: new THREE.Vector3(wx, stationWorldPos.y + centerY, wz),
    screenTopTarget: new THREE.Vector3(wx, stationWorldPos.y + topY, wz),
    screenForward: new THREE.Vector3(Math.sin(t.yaw), 0, Math.cos(t.yaw)).normalize(),
  };
}

/** 动态切换显示器画布清晰度 LOD（近距升级 2048×1280，远距回落省显存） */
export function setMonitorScreenLod(
  rig: MonitorAssemblyRig,
  lod: MonitorScreenLod,
  tier: VoxelQualityTier,
  session: OfficeSessionItem,
  isSelected: boolean,
  palette: OfficeScenePalette,
  anisotropy: number
): boolean {
  const unit = rig.monitor;
  if (unit.currentLod === lod && unit.currentTier === tier) {
    return false;
  }
  unit.currentLod = lod;
  unit.currentTier = tier;
  const resized = resizeMonitorScreenBundle(unit.screenBundle, lod, tier, anisotropy);
  if (resized) {
    updateMonitorScreenTexture(unit.screenBundle, session, isSelected, palette, lod);
    return true;
  }
  return false;
}

export function syncMonitorAssemblyRig(
  rig: MonitorAssemblyRig,
  session: OfficeSessionItem,
  isSelected: boolean,
  palette: OfficeScenePalette,
  options: {
    transform: OfficeMonitorTransform;
  }
): void {
  applyMonitorTransform(rig, options.transform);
  const unit = rig.monitor;
  const isDark = palette.mode === 'dark';

  updateMonitorScreenTexture(unit.screenBundle, session, isSelected, palette, unit.currentLod);

  if (session.availability === 'exited') {
    unit.screenMaterial.color.set('#a8b8cc');
    unit.powerLedMaterial.color.set(LED_EXITED_HEX);
    unit.webcamLedMaterial.color.set('#334155');
    unit.screenGlowMesh.visible = false;
  } else if (session.availability === 'unavailable') {
    unit.screenMaterial.color.set('#f0e5d2');
    unit.powerLedMaterial.color.set(palette.warningHex);
    unit.webcamLedMaterial.color.set(palette.warningHex);
    unit.screenGlowMesh.visible = isDark;
    unit.screenGlowMaterial.color.set(palette.warningHex);
    unit.screenGlowMaterial.opacity = 0.05;
  } else {
    unit.screenMaterial.color.set('#ffffff');
    const accent = session.availability === 'interactive' ? palette.successHex : palette.accentHex;
    unit.powerLedMaterial.color.set(accent);
    unit.webcamLedMaterial.color.set(isSelected ? '#56ecff' : accent);
    unit.screenGlowMesh.visible = isDark;
    unit.screenGlowMaterial.color.set(isSelected ? '#56ecff' : accent);
    unit.screenGlowMaterial.opacity = isSelected ? 0.11 : 0.07;
  }
}
