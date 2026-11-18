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
  syncDualMonitorAssemblyRig,
  type DualMonitorAssemblyRig,
} from './office-monitor-rig';

export interface OfficeStationRig {
  sessionKey: string;
  root: THREE.Group;
  targetPosition: THREE.Vector3;
  monitorAssembly: DualMonitorAssemblyRig;
  screenMesh: THREE.Mesh;
  computerRig: DesktopComputerRig;
  mailTrayGroup: THREE.Group;
  mailPackets: THREE.Mesh[];
  pulseArcMesh: THREE.Mesh;
  pulseOrbMesh: THREE.Mesh;
  pulseCurve: THREE.CatmullRomCurve3;
  character: OfficeCharacterRig;
  badgeBundle: CanvasTextureBundle;
  floorRingMaterial: THREE.MeshStandardMaterial;
  trayLedMaterial: THREE.MeshStandardMaterial;
  pulseOrbMaterial: THREE.MeshStandardMaterial;
  pulseArcMaterial: THREE.MeshBasicMaterial;
  deskTopMaterial: THREE.MeshStandardMaterial;
  deskEdgeMaterial: THREE.MeshStandardMaterial;
  deskLegMaterial: THREE.MeshStandardMaterial;
  floorPadMaterial: THREE.MeshStandardMaterial;
  packetMaterial: THREE.MeshStandardMaterial;
  chairFabricMaterial: THREE.MeshStandardMaterial;
  chairMetalMaterial: THREE.MeshStandardMaterial;
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

function buildDeskAssembly(
  sessionKey: string,
  deskTopMaterial: THREE.MeshStandardMaterial,
  deskEdgeMaterial: THREE.MeshStandardMaterial,
  deskLegMaterial: THREE.MeshStandardMaterial,
  badgeTexture: THREE.Texture
): THREE.Group {
  const desk = new THREE.Group();

  // Beveled Desk Slab (1.34m x 0.98m: x in [-1.06, +0.28], z in [-0.48, +0.50], top surface y = 0.746)
  const slabShape = createRoundedRectShape(1.34, 0.98, 0.042);
  const slabGeo = new THREE.ExtrudeGeometry(slabShape, {
    depth: 0.036,
    bevelEnabled: true,
    bevelThickness: 0.006,
    bevelSize: 0.006,
    bevelSegments: 2,
    curveSegments: 8,
  });
  slabGeo.rotateX(Math.PI / 2);
  const slabMesh = new THREE.Mesh(slabGeo, deskTopMaterial);
  slabMesh.position.set(-0.39, 0.74, 0.01);
  desk.add(slabMesh);

  // Desk edge frame / modesty apron
  const apron = new THREE.Mesh(new THREE.BoxGeometry(1.18, 0.06, 0.032), deskEdgeMaterial);
  apron.position.set(-0.39, 0.67, -0.41);
  desk.add(apron);

  // Four cylindrical legs + machined leveler feet
  const legPositions: Array<[number, number]> = [
    [-0.96, -0.39],
    [0.19, -0.39],
    [-0.96, 0.41],
    [0.19, 0.41],
  ];
  const legGeo = new THREE.CylinderGeometry(0.022, 0.02, 0.68, 10);
  const footGeo = new THREE.CylinderGeometry(0.032, 0.034, 0.018, 10);
  for (const [lx, lz] of legPositions) {
    const leg = new THREE.Mesh(legGeo, deskLegMaterial);
    leg.position.set(lx, 0.36, lz);
    desk.add(leg);

    const foot = new THREE.Mesh(footGeo, deskLegMaterial);
    foot.position.set(lx, 0.028, lz);
    desk.add(foot);
  }

  // Desk Nameplate Badge on front edge
  const badgePlate = new THREE.Mesh(
    new THREE.BoxGeometry(0.24, 0.075, 0.014),
    deskEdgeMaterial
  );
  badgePlate.position.set(-0.39, 0.72, 0.506);
  badgePlate.rotation.x = -0.22;
  desk.add(badgePlate);

  const badgeFaceMat = new THREE.MeshBasicMaterial({ map: badgeTexture });
  const badgeFace = new THREE.Mesh(new THREE.PlaneGeometry(0.225, 0.065), badgeFaceMat);
  badgeFace.position.set(0, 0, 0.008);
  badgeFace.userData.noShadow = true;
  badgePlate.add(badgeFace);

  // Coffee Mug prop
  const mugMat = new THREE.MeshStandardMaterial({ color: '#dbe7f3', roughness: 0.35, metalness: 0.08 });
  const mug = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.028, 0.075, 14), mugMat);
  mug.position.set(-0.26, 0.783, 0.36);
  desk.add(mug);
  const coffeeMat = new THREE.MeshStandardMaterial({ color: '#2b1911', roughness: 0.2 });
  const coffeeTop = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.028, 0.004, 12), coffeeMat);
  coffeeTop.position.set(-0.26, 0.818, 0.36);
  desk.add(coffeeTop);

  tagPickableTree(desk, sessionKey, 'station');
  return desk;
}

