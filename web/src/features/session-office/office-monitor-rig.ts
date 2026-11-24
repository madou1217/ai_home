import * as THREE from 'three';
import type { OfficeSessionItem } from './session-office-types';
import type { OfficeMonitorIndex, OfficeScenePalette } from './office-scene-types';
import {
  DEFAULT_OFFICE_MONITOR_TRANSFORMS,
  type OfficeComputerPowerState,
  type OfficeMonitorTransform,
  type OfficeWallpaperId,
} from './office-computer-state';
import {
  createMonitorScreenBundle,
  updateMonitorScreenTexture,
  type CanvasTextureBundle,
} from './office-scene-textures';
import { getSharedVoxelMaterialSet } from './office-voxel-atlas';
import { VoxelBoxBuilder } from './office-voxel-builder';
import { createWireframeBoxGeometry } from './office-voxel-kit';

/**
 * Minecraft 体素单/双显示器组件：
 * - 厚实深灰方块边框外壳 + 实时 2D Canvas 像素风屏幕（NearestFilter，保持壁纸光栅化语义）。
 * - 桌沿方块夹具、方形立柱与双臂正交（曼哈顿折线，0° 轴对齐）体素支架合批为 1 个 Mesh，
 *   显著压低全场景 Draw Call（单屏 4 Draw Calls，双屏 7 Draw Calls）。
 * - 显示器本体允许任意 yaw 偏航角编辑（视觉规格 §1.1 明确豁免的交互需求）。
 */

export const DESK_SURFACE_Y = 0.746;

const MONITOR_SCREEN_CENTER_OFFSET_Y = 0.34;
const ARM_HUB_X = -0.46;
const ARM_HUB_Z = -0.42;

/** 垂直立柱夹持范围（相对 DESK_SURFACE_Y），覆盖全部 y ∈ [-0.06, 0.24] + 0.34 = [0.28, 0.58] */
const MAST_TOP_Y = 0.625;
const COLLAR_MIN_LOCAL_Y = 0.09375;
const COLLAR_MAX_LOCAL_Y = 0.59375;

/** VESA 接驳锚点位于后背凸包与铁块 VESA 座交界处 */
const VESA_BACK_OFFSET_Z = -0.15625;
const ARM_SEGMENT_EPS = 0.01;
const COLLAR_DEDUP_EPS = 0.002;

const LED_STANDBY_HEX = '#8a5a10';
const LED_EXITED_HEX = '#475569';

export interface SingleMonitorRig {
  index: OfficeMonitorIndex;
  monitorGroup: THREE.Group;
  screenMesh: THREE.Mesh;
  screenBundle: CanvasTextureBundle;
  screenMaterial: THREE.MeshLambertMaterial;
  powerLedMaterial: THREE.MeshBasicMaterial;
  editFrameMesh: THREE.Mesh;
  editFrameMaterial: THREE.MeshBasicMaterial;
  armGroup: THREE.Group;
  currentTransform: OfficeMonitorTransform;
}

export interface DualMonitorAssemblyRig {
  root: THREE.Group;
  mountBaseGroup: THREE.Group;
  armStructureMesh: THREE.Mesh;
  monitors: [SingleMonitorRig, SingleMonitorRig];
  dualMonitor: boolean;
  lastArmSignature: string;
}

