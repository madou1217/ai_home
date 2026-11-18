import * as THREE from 'three';
import type { OfficeScenePalette, OfficeSceneSyncState } from './office-scene-types';
import {
  createFloorTileBundle,
  createRoomTerminalBundle,
  createWallPlaqueBundle,
  createWindowSkyBundle,
  updateFloorTileTexture,
  updateRoomTerminalTexture,
  updateWallPlaqueTexture,
  updateWindowSkyTexture,
  type CanvasTextureBundle,
} from './office-scene-textures';

export interface OfficeRoomRig {
  root: THREE.Group;
  floorMesh: THREE.Mesh;
  aisleMesh: THREE.Mesh;
  backWallGroup: THREE.Group;
  leftWindowGroup: THREE.Group;
  rightTrimGroup: THREE.Group;
  ceilingGroup: THREE.Group;
  plaqueMesh: THREE.Group;
  roomTerminalGroup: THREE.Group;
  roomTerminalScreen: THREE.Mesh;
  plantGroup: THREE.Group;
  floorBundle: CanvasTextureBundle;
  skyBundle: CanvasTextureBundle;
  plaqueBundle: CanvasTextureBundle;
  terminalBundle: CanvasTextureBundle;
  floorMaterial: THREE.MeshStandardMaterial;
  aisleMaterial: THREE.MeshStandardMaterial;
  wallPrimaryMaterial: THREE.MeshStandardMaterial;
  wallPanelMaterial: THREE.MeshStandardMaterial;
  wallTrimMaterial: THREE.MeshStandardMaterial;
  windowFrameMaterial: THREE.MeshStandardMaterial;
  windowGlassMaterial: THREE.MeshStandardMaterial;
  skyBackdropMaterial: THREE.MeshBasicMaterial;
  plaqueScreenMaterial: THREE.MeshStandardMaterial;
  terminalScreenMaterial: THREE.MeshStandardMaterial;
  lightStripMaterial: THREE.MeshStandardMaterial;
  currentWidth: number;
  currentDepth: number;
}