function buildErgonomicChair(
  sessionKey: string,
  fabricMaterial: THREE.MeshStandardMaterial,
  metalMaterial: THREE.MeshStandardMaterial
): THREE.Group {
  const chair = new THREE.Group();

  // 5-star caster base
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.055, 0.05, 12), metalMaterial);
  hub.position.y = 0.075;
  chair.add(hub);

  const spokeGeo = new THREE.BoxGeometry(0.032, 0.024, 0.27);
  const casterGeo = new THREE.CylinderGeometry(0.024, 0.024, 0.026, 10);
  for (let i = 0; i < 5; i += 1) {
    const angle = (i * Math.PI * 2) / 5;
    const arm = new THREE.Group();
    arm.rotation.y = angle;
    chair.add(arm);

    const spoke = new THREE.Mesh(spokeGeo, metalMaterial);
    spoke.position.set(0, 0.06, 0.135);
    arm.add(spoke);

    const caster = new THREE.Mesh(casterGeo, metalMaterial);
    caster.rotation.z = Math.PI / 2;
    caster.position.set(0, 0.024, 0.255);
    arm.add(caster);
  }

  // Gas lift stem
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.03, 0.34, 12), metalMaterial);
  stem.position.y = 0.26;
  chair.add(stem);

  // Contoured Seat Cushion
  const seatShape = createRoundedRectShape(0.44, 0.42, 0.06);
  const seatGeo = new THREE.ExtrudeGeometry(seatShape, {
    depth: 0.055,
    bevelEnabled: true,
    bevelThickness: 0.012,
    bevelSize: 0.012,
    bevelSegments: 2,
    curveSegments: 8,
  });
  seatGeo.rotateX(Math.PI / 2);
  const seat = new THREE.Mesh(seatGeo, fabricMaterial);
  seat.position.set(0, 0.445, 0.01);
  chair.add(seat);

  // Spine bracket + Lumbar Backrest + Headrest
  const spinePost = new THREE.Mesh(new THREE.BoxGeometry(0.065, 0.38, 0.03), metalMaterial);
  spinePost.position.set(0, 0.59, -0.215);
  spinePost.rotation.x = -0.1;
  chair.add(spinePost);

  const backShape = createRoundedRectShape(0.38, 0.44, 0.06);
  const backGeo = new THREE.ExtrudeGeometry(backShape, {
    depth: 0.038,
    bevelEnabled: true,
    bevelThickness: 0.01,
    bevelSize: 0.01,
    bevelSegments: 2,
    curveSegments: 8,
  });
  const backrest = new THREE.Mesh(backGeo, fabricMaterial);
  backrest.position.set(0, 0.74, -0.22);
  backrest.rotation.x = -0.09;
  chair.add(backrest);

  const headrest = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.11, 0.042), fabricMaterial);
  headrest.position.set(0, 1.04, -0.245);
  headrest.rotation.x = 0.08;
  chair.add(headrest);

  // Armrests
  const armPostGeo = new THREE.BoxGeometry(0.026, 0.21, 0.03);
  const armPadGeo = new THREE.BoxGeometry(0.055, 0.024, 0.22);
  for (const side of [-1, 1]) {
    const armPost = new THREE.Mesh(armPostGeo, metalMaterial);
    armPost.position.set(side * 0.235, 0.53, -0.01);
    chair.add(armPost);

    const armPad = new THREE.Mesh(armPadGeo, fabricMaterial);
    armPad.position.set(side * 0.235, 0.64, 0.02);
    chair.add(armPad);
  }

  tagPickableTree(chair, sessionKey, 'station');
  return chair;
}

