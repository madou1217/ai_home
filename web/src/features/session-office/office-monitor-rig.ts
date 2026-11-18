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

export const DESK_SURFACE_Y = 0.746;
const MONITOR_SCREEN_CENTER_OFFSET_Y = 0.34;
const ARM_HUB_X = -0.46;
const ARM_HUB_Z = -0.42;
const BASE_ARM_SEGMENT_LEN = 0.26;
const VESA_BACK_OFFSET_Z = -0.028;

export interface SingleMonitorRig {
  index: OfficeMonitorIndex;
  monitorGroup: THREE.Group;
  screenMesh: THREE.Mesh;
  screenBundle: CanvasTextureBundle;
  screenMaterial: THREE.MeshStandardMaterial;
  powerLedMaterial: THREE.MeshStandardMaterial;
  editFrameMesh: THREE.Group;
  editFrameMaterial: THREE.MeshBasicMaterial;
  collarMesh: THREE.Mesh;
  upperArmGroup: THREE.Group;
  upperArmMesh: THREE.Mesh;
  elbowJointMesh: THREE.Mesh;
  forearmGroup: THREE.Group;
  forearmMesh: THREE.Mesh;
  vesaKnuckleMesh: THREE.Mesh;
  armGroup: THREE.Group;
  currentTransform: OfficeMonitorTransform;
}

export interface DualMonitorAssemblyRig {
  root: THREE.Group;
  mountBaseGroup: THREE.Group;
  monitors: [SingleMonitorRig, SingleMonitorRig];
  shellMaterial: THREE.MeshStandardMaterial;
  armMetalMaterial: THREE.MeshStandardMaterial;
  dualMonitor: boolean;
}