export function createOfficeRoomRig(
  palette: OfficeScenePalette,
  anisotropy: number
): OfficeRoomRig {
  const root = new THREE.Group();

  const floorBundle = createFloorTileBundle(anisotropy);
  const skyBundle = createWindowSkyBundle(anisotropy);
  const plaqueBundle = createWallPlaqueBundle(anisotropy);
  const terminalBundle = createRoomTerminalBundle(anisotropy);

  const floorMaterial = new THREE.MeshStandardMaterial({
    map: floorBundle.texture,
    roughness: 0.78,
    metalness: 0.12,
  });
  const aisleMaterial = new THREE.MeshStandardMaterial({
    color: palette.floorAisleHex,
    roughness: 0.72,
    metalness: 0.16,
  });
  const wallPrimaryMaterial = new THREE.MeshStandardMaterial({
    color: palette.wallPrimaryHex,
    roughness: 0.82,
    metalness: 0.08,
  });
  const wallPanelMaterial = new THREE.MeshStandardMaterial({
    color: palette.wallPanelHex,
    roughness: 0.7,
    metalness: 0.14,
  });
  const wallTrimMaterial = new THREE.MeshStandardMaterial({
    color: palette.wallTrimHex,
    roughness: 0.45,
    metalness: 0.48,
  });
  const windowFrameMaterial = new THREE.MeshStandardMaterial({
    color: palette.windowFrameHex,
    roughness: 0.36,
    metalness: 0.62,
  });
  const windowGlassMaterial = new THREE.MeshStandardMaterial({
    color: palette.windowGlassHex,
    transparent: true,
    opacity: 0.22,
    roughness: 0.12,
    metalness: 0.15,
  });
  const skyBackdropMaterial = new THREE.MeshBasicMaterial({
    map: skyBundle.texture,
  });
  const plaqueScreenMaterial = new THREE.MeshStandardMaterial({
    map: plaqueBundle.texture,
    emissive: new THREE.Color('#ffffff'),
    emissiveMap: plaqueBundle.texture,
    emissiveIntensity: 0.72,
    roughness: 0.32,
  });
  const terminalScreenMaterial = new THREE.MeshStandardMaterial({
    map: terminalBundle.texture,
    emissive: new THREE.Color('#ffffff'),
    emissiveMap: terminalBundle.texture,
    emissiveIntensity: 0.82,
    roughness: 0.25,
  });
  const lightStripMaterial = new THREE.MeshStandardMaterial({
    color: palette.accentHex,
    emissive: palette.accentHex,
    emissiveIntensity: 1.25,
    roughness: 0.2,
  });

  // Floor
  const floorMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), floorMaterial);
  floorMesh.rotation.x = -Math.PI / 2;
  floorMesh.receiveShadow = true;
  root.add(floorMesh);

  // Center aisle strip
  const aisleMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 0.008, 1), aisleMaterial);
  aisleMesh.position.y = 0.004;
  aisleMesh.receiveShadow = true;
  root.add(aisleMesh);

  // Back Wall Assembly
  const backWallGroup = new THREE.Group();
  root.add(backWallGroup);

  const plaqueGroup = new THREE.Group();
  const plaqueFrame = new THREE.Mesh(new THREE.BoxGeometry(2.7, 0.74, 0.032), wallTrimMaterial);
  plaqueFrame.castShadow = true;
  plaqueGroup.add(plaqueFrame);

  const plaqueMesh = new THREE.Mesh(new THREE.PlaneGeometry(2.58, 0.64), plaqueScreenMaterial);
  plaqueMesh.position.z = 0.018;
  plaqueGroup.add(plaqueMesh);
  plaqueGroup.position.set(-0.55, 2.15, 0.12);
  backWallGroup.add(plaqueGroup);

  // Room Mail Terminal Kiosk (clickable -> onOpenRoomMailbox)
  const roomTerminalGroup = new THREE.Group();
  const pedestal = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.92, 0.24), wallTrimMaterial);
  pedestal.position.set(0, 0.46, 0);
  pedestal.castShadow = true;
  pedestal.receiveShadow = true;
  roomTerminalGroup.add(pedestal);

  const kioskFrame = new THREE.Mesh(new THREE.BoxGeometry(1.12, 0.76, 0.08), windowFrameMaterial);
  kioskFrame.position.set(0, 1.24, 0.04);
  kioskFrame.rotation.x = -0.14;
  kioskFrame.castShadow = true;
  roomTerminalGroup.add(kioskFrame);

  const roomTerminalScreen = new THREE.Mesh(
    new THREE.PlaneGeometry(1.04, 0.68),
    terminalScreenMaterial
  );
  roomTerminalScreen.position.set(0, 1.24, 0.085);
  roomTerminalScreen.rotation.x = -0.14;
  roomTerminalGroup.add(roomTerminalScreen);

  roomTerminalGroup.traverse((obj) => {
    obj.userData.hitKind = 'room-mailbox';
  });
  backWallGroup.add(roomTerminalGroup);

  // Architectural corner planter (adds organic silhouette balance)
  const plantGroup = new THREE.Group();
  const potMat = new THREE.MeshStandardMaterial({ color: '#263649', roughness: 0.65, metalness: 0.2 });
  const soilMat = new THREE.MeshStandardMaterial({ color: '#231c17', roughness: 0.95 });
  const leafMat = new THREE.MeshStandardMaterial({ color: '#25855a', roughness: 0.68, metalness: 0.04 });

  const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.16, 0.36, 14), potMat);
  pot.position.y = 0.18;
  pot.castShadow = true;
  pot.receiveShadow = true;
  plantGroup.add(pot);

  const soil = new THREE.Mesh(new THREE.CylinderGeometry(0.20, 0.20, 0.03, 12), soilMat);
  soil.position.y = 0.35;
  plantGroup.add(soil);

  const leafConfigs: Array<[number, number, number, number, number]> = [
    [0, 0.56, 0, 0.18, 0.2],
    [0.09, 0.52, 0.06, 0.45, -0.5],
    [-0.09, 0.54, 0.05, 0.42, 0.6],
    [0.04, 0.50, -0.09, -0.45, -0.2],
    [-0.06, 0.60, -0.04, -0.32, 0.4],
    [0, 0.68, 0, 0.12, 0.1],
  ];
  for (const [lx, ly, lz, rx, rz] of leafConfigs) {
    const leaf = new THREE.Mesh(new THREE.ConeGeometry(0.085, 0.34, 6), leafMat);
    leaf.scale.set(0.75, 1.0, 0.32);
    leaf.position.set(lx, ly, lz);
    leaf.rotation.set(rx, rz * 1.8, rz);
    leaf.castShadow = true;
    plantGroup.add(leaf);
  }
  backWallGroup.add(plantGroup);

  const leftWindowGroup = new THREE.Group();
  root.add(leftWindowGroup);

  const rightTrimGroup = new THREE.Group();
  root.add(rightTrimGroup);

  const ceilingGroup = new THREE.Group();
  root.add(ceilingGroup);

  const rig: OfficeRoomRig = {
    root,
    floorMesh,
    aisleMesh,
    backWallGroup,
    leftWindowGroup,
    rightTrimGroup,
    ceilingGroup,
    plaqueMesh: plaqueGroup,
    roomTerminalGroup,
    roomTerminalScreen,
    plantGroup,
    floorBundle,
    skyBundle,
    plaqueBundle,
    terminalBundle,
    floorMaterial,
    aisleMaterial,
    wallPrimaryMaterial,
    wallPanelMaterial,
    wallTrimMaterial,
    windowFrameMaterial,
    windowGlassMaterial,
    skyBackdropMaterial,
    plaqueScreenMaterial,
    terminalScreenMaterial,
    lightStripMaterial,
    currentWidth: 0,
    currentDepth: 0,
  };

  rebuildRoomEnvelopeGeometry(rig, 9.0, 6.8);
  return rig;
}