function buildMailTray(
  sessionKey: string,
  shellMaterial: THREE.MeshStandardMaterial,
  trayLedMaterial: THREE.MeshStandardMaterial,
  pulseOrbMaterial: THREE.MeshStandardMaterial,
  pulseArcMaterial: THREE.MeshBasicMaterial,
  packetMaterial: THREE.MeshStandardMaterial
): {
  mailTrayGroup: THREE.Group;
  mailPackets: THREE.Mesh[];
  pulseArcMesh: THREE.Mesh;
  pulseOrbMesh: THREE.Mesh;
  pulseCurve: THREE.CatmullRomCurve3;
} {
  const mailTrayGroup = new THREE.Group();
  mailTrayGroup.position.set(0.04, 0.746, 0.37);

  const base = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.018, 0.17), shellMaterial);
  base.position.y = 0.009;
  mailTrayGroup.add(base);

  const rimBack = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.042, 0.016), shellMaterial);
  rimBack.position.set(0, 0.025, -0.077);
  mailTrayGroup.add(rimBack);

  const rimL = new THREE.Mesh(new THREE.BoxGeometry(0.016, 0.038, 0.17), shellMaterial);
  rimL.position.set(-0.102, 0.023, 0);
  mailTrayGroup.add(rimL);

  const rimR = new THREE.Mesh(new THREE.BoxGeometry(0.016, 0.038, 0.17), shellMaterial);
  rimR.position.set(0.102, 0.023, 0);
  mailTrayGroup.add(rimR);

  const trayLed = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.01, 0.014), trayLedMaterial);
  trayLed.position.set(0, 0.018, 0.084);
  mailTrayGroup.add(trayLed);

  const mailPackets: THREE.Mesh[] = [];
  const packetGeo = new THREE.BoxGeometry(0.14, 0.012, 0.10);
  for (let i = 0; i < 3; i += 1) {
    const packet = new THREE.Mesh(packetGeo, packetMaterial);
    packet.position.set(0, 0.026 + i * 0.015, -0.005);
    packet.rotation.y = (i - 1) * 0.08;
    packet.visible = false;
    mailTrayGroup.add(packet);
    mailPackets.push(packet);
  }

  // Curved Telemetry Signal Arc above mail tray
  const pulseCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-0.11, 0.06, 0),
    new THREE.Vector3(-0.04, 0.24, 0.02),
    new THREE.Vector3(0.04, 0.24, -0.02),
    new THREE.Vector3(0.11, 0.06, 0),
  ]);
  const arcGeo = new THREE.TubeGeometry(pulseCurve, 18, 0.0055, 6, false);
  const pulseArcMesh = new THREE.Mesh(arcGeo, pulseArcMaterial);
  pulseArcMesh.visible = false;
  mailTrayGroup.add(pulseArcMesh);

  const pulseOrbMesh = new THREE.Mesh(new THREE.SphereGeometry(0.024, 10, 8), pulseOrbMaterial);
  pulseOrbMesh.visible = false;
  mailTrayGroup.add(pulseOrbMesh);

  tagPickableTree(mailTrayGroup, sessionKey, 'mail-tray');
  pulseArcMesh.castShadow = false;
  pulseOrbMesh.castShadow = false;

  return {
    mailTrayGroup,
    mailPackets,
    pulseArcMesh,
    pulseOrbMesh,
    pulseCurve,
  };
}