function createRoundedRectShape(width: number, height: number, radius: number): THREE.Shape {
  const shape = new THREE.Shape();
  const hw = width / 2;
  const hh = height / 2;
  const r = Math.min(radius, hw, hh);
  shape.moveTo(-hw + r, -hh);
  shape.lineTo(hw - r, -hh);
  shape.quadraticCurveTo(hw, -hh, hw, -hh + r);
  shape.lineTo(hw, hh - r);
  shape.quadraticCurveTo(hw, hh, hw - r, hh);
  shape.lineTo(-hw + r, hh);
  shape.quadraticCurveTo(-hw, hh, -hw, hh - r);
  shape.lineTo(-hw, -hh + r);
  shape.quadraticCurveTo(-hw, -hh, -hw + r, -hh);
  return shape;
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

function buildSingleMonitorUnit(
  index: OfficeMonitorIndex,
  sessionKey: string,
  anisotropy: number,
  shellMaterial: THREE.MeshStandardMaterial,
  armMetalMaterial: THREE.MeshStandardMaterial,
  palette: OfficeScenePalette
): SingleMonitorRig {
  const screenBundle = createMonitorScreenBundle(anisotropy);
  const screenMaterial = new THREE.MeshStandardMaterial({
    map: screenBundle.texture,
    emissive: new THREE.Color('#ffffff'),
    emissiveMap: screenBundle.texture,
    emissiveIntensity: 0.85,
    roughness: 0.22,
    metalness: 0.06,
  });

  const powerLedMaterial = new THREE.MeshStandardMaterial({
    color: palette.successHex,
    emissive: palette.successHex,
    emissiveIntensity: 1.1,
    roughness: 0.3,
  });

  const editFrameMaterial = new THREE.MeshBasicMaterial({
    color: palette.accentHex,
    transparent: true,
    opacity: 0.88,
  });

  const monitorGroup = new THREE.Group();

  // Slim beveled display housing (0.624 x 0.402m, 16:10 ultra-thin bezel)
  const bezelW = 0.624;
  const bezelH = 0.402;
  const shellShape = createRoundedRectShape(bezelW, bezelH, 0.012);
  const shellGeo = new THREE.ExtrudeGeometry(shellShape, {
    depth: 0.018,
    bevelEnabled: true,
    bevelThickness: 0.003,
    bevelSize: 0.003,
    bevelSegments: 2,
    curveSegments: 6,
  });
  const housing = new THREE.Mesh(shellGeo, shellMaterial);
  housing.position.set(0, MONITOR_SCREEN_CENTER_OFFSET_Y, -0.022);
  monitorGroup.add(housing);

  // Tapered rear electronics spine + VESA plate
  const rearSpine = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.16, 0.018), shellMaterial);
  rearSpine.position.set(0, MONITOR_SCREEN_CENTER_OFFSET_Y, -0.032);
  monitorGroup.add(rearSpine);

  const vesaPlate = new THREE.Mesh(new THREE.BoxGeometry(0.105, 0.105, 0.010), armMetalMaterial);
  vesaPlate.position.set(0, MONITOR_SCREEN_CENTER_OFFSET_Y, -0.044);
  monitorGroup.add(vesaPlate);

  // Subtle bottom chin accent & standby/power LED
  const powerLed = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.004, 0.004), powerLedMaterial);
  powerLed.position.set(0.24, MONITOR_SCREEN_CENTER_OFFSET_Y - bezelH * 0.5 + 0.006, 0.002);
  powerLed.userData.noShadow = true;
  monitorGroup.add(powerLed);

  // Primary monitor gets slim integrated webcam housing at top bezel
  if (index === 0) {
    const camBar = new THREE.Mesh(new THREE.BoxGeometry(0.072, 0.015, 0.018), shellMaterial);
    camBar.position.set(0, MONITOR_SCREEN_CENTER_OFFSET_Y + bezelH * 0.5 + 0.009, -0.010);
    monitorGroup.add(camBar);

    const camLens = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, 0.005, 10), armMetalMaterial);
    camLens.rotation.x = Math.PI / 2;
    camLens.position.set(0, MONITOR_SCREEN_CENTER_OFFSET_Y + bezelH * 0.5 + 0.009, 0.001);
    camLens.userData.noShadow = true;
    monitorGroup.add(camLens);
  }

  // Crisp 16:10 screen surface
  const screenMesh = new THREE.Mesh(new THREE.PlaneGeometry(0.598, 0.374), screenMaterial);
  screenMesh.position.set(0, MONITOR_SCREEN_CENTER_OFFSET_Y + 0.002, 0.0015);
  screenMesh.userData.noShadow = true;
  monitorGroup.add(screenMesh);

  // Edit-mode perimeter highlight ring (hidden unless actively editing this monitor)
  const editFrameMesh = new THREE.Group();
  editFrameMesh.position.set(0, MONITOR_SCREEN_CENTER_OFFSET_Y, 0.004);
  editFrameMesh.visible = false;
  const barThick = 0.009;
  const topBar = new THREE.Mesh(new THREE.BoxGeometry(bezelW + 0.024, barThick, 0.008), editFrameMaterial);
  topBar.position.y = bezelH * 0.5 + 0.008;
  const botBar = new THREE.Mesh(new THREE.BoxGeometry(bezelW + 0.024, barThick, 0.008), editFrameMaterial);
  botBar.position.y = -bezelH * 0.5 - 0.008;
  const leftBar = new THREE.Mesh(new THREE.BoxGeometry(barThick, bezelH + 0.024, 0.008), editFrameMaterial);
  leftBar.position.x = -bezelW * 0.5 - 0.008;
  const rightBar = new THREE.Mesh(new THREE.BoxGeometry(barThick, bezelH + 0.024, 0.008), editFrameMaterial);
  rightBar.position.x = bezelW * 0.5 + 0.008;
  for (const bar of [topBar, botBar, leftBar, rightBar]) {
    bar.userData.noShadow = true;
    editFrameMesh.add(bar);
  }
  monitorGroup.add(editFrameMesh);

  tagMonitorTree(monitorGroup, sessionKey, index);

  // Articulated 2-Link Gas-Spring / Mast Arm Assembly
  const armGroup = new THREE.Group();
  const collarMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.026, 0.036, 12), armMetalMaterial);
  collarMesh.castShadow = true;
  armGroup.add(collarMesh);

  const upperArmGroup = new THREE.Group();
  upperArmGroup.rotation.order = 'YXZ';
  const upperArmMesh = new THREE.Mesh(
    new THREE.BoxGeometry(0.026, 0.022, BASE_ARM_SEGMENT_LEN),
    armMetalMaterial
  );
  upperArmMesh.position.z = BASE_ARM_SEGMENT_LEN * 0.5;
  upperArmMesh.castShadow = true;
  upperArmGroup.add(upperArmMesh);
  armGroup.add(upperArmGroup);

  const elbowJointMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.017, 0.017, 0.032, 12), armMetalMaterial);
  elbowJointMesh.castShadow = true;
  armGroup.add(elbowJointMesh);

  const forearmGroup = new THREE.Group();
  forearmGroup.rotation.order = 'YXZ';
  const forearmMesh = new THREE.Mesh(
    new THREE.BoxGeometry(0.022, 0.020, BASE_ARM_SEGMENT_LEN),
    armMetalMaterial
  );
  forearmMesh.position.z = BASE_ARM_SEGMENT_LEN * 0.5;
  forearmMesh.castShadow = true;
  forearmGroup.add(forearmMesh);
  armGroup.add(forearmGroup);

  const vesaKnuckleMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.030, 10), armMetalMaterial);
  vesaKnuckleMesh.rotation.x = Math.PI / 2;
  armGroup.add(vesaKnuckleMesh);

  armGroup.traverse((child) => {
    child.userData.sessionKey = sessionKey;
    child.userData.hitKind = 'station';
  });

  return {
    index,
    monitorGroup,
    screenMesh,
    screenBundle,
    screenMaterial,
    powerLedMaterial,
    editFrameMesh,
    editFrameMaterial,
    collarMesh,
    upperArmGroup,
    upperArmMesh,
    elbowJointMesh,
    forearmGroup,
    forearmMesh,
    vesaKnuckleMesh,
    armGroup,
    currentTransform: { ...DEFAULT_OFFICE_MONITOR_TRANSFORMS[index] },
  };
}