function clearDynamicGroup(group: THREE.Group, preserve: Set<THREE.Object3D>): void {
  const children = [...group.children];
  for (const child of children) {
    if (preserve.has(child)) continue;
    group.remove(child);
    child.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
      }
    });
  }
}

function rebuildRoomEnvelopeGeometry(
  rig: OfficeRoomRig,
  roomWidth: number,
  roomDepth: number
): void {
  rig.currentWidth = roomWidth;
  rig.currentDepth = roomDepth;

  const halfW = roomWidth / 2;
  const halfD = roomDepth / 2;
  const wallH = 3.25;

  // Resize floor & tile repeat cleanly
  rig.floorMesh.geometry.dispose();
  rig.floorMesh.geometry = new THREE.PlaneGeometry(roomWidth + 1.8, roomDepth + 1.8);
  rig.floorBundle.texture.repeat.set((roomWidth + 1.8) / 1.6, (roomDepth + 1.8) / 1.6);

  rig.aisleMesh.geometry.dispose();
  rig.aisleMesh.geometry = new THREE.BoxGeometry(1.1, 0.008, roomDepth - 0.5);

  // Rebuild Back Wall panels (preserving plaque, terminal, plant)
  const preserveBack = new Set<THREE.Object3D>([
    rig.plaqueMesh,
    rig.roomTerminalGroup,
    rig.plantGroup,
  ]);
  clearDynamicGroup(rig.backWallGroup, preserveBack);
  rig.backWallGroup.position.set(0, 0, -halfD);

  const mainBackWall = new THREE.Mesh(
    new THREE.BoxGeometry(roomWidth, wallH, 0.16),
    rig.wallPrimaryMaterial
  );
  mainBackWall.position.set(0, wallH / 2, 0);
  mainBackWall.receiveShadow = true;
  mainBackWall.castShadow = true;
  rig.backWallGroup.add(mainBackWall);

  const baseboard = new THREE.Mesh(
    new THREE.BoxGeometry(roomWidth + 0.04, 0.14, 0.19),
    rig.wallTrimMaterial
  );
  baseboard.position.set(0, 0.07, 0.01);
  rig.backWallGroup.add(baseboard);

  // Vertical architectural acoustic ribs on back wall
  const ribCount = Math.max(5, Math.floor(roomWidth / 1.15));
  for (let i = 0; i < ribCount; i += 1) {
    const rx = -halfW + 0.5 + (i * (roomWidth - 1.0)) / Math.max(1, ribCount - 1);
    const rib = new THREE.Mesh(
      new THREE.BoxGeometry(0.14, wallH - 0.25, 0.04),
      rig.wallPanelMaterial
    );
    rib.position.set(rx, wallH / 2 + 0.05, 0.09);
    rib.receiveShadow = true;
    rig.backWallGroup.add(rib);
  }

  // Plaque + Terminal + Plant placements
  rig.plaqueMesh.position.set(-Math.min(0.85, roomWidth * 0.12), 2.15, 0.122);
  rig.roomTerminalGroup.position.set(Math.max(1.8, halfW - 1.15), 0, 0.34);
  rig.plantGroup.position.set(-halfW + 0.52, 0, 0.44);

  // Rebuild Left Window Wall (curtain-wall glass bay)
  clearDynamicGroup(rig.leftWindowGroup, new Set());
  rig.leftWindowGroup.position.set(-halfW, 0, 0);

  const sill = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.72, roomDepth), rig.wallPrimaryMaterial);
  sill.position.set(0, 0.36, 0);
  sill.receiveShadow = true;
  sill.castShadow = true;
  rig.leftWindowGroup.add(sill);

  const header = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.42, roomDepth), rig.wallPrimaryMaterial);
  header.position.set(0, wallH - 0.21, 0);
  header.castShadow = true;
  rig.leftWindowGroup.add(header);

  const windowSpan = roomDepth - 0.4;
  const windowH = wallH - 1.14;
  const windowCenterY = 0.72 + windowH / 2;

  // Translucent window glass
  const glassPane = new THREE.Mesh(
    new THREE.BoxGeometry(0.03, windowH, windowSpan),
    rig.windowGlassMaterial
  );
  glassPane.position.set(0, windowCenterY, 0);
  rig.leftWindowGroup.add(glassPane);

  // Exterior skyline / daylight panel just outside glass
  const skyPlane = new THREE.Mesh(
    new THREE.PlaneGeometry(windowSpan + 0.2, windowH + 0.15),
    rig.skyBackdropMaterial
  );
  skyPlane.rotation.y = Math.PI / 2;
  skyPlane.position.set(-0.22, windowCenterY, 0);
  rig.leftWindowGroup.add(skyPlane);

  // Aluminum mullions & horizontal transom
  const mullionCount = Math.max(4, Math.round(roomDepth / 1.45) + 1);
  for (let i = 0; i < mullionCount; i += 1) {
    const mz = -windowSpan / 2 + (i * windowSpan) / Math.max(1, mullionCount - 1);
    const mullion = new THREE.Mesh(
      new THREE.BoxGeometry(0.11, windowH + 0.06, 0.07),
      rig.windowFrameMaterial
    );
    mullion.position.set(0, windowCenterY, mz);
    mullion.castShadow = true;
    rig.leftWindowGroup.add(mullion);
  }
  const transom = new THREE.Mesh(
    new THREE.BoxGeometry(0.11, 0.06, windowSpan + 0.06),
    rig.windowFrameMaterial
  );
  transom.position.set(0, windowCenterY + 0.36, 0);
  rig.leftWindowGroup.add(transom);

  // Right low architectural curb & corner structural pillars (never obstruct isometric view!)
  clearDynamicGroup(rig.rightTrimGroup, new Set());
  const rightCurb = new THREE.Mesh(
    new THREE.BoxGeometry(0.14, 0.22, roomDepth),
    rig.wallTrimMaterial
  );
  rightCurb.position.set(halfW, 0.11, 0);
  rightCurb.receiveShadow = true;
  rig.rightTrimGroup.add(rightCurb);

  const rightGlassRail = new THREE.Mesh(
    new THREE.BoxGeometry(0.03, 0.42, roomDepth - 0.3),
    rig.windowGlassMaterial
  );
  rightGlassRail.position.set(halfW, 0.43, 0);
  rig.rightTrimGroup.add(rightGlassRail);

  const frontBackRightColumn = new THREE.Mesh(
    new THREE.BoxGeometry(0.22, wallH, 0.22),
    rig.wallTrimMaterial
  );
  frontBackRightColumn.position.set(halfW, wallH / 2, -halfD);
  frontBackRightColumn.castShadow = true;
  rig.rightTrimGroup.add(frontBackRightColumn);

  const frontLeftColumn = new THREE.Mesh(
    new THREE.BoxGeometry(0.22, wallH, 0.22),
    rig.wallTrimMaterial
  );
  frontLeftColumn.position.set(-halfW, wallH / 2, halfD);
  frontLeftColumn.castShadow = true;
  rig.rightTrimGroup.add(frontLeftColumn);

  // Perimeter Ceiling Beams & Glowing Luminaire Strips (open center skylight for Overview clarity)
  clearDynamicGroup(rig.ceilingGroup, new Set());
  const rearBeam = new THREE.Mesh(
    new THREE.BoxGeometry(roomWidth + 0.2, 0.16, 0.24),
    rig.wallTrimMaterial
  );
  rearBeam.position.set(0, wallH + 0.08, -halfD + 0.08);
  rig.ceilingGroup.add(rearBeam);

  const leftBeam = new THREE.Mesh(
    new THREE.BoxGeometry(0.24, 0.16, roomDepth + 0.2),
    rig.wallTrimMaterial
  );
  leftBeam.position.set(-halfW + 0.08, wallH + 0.08, 0);
  rig.ceilingGroup.add(leftBeam);

  const rearLed = new THREE.Mesh(
    new THREE.BoxGeometry(roomWidth - 0.8, 0.03, 0.06),
    rig.lightStripMaterial
  );
  rearLed.position.set(0, wallH - 0.01, -halfD + 0.18);
  rig.ceilingGroup.add(rearLed);

  const leftLed = new THREE.Mesh(
    new THREE.BoxGeometry(0.06, 0.03, roomDepth - 0.8),
    rig.lightStripMaterial
  );
  leftLed.position.set(-halfW + 0.18, wallH - 0.01, 0);
  rig.ceilingGroup.add(leftLed);
}