export function createWorkstationPod(
  session: OfficeSessionItem,
  palette: OfficeScenePalette,
  anisotropy: number
): OfficeStationRig {
  const root = new THREE.Group();

  const deskTopMaterial = new THREE.MeshStandardMaterial({
    color: palette.deskTopHex,
    roughness: 0.58,
    metalness: 0.14,
  });
  const deskEdgeMaterial = new THREE.MeshStandardMaterial({
    color: palette.deskEdgeHex,
    roughness: 0.48,
    metalness: 0.35,
  });
  const deskLegMaterial = new THREE.MeshStandardMaterial({
    color: palette.deskLegHex,
    roughness: 0.38,
    metalness: 0.62,
  });
  const chairFabricMaterial = new THREE.MeshStandardMaterial({
    color: palette.chairFabricHex,
    roughness: 0.78,
    metalness: 0.06,
  });
  const chairMetalMaterial = new THREE.MeshStandardMaterial({
    color: palette.chairMetalHex,
    roughness: 0.36,
    metalness: 0.68,
  });
  const floorPadMaterial = new THREE.MeshStandardMaterial({
    color: palette.floorAisleHex,
    roughness: 0.72,
    metalness: 0.12,
  });
  const floorRingMaterial = new THREE.MeshStandardMaterial({
    color: palette.accentHex,
    emissive: palette.accentHex,
    emissiveIntensity: 0.55,
    roughness: 0.3,
    metalness: 0.2,
  });
  const trayLedMaterial = new THREE.MeshStandardMaterial({
    color: palette.accentHex,
    emissive: palette.accentHex,
    emissiveIntensity: 0.45,
  });
  const pulseOrbMaterial = new THREE.MeshStandardMaterial({
    color: palette.accentHex,
    emissive: palette.accentHex,
    emissiveIntensity: 1.8,
  });
  const pulseArcMaterial = new THREE.MeshBasicMaterial({
    color: palette.accentHex,
    transparent: true,
    opacity: 0.7,
  });
  const packetMaterial = new THREE.MeshStandardMaterial({
    color: '#dff4ff',
    emissive: palette.accentHex,
    emissiveIntensity: 0.35,
    roughness: 0.3,
  });

  // Floor Contact Pad + Perimeter Ring
  const padShape = createRoundedRectShape(2.14, 1.56, 0.1);
  const padGeo = new THREE.ExtrudeGeometry(padShape, {
    depth: 0.016,
    bevelEnabled: false,
    curveSegments: 8,
  });
  padGeo.rotateX(Math.PI / 2);
  const padMesh = new THREE.Mesh(padGeo, floorPadMaterial);
  padMesh.position.set(-0.12, 0.018, 0.02);
  padMesh.userData.sessionKey = session.sessionKey;
  padMesh.userData.hitKind = 'station';
  padMesh.receiveShadow = true;
  root.add(padMesh);

  // Subtle perimeter highlight strips around floor pad
  const ringBars = [
    [2.16, 0.012, 0.022, -0.12, 0.012, 0.805],
    [2.16, 0.012, 0.022, -0.12, 0.012, -0.765],
    [0.022, 0.012, 1.58, -1.195, 0.012, 0.02],
    [0.022, 0.012, 1.58, 0.955, 0.012, 0.02],
  ];
  for (const [w, h, d, rx, ry, rz] of ringBars) {
    const bar = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), floorRingMaterial);
    bar.position.set(rx, ry, rz);
    bar.userData.sessionKey = session.sessionKey;
    bar.userData.hitKind = 'station';
    root.add(bar);
  }

  // Desk Badge texture
  const badgeBundle = createDeskBadgeBundle(anisotropy);

  // Desk
  const desk = buildDeskAssembly(
    session.sessionKey,
    deskTopMaterial,
    deskEdgeMaterial,
    deskLegMaterial,
    badgeBundle.texture
  );
  root.add(desk);

  // High-detail Showcase Glass RGB PC Case, Keyboard, Mouse & Under-Desk Cable Management
  const computerRig = createDesktopComputerRig(
    palette,
    session.persona.deskAccent || palette.accentHex
  );
  tagPickableTree(computerRig.root, session.sessionKey, 'station', true);
  root.add(computerRig.root);

  // Chair
  const chair = buildErgonomicChair(session.sessionKey, chairFabricMaterial, chairMetalMaterial);
  chair.position.set(0.52, 0, -0.02);
  chair.rotation.y = -1.32;
  root.add(chair);

  // Humanoid Worker seated on Chair
  const character = createOfficeCharacter(session, palette);
  character.root.position.set(0.52, 0, -0.02);
  character.root.rotation.y = -1.32;
  root.add(character.root);

  // Articulated Single/Dual Monitors
  const monitorAssembly = createDualMonitorAssemblyRig(
    session.sessionKey,
    anisotropy,
    palette
  );
  root.add(monitorAssembly.root);

  // Mail Tray
  const {
    mailTrayGroup,
    mailPackets,
    pulseArcMesh,
    pulseOrbMesh,
    pulseCurve,
  } = buildMailTray(
    session.sessionKey,
    monitorAssembly.shellMaterial,
    trayLedMaterial,
    pulseOrbMaterial,
    pulseArcMaterial,
    packetMaterial
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
    mailPackets,
    pulseArcMesh,
    pulseOrbMesh,
    pulseCurve,
    character,
    badgeBundle,
    floorRingMaterial,
    trayLedMaterial,
    pulseOrbMaterial,
    pulseArcMaterial,
    deskTopMaterial,
    deskEdgeMaterial,
    deskLegMaterial,
    floorPadMaterial,
    packetMaterial,
    chairFabricMaterial,
    chairMetalMaterial,
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
): THREE.Mesh {
  if (monitorIndex === 1 && rig.monitorAssembly.dualMonitor) {
    return rig.monitorAssembly.monitors[1].screenMesh;
  }
  return rig.monitorAssembly.monitors[0].screenMesh;
}