function tagMonitorTree(
  object: THREE.Object3D,
  sessionKey: string,
  monitorIndex: OfficeMonitorIndex
): void {
  object.traverse((child) => {
    child.userData.sessionKey = sessionKey;
    child.userData.hitKind = 'monitor';
    child.userData.monitorIndex = monitorIndex;
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

/** 构建单个显示器的合批体素外壳（背板、4 条内凹前边框、后背凸包、VESA 铁块及主屏方块摄像头） */
function createMonitorHousingGeometry(index: OfficeMonitorIndex): THREE.BufferGeometry {
  const builder = new VoxelBoxBuilder();
  const cy = MONITOR_SCREEN_CENTER_OFFSET_Y;
  const halfW = 0.34375; // 总宽 0.6875
  const halfH = 0.234375; // 总高 0.46875
  const rim = 0.046875;

  // 主背板：0.6875 × 0.46875 × 0.078125（z ∈ [-0.09375, -0.015625]）
  builder.addBox({
    minX: -halfW,
    minY: cy - halfH,
    minZ: -0.09375,
    maxX: halfW,
    maxY: cy + halfH,
    maxZ: -0.015625,
    tiles: { pz: 'screen_off', all: 'dark_iron' },
  });

  // 上/下/左/右 4 条内凹前边框（延伸至 z = +0.015625，形成厚实像素显示框）
  builder.addBox({
    minX: -halfW,
    minY: cy + halfH - rim,
    minZ: -0.015625,
    maxX: halfW,
    maxY: cy + halfH,
    maxZ: 0.015625,
    tiles: 'dark_iron',
    hiddenFaces: { nz: true },
  });
  builder.addBox({
    minX: -halfW,
    minY: cy - halfH,
    minZ: -0.015625,
    maxX: halfW,
    maxY: cy - halfH + rim,
    maxZ: 0.015625,
    tiles: 'dark_iron',
    hiddenFaces: { nz: true },
  });
  builder.addBox({
    minX: -halfW,
    minY: cy - halfH + rim,
    minZ: -0.015625,
    maxX: -halfW + rim,
    maxY: cy + halfH - rim,
    maxZ: 0.015625,
    tiles: 'dark_iron',
    hiddenFaces: { nz: true, py: true, ny: true },
  });
  builder.addBox({
    minX: halfW - rim,
    minY: cy - halfH + rim,
    minZ: -0.015625,
    maxX: halfW,
    maxY: cy + halfH - rim,
    maxZ: 0.015625,
    tiles: 'dark_iron',
    hiddenFaces: { nz: true, py: true, ny: true },
  });

  // 后背电子凸包：0.3125 × 0.25 × 0.0625（z ∈ [-0.15625, -0.09375]）
  builder.addBox({
    minX: -0.15625,
    minY: cy - 0.125,
    minZ: -0.15625,
    maxX: 0.15625,
    maxY: cy + 0.125,
    maxZ: -0.09375,
    tiles: 'dark_iron',
    hiddenFaces: { pz: true },
  });

  // 铁块 VESA 安装座：0.125 × 0.125 × 0.03125
  builder.addBox({
    minX: -0.0625,
    minY: cy - 0.0625,
    minZ: -0.1875,
    maxX: 0.0625,
    maxY: cy + 0.0625,
    maxZ: -0.15625,
    tiles: 'iron_block',
    hiddenFaces: { pz: true },
  });

  // 主屏顶部居中方块摄像头砖块
  if (index === 0) {
    builder.addBox({
      minX: -0.0625,
      minY: cy + halfH,
      minZ: -0.046875,
      maxX: 0.0625,
      maxY: cy + halfH + 0.0625,
      maxZ: 0.015625,
      tiles: 'dark_iron',
      hiddenFaces: { ny: true },
    });
    builder.addBox({
      minX: -0.015625,
      minY: cy + halfH + 0.015625,
      minZ: 0.015625,
      maxX: 0.015625,
      maxY: cy + halfH + 0.046875,
      maxZ: 0.03125,
      tiles: { pz: 'screen_off', all: 'iron_block' },
      occludes: false,
      hiddenFaces: { nz: true },
    });
  }

  return builder.build(true);
}

/** 将桌沿夹具、立柱与全部激活显示器的严格 0° 轴对齐曼哈顿支臂合批为单一 BufferGeometry */
function buildMergedArmStructureGeometry(
  transforms: readonly [OfficeMonitorTransform, OfficeMonitorTransform],
  dualMonitor: boolean
): THREE.BufferGeometry {
  const builder = new VoxelBoxBuilder();

  // 1. 桌沿 C 型方块夹具与方形立柱（位于 (ARM_HUB_X, DESK_SURFACE_Y, ARM_HUB_Z)）
  builder.addBox({
    minX: ARM_HUB_X - 0.0625,
    minY: DESK_SURFACE_Y,
    minZ: ARM_HUB_Z - 0.0625,
    maxX: ARM_HUB_X + 0.0625,
    maxY: DESK_SURFACE_Y + 0.03125,
    maxZ: ARM_HUB_Z + 0.0625,
    tiles: 'iron_block',
    floorY: DESK_SURFACE_Y,
  });
  builder.addBox({
    minX: ARM_HUB_X - 0.046875,
    minY: DESK_SURFACE_Y - 0.09375,
    minZ: ARM_HUB_Z - 0.0625,
    maxX: ARM_HUB_X + 0.046875,
    maxY: DESK_SURFACE_Y,
    maxZ: ARM_HUB_Z - 0.03125,
    tiles: 'dark_iron',
    hiddenFaces: { py: true },
  });
  builder.addBox({
    minX: ARM_HUB_X - 0.046875,
    minY: DESK_SURFACE_Y - 0.09375,
    minZ: ARM_HUB_Z - 0.03125,
    maxX: ARM_HUB_X + 0.046875,
    maxY: DESK_SURFACE_Y - 0.0625,
    maxZ: ARM_HUB_Z + 0.03125,
    tiles: 'iron_block',
    hiddenFaces: { nz: true },
  });
  builder.addBox({
    minX: ARM_HUB_X - 0.03125,
    minY: DESK_SURFACE_Y + 0.03125,
    minZ: ARM_HUB_Z - 0.03125,
    maxX: ARM_HUB_X + 0.03125,
    maxY: DESK_SURFACE_Y + MAST_TOP_Y,
    maxZ: ARM_HUB_Z + 0.03125,
    tiles: 'dark_iron',
    hiddenFaces: { ny: true, py: true },
  });
  builder.addBox({
    minX: ARM_HUB_X - 0.046875,
    minY: DESK_SURFACE_Y + MAST_TOP_Y,
    minZ: ARM_HUB_Z - 0.046875,
    maxX: ARM_HUB_X + 0.046875,
    maxY: DESK_SURFACE_Y + MAST_TOP_Y + 0.03125,
    maxZ: ARM_HUB_Z + 0.046875,
    tiles: 'iron_block',
  });

  // 2. 逐屏追加正交曼哈顿支臂（自动选择位于屏幕背侧的拐角，避免穿模）
  const activeCount = dualMonitor ? 2 : 1;
  let primaryCollarY = 0;

  for (let i = 0; i < activeCount; i += 1) {
    const transform = transforms[i];
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
    if (i === 0) {
      primaryCollarY = collarY;
    }

    // 同高度双屏复用主屏抱箍避免 Z 闪烁
    if (i === 0 || Math.abs(collarY - primaryCollarY) >= COLLAR_DEDUP_EPS) {
      const collarW = i === 0 ? 0.09375 : 0.09175;
      builder.addCenteredBox(ARM_HUB_X, collarY, ARM_HUB_Z, collarW, 0.09375, collarW, 'iron_block');
    }

    const spanX = Math.abs(vesaX - ARM_HUB_X);
    const spanZ = Math.abs(vesaZ - ARM_HUB_Z);
    const showArmX = spanX >= ARM_SEGMENT_EPS;
    const showArmZ = spanZ >= ARM_SEGMENT_EPS;
    const midX = (ARM_HUB_X + vesaX) * 0.5;
    const midZ = (ARM_HUB_Z + vesaZ) * 0.5;

    const elbowALocalZ = (vesaX - transform.x) * sinY + (ARM_HUB_Z - transform.z) * cosY;
    const elbowBLocalZ = (ARM_HUB_X - transform.x) * sinY + (vesaZ - transform.z) * cosY;
    const useXFirst = elbowALocalZ <= elbowBLocalZ;

    if (useXFirst) {
      if (showArmX) {
        builder.addCenteredBox(midX, collarY, ARM_HUB_Z, spanX, 0.0625, 0.0625, 'dark_iron');
      }
      if (showArmX && showArmZ) {
        builder.addCenteredBox(vesaX, collarY, ARM_HUB_Z, 0.09375, 0.09375, 0.09375, 'iron_block');
      }
      if (showArmZ) {
        builder.addCenteredBox(vesaX, collarY, midZ, 0.0625, 0.0625, spanZ, 'dark_iron');
      }
    } else {
      if (showArmZ) {
        builder.addCenteredBox(ARM_HUB_X, collarY, midZ, 0.0625, 0.0625, spanZ, 'dark_iron');
      }
      if (showArmX && showArmZ) {
        builder.addCenteredBox(ARM_HUB_X, collarY, vesaZ, 0.09375, 0.09375, 0.09375, 'iron_block');
      }
      if (showArmX) {
        builder.addCenteredBox(midX, collarY, vesaZ, spanX, 0.0625, 0.0625, 'dark_iron');
      }
    }

    const dropY = Math.abs(vesaY - collarY);
    if (dropY >= ARM_SEGMENT_EPS) {
      builder.addCenteredBox(vesaX, (collarY + vesaY) * 0.5, vesaZ, 0.0625, dropY, 0.0625, 'dark_iron');
    }
  }

  return builder.build(false);
}

function buildArmSignature(
  transforms: readonly [OfficeMonitorTransform, OfficeMonitorTransform],
  dualMonitor: boolean
): string {
  const a = transforms[0];
  const b = transforms[1];
  return `${dualMonitor ? '2' : '1'}|${a.x.toFixed(3)},${a.y.toFixed(3)},${a.z.toFixed(3)},${a.yaw.toFixed(3)}|${b.x.toFixed(3)},${b.y.toFixed(3)},${b.z.toFixed(3)},${b.yaw.toFixed(3)}`;
}

function buildSingleMonitorUnit(
  index: OfficeMonitorIndex,
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
    emissiveIntensity: 0.92,
  });

  const powerLedMaterial = new THREE.MeshBasicMaterial({
    color: palette.successHex,
  });

  const editFrameMaterial = new THREE.MeshBasicMaterial({
    color: palette.accentHex,
    transparent: true,
    opacity: 0.92,
  });

  const monitorGroup = new THREE.Group();

  // 1. 单一合批显示器体素外壳
  const housingMesh = new THREE.Mesh(
    createMonitorHousingGeometry(index),
    sharedMaterials.opaque
  );
  monitorGroup.add(housingMesh);

  // 2. 实时 2D Canvas 像素风屏幕平面（内嵌于前边框凹槽中）
  const screenMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(0.59375, 0.375),
    screenMaterial
  );
  screenMesh.position.set(0, MONITOR_SCREEN_CENTER_OFFSET_Y, -0.008);
  screenMesh.userData.noShadow = true;
  monitorGroup.add(screenMesh);

  // 3. 右下边框方块电源指示灯
  const powerLedMesh = new THREE.Mesh(
    new THREE.BoxGeometry(0.046875, 0.025, 0.016),
    powerLedMaterial
  );
  powerLedMesh.position.set(0.25, MONITOR_SCREEN_CENTER_OFFSET_Y - 0.2109375, 0.019625);
  powerLedMesh.userData.noShadow = true;
  monitorGroup.add(powerLedMesh);

  // 4. 编辑态 12 根棱条合批高亮线框（单 Mesh，默认隐藏）
  const editFrameMesh = new THREE.Mesh(
    createWireframeBoxGeometry(0.75, 0.53125, 0.1875, 0.02, true),
    editFrameMaterial
  );
  editFrameMesh.position.set(0, MONITOR_SCREEN_CENTER_OFFSET_Y, -0.03125);
  editFrameMesh.visible = false;
  editFrameMesh.userData.noShadow = true;
  monitorGroup.add(editFrameMesh);

  tagMonitorTree(monitorGroup, sessionKey, index);

  // 保留空 armGroup 句柄以保持结构接口完整
  const armGroup = new THREE.Group();
  tagStationTree(armGroup, sessionKey);

  return {
    index,
    monitorGroup,
    screenMesh,
    screenBundle,
    screenMaterial,
    powerLedMaterial,
    editFrameMesh,
    editFrameMaterial,
    armGroup,
    currentTransform: { ...DEFAULT_OFFICE_MONITOR_TRANSFORMS[index] },
  };
}