function solveMonitorArmTransform(unit: SingleMonitorRig, transform: OfficeMonitorTransform): void {
  const worldMonitorY = DESK_SURFACE_Y + transform.y;
  unit.monitorGroup.position.set(transform.x, worldMonitorY, transform.z);
  unit.monitorGroup.rotation.set(0, transform.yaw, 0);

  // VESA back socket in station space
  const sinY = Math.sin(transform.yaw);
  const cosY = Math.cos(transform.yaw);
  const vesaX = transform.x + sinY * VESA_BACK_OFFSET_Z;
  const vesaZ = transform.z + cosY * VESA_BACK_OFFSET_Z;
  const vesaY = worldMonitorY + MONITOR_SCREEN_CENTER_OFFSET_Y;

  const collarY = Math.max(DESK_SURFACE_Y + 0.08, Math.min(DESK_SURFACE_Y + 0.44, vesaY - 0.02));
  unit.collarMesh.position.set(ARM_HUB_X, collarY, ARM_HUB_Z);

  const dx = vesaX - ARM_HUB_X;
  const dz = vesaZ - ARM_HUB_Z;
  const distXZ = Math.hypot(dx, dz);
  const safeDist = Math.max(0.06, distXZ);

  // Stretch segment length smoothly if user drags beyond nominal reach so the arm stays joined
  const segLen = Math.max(BASE_ARM_SEGMENT_LEN, safeDist * 0.56);
  const ratio = Math.min(0.985, safeDist / (2 * segLen));
  const bend = Math.acos(ratio);
  const baseAngle = Math.atan2(dx, dz);

  // Pick elbow bend direction that keeps the hinge furthest behind (-Z) the screens
  const candA = baseAngle + bend;
  const candB = baseAngle - bend;
  const elbowZa = ARM_HUB_Z + Math.cos(candA) * segLen;
  const elbowZb = ARM_HUB_Z + Math.cos(candB) * segLen;
  const theta1 = elbowZa <= elbowZb ? candA : candB;

  const elbowX = ARM_HUB_X + Math.sin(theta1) * segLen;
  const elbowZ = ARM_HUB_Z + Math.cos(theta1) * segLen;
  const elbowY = (collarY + vesaY) * 0.5;

  const dy1 = elbowY - collarY;
  const upperLen3D = Math.hypot(segLen, dy1);
  unit.upperArmGroup.position.set(ARM_HUB_X, collarY, ARM_HUB_Z);
  unit.upperArmGroup.rotation.set(-Math.atan2(dy1, segLen), theta1, 0);
  unit.upperArmGroup.scale.set(1, 1, upperLen3D / BASE_ARM_SEGMENT_LEN);

  unit.elbowJointMesh.position.set(elbowX, elbowY, elbowZ);

  const fdx = vesaX - elbowX;
  const fdz = vesaZ - elbowZ;
  const fdy = vesaY - elbowY;
  const fDistXZ = Math.max(0.03, Math.hypot(fdx, fdz));
  const forearmLen3D = Math.hypot(fDistXZ, fdy);
  const theta2 = Math.atan2(fdx, fdz);

  unit.forearmGroup.position.set(elbowX, elbowY, elbowZ);
  unit.forearmGroup.rotation.set(-Math.atan2(fdy, fDistXZ), theta2, 0);
  unit.forearmGroup.scale.set(1, 1, forearmLen3D / BASE_ARM_SEGMENT_LEN);

  unit.vesaKnuckleMesh.position.set(vesaX, vesaY, vesaZ);
  unit.vesaKnuckleMesh.rotation.set(0, transform.yaw, 0);
}

