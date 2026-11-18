import * as THREE from 'three';
import type { SessionAvailability } from './session-office-types';
import type { OfficeScenePalette } from './office-scene-types';
import {
  normalizeOfficeRgbColor,
  type OfficeComputerPowerState,
} from './office-computer-state';

export interface FanInstanceSlot {
  center: THREE.Vector3;
  normalQuat: THREE.Quaternion;
  bladeRadius: number;
  bladeCount: number;
  speedMul: number;
}

export interface DesktopComputerRig {
  root: THREE.Group;
  caseFrameMaterial: THREE.MeshStandardMaterial;
  caseInteriorMaterial: THREE.MeshStandardMaterial;
  glassMaterial: THREE.MeshPhysicalMaterial;
  pcbMaterial: THREE.MeshStandardMaterial;
  copperMaterial: THREE.MeshStandardMaterial;
  heatsinkMaterial: THREE.MeshStandardMaterial;
  gpuShroudMaterial: THREE.MeshStandardMaterial;
  rgbMaterial: THREE.MeshStandardMaterial;
  powerLedMaterial: THREE.MeshStandardMaterial;
  cableMaterial: THREE.MeshStandardMaterial;
  deskMatMaterial: THREE.MeshStandardMaterial;
  matStitchMaterial: THREE.MeshStandardMaterial;
  keyboardShellMaterial: THREE.MeshStandardMaterial;
  keycapBaseMaterial: THREE.MeshStandardMaterial;
  mouseShellMaterial: THREE.MeshStandardMaterial;
  caseFanBladesMesh: THREE.InstancedMesh;
  caseFanSlots: FanInstanceSlot[];
  gpuFanBladesMesh: THREE.InstancedMesh;
  gpuFanSlots: FanInstanceSlot[];
  powerState: OfficeComputerPowerState;
  rgbEnabled: boolean;
  rgbColor: THREE.Color;
  fanAngle: number;
}

interface KeycapSpec {
  x: number;
  z: number;
  wUnits: number;
  row: number;
  kind: 'alpha' | 'mod' | 'accent' | 'space';
}

// Scratch math objects for zero-allocation fan animation
const SCRATCH_POS = new THREE.Vector3();
const SCRATCH_QUAT = new THREE.Quaternion();
const SCRATCH_SPIN_QUAT = new THREE.Quaternion();
const SCRATCH_SCALE = new THREE.Vector3();
const SCRATCH_MAT4 = new THREE.Matrix4();
const LOCAL_Y_AXIS = new THREE.Vector3(0, 1, 0);

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

function createSculptedKeycapGeometry(): THREE.BufferGeometry {
  // Tapered 4-sided frustum rotated 45deg -> ~17.6mm base square on 19mm pitch for realistic 1.4mm gaps
  const geo = new THREE.CylinderGeometry(0.0094, 0.0124, 0.0080, 4, 1);
  geo.rotateY(Math.PI / 4);
  return geo;
}

function createFanBladeGeometry(): THREE.BufferGeometry {
  const geo = new THREE.BoxGeometry(0.011, 0.0022, 0.036);
  geo.translate(0, 0, 0.022);
  geo.rotateZ(0.36);
  return geo;
}

function updateFanInstancedMesh(
  mesh: THREE.InstancedMesh,
  slots: FanInstanceSlot[],
  baseAngle: number
): void {
  let instanceIdx = 0;
  for (let s = 0; s < slots.length; s += 1) {
    const slot = slots[s];
    const scaleFactor = slot.bladeRadius / 0.042;
    SCRATCH_SCALE.set(scaleFactor, 1, scaleFactor);
    const spinOffset = baseAngle * slot.speedMul + s * 0.47;

    for (let b = 0; b < slot.bladeCount; b += 1) {
      const bladeTheta = spinOffset + (b * Math.PI * 2) / slot.bladeCount;
      SCRATCH_SPIN_QUAT.setFromAxisAngle(LOCAL_Y_AXIS, bladeTheta);
      SCRATCH_QUAT.copy(slot.normalQuat).multiply(SCRATCH_SPIN_QUAT);
      SCRATCH_POS.copy(slot.center);
      SCRATCH_MAT4.compose(SCRATCH_POS, SCRATCH_QUAT, SCRATCH_SCALE);
      mesh.setMatrixAt(instanceIdx, SCRATCH_MAT4);
      instanceIdx += 1;
    }
  }
  mesh.instanceMatrix.needsUpdate = true;
}

function build75PercentKeySpecs(): KeycapSpec[] {
  const specs: KeycapSpec[] = [];
  const pitch = 0.019;
  const originX = -0.1534; // 16.15 units wide (~0.307m) centered symmetrically inside 0.336m bezel
  const originZ = -0.050;

  const pushRow = (
    rowIndex: number,
    zOffset: number,
    layout: Array<{ w: number; kind: KeycapSpec['kind']; gapAfter?: number }>
  ) => {
    let cursorU = 0;
    for (const item of layout) {
      const centerU = cursorU + item.w * 0.5;
      specs.push({
        x: originX + centerU * pitch,
        z: originZ + zOffset,
        wUnits: item.w,
        row: rowIndex,
        kind: item.kind,
      });
      cursorU += item.w + (item.gapAfter ?? 0);
    }
  };

  // Row 0: Function row with authentic gap above number row
  pushRow(0, 0, [
    { w: 1, kind: 'accent', gapAfter: 0.35 },
    { w: 1, kind: 'alpha' }, { w: 1, kind: 'alpha' }, { w: 1, kind: 'alpha' }, { w: 1, kind: 'alpha', gapAfter: 0.25 },
    { w: 1, kind: 'mod' }, { w: 1, kind: 'mod' }, { w: 1, kind: 'mod' }, { w: 1, kind: 'mod', gapAfter: 0.25 },
    { w: 1, kind: 'alpha' }, { w: 1, kind: 'alpha' }, { w: 1, kind: 'alpha' }, { w: 1, kind: 'alpha', gapAfter: 0.15 },
    { w: 1, kind: 'mod' }, { w: 1, kind: 'mod' },
  ]);

  // Row 1: Number row
  pushRow(1, 0.0215, [
    { w: 1, kind: 'mod' },
    ...Array.from({ length: 12 }, () => ({ w: 1, kind: 'alpha' as const })),
    { w: 2, kind: 'mod', gapAfter: 0.15 },
    { w: 1, kind: 'mod' },
  ]);

  // Row 2: QWERTY
  pushRow(2, 0.0405, [
    { w: 1.5, kind: 'mod' },
    ...Array.from({ length: 12 }, () => ({ w: 1, kind: 'alpha' as const })),
    { w: 1.5, kind: 'mod', gapAfter: 0.15 },
    { w: 1, kind: 'mod' },
  ]);

  // Row 3: Home row
  pushRow(3, 0.0595, [
    { w: 1.75, kind: 'mod' },
    ...Array.from({ length: 11 }, () => ({ w: 1, kind: 'alpha' as const })),
    { w: 2.25, kind: 'accent', gapAfter: 0.15 },
    { w: 1, kind: 'mod' },
  ]);

  // Row 4: Shift row + Up arrow
  pushRow(4, 0.0785, [
    { w: 2.25, kind: 'mod' },
    ...Array.from({ length: 10 }, () => ({ w: 1, kind: 'alpha' as const })),
    { w: 1.75, kind: 'mod', gapAfter: 0.15 },
    { w: 1, kind: 'accent' },
    { w: 1, kind: 'mod' },
  ]);

  // Row 5: Modifiers + Spacebar + Inverted-T Arrows (16.15u total)
  pushRow(5, 0.0975, [
    { w: 1.25, kind: 'mod' },
    { w: 1.25, kind: 'mod' },
    { w: 1.25, kind: 'mod' },
    { w: 6.25, kind: 'space' },
    { w: 1, kind: 'mod' },
    { w: 1, kind: 'mod' },
    { w: 1, kind: 'mod', gapAfter: 0.15 },
    { w: 1, kind: 'accent' },
    { w: 1, kind: 'accent' },
    { w: 1, kind: 'accent' },
  ]);

  return specs;
}