export function disposeStationTextureBundles(rig: OfficeStationRig): void {
  rig.badgeBundle.texture.dispose();
  for (const monitor of rig.monitorAssembly.monitors) {
    monitor.screenBundle.texture.dispose();
  }
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

  // Theme material sync
  rig.deskTopMaterial.color.set(palette.deskTopHex);
  rig.deskEdgeMaterial.color.set(palette.deskEdgeHex);
  rig.deskLegMaterial.color.set(palette.deskLegHex);
  rig.floorPadMaterial.color.set(palette.floorAisleHex);
  rig.packetMaterial.emissive.set(palette.accentHex);
  rig.chairFabricMaterial.color.set(palette.chairFabricHex);
  rig.chairMetalMaterial.color.set(palette.chairMetalHex);

  // Sync showcase PC RGB/power & peripherals
  syncDesktopComputerRig(
    rig.computerRig,
    preferences.power,
    preferences.rgbEnabled,
    preferences.rgbColor,
    session.availability,
    palette
  );

  // Sync dual monitors, transforms, arms, wallpaper, and power state
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

  // Character state update
  updateOfficeCharacter(rig.character, session, palette);

  // Floor ring indicator
  let statusHex = palette.accentHex;
  if (session.availability === 'interactive') statusHex = palette.successHex;
  else if (session.availability === 'unavailable') statusHex = palette.warningHex;
  else if (session.availability === 'exited') statusHex = palette.screenMutedHex;

  const ringHex = isSelected || isHovered ? palette.accentHex : statusHex;
  rig.floorRingMaterial.color.set(ringHex);
  rig.floorRingMaterial.emissive.set(ringHex);
  rig.floorRingMaterial.emissiveIntensity = isSelected
    ? 1.85
    : isHovered
      ? 1.35
      : preferences.power === 'off'
        ? 0.25
        : session.availability === 'exited'
          ? 0.18
          : 0.65;

  // Mail tray packets & pulse telemetry
  const totalMailIndicator = session.pendingCount + session.inboxCount;
  const visiblePackets = session.pendingCount > 0 || session.inboxCount > 0
    ? Math.min(3, Math.max(1, Math.ceil(totalMailIndicator / 2)))
    : 0;
  for (let i = 0; i < rig.mailPackets.length; i += 1) {
    rig.mailPackets[i].visible = i < visiblePackets;
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
  rig.trayLedMaterial.emissive.set(mailSignalHex);
  rig.trayLedMaterial.emissiveIntensity = hasPulse ? 1.9 : hasPending ? 1.2 : 0.35;

  rig.pulseOrbMaterial.color.set(mailSignalHex);
  rig.pulseOrbMaterial.emissive.set(mailSignalHex);
  rig.pulseArcMaterial.color.set(mailSignalHex);

  const showArc = hasPulse || session.pendingCount > 0;
  rig.pulseArcMesh.visible = showArc;
  rig.pulseOrbMesh.visible = showArc;
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

  if (rig.pulseOrbMesh.visible) {
    const u = reducedMotion ? 0.5 : ((elapsedSec * (rig.hasActivePulse ? 0.95 : 0.45) + rig.phaseOffset * 0.2) % 1);
    const point = rig.pulseCurve.getPointAt(u);
    rig.pulseOrbMesh.position.copy(point);
  }
}