export function createDualMonitorAssemblyRig(
  sessionKey: string,
  anisotropy: number,
  palette: OfficeScenePalette
): DualMonitorAssemblyRig {
  const root = new THREE.Group();
  const sharedMaterials = getSharedVoxelMaterialSet();

  const initialTransforms: readonly [OfficeMonitorTransform, OfficeMonitorTransform] = [
    DEFAULT_OFFICE_MONITOR_TRANSFORMS[0],
    DEFAULT_OFFICE_MONITOR_TRANSFORMS[1],
  ];

  // 桌沿夹具、立柱与全部正交支臂合批为单个 Mesh
  const mountBaseGroup = new THREE.Group();
  const armStructureMesh = new THREE.Mesh(
    buildMergedArmStructureGeometry(initialTransforms, false),
    sharedMaterials.opaque
  );
  mountBaseGroup.add(armStructureMesh);
  tagStationTree(mountBaseGroup, sessionKey);
  root.add(mountBaseGroup);

  const monitor0 = buildSingleMonitorUnit(0, sessionKey, anisotropy, palette);
  const monitor1 = buildSingleMonitorUnit(1, sessionKey, anisotropy, palette);

  root.add(monitor0.armGroup);
  root.add(monitor0.monitorGroup);
  root.add(monitor1.armGroup);
  root.add(monitor1.monitorGroup);

  const rig: DualMonitorAssemblyRig = {
    root,
    mountBaseGroup,
    armStructureMesh,
    monitors: [monitor0, monitor1],
    dualMonitor: false,
    lastArmSignature: buildArmSignature(initialTransforms, false),
  };

  applyDualMonitorTransforms(rig, initialTransforms, false);

  return rig;
}