function buildTowerCaseAssembly(
  caseFrameMaterial: THREE.MeshStandardMaterial,
  caseInteriorMaterial: THREE.MeshStandardMaterial,
  glassMaterial: THREE.MeshPhysicalMaterial,
  pcbMaterial: THREE.MeshStandardMaterial,
  copperMaterial: THREE.MeshStandardMaterial,
  heatsinkMaterial: THREE.MeshStandardMaterial,
  gpuShroudMaterial: THREE.MeshStandardMaterial,
  rgbMaterial: THREE.MeshStandardMaterial,
  powerLedMaterial: THREE.MeshStandardMaterial,
  cableMaterial: THREE.MeshStandardMaterial
): {
  pcGroup: THREE.Group;
  caseFanBladesMesh: THREE.InstancedMesh;
  caseFanSlots: FanInstanceSlot[];
  gpuFanBladesMesh: THREE.InstancedMesh;
  gpuFanSlots: FanInstanceSlot[];
} {
  const pcGroup = new THREE.Group();
  // Showcase ATX mid-tower seated cleanly at left-front of desk, glass (-X) angled toward camera (+X/+Z)
  pcGroup.position.set(-0.87, 0.746, 0.28);
  pcGroup.rotation.y = 1.98;

  // 1. Machined Rubber-Tipped Case Feet (4x)
  const footGeo = new THREE.CylinderGeometry(0.017, 0.015, 0.016, 12);
  const footOffsets: Array<[number, number]> = [
    [-0.082, -0.174],
    [0.082, -0.174],
    [-0.082, 0.174],
    [0.082, 0.174],
  ];
  for (const [fx, fz] of footOffsets) {
    const foot = new THREE.Mesh(footGeo, caseFrameMaterial);
    foot.position.set(fx, 0.008, fz);
    foot.castShadow = true;
    pcGroup.add(foot);
  }

  // 2. Structural Open-Cavity Chassis Frame (NO solid box!)
  const bottomPlate = new THREE.Mesh(new THREE.BoxGeometry(0.208, 0.012, 0.420), caseFrameMaterial);
  bottomPlate.position.set(0, 0.022, 0);
  bottomPlate.castShadow = true;
  bottomPlate.receiveShadow = true;
  pcGroup.add(bottomPlate);

  // Right solid steel panel (+X)
  const rightPanel = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.402, 0.418), caseFrameMaterial);
  rightPanel.position.set(0.100, 0.228, 0);
  rightPanel.castShadow = true;
  rightPanel.receiveShadow = true;
  pcGroup.add(rightPanel);

  // Internal motherboard tray sheet (+X = 0.082)
  const mbTray = new THREE.Mesh(new THREE.BoxGeometry(0.004, 0.295, 0.365), caseInteriorMaterial);
  mbTray.position.set(0.082, 0.270, -0.015);
  pcGroup.add(mbTray);

  // Rear chassis wall (-Z = -0.205) with I/O cutout detail & expansion slot bars
  const rearTop = new THREE.Mesh(new THREE.BoxGeometry(0.206, 0.028, 0.010), caseFrameMaterial);
  rearTop.position.set(0, 0.415, -0.205);
  pcGroup.add(rearTop);

  const rearRightStrip = new THREE.Mesh(new THREE.BoxGeometry(0.044, 0.388, 0.010), caseFrameMaterial);
  rearRightStrip.position.set(0.081, 0.214, -0.205);
  pcGroup.add(rearRightStrip);

  const rearLeftPillar = new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.388, 0.012), caseFrameMaterial);
  rearLeftPillar.position.set(-0.092, 0.214, -0.205);
  rearLeftPillar.castShadow = true;
  pcGroup.add(rearLeftPillar);

  const rearMidBridge = new THREE.Mesh(new THREE.BoxGeometry(0.145, 0.018, 0.010), caseInteriorMaterial);
  rearMidBridge.position.set(-0.010, 0.246, -0.204);
  pcGroup.add(rearMidBridge);

  // PCIe Expansion slot ventilated brackets
  const pcieBracketGeo = new THREE.BoxGeometry(0.105, 0.008, 0.006);
  for (let s = 0; s < 5; s += 1) {
    const slotBar = new THREE.Mesh(pcieBracketGeo, heatsinkMaterial);
    slotBar.position.set(-0.014, 0.145 + s * 0.020, -0.205);
    pcGroup.add(slotBar);
  }

  // Front Structural Pillars & Perforated Mesh Bezel (+Z = +0.204)
  for (const side of [-1, 1]) {
    const frontPillar = new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.402, 0.020), caseFrameMaterial);
    frontPillar.position.set(side * 0.093, 0.228, 0.200);
    frontPillar.castShadow = true;
    pcGroup.add(frontPillar);
  }
  const frontTopBezel = new THREE.Mesh(new THREE.BoxGeometry(0.208, 0.028, 0.022), caseFrameMaterial);
  frontTopBezel.position.set(0, 0.415, 0.201);
  pcGroup.add(frontTopBezel);

  const frontBotBezel = new THREE.Mesh(new THREE.BoxGeometry(0.208, 0.030, 0.022), caseFrameMaterial);
  frontBotBezel.position.set(0, 0.037, 0.201);
  pcGroup.add(frontBotBezel);

  // Perforated dark acoustic mesh over front intake (translucent enough to show front RGB fans!)
  const frontMeshMat = new THREE.MeshStandardMaterial({
    color: '#0e141d',
    roughness: 0.72,
    metalness: 0.35,
    transparent: true,
    opacity: 0.56,
  });
  const frontMesh = new THREE.Mesh(new THREE.BoxGeometry(0.164, 0.350, 0.005), frontMeshMat);
  frontMesh.position.set(0, 0.226, 0.207);
  pcGroup.add(frontMesh);

  // Subtle vertical RGB front light accent strip
  const frontAccentBar = new THREE.Mesh(new THREE.BoxGeometry(0.006, 0.348, 0.006), rgbMaterial);
  frontAccentBar.position.set(-0.082, 0.226, 0.210);
  pcGroup.add(frontAccentBar);

  // Top Frame + Recessed Radiator Filter + Top Front I/O
  const topLeftRail = new THREE.Mesh(new THREE.BoxGeometry(0.028, 0.014, 0.418), caseFrameMaterial);
  topLeftRail.position.set(-0.090, 0.425, 0);
  topLeftRail.castShadow = true;
  pcGroup.add(topLeftRail);

  const topRightRail = new THREE.Mesh(new THREE.BoxGeometry(0.028, 0.014, 0.418), caseFrameMaterial);
  topRightRail.position.set(0.090, 0.425, 0);
  pcGroup.add(topRightRail);

  const topFrontDeck = new THREE.Mesh(new THREE.BoxGeometry(0.156, 0.014, 0.072), caseFrameMaterial);
  topFrontDeck.position.set(0, 0.425, 0.173);
  pcGroup.add(topFrontDeck);

  const topRearDeck = new THREE.Mesh(new THREE.BoxGeometry(0.156, 0.014, 0.068), caseFrameMaterial);
  topRearDeck.position.set(0, 0.425, -0.175);
  pcGroup.add(topRearDeck);

  const topMesh = new THREE.Mesh(new THREE.BoxGeometry(0.152, 0.004, 0.278), frontMeshMat);
  topMesh.position.set(0, 0.430, -0.002);
  pcGroup.add(topMesh);

  // Top Front I/O: Power button + illuminated status ring + USB-A / USB-C
  const powerBtnRing = new THREE.Mesh(new THREE.TorusGeometry(0.0085, 0.002, 8, 16), powerLedMaterial);
  powerBtnRing.rotation.x = Math.PI / 2;
  powerBtnRing.position.set(-0.048, 0.433, 0.178);
  pcGroup.add(powerBtnRing);

  const powerBtnCap = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.003, 12), heatsinkMaterial);
  powerBtnCap.position.set(-0.048, 0.433, 0.178);
  pcGroup.add(powerBtnCap);

  const usbPortGeo = new THREE.BoxGeometry(0.012, 0.003, 0.006);
  for (let u = 0; u < 2; u += 1) {
    const usb = new THREE.Mesh(usbPortGeo, heatsinkMaterial);
    usb.position.set(-0.018 + u * 0.020, 0.433, 0.178);
    pcGroup.add(usb);
  }
  const usbc = new THREE.Mesh(new THREE.BoxGeometry(0.009, 0.003, 0.004), copperMaterial);
  usbc.position.set(0.024, 0.433, 0.178);
  pcGroup.add(usbc);

  // 3. PSU Shroud + Visible PSU Unit through Side Window
  const shroudTopDeck = new THREE.Mesh(new THREE.BoxGeometry(0.172, 0.006, 0.398), caseInteriorMaterial);
  shroudTopDeck.position.set(-0.008, 0.114, -0.005);
  shroudTopDeck.receiveShadow = true;
  pcGroup.add(shroudTopDeck);

  // Front half of shroud wall (leaving rear PSU inspection window open!)
  const shroudFrontWall = new THREE.Mesh(new THREE.BoxGeometry(0.006, 0.088, 0.215), caseInteriorMaterial);
  shroudFrontWall.position.set(-0.092, 0.070, 0.088);
  pcGroup.add(shroudFrontWall);

  // PSU Unit housing visible in rear cutout
  const psuHousing = new THREE.Mesh(new THREE.BoxGeometry(0.140, 0.082, 0.155), gpuShroudMaterial);
  psuHousing.position.set(0.004, 0.070, -0.120);
  pcGroup.add(psuHousing);

  const psuBadgePlate = new THREE.Mesh(new THREE.BoxGeometry(0.004, 0.042, 0.095), heatsinkMaterial);
  psuBadgePlate.position.set(-0.067, 0.072, -0.115);
  pcGroup.add(psuBadgePlate);

  const psuAccentStripe = new THREE.Mesh(new THREE.BoxGeometry(0.004, 0.008, 0.085), rgbMaterial);
  psuAccentStripe.position.set(-0.068, 0.058, -0.115);
  pcGroup.add(psuAccentStripe);

  // Shroud rubber cable pass-through grommet
  const grommet = new THREE.Mesh(new THREE.BoxGeometry(0.032, 0.008, 0.046), caseFrameMaterial);
  grommet.position.set(-0.036, 0.117, 0.070);
  pcGroup.add(grommet);

  // 4. Motherboard + Brass Standoffs + Instanced Copper Traces + Heatsinks + CPU Cooler + RAM
  const pcb = new THREE.Mesh(new THREE.BoxGeometry(0.005, 0.285, 0.235), pcbMaterial);
  pcb.position.set(0.068, 0.264, -0.045);
  pcGroup.add(pcb);

  const standoffGeo = new THREE.CylinderGeometry(0.003, 0.003, 0.012, 6);
  standoffGeo.rotateZ(Math.PI / 2);
  for (const [sy, sz] of [
    [0.145, -0.145],
    [0.145, 0.055],
    [0.385, -0.145],
    [0.385, 0.055],
  ] as const) {
    const standoff = new THREE.Mesh(standoffGeo, copperMaterial);
    standoff.position.set(0.075, sy, sz);
    pcGroup.add(standoff);
  }

  // Instanced Copper PCB Traces (22 traces in 1 draw call)
  const traceDefs: Array<{ y: number; z: number; lenZ: number; rotX: number; thick: number }> = [
    // DDR memory bus traces (between CPU socket & RAM)
    ...Array.from({ length: 8 }, (_, idx) => ({
      y: 0.284 + idx * 0.008,
      z: 0.005,
      lenZ: 0.042,
      rotX: 0,
      thick: 0.0018,
    })),
    // PCIe lanes descending from CPU to primary GPU slot
    ...Array.from({ length: 8 }, (_, idx) => ({
      y: 0.246,
      z: -0.088 + idx * 0.009,
      lenZ: 0.056,
      rotX: Math.PI / 2,
      thick: 0.0018,
    })),
    // Lower chipset / audio routing traces
    { y: 0.165, z: -0.025, lenZ: 0.095, rotX: 0, thick: 0.0022 },
    { y: 0.156, z: -0.032, lenZ: 0.085, rotX: 0, thick: 0.0020 },
    { y: 0.148, z: -0.095, lenZ: 0.048, rotX: 0.48, thick: 0.0020 },
    { y: 0.175, z: 0.020, lenZ: 0.050, rotX: -0.45, thick: 0.0020 },
    { y: 0.345, z: -0.015, lenZ: 0.068, rotX: 0.32, thick: 0.0022 },
    { y: 0.352, z: -0.022, lenZ: 0.060, rotX: 0.32, thick: 0.0020 },
  ];
  const traceMesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(0.0015, 1, 1),
    copperMaterial,
    traceDefs.length
  );
  const traceDummy = new THREE.Object3D();
  traceDefs.forEach((tr, i) => {
    traceDummy.position.set(0.065, tr.y, tr.z);
    traceDummy.rotation.set(tr.rotX, 0, 0);
    traceDummy.scale.set(1, tr.thick, tr.lenZ);
    traceDummy.updateMatrix();
    traceMesh.setMatrixAt(i, traceDummy.matrix);
  });
  traceMesh.instanceMatrix.needsUpdate = true;
  traceMesh.computeBoundingSphere();
  pcGroup.add(traceMesh);

  // VRM Heatsinks & Rear I/O Armor + PCH Chipset Heatsink
  const ioArmor = new THREE.Mesh(new THREE.BoxGeometry(0.032, 0.115, 0.036), gpuShroudMaterial);
  ioArmor.position.set(0.050, 0.335, -0.140);
  pcGroup.add(ioArmor);

  const topVrm = new THREE.Mesh(new THREE.BoxGeometry(0.026, 0.026, 0.105), heatsinkMaterial);
  topVrm.position.set(0.053, 0.382, -0.055);
  pcGroup.add(topVrm);

  const pchSink = new THREE.Mesh(new THREE.BoxGeometry(0.014, 0.056, 0.064), heatsinkMaterial);
  pchSink.position.set(0.059, 0.165, 0.034);
  pcGroup.add(pchSink);

  // M.2 NVMe Slot & Armored Heatsink
  const m2Sink = new THREE.Mesh(new THREE.BoxGeometry(0.010, 0.020, 0.084), heatsinkMaterial);
  m2Sink.position.set(0.061, 0.244, -0.058);
  pcGroup.add(m2Sink);

  // 2x Armored PCIe x16 Slots
  const pcieSlotGeo = new THREE.BoxGeometry(0.012, 0.010, 0.095);
  const pcieSlot1 = new THREE.Mesh(pcieSlotGeo, heatsinkMaterial);
  pcieSlot1.position.set(0.061, 0.214, -0.088);
  pcGroup.add(pcieSlot1);

  const pcieSlot2 = new THREE.Mesh(pcieSlotGeo, heatsinkMaterial);
  pcieSlot2.position.set(0.061, 0.156, -0.088);
  pcGroup.add(pcieSlot2);

  // CPU Tower Air Cooler: copper base + 4 heatpipes + 12 instanced aluminum fins + top cap
  const cpuColdplate = new THREE.Mesh(new THREE.BoxGeometry(0.016, 0.044, 0.044), copperMaterial);
  cpuColdplate.position.set(0.058, 0.312, -0.058);
  pcGroup.add(cpuColdplate);

  const heatpipeGeo = new THREE.CylinderGeometry(0.0028, 0.0028, 0.072, 8);
  heatpipeGeo.rotateZ(Math.PI / 2);
  for (let hp = 0; hp < 4; hp += 1) {
    const pipe = new THREE.Mesh(heatpipeGeo, copperMaterial);
    pipe.position.set(0.024, 0.290 + hp * 0.014, -0.080);
    pcGroup.add(pipe);
    const pipe2 = new THREE.Mesh(heatpipeGeo, copperMaterial);
    pipe2.position.set(0.024, 0.290 + hp * 0.014, -0.036);
    pcGroup.add(pipe2);
  }

  // Instanced Cooling Fin Stack (12 parallel aluminum plates in 1 draw call)
  const finCount = 12;
  const finStack = new THREE.InstancedMesh(
    new THREE.BoxGeometry(0.066, 0.0022, 0.084),
    heatsinkMaterial,
    finCount
  );
  const finDummy = new THREE.Object3D();
  for (let f = 0; f < finCount; f += 1) {
    finDummy.position.set(0.014, 0.275 + f * 0.0068, -0.058);
    finDummy.rotation.set(0, 0, 0);
    finDummy.scale.set(1, 1, 1);
    finDummy.updateMatrix();
    finStack.setMatrixAt(f, finDummy.matrix);
  }
  finStack.instanceMatrix.needsUpdate = true;
  finStack.computeBoundingSphere();
  pcGroup.add(finStack);

  // Cooler top plate facing glass (-X) + subtle RGB emblem ring
  const coolerCap = new THREE.Mesh(new THREE.BoxGeometry(0.005, 0.084, 0.088), gpuShroudMaterial);
  coolerCap.position.set(-0.021, 0.312, -0.058);
  pcGroup.add(coolerCap);

  const coolerRgbRing = new THREE.Mesh(new THREE.BoxGeometry(0.004, 0.052, 0.008), rgbMaterial);
  coolerRgbRing.position.set(-0.024, 0.312, -0.058);
  pcGroup.add(coolerRgbRing);

  // Cooler side fan housing facing front (+Z)
  const coolerFanBox = new THREE.Mesh(new THREE.BoxGeometry(0.064, 0.082, 0.016), caseInteriorMaterial);
  coolerFanBox.position.set(0.014, 0.312, -0.006);
  pcGroup.add(coolerFanBox);

  // 4x Populated RAM DIMM Sticks with Heatspreaders & RGB Lightbars
  const dimmSlotGeo = new THREE.BoxGeometry(0.006, 0.118, 0.005);
  const ramStickGeo = new THREE.BoxGeometry(0.032, 0.114, 0.005);
  const ramRgbGeo = new THREE.BoxGeometry(0.005, 0.112, 0.004);
  for (let r = 0; r < 4; r += 1) {
    const rz = 0.018 + r * 0.013;
    const slot = new THREE.Mesh(dimmSlotGeo, caseInteriorMaterial);
    slot.position.set(0.062, 0.312, rz);
    pcGroup.add(slot);

    const stick = new THREE.Mesh(ramStickGeo, gpuShroudMaterial);
    stick.position.set(0.044, 0.312, rz);
    pcGroup.add(stick);

    const ramLight = new THREE.Mesh(ramRgbGeo, rgbMaterial);
    ramLight.position.set(0.026, 0.312, rz);
    pcGroup.add(ramLight);
  }

  // 5. Dedicated Triple-Fan GPU Assembly (mounted horizontally in PCIe x16 slot)
  const gpuGroup = new THREE.Group();
  gpuGroup.position.set(0.004, 0.210, -0.050);
  pcGroup.add(gpuGroup);

  // Metal GPU Backplate (top face)
  const gpuBackplate = new THREE.Mesh(new THREE.BoxGeometry(0.112, 0.004, 0.268), heatsinkMaterial);
  gpuBackplate.position.set(0, 0.017, 0);
  gpuGroup.add(gpuBackplate);

  // GPU PCB substrate
  const gpuPcb = new THREE.Mesh(new THREE.BoxGeometry(0.106, 0.004, 0.220), pcbMaterial);
  gpuPcb.position.set(0.002, 0.012, -0.020);
  gpuGroup.add(gpuPcb);

  // GPU Exposed Heatsink Fin Array (14 instanced fins visible through glass side!)
  const gpuFinCount = 14;
  const gpuFins = new THREE.InstancedMesh(
    new THREE.BoxGeometry(0.102, 0.022, 0.0024),
    heatsinkMaterial,
    gpuFinCount
  );
  const gpuFinDummy = new THREE.Object3D();
  for (let gf = 0; gf < gpuFinCount; gf += 1) {
    gpuFinDummy.position.set(0, -0.002, -0.118 + gf * 0.018);
    gpuFinDummy.rotation.set(0, 0, 0);
    gpuFinDummy.scale.set(1, 1, 1);
    gpuFinDummy.updateMatrix();
    gpuFins.setMatrixAt(gf, gpuFinDummy.matrix);
  }
  gpuFins.instanceMatrix.needsUpdate = true;
  gpuFins.computeBoundingSphere();
  gpuGroup.add(gpuFins);

  // Twin Visible Copper Heatpipes along GPU side edge facing tempered glass (-X)
  const gpuPipeGeo = new THREE.CylinderGeometry(0.0032, 0.0032, 0.236, 8);
  gpuPipeGeo.rotateX(Math.PI / 2);
  const gpuPipe1 = new THREE.Mesh(gpuPipeGeo, copperMaterial);
  gpuPipe1.position.set(-0.053, 0.004, -0.002);
  gpuGroup.add(gpuPipe1);
  const gpuPipe2 = new THREE.Mesh(gpuPipeGeo, copperMaterial);
  gpuPipe2.position.set(-0.053, -0.007, -0.002);
  gpuGroup.add(gpuPipe2);

  // Sculpted GPU Shroud Skirt & Side Faceplate with RGB Strip
  const gpuSideTopRail = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.012, 0.270), gpuShroudMaterial);
  gpuSideTopRail.position.set(-0.052, 0.012, 0);
  gpuGroup.add(gpuSideTopRail);

  const gpuSideBotRail = new THREE.Mesh(new THREE.BoxGeometry(0.014, 0.010, 0.270), gpuShroudMaterial);
  gpuSideBotRail.position.set(-0.052, -0.018, 0);
  gpuGroup.add(gpuSideBotRail);

  const gpuFrontNose = new THREE.Mesh(new THREE.BoxGeometry(0.112, 0.036, 0.022), gpuShroudMaterial);
  gpuFrontNose.position.set(0, -0.002, 0.125);
  gpuGroup.add(gpuFrontNose);

  // GPU RGB Side Lightbar facing glass
  const gpuRgbBar = new THREE.Mesh(new THREE.BoxGeometry(0.005, 0.006, 0.145), rgbMaterial);
  gpuRgbBar.position.set(-0.058, 0.012, 0.018);
  gpuGroup.add(gpuRgbBar);

  // Lower Shroud Plate with 3 Axial Fan Rings + Hubs
  const gpuFanRingGeo = new THREE.TorusGeometry(0.036, 0.004, 8, 20);
  gpuFanRingGeo.rotateX(Math.PI / 2);
  const gpuHubGeo = new THREE.CylinderGeometry(0.010, 0.010, 0.008, 12);
  const gpuFanSlots: FanInstanceSlot[] = [];
  const downQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI, 0, 0));

  for (let gf = 0; gf < 3; gf += 1) {
    const fz = -0.080 + gf * 0.080;
    const fRing = new THREE.Mesh(gpuFanRingGeo, gpuShroudMaterial);
    fRing.position.set(-0.002, -0.020, fz);
    gpuGroup.add(fRing);

    const fHub = new THREE.Mesh(gpuHubGeo, caseFrameMaterial);
    fHub.position.set(-0.002, -0.020, fz);
    gpuGroup.add(fHub);

    gpuFanSlots.push({
      center: new THREE.Vector3(-0.002, -0.020, fz),
      normalQuat: downQuat.clone(),
      bladeRadius: 0.032,
      bladeCount: 7,
      speedMul: 1.45,
    });
  }

  const bladeGeo = createFanBladeGeometry();
  const gpuFanBladesMesh = new THREE.InstancedMesh(
    bladeGeo,
    caseInteriorMaterial,
    gpuFanSlots.length * 7
  );
  updateFanInstancedMesh(gpuFanBladesMesh, gpuFanSlots, 0);
  gpuFanBladesMesh.computeBoundingSphere();
  gpuGroup.add(gpuFanBladesMesh);

  // 8-pin PCIe Power Header + Braided Cable curving down into PSU shroud grommet
  const pcieHeader = new THREE.Mesh(new THREE.BoxGeometry(0.014, 0.012, 0.028), caseInteriorMaterial);
  pcieHeader.position.set(-0.044, 0.018, 0.072);
  gpuGroup.add(pcieHeader);

  const gpuCableCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-0.044, 0.228, 0.022),
    new THREE.Vector3(-0.068, 0.190, 0.048),
    new THREE.Vector3(-0.056, 0.145, 0.068),
    new THREE.Vector3(-0.036, 0.116, 0.070),
  ]);
  const gpuCable = new THREE.Mesh(
    new THREE.TubeGeometry(gpuCableCurve, 12, 0.0055, 6, false),
    cableMaterial
  );
  pcGroup.add(gpuCable);

  // 24-pin ATX Motherboard Power Cable curving cleanly into tray slot
  const atxCableCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0.054, 0.285, 0.068),
    new THREE.Vector3(0.034, 0.285, 0.095),
    new THREE.Vector3(0.068, 0.265, 0.116),
  ]);
  const atxCable = new THREE.Mesh(
    new THREE.TubeGeometry(atxCableCurve, 10, 0.007, 6, false),
    cableMaterial
  );
  pcGroup.add(atxCable);

  // 6. 6x Case Cooling Fans (3 Front Intake, 2 Top Exhaust, 1 Rear Exhaust) with Optional RGB Halo Rings
  const caseFanSlots: FanInstanceSlot[] = [];
  const fanHousingGeo = new THREE.TorusGeometry(0.048, 0.0055, 8, 22);
  const fanHaloGeo = new THREE.TorusGeometry(0.044, 0.0028, 6, 22);
  const fanHubGeo = new THREE.CylinderGeometry(0.012, 0.012, 0.010, 12);

  const addCaseFan = (
    pos: THREE.Vector3,
    rotEuler: THREE.Euler,
    scale: number,
    speedMul: number
  ) => {
    const holder = new THREE.Group();
    holder.position.copy(pos);
    holder.rotation.copy(rotEuler);
    holder.scale.setScalar(scale);
    pcGroup.add(holder);

    // Torus lies in XY plane; align blade spin axis (local +Y) along holder's +Z normal
    const housing = new THREE.Mesh(fanHousingGeo, caseInteriorMaterial);
    holder.add(housing);

    const halo = new THREE.Mesh(fanHaloGeo, rgbMaterial);
    halo.position.z = 0.002;
    holder.add(halo);

    const hub = new THREE.Mesh(fanHubGeo, caseFrameMaterial);
    hub.rotation.x = Math.PI / 2;
    holder.add(hub);

    const normalQuat = new THREE.Quaternion().setFromEuler(rotEuler);
    const bladeAlign = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(1, 0, 0),
      Math.PI / 2
    );
    normalQuat.multiply(bladeAlign);

    caseFanSlots.push({
      center: pos.clone(),
      normalQuat,
      bladeRadius: 0.040 * scale,
      bladeCount: 7,
      speedMul,
    });
  };

  // 3x Front Intake Fans (facing +Z)
  for (let i = 0; i < 3; i += 1) {
    addCaseFan(
      new THREE.Vector3(0, 0.115 + i * 0.110, 0.191),
      new THREE.Euler(0, 0, 0),
      1.0,
      1.0
    );
  }
  // 2x Top Exhaust Fans (facing -Y into case)
  for (let i = 0; i < 2; i += 1) {
    addCaseFan(
      new THREE.Vector3(0, 0.415, -0.072 + i * 0.112),
      new THREE.Euler(Math.PI / 2, 0, 0),
      0.95,
      0.92
    );
  }
  // 1x Rear Exhaust Fan (facing +Z inward)
  addCaseFan(
    new THREE.Vector3(-0.006, 0.322, -0.194),
    new THREE.Euler(0, 0, 0),
    0.9,
    1.1
  );

  const caseFanBladesMesh = new THREE.InstancedMesh(
    bladeGeo,
    caseInteriorMaterial,
    caseFanSlots.length * 7
  );
  updateFanInstancedMesh(caseFanBladesMesh, caseFanSlots, 0);
  caseFanBladesMesh.computeBoundingSphere();
  pcGroup.add(caseFanBladesMesh);

  // 7. Tempered Glass Side Panel (-X = -0.102) with Ceramic Border Frit & 4 Thumbscrews
  const glassGroup = new THREE.Group();
  glassGroup.position.set(-0.102, 0.228, 0);
  pcGroup.add(glassGroup);

  const glassPane = new THREE.Mesh(new THREE.BoxGeometry(0.004, 0.376, 0.388), glassMaterial);
  glassPane.userData.noShadow = true;
  glassGroup.add(glassPane);

  // Ceramic perimeter framing strips around tempered glass edge
  const fritHGeo = new THREE.BoxGeometry(0.005, 0.014, 0.390);
  const fritVGeo = new THREE.BoxGeometry(0.005, 0.352, 0.014);
  const fritTop = new THREE.Mesh(fritHGeo, caseInteriorMaterial);
  fritTop.position.set(0, 0.181, 0);
  glassGroup.add(fritTop);
  const fritBot = new THREE.Mesh(fritHGeo, caseInteriorMaterial);
  fritBot.position.set(0, -0.181, 0);
  glassGroup.add(fritBot);
  const fritFront = new THREE.Mesh(fritVGeo, caseInteriorMaterial);
  fritFront.position.set(0, 0, 0.187);
  glassGroup.add(fritFront);
  const fritRear = new THREE.Mesh(fritVGeo, caseInteriorMaterial);
  fritRear.position.set(0, 0, -0.187);
  glassGroup.add(fritRear);

  // 4x Knurled Metallic Corner Thumbscrews
  const screwGeo = new THREE.CylinderGeometry(0.0065, 0.0065, 0.008, 10);
  screwGeo.rotateZ(Math.PI / 2);
  for (const sy of [-0.172, 0.172]) {
    for (const sz of [-0.176, 0.176]) {
      const screw = new THREE.Mesh(screwGeo, heatsinkMaterial);
      screw.position.set(-0.004, sy, sz);
      glassGroup.add(screw);
    }
  }

  return {
    pcGroup,
    caseFanBladesMesh,
    caseFanSlots,
    gpuFanBladesMesh,
    gpuFanSlots,
  };
}