export function createDualMonitorAssemblyRig(
  sessionKey: string,
  anisotropy: number,
  palette: OfficeScenePalette
): DualMonitorAssemblyRig {
  const root = new THREE.Group();

  const shellMaterial = new THREE.MeshStandardMaterial({
    color: palette.monitorShellHex,
    roughness: 0.40,
    metalness: 0.42,
  });
  const armMetalMaterial = new THREE.MeshStandardMaterial({
    color: palette.chairMetalHex,
    roughness: 0.34,
    metalness: 0.72,
  });

  // Heavy desk-edge C-clamp & vertical pole mast
  const mountBaseGroup = new THREE.Group();
  mountBaseGroup.position.set(ARM_HUB_X, DESK_SURFACE_Y, ARM_HUB_Z);

  const clampPlate = new THREE.Mesh(new THREE.BoxGeometry(0.092, 0.014, 0.088), armMetalMaterial);
  clampPlate.position.set(0, 0.007, 0);
  clampPlate.castShadow = true;
  mountBaseGroup.add(clampPlate);

  const rearClampJaw = new THREE.Mesh(new THREE.BoxGeometry(0.076, 0.075, 0.016), armMetalMaterial);
  rearClampJaw.position.set(0, -0.028, -0.042);
  mountBaseGroup.add(rearClampJaw);

  const mastPole = new THREE.Mesh(new THREE.CylinderGeometry(0.019, 0.019, 0.48, 14), armMetalMaterial);
  mastPole.position.set(0, 0.24, 0);
  mastPole.castShadow = true;
  mountBaseGroup.add(mastPole);

  const mastCap = new THREE.Mesh(new THREE.CylinderGeometry(0.021, 0.021, 0.010, 14), shellMaterial);
  mastCap.position.set(0, 0.482, 0);
  mountBaseGroup.add(mastCap);

  mountBaseGroup.traverse((child) => {
    child.userData.sessionKey = sessionKey;
    child.userData.hitKind = 'station';
  });
  root.add(mountBaseGroup);

  const monitor0 = buildSingleMonitorUnit(
    0,
    sessionKey,
    anisotropy,
    shellMaterial,
    armMetalMaterial,
    palette
  );
  const monitor1 = buildSingleMonitorUnit(
    1,
    sessionKey,
    anisotropy,
    shellMaterial,
    armMetalMaterial,
    palette
  );

  root.add(monitor0.armGroup);
  root.add(monitor0.monitorGroup);
  root.add(monitor1.armGroup);
  root.add(monitor1.monitorGroup);

  const rig: DualMonitorAssemblyRig = {
    root,
    mountBaseGroup,
    monitors: [monitor0, monitor1],
    shellMaterial,
    armMetalMaterial,
    dualMonitor: false,
  };

  applyDualMonitorTransforms(
    rig,
    [DEFAULT_OFFICE_MONITOR_TRANSFORMS[0], DEFAULT_OFFICE_MONITOR_TRANSFORMS[1]],
    false
  );

  return rig;
}

export function applyDualMonitorTransforms(
  rig: DualMonitorAssemblyRig,
  transforms: readonly [OfficeMonitorTransform, OfficeMonitorTransform],
  dualMonitor: boolean
): void {
  rig.dualMonitor = dualMonitor;

  rig.monitors[0].currentTransform = { ...transforms[0] };
  solveMonitorArmTransform(rig.monitors[0], transforms[0]);
  rig.monitors[0].monitorGroup.visible = true;
  rig.monitors[0].armGroup.visible = true;

  rig.monitors[1].currentTransform = { ...transforms[1] };
  solveMonitorArmTransform(rig.monitors[1], transforms[1]);
  rig.monitors[1].monitorGroup.visible = dualMonitor;
  rig.monitors[1].armGroup.visible = dualMonitor;
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
  rig.shellMaterial.color.set(palette.monitorShellHex);
  rig.armMetalMaterial.color.set(palette.chairMetalHex);

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
      unit.screenMaterial.emissiveIntensity = 0.04;
      unit.screenMaterial.roughness = 0.14;
      unit.screenMaterial.metalness = 0.14;
      unit.powerLedMaterial.color.set('#f59e0b');
      unit.powerLedMaterial.emissive.set('#f59e0b');
      unit.powerLedMaterial.emissiveIntensity = 0.18;
    } else {
      if (session.availability === 'exited') {
        unit.screenMaterial.emissiveIntensity = 0.28;
      } else if (session.availability === 'unavailable') {
        unit.screenMaterial.emissiveIntensity = 0.56;
      } else {
        unit.screenMaterial.emissiveIntensity = isSelected ? 0.96 : 0.84;
      }
      unit.screenMaterial.roughness = 0.22;
      unit.screenMaterial.metalness = 0.06;

      const ledHex = session.availability === 'interactive'
        ? palette.successHex
        : session.availability === 'unavailable'
          ? palette.warningHex
          : palette.accentHex;
      unit.powerLedMaterial.color.set(ledHex);
      unit.powerLedMaterial.emissive.set(ledHex);
      unit.powerLedMaterial.emissiveIntensity = session.availability === 'exited' ? 0.2 : 1.15;
    }

    unit.editFrameMaterial.color.set(
      unit.index === options.activeEditMonitorIndex ? palette.accentHex : palette.warningHex
    );
    unit.editFrameMesh.visible = options.isEditingThisStation;
  }
}