export function applyDualMonitorTransforms(
  rig: DualMonitorAssemblyRig,
  transforms: readonly [OfficeMonitorTransform, OfficeMonitorTransform],
  dualMonitor: boolean
): void {
  rig.dualMonitor = dualMonitor;

  rig.monitors[0].currentTransform = { ...transforms[0] };
  rig.monitors[0].monitorGroup.position.set(
    transforms[0].x,
    DESK_SURFACE_Y + transforms[0].y,
    transforms[0].z
  );
  rig.monitors[0].monitorGroup.rotation.set(0, transforms[0].yaw, 0);
  rig.monitors[0].monitorGroup.visible = true;
  rig.monitors[0].armGroup.visible = true;

  rig.monitors[1].currentTransform = { ...transforms[1] };
  rig.monitors[1].monitorGroup.position.set(
    transforms[1].x,
    DESK_SURFACE_Y + transforms[1].y,
    transforms[1].z
  );
  rig.monitors[1].monitorGroup.rotation.set(0, transforms[1].yaw, 0);
  rig.monitors[1].monitorGroup.visible = dualMonitor;
  rig.monitors[1].armGroup.visible = dualMonitor;

  const sig = buildArmSignature(transforms, dualMonitor);
  if (sig !== rig.lastArmSignature) {
    rig.lastArmSignature = sig;
    rig.armStructureMesh.geometry.dispose();
    rig.armStructureMesh.geometry = buildMergedArmStructureGeometry(transforms, dualMonitor);
  }
}