function buildInputPeripheralsAssembly(
  deskMatMaterial: THREE.MeshStandardMaterial,
  matStitchMaterial: THREE.MeshStandardMaterial,
  keyboardShellMaterial: THREE.MeshStandardMaterial,
  keycapBaseMaterial: THREE.MeshStandardMaterial,
  mouseShellMaterial: THREE.MeshStandardMaterial,
  heatsinkMaterial: THREE.MeshStandardMaterial,
  rgbMaterial: THREE.MeshStandardMaterial,
  cableMaterial: THREE.MeshStandardMaterial,
  accentHex: string
): THREE.Group {
  const inputGroup = new THREE.Group();
  inputGroup.position.set(0.04, 0.746, 0.05);
  inputGroup.rotation.y = 1.82; // Front faces seated worker at (+0.52, -0.02)

  // 1. Rounded Stitched Desk Mat
  const matShape = createRoundedRectShape(0.58, 0.30, 0.024);
  const matGeo = new THREE.ExtrudeGeometry(matShape, {
    depth: 0.004,
    bevelEnabled: true,
    bevelThickness: 0.001,
    bevelSize: 0.001,
    bevelSegments: 1,
    curveSegments: 8,
  });
  matGeo.rotateX(Math.PI / 2);
  const deskMat = new THREE.Mesh(matGeo, deskMatMaterial);
  deskMat.position.set(0, 0.005, 0);
  deskMat.receiveShadow = true;
  inputGroup.add(deskMat);

  // Subtle perimeter stitch trim around desk mat
  const stitchTop = new THREE.Mesh(new THREE.BoxGeometry(0.556, 0.0015, 0.003), matStitchMaterial);
  stitchTop.position.set(0, 0.006, -0.145);
  inputGroup.add(stitchTop);
  const stitchBot = new THREE.Mesh(new THREE.BoxGeometry(0.556, 0.0015, 0.003), matStitchMaterial);
  stitchBot.position.set(0, 0.006, 0.145);
  inputGroup.add(stitchBot);

  // 2. 75% Aluminum Mechanical Keyboard (left-center of desk mat)
  const kbGroup = new THREE.Group();
  kbGroup.position.set(-0.075, 0.006, 0.01);
  inputGroup.add(kbGroup);

  const kbTiltGroup = new THREE.Group();
  kbTiltGroup.rotation.x = 0.065; // Ergonomic 4deg typing angle
  kbGroup.add(kbTiltGroup);

  // Aluminum bottom housing + top frame
  const kbBase = new THREE.Mesh(new THREE.BoxGeometry(0.336, 0.011, 0.130), keyboardShellMaterial);
  kbBase.position.set(0, 0.007, 0);
  kbBase.castShadow = true;
  kbTiltGroup.add(kbBase);

  // Recessed dark switch plate
  const switchPlate = new THREE.Mesh(new THREE.BoxGeometry(0.322, 0.003, 0.116), matStitchMaterial);
  switchPlate.position.set(0, 0.013, 0);
  kbTiltGroup.add(switchPlate);

  // Subtle side/front RGB underglow rim
  const kbRgbStrip = new THREE.Mesh(new THREE.BoxGeometry(0.339, 0.0028, 0.132), rgbMaterial);
  kbRgbStrip.position.set(0, 0.0035, 0);
  kbTiltGroup.add(kbRgbStrip);

  // Instanced Sculpted Keycaps (batched ~79 keys in 1 draw call!)
  const keySpecs = build75PercentKeySpecs();
  const keycapGeo = createSculptedKeycapGeometry();
  const keycapsMesh = new THREE.InstancedMesh(keycapGeo, keycapBaseMaterial, keySpecs.length);

  const keyDummy = new THREE.Object3D();
  const alphaColor = new THREE.Color('#303d52');
  const modColor = new THREE.Color('#1d2736');
  const spaceColor = new THREE.Color('#273447');
  const accentColor = new THREE.Color(accentHex);

  keySpecs.forEach((spec, idx) => {
    const scaleX = spec.wUnits === 1 ? 1.0 : (spec.wUnits * 0.019 - 0.0014) / 0.0176;
    // Slight cylindrical keycap row pitch sculpt (R0-R1 angled slightly back, R4-R5 forward)
    const rowPitch = spec.row <= 1 ? -0.09 : spec.row === 2 ? -0.03 : spec.row === 3 ? 0.02 : 0.07;
    keyDummy.position.set(spec.x, 0.0175, spec.z);
    keyDummy.rotation.set(rowPitch, 0, 0);
    keyDummy.scale.set(scaleX, spec.kind === 'space' ? 0.92 : 1.0, 1.0);
    keyDummy.updateMatrix();
    keycapsMesh.setMatrixAt(idx, keyDummy.matrix);

    const color = spec.kind === 'accent'
      ? accentColor
      : spec.kind === 'space'
        ? spaceColor
        : spec.kind === 'mod'
          ? modColor
          : alphaColor;
    keycapsMesh.setColorAt(idx, color);
  });
  keycapsMesh.instanceMatrix.needsUpdate = true;
  if (keycapsMesh.instanceColor) {
    keycapsMesh.instanceColor.needsUpdate = true;
  }
  keycapsMesh.computeBoundingSphere();
  kbTiltGroup.add(keycapsMesh);

  // Coiled Aviator USB-C Keyboard Cable running to rear edge of desk mat
  const coilPoints: THREE.Vector3[] = [];
  const coilTurns = 5.5;
  const coilSteps = 32;
  for (let i = 0; i <= coilSteps; i += 1) {
    const t = i / coilSteps;
    const angle = t * Math.PI * 2 * coilTurns;
    coilPoints.push(
      new THREE.Vector3(
        -0.11 + t * 0.085,
        0.008 + Math.sin(angle) * 0.005,
        -0.078 + Math.cos(angle) * 0.005
      )
    );
  }
  coilPoints.push(
    new THREE.Vector3(0.01, 0.006, -0.078),
    new THREE.Vector3(0.04, 0.005, -0.145)
  );
  const kbCable = new THREE.Mesh(
    new THREE.TubeGeometry(new THREE.CatmullRomCurve3(coilPoints), 36, 0.0022, 5, false),
    cableMaterial
  );
  kbGroup.add(kbCable);

  // Metallic Aviator Connector Coupler on coiled cable
  const aviator = new THREE.Mesh(new THREE.CylinderGeometry(0.0046, 0.0046, 0.022, 10), heatsinkMaterial);
  aviator.rotation.z = Math.PI / 2;
  aviator.position.set(-0.008, 0.008, -0.078);
  kbGroup.add(aviator);

  // 3. Sculpted Ergonomic Mouse + Charging Dock (right side of desk mat)
  const mouseGroup = new THREE.Group();
  mouseGroup.position.set(0.185, 0.006, 0.014);
  inputGroup.add(mouseGroup);

  // Lower mouse glide chassis
  const mouseChassisShape = createRoundedRectShape(0.056, 0.104, 0.024);
  const mouseChassisGeo = new THREE.ExtrudeGeometry(mouseChassisShape, {
    depth: 0.010,
    bevelEnabled: true,
    bevelThickness: 0.003,
    bevelSize: 0.003,
    bevelSegments: 2,
    curveSegments: 10,
  });
  mouseChassisGeo.rotateX(Math.PI / 2);
  const mouseChassis = new THREE.Mesh(mouseChassisGeo, mouseShellMaterial);
  mouseChassis.position.set(0, 0.013, 0);
  mouseChassis.castShadow = true;
  mouseGroup.add(mouseChassis);

  // Sculpted Rear Palm Dorsal Hump
  const palmHump = new THREE.Mesh(new THREE.SphereGeometry(0.029, 14, 10), mouseShellMaterial);
  palmHump.scale.set(0.95, 0.56, 1.32);
  palmHump.position.set(0, 0.019, 0.014);
  mouseGroup.add(palmHump);

  // Separate Left & Right Click Paddles (angled forward with crisp split gap)
  const paddleGeo = new THREE.BoxGeometry(0.023, 0.006, 0.044);
  const leftPaddle = new THREE.Mesh(paddleGeo, mouseShellMaterial);
  leftPaddle.position.set(-0.014, 0.021, -0.024);
  leftPaddle.rotation.x = 0.16;
  leftPaddle.rotation.z = 0.05;
  mouseGroup.add(leftPaddle);

  const rightPaddle = new THREE.Mesh(paddleGeo, mouseShellMaterial);
  rightPaddle.position.set(0.014, 0.021, -0.024);
  rightPaddle.rotation.x = 0.16;
  rightPaddle.rotation.z = -0.05;
  mouseGroup.add(rightPaddle);

  // Scroll Wheel with Metallic Rim & RGB Glow
  const scrollWheel = new THREE.Mesh(new THREE.CylinderGeometry(0.0075, 0.0075, 0.0065, 14), heatsinkMaterial);
  scrollWheel.rotation.z = Math.PI / 2;
  scrollWheel.position.set(0, 0.023, -0.027);
  mouseGroup.add(scrollWheel);

  const scrollTire = new THREE.Mesh(new THREE.CylinderGeometry(0.0080, 0.0080, 0.0038, 14), cableMaterial);
  scrollTire.rotation.z = Math.PI / 2;
  scrollTire.position.set(0, 0.023, -0.027);
  mouseGroup.add(scrollTire);

  // Side Thumb Buttons (2x on inner thumb wall)
  const thumbBtnGeo = new THREE.BoxGeometry(0.004, 0.006, 0.015);
  for (let tb = 0; tb < 2; tb += 1) {
    const tbtn = new THREE.Mesh(thumbBtnGeo, heatsinkMaterial);
    tbtn.position.set(-0.029, 0.016, -0.008 + tb * 0.019);
    mouseGroup.add(tbtn);
  }

  // Rear Mouse RGB Underglow Arc
  const mouseRgb = new THREE.Mesh(new THREE.TorusGeometry(0.024, 0.0022, 6, 16, Math.PI), rgbMaterial);
  mouseRgb.rotation.x = Math.PI / 2;
  mouseRgb.rotation.z = Math.PI;
  mouseRgb.position.set(0, 0.005, 0.028);
  mouseGroup.add(mouseRgb);

  // Sleek Magnetic Mouse Charging Dock behind mouse + neat cable
  const dock = new THREE.Mesh(new THREE.BoxGeometry(0.044, 0.010, 0.030), keyboardShellMaterial);
  dock.position.set(0.005, 0.005, -0.095);
  dock.rotation.x = -0.18;
  mouseGroup.add(dock);

  const dockLed = new THREE.Mesh(new THREE.BoxGeometry(0.032, 0.002, 0.004), rgbMaterial);
  dockLed.position.set(0.005, 0.002, -0.080);
  mouseGroup.add(dockLed);

  const mouseCordCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0.005, 0.006, -0.108),
    new THREE.Vector3(-0.008, 0.004, -0.140),
  ]);
  const mouseCord = new THREE.Mesh(
    new THREE.TubeGeometry(mouseCordCurve, 8, 0.0018, 5, false),
    cableMaterial
  );
  mouseGroup.add(mouseCord);

  return inputGroup;
}