export function syncOfficeRoomRig(
  rig: OfficeRoomRig,
  state: OfficeSceneSyncState,
  palette: OfficeScenePalette,
  roomWidth: number,
  roomDepth: number,
  isTerminalHovered: boolean
): void {
  if (
    Math.abs(rig.currentWidth - roomWidth) > 0.05
    || Math.abs(rig.currentDepth - roomDepth) > 0.05
  ) {
    rebuildRoomEnvelopeGeometry(rig, roomWidth, roomDepth);
  }

  rig.aisleMaterial.color.set(palette.floorAisleHex);
  rig.wallPrimaryMaterial.color.set(palette.wallPrimaryHex);
  rig.wallPanelMaterial.color.set(palette.wallPanelHex);
  rig.wallTrimMaterial.color.set(palette.wallTrimHex);
  rig.windowFrameMaterial.color.set(palette.windowFrameHex);
  rig.windowGlassMaterial.color.set(palette.windowGlassHex);
  rig.lightStripMaterial.color.set(state.hasRecentPulse ? palette.successHex : palette.accentHex);
  rig.lightStripMaterial.emissive.set(state.hasRecentPulse ? palette.successHex : palette.accentHex);
  rig.lightStripMaterial.emissiveIntensity = state.hasRecentPulse ? 1.65 : 1.05;

  rig.terminalScreenMaterial.emissiveIntensity = isTerminalHovered ? 1.1 : 0.82;

  updateFloorTileTexture(rig.floorBundle, palette);
  updateWindowSkyTexture(rig.skyBundle, palette);
  updateWallPlaqueTexture(rig.plaqueBundle, state, palette);
  updateRoomTerminalTexture(rig.terminalBundle, state, palette);
}