export function syncDualMonitorAssemblyRig(
  rig: DualMonitorAssemblyRig,
  session: OfficeSessionItem,
  isSelected: boolean,
  palette: OfficeScenePalette,
  options: {
    power: OfficeComputerPowerState;
    wallpaper: OfficeWallpaperId;
    dualMonitor: boolean;
    transforms: readonly [OfficeMonitorTransform, OfficeMonitorTransform];
    rasterVersion: number;
    isEditingThisStation: boolean;
    activeEditMonitorIndex: OfficeMonitorIndex;
  }
): void {
  applyDualMonitorTransforms(rig, options.transforms, options.dualMonitor);

  for (const unit of rig.monitors) {
    if (unit.index === 1 && !options.dualMonitor) {
      unit.editFrameMesh.visible = false;
      continue;
    }

    updateMonitorScreenTexture(unit.screenBundle, session, isSelected, palette, {
      power: options.power,
      wallpaper: options.wallpaper,
      monitorIndex: unit.index,
      dualMonitor: options.dualMonitor,
      rasterVersion: options.rasterVersion,
    });

    if (options.power === 'off') {
      unit.screenMaterial.emissiveIntensity = 0.08;
      unit.powerLedMaterial.color.set(LED_STANDBY_HEX);
    } else {
      if (session.availability === 'exited') {
        unit.screenMaterial.emissiveIntensity = 0.35;
        unit.powerLedMaterial.color.set(LED_EXITED_HEX);
      } else if (session.availability === 'unavailable') {
        unit.screenMaterial.emissiveIntensity = 0.65;
        unit.powerLedMaterial.color.set(palette.warningHex);
      } else {
        unit.screenMaterial.emissiveIntensity = isSelected ? 1.0 : 0.9;
        const ledHex = session.availability === 'interactive'
          ? palette.successHex
          : palette.accentHex;
        unit.powerLedMaterial.color.set(ledHex);
      }
    }

    unit.editFrameMaterial.color.set(
      unit.index === options.activeEditMonitorIndex ? palette.accentHex : palette.warningHex
    );
    unit.editFrameMesh.visible = options.isEditingThisStation;
  }
}