function buildUnderDeskCableRig(
  caseFrameMaterial: THREE.MeshStandardMaterial,
  cableMaterial: THREE.MeshStandardMaterial
): THREE.Group {
  const cableGroup = new THREE.Group();

  // Rear desk pass-through cable grommet on desk top surface
  const grommetRing = new THREE.Mesh(
    new THREE.TorusGeometry(0.024, 0.004, 8, 16),
    caseFrameMaterial
  );
  grommetRing.rotation.x = Math.PI / 2;
  grommetRing.position.set(-0.62, 0.747, -0.30);
  cableGroup.add(grommetRing);

  // Suspended Under-Desk Metal Cable Management Raceway Tray
  const trayFloor = new THREE.Mesh(new THREE.BoxGeometry(0.84, 0.008, 0.095), caseFrameMaterial);
  trayFloor.position.set(-0.38, 0.625, -0.34);
  cableGroup.add(trayFloor);

  const trayLip = new THREE.Mesh(new THREE.BoxGeometry(0.84, 0.036, 0.008), caseFrameMaterial);
  trayLip.position.set(-0.38, 0.642, -0.295);
  cableGroup.add(trayLip);

  for (const bx of [-0.68, -0.08]) {
    const bracket = new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.095, 0.012), caseFrameMaterial);
    bracket.position.set(bx, 0.672, -0.385);
    cableGroup.add(bracket);
  }

  // Bundled DisplayPort + Power Cables routing cleanly from PC rear -> desk grommet -> under-desk raceway -> rear leg
  const cablePaths: Array<{ points: THREE.Vector3[]; radius: number }> = [
    // PC rear I/O sweeping into rear desk grommet & down into raceway
    {
      radius: 0.0055,
      points: [
        new THREE.Vector3(-1.04, 0.90, 0.34),
        new THREE.Vector3(-0.98, 0.78, 0.12),
        new THREE.Vector3(-0.78, 0.755, -0.16),
        new THREE.Vector3(-0.62, 0.74, -0.30),
        new THREE.Vector3(-0.58, 0.64, -0.34),
        new THREE.Vector3(-0.18, 0.635, -0.34),
      ],
    },
    // Monitor DisplayPort trunk from rear pole down through grommet to PC rear
    {
      radius: 0.0045,
      points: [
        new THREE.Vector3(-0.46, 0.86, -0.40),
        new THREE.Vector3(-0.56, 0.755, -0.33),
        new THREE.Vector3(-0.62, 0.74, -0.30),
        new THREE.Vector3(-0.80, 0.765, -0.14),
        new THREE.Vector3(-1.03, 0.88, 0.32),
      ],
    },
    // Main AC trunk descending neatly along rear-left desk leg to floor
    {
      radius: 0.006,
      points: [
        new THREE.Vector3(-0.62, 0.64, -0.34),
        new THREE.Vector3(-0.84, 0.63, -0.34),
        new THREE.Vector3(-0.93, 0.42, -0.35),
        new THREE.Vector3(-0.93, 0.06, -0.35),
      ],
    },
  ];

  for (const spec of cablePaths) {
    const curve = new THREE.CatmullRomCurve3(spec.points);
    const mesh = new THREE.Mesh(
      new THREE.TubeGeometry(curve, 16, spec.radius, 5, false),
      cableMaterial
    );
    cableGroup.add(mesh);
  }

  return cableGroup;
}

export function createDesktopComputerRig(
  palette: OfficeScenePalette,
  accentHex: string
): DesktopComputerRig {
  const root = new THREE.Group();

  const caseFrameMaterial = new THREE.MeshStandardMaterial({
    color: palette.mode === 'dark' ? '#1c2533' : '#2b394d',
    roughness: 0.34,
    metalness: 0.78,
  });
  const caseInteriorMaterial = new THREE.MeshStandardMaterial({
    color: '#111722',
    roughness: 0.72,
    metalness: 0.25,
  });
  const glassMaterial = new THREE.MeshPhysicalMaterial({
    color: '#bfe8ff',
    transparent: true,
    opacity: 0.20,
    roughness: 0.07,
    metalness: 0.06,
    ior: 1.5,
    reflectivity: 0.92,
    clearcoat: 1.0,
    clearcoatRoughness: 0.05,
    depthWrite: false,
  });
  const pcbMaterial = new THREE.MeshStandardMaterial({
    color: '#0c1824',
    roughness: 0.62,
    metalness: 0.14,
  });
  const copperMaterial = new THREE.MeshStandardMaterial({
    color: '#d2894a',
    roughness: 0.24,
    metalness: 0.88,
  });
  const heatsinkMaterial = new THREE.MeshStandardMaterial({
    color: '#a8bacd',
    roughness: 0.26,
    metalness: 0.86,
  });
  const gpuShroudMaterial = new THREE.MeshStandardMaterial({
    color: '#222d3d',
    roughness: 0.38,
    metalness: 0.48,
  });
  const rgbMaterial = new THREE.MeshStandardMaterial({
    color: '#00e5ff',
    emissive: '#00e5ff',
    emissiveIntensity: 1.35,
    roughness: 0.2,
    metalness: 0.1,
  });
  const powerLedMaterial = new THREE.MeshStandardMaterial({
    color: palette.successHex,
    emissive: palette.successHex,
    emissiveIntensity: 1.25,
    roughness: 0.25,
  });
  const cableMaterial = new THREE.MeshStandardMaterial({
    color: '#161e2b',
    roughness: 0.80,
    metalness: 0.08,
  });
  const deskMatMaterial = new THREE.MeshStandardMaterial({
    color: palette.deskMatHex,
    roughness: 0.86,
    metalness: 0.04,
  });
  const matStitchMaterial = new THREE.MeshStandardMaterial({
    color: palette.deskEdgeHex,
    roughness: 0.68,
    metalness: 0.18,
  });
  const keyboardShellMaterial = new THREE.MeshStandardMaterial({
    color: palette.mode === 'dark' ? '#243144' : '#334358',
    roughness: 0.34,
    metalness: 0.72,
  });
  const keycapBaseMaterial = new THREE.MeshStandardMaterial({
    color: '#ffffff',
    roughness: 0.68,
    metalness: 0.06,
  });
  const mouseShellMaterial = new THREE.MeshStandardMaterial({
    color: palette.mode === 'dark' ? '#1e2838' : '#2d3b4f',
    roughness: 0.38,
    metalness: 0.22,
  });

  const {
    pcGroup,
    caseFanBladesMesh,
    caseFanSlots,
    gpuFanBladesMesh,
    gpuFanSlots,
  } = buildTowerCaseAssembly(
    caseFrameMaterial,
    caseInteriorMaterial,
    glassMaterial,
    pcbMaterial,
    copperMaterial,
    heatsinkMaterial,
    gpuShroudMaterial,
    rgbMaterial,
    powerLedMaterial,
    cableMaterial
  );
  root.add(pcGroup);

  const inputGroup = buildInputPeripheralsAssembly(
    deskMatMaterial,
    matStitchMaterial,
    keyboardShellMaterial,
    keycapBaseMaterial,
    mouseShellMaterial,
    heatsinkMaterial,
    rgbMaterial,
    cableMaterial,
    accentHex
  );
  root.add(inputGroup);

  const cables = buildUnderDeskCableRig(caseFrameMaterial, cableMaterial);
  root.add(cables);

  return {
    root,
    caseFrameMaterial,
    caseInteriorMaterial,
    glassMaterial,
    pcbMaterial,
    copperMaterial,
    heatsinkMaterial,
    gpuShroudMaterial,
    rgbMaterial,
    powerLedMaterial,
    cableMaterial,
    deskMatMaterial,
    matStitchMaterial,
    keyboardShellMaterial,
    keycapBaseMaterial,
    mouseShellMaterial,
    caseFanBladesMesh,
    caseFanSlots,
    gpuFanBladesMesh,
    gpuFanSlots,
    powerState: 'on',
    rgbEnabled: true,
    rgbColor: new THREE.Color('#00e5ff'),
    fanAngle: 0,
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
  const normalizedHex = normalizeOfficeRgbColor(rgbColorHex);
  rig.rgbColor.set(normalizedHex);

  rig.caseFrameMaterial.color.set(palette.mode === 'dark' ? '#1c2533' : '#2b394d');
  rig.deskMatMaterial.color.set(palette.deskMatHex);
  rig.matStitchMaterial.color.set(palette.deskEdgeHex);
  rig.keyboardShellMaterial.color.set(palette.mode === 'dark' ? '#243144' : '#334358');
  rig.mouseShellMaterial.color.set(palette.mode === 'dark' ? '#1e2838' : '#2d3b4f');

  const rgbActive = power === 'on' && rgbEnabled;
  if (rgbActive) {
    rig.rgbMaterial.color.copy(rig.rgbColor);
    rig.rgbMaterial.emissive.copy(rig.rgbColor);
    rig.rgbMaterial.emissiveIntensity = availability === 'exited' ? 0.55 : 1.35;
  } else {
    rig.rgbMaterial.color.set('#1f2937');
    rig.rgbMaterial.emissive.set('#000000');
    rig.rgbMaterial.emissiveIntensity = 0;
  }

  let ledHex = palette.accentHex;
  let ledIntensity = 1.15;
  if (power === 'off') {
    ledHex = '#4b5563';
    ledIntensity = 0.08;
  } else if (availability === 'interactive') {
    ledHex = palette.successHex;
    ledIntensity = 1.35;
  } else if (availability === 'unavailable') {
    ledHex = palette.warningHex;
    ledIntensity = 0.95;
  } else if (availability === 'exited') {
    ledHex = palette.screenMutedHex;
    ledIntensity = 0.22;
  }
  rig.powerLedMaterial.color.set(ledHex);
  rig.powerLedMaterial.emissive.set(ledHex);
  rig.powerLedMaterial.emissiveIntensity = ledIntensity;
}

export function animateDesktopComputerRig(
  rig: DesktopComputerRig,
  elapsedSec: number,
  dtSec: number,
  reducedMotion: boolean
): void {
  if (rig.powerState !== 'on' || reducedMotion) {
    return;
  }

  rig.fanAngle = (rig.fanAngle + dtSec * 8.5) % (Math.PI * 200);
  updateFanInstancedMesh(rig.caseFanBladesMesh, rig.caseFanSlots, rig.fanAngle);
  updateFanInstancedMesh(rig.gpuFanBladesMesh, rig.gpuFanSlots, rig.fanAngle);

  if (rig.rgbEnabled) {
    const breath = 1.15 + Math.sin(elapsedSec * 2.4) * 0.24;
    rig.rgbMaterial.emissiveIntensity = breath;
  }
}
