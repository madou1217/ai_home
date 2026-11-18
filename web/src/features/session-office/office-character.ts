import * as THREE from 'three';
import type {
  EmployeeVisualPersona,
  OfficeSessionItem,
  SessionAvailability,
} from './session-office-types';
import type { OfficeScenePalette } from './office-scene-types';

export interface OfficeCharacterRig {
  root: THREE.Group;
  pelvis: THREE.Group;
  spine: THREE.Group;
  neck: THREE.Group;
  head: THREE.Group;
  eyelidLeft: THREE.Mesh;
  eyelidRight: THREE.Mesh;
  leftShoulder: THREE.Group;
  leftElbow: THREE.Group;
  leftWrist: THREE.Group;
  rightShoulder: THREE.Group;
  rightElbow: THREE.Group;
  rightWrist: THREE.Group;
  leftUpperLeg: THREE.Group;
  leftLowerLeg: THREE.Group;
  rightUpperLeg: THREE.Group;
  rightLowerLeg: THREE.Group;
  visorGroup: THREE.Group;
  glassesGroup: THREE.Group;
  headsetGroup: THREE.Group;
  jacketMaterial: THREE.MeshStandardMaterial;
  shirtMaterial: THREE.MeshStandardMaterial;
  trouserMaterial: THREE.MeshStandardMaterial;
  shoeMaterial: THREE.MeshStandardMaterial;
  skinMaterial: THREE.MeshStandardMaterial;
  hairMaterial: THREE.MeshStandardMaterial;
  visorGlowMaterial: THREE.MeshStandardMaterial;
  badgeLedMaterial: THREE.MeshStandardMaterial;
  baseJacketColor: THREE.Color;
  baseTrouserColor: THREE.Color;
  baseAccentColor: THREE.Color;
  phaseOffset: number;
  availability: SessionAvailability;
  posture: EmployeeVisualPersona['posture'];
  recentPulse: boolean;
}

const SKIN_TONES = [
  '#f0c7a8',
  '#e4b18e',
  '#d29972',
  '#b87d56',
  '#8b5a3c',
  '#f4d2ba',
] as const;

const HAIR_TONES = [
  '#1b1d24',
  '#2d221c',
  '#453124',
  '#61442c',
  '#2c3442',
  '#8c6b48',
] as const;

function hashText(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function tagTree(object: THREE.Object3D, sessionKey: string): void {
  object.traverse((child) => {
    child.userData.sessionKey = sessionKey;
    child.userData.hitKind = 'station';
    if (child instanceof THREE.Mesh) {
      child.castShadow = true;
      child.receiveShadow = true;
    }
  });
}

function buildLimbCylinder(
  radiusTop: number,
  radiusBottom: number,
  length: number,
  material: THREE.Material
): THREE.Mesh {
  const geometry = new THREE.CylinderGeometry(radiusTop, radiusBottom, length, 12);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.y = -length / 2;
  return mesh;
}

function buildShoe(
  shoeMaterial: THREE.MeshStandardMaterial,
  soleMaterial: THREE.MeshStandardMaterial
): THREE.Group {
  const shoe = new THREE.Group();

  const sole = new THREE.Mesh(new THREE.BoxGeometry(0.096, 0.02, 0.21), soleMaterial);
  sole.position.set(0, -0.052, 0.048);
  shoe.add(sole);

  const upper = new THREE.Mesh(new THREE.BoxGeometry(0.088, 0.042, 0.175), shoeMaterial);
  upper.position.set(0, -0.024, 0.038);
  shoe.add(upper);

  const toeCap = new THREE.Mesh(
    new THREE.SphereGeometry(0.044, 10, 8),
    shoeMaterial
  );
  toeCap.scale.set(1.0, 0.56, 1.35);
  toeCap.position.set(0, -0.029, 0.118);
  shoe.add(toeCap);

  return shoe;
}

function buildHand(skinMaterial: THREE.MeshStandardMaterial): THREE.Group {
  const hand = new THREE.Group();

  const palm = new THREE.Mesh(new THREE.BoxGeometry(0.056, 0.022, 0.068), skinMaterial);
  palm.position.set(0, 0, 0.032);
  hand.add(palm);

  const fingers = new THREE.Mesh(new THREE.BoxGeometry(0.052, 0.018, 0.042), skinMaterial);
  fingers.position.set(0, -0.004, 0.078);
  fingers.rotation.x = 0.22;
  hand.add(fingers);

  const thumb = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.018, 0.036), skinMaterial);
  thumb.position.set(0.032, -0.002, 0.036);
  thumb.rotation.y = 0.35;
  hand.add(thumb);

  return hand;
}

function buildHairGroup(
  variant: number,
  hairMaterial: THREE.MeshStandardMaterial
): THREE.Group {
  const group = new THREE.Group();

  // Base cranium cap
  const cap = new THREE.Mesh(
    new THREE.SphereGeometry(0.114, 16, 14, 0, Math.PI * 2, 0, Math.PI * 0.58),
    hairMaterial
  );
  cap.scale.set(0.92, 1.03, 0.98);
  cap.position.set(0, 0.012, -0.01);
  cap.rotation.x = -0.18;
  group.add(cap);

  // Back hair layer
  const backHair = new THREE.Mesh(new THREE.BoxGeometry(0.185, 0.125, 0.085), hairMaterial);
  backHair.position.set(0, -0.018, -0.072);
  group.add(backHair);

  if (variant === 0) {
    // Side-parted swept crop
    const crownSweep = new THREE.Mesh(new THREE.BoxGeometry(0.165, 0.048, 0.145), hairMaterial);
    crownSweep.position.set(0.014, 0.094, 0.016);
    crownSweep.rotation.z = -0.14;
    crownSweep.rotation.x = 0.1;
    group.add(crownSweep);

    const sideLeft = new THREE.Mesh(new THREE.BoxGeometry(0.028, 0.082, 0.065), hairMaterial);
    sideLeft.position.set(-0.094, 0.015, 0.005);
    group.add(sideLeft);
    const sideRight = new THREE.Mesh(new THREE.BoxGeometry(0.028, 0.082, 0.065), hairMaterial);
    sideRight.position.set(0.094, 0.015, 0.005);
    group.add(sideRight);
  } else if (variant === 1) {
    // Textured bangs & fuller crown
    const bangs = new THREE.Mesh(new THREE.BoxGeometry(0.175, 0.044, 0.064), hairMaterial);
    bangs.position.set(0, 0.074, 0.076);
    bangs.rotation.x = 0.25;
    group.add(bangs);

    const topVolume = new THREE.Mesh(new THREE.SphereGeometry(0.096, 12, 10), hairMaterial);
    topVolume.scale.set(0.98, 0.48, 1.05);
    topVolume.position.set(0, 0.092, 0.0);
    group.add(topVolume);
  } else {
    // Sleek bob with back bun
    const sideBobL = new THREE.Mesh(new THREE.BoxGeometry(0.036, 0.125, 0.105), hairMaterial);
    sideBobL.position.set(-0.095, -0.008, -0.006);
    group.add(sideBobL);
    const sideBobR = new THREE.Mesh(new THREE.BoxGeometry(0.036, 0.125, 0.105), hairMaterial);
    sideBobR.position.set(0.095, -0.008, -0.006);
    group.add(sideBobR);

    const bun = new THREE.Mesh(new THREE.SphereGeometry(0.052, 12, 10), hairMaterial);
    bun.position.set(0, 0.032, -0.125);
    group.add(bun);
  }

  return group;
}

function buildEyewearGroups(
  frameMaterial: THREE.MeshStandardMaterial,
  visorGlowMaterial: THREE.MeshStandardMaterial,
  padMaterial: THREE.MeshStandardMaterial
): {
  visorGroup: THREE.Group;
  glassesGroup: THREE.Group;
  headsetGroup: THREE.Group;
} {
  // 1. AR Visor
  const visorGroup = new THREE.Group();
  const visorShield = new THREE.Mesh(new THREE.BoxGeometry(0.186, 0.046, 0.026), visorGlowMaterial);
  visorShield.position.set(0, 0.015, 0.104);
  visorGroup.add(visorShield);

  const visorBridge = new THREE.Mesh(new THREE.BoxGeometry(0.194, 0.012, 0.022), frameMaterial);
  visorBridge.position.set(0, 0.039, 0.102);
  visorGroup.add(visorBridge);

  const templeL = new THREE.Mesh(new THREE.BoxGeometry(0.014, 0.014, 0.115), frameMaterial);
  templeL.position.set(-0.098, 0.02, 0.044);
  visorGroup.add(templeL);
  const templeR = new THREE.Mesh(new THREE.BoxGeometry(0.014, 0.014, 0.115), frameMaterial);
  templeR.position.set(0.098, 0.02, 0.044);
  visorGroup.add(templeR);

  // 2. Optical Glasses
  const glassesGroup = new THREE.Group();
  const lensMat = new THREE.MeshStandardMaterial({
    color: '#9adbf2',
    transparent: true,
    opacity: 0.28,
    roughness: 0.1,
    metalness: 0.2,
  });
  const makeLens = (x: number) => {
    const rim = new THREE.Mesh(new THREE.BoxGeometry(0.058, 0.036, 0.012), frameMaterial);
    rim.position.set(x, 0.014, 0.106);
    glassesGroup.add(rim);
    const glass = new THREE.Mesh(new THREE.PlaneGeometry(0.048, 0.026), lensMat);
    glass.position.set(x, 0.014, 0.113);
    glassesGroup.add(glass);
  };
  makeLens(-0.038);
  makeLens(0.038);
  const noseBridge = new THREE.Mesh(new THREE.BoxGeometry(0.024, 0.008, 0.012), frameMaterial);
  noseBridge.position.set(0, 0.018, 0.107);
  glassesGroup.add(noseBridge);
  const gTempleL = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.01, 0.11), frameMaterial);
  gTempleL.position.set(-0.092, 0.018, 0.048);
  glassesGroup.add(gTempleL);
  const gTempleR = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.01, 0.11), frameMaterial);
  gTempleR.position.set(0.092, 0.018, 0.048);
  glassesGroup.add(gTempleR);

  // 3. Studio Headset + Boom Mic
  const headsetGroup = new THREE.Group();
  const headband = new THREE.Mesh(
    new THREE.TorusGeometry(0.114, 0.012, 8, 20, Math.PI),
    frameMaterial
  );
  headband.position.set(0, 0.018, -0.004);
  headsetGroup.add(headband);

  const earcupL = new THREE.Mesh(new THREE.CylinderGeometry(0.038, 0.038, 0.034, 14), padMaterial);
  earcupL.rotation.z = Math.PI / 2;
  earcupL.position.set(-0.112, -0.002, -0.004);
  headsetGroup.add(earcupL);

  const earcupR = new THREE.Mesh(new THREE.CylinderGeometry(0.038, 0.038, 0.034, 14), padMaterial);
  earcupR.rotation.z = Math.PI / 2;
  earcupR.position.set(0.112, -0.002, -0.004);
  headsetGroup.add(earcupR);

  const micArm = new THREE.Mesh(new THREE.CylinderGeometry(0.005, 0.005, 0.125, 8), frameMaterial);
  micArm.rotation.x = Math.PI / 2.2;
  micArm.rotation.z = -0.35;
  micArm.position.set(-0.088, -0.034, 0.056);
  headsetGroup.add(micArm);

  const micTip = new THREE.Mesh(new THREE.SphereGeometry(0.011, 8, 8), visorGlowMaterial);
  micTip.position.set(-0.046, -0.048, 0.112);
  headsetGroup.add(micTip);

  return { visorGroup, glassesGroup, headsetGroup };
}

export function createOfficeCharacter(
  session: OfficeSessionItem,
  palette: OfficeScenePalette
): OfficeCharacterRig {
  const hash = hashText(session.sessionKey);
  const skinTone = SKIN_TONES[hash % SKIN_TONES.length];
  const hairTone = HAIR_TONES[(hash >>> 4) % HAIR_TONES.length];
  const hairVariant = (hash >>> 8) % 3;

  const baseJacketColor = new THREE.Color(session.persona.avatarTone || palette.accentHex);
  const baseTrouserColor = baseJacketColor.clone().multiplyScalar(0.32).lerp(new THREE.Color('#192231'), 0.65);
  const baseAccentColor = new THREE.Color(session.persona.deskAccent || palette.accentHex);

  const jacketMaterial = new THREE.MeshStandardMaterial({
    color: baseJacketColor,
    roughness: 0.62,
    metalness: 0.08,
  });
  const shirtMaterial = new THREE.MeshStandardMaterial({
    color: '#e5eef6',
    roughness: 0.72,
    metalness: 0.02,
  });
  const trouserMaterial = new THREE.MeshStandardMaterial({
    color: baseTrouserColor,
    roughness: 0.74,
    metalness: 0.05,
  });
  const shoeMaterial = new THREE.MeshStandardMaterial({
    color: '#1e2736',
    roughness: 0.52,
    metalness: 0.15,
  });
  const soleMaterial = new THREE.MeshStandardMaterial({
    color: '#cbd7e3',
    roughness: 0.78,
    metalness: 0.04,
  });
  const skinMaterial = new THREE.MeshStandardMaterial({
    color: skinTone,
    roughness: 0.68,
    metalness: 0.02,
  });
  const hairMaterial = new THREE.MeshStandardMaterial({
    color: hairTone,
    roughness: 0.75,
    metalness: 0.08,
  });
  const scleraMaterial = new THREE.MeshStandardMaterial({
    color: '#f7fbff',
    roughness: 0.35,
  });
  const irisMaterial = new THREE.MeshStandardMaterial({
    color: '#172230',
    roughness: 0.25,
  });
  const frameMaterial = new THREE.MeshStandardMaterial({
    color: '#1f2b3c',
    roughness: 0.35,
    metalness: 0.55,
  });
  const padMaterial = new THREE.MeshStandardMaterial({
    color: '#253347',
    roughness: 0.65,
    metalness: 0.15,
  });
  const visorGlowMaterial = new THREE.MeshStandardMaterial({
    color: baseAccentColor,
    emissive: baseAccentColor,
    emissiveIntensity: 0.85,
    transparent: true,
    opacity: 0.78,
    roughness: 0.18,
    metalness: 0.35,
  });
  const badgePlateMaterial = new THREE.MeshStandardMaterial({
    color: '#121b29',
    roughness: 0.4,
    metalness: 0.4,
  });
  const badgeLedMaterial = new THREE.MeshStandardMaterial({
    color: palette.successHex,
    emissive: palette.successHex,
    emissiveIntensity: 1.4,
    roughness: 0.25,
  });

  const root = new THREE.Group();
  const pelvis = new THREE.Group();
  pelvis.position.set(0, 0.48, 0);
  root.add(pelvis);

  // Pelvis / Hips
  const hipBlock = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.115, 0.185), trouserMaterial);
  pelvis.add(hipBlock);

  const belt = new THREE.Mesh(new THREE.BoxGeometry(0.268, 0.026, 0.192), frameMaterial);
  belt.position.y = 0.056;
  pelvis.add(belt);

  // Legs + Knees + Shoes
  const buildLeg = (sideSign: number) => {
    const upperLeg = new THREE.Group();
    upperLeg.position.set(sideSign * 0.084, -0.015, 0.02);
    pelvis.add(upperLeg);

    const thigh = buildLimbCylinder(0.066, 0.054, 0.35, trouserMaterial);
    upperLeg.add(thigh);

    const knee = new THREE.Mesh(new THREE.SphereGeometry(0.054, 10, 8), trouserMaterial);
    knee.position.y = -0.35;
    upperLeg.add(knee);

    const lowerLeg = new THREE.Group();
    lowerLeg.position.set(0, -0.35, 0);
    upperLeg.add(lowerLeg);

    const shin = buildLimbCylinder(0.052, 0.041, 0.37, trouserMaterial);
    lowerLeg.add(shin);

    const shoe = buildShoe(shoeMaterial, soleMaterial);
    shoe.position.set(0, -0.37, 0);
    lowerLeg.add(shoe);

    return { upperLeg, lowerLeg };
  };

  const leftLeg = buildLeg(-1);
  const rightLeg = buildLeg(1);

  // Spine & Torso
  const spine = new THREE.Group();
  spine.position.set(0, 0.055, -0.01);
  pelvis.add(spine);

  const waist = new THREE.Mesh(new THREE.BoxGeometry(0.255, 0.13, 0.172), jacketMaterial);
  waist.position.y = 0.065;
  spine.add(waist);

  const chest = new THREE.Mesh(new THREE.BoxGeometry(0.328, 0.275, 0.186), jacketMaterial);
  chest.position.y = 0.255;
  spine.add(chest);

  const shoulderSlope = new THREE.Mesh(new THREE.BoxGeometry(0.37, 0.065, 0.168), jacketMaterial);
  shoulderSlope.position.y = 0.375;
  spine.add(shoulderSlope);

  // Shirt inner placket + collar
  const innerShirt = new THREE.Mesh(new THREE.BoxGeometry(0.102, 0.23, 0.022), shirtMaterial);
  innerShirt.position.set(0, 0.275, 0.086);
  spine.add(innerShirt);

  const collarL = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.058, 0.045), jacketMaterial);
  collarL.position.set(-0.062, 0.388, 0.078);
  collarL.rotation.z = -0.35;
  spine.add(collarL);

  const collarR = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.058, 0.045), jacketMaterial);
  collarR.position.set(0.062, 0.388, 0.078);
  collarR.rotation.z = 0.35;
  spine.add(collarR);

  // Chest ID Badge & live status LED
  const badgePlate = new THREE.Mesh(new THREE.BoxGeometry(0.058, 0.036, 0.012), badgePlateMaterial);
  badgePlate.position.set(0.095, 0.285, 0.096);
  spine.add(badgePlate);

  const badgeLed = new THREE.Mesh(new THREE.BoxGeometry(0.014, 0.014, 0.008), badgeLedMaterial);
  badgeLed.position.set(0.112, 0.285, 0.103);
  spine.add(badgeLed);

  // Arms (Shoulder -> Upper Arm -> Elbow -> Forearm -> Wrist -> Hand)
  const buildArm = (sideSign: number) => {
    const shoulder = new THREE.Group();
    shoulder.position.set(sideSign * 0.205, 0.365, 0.0);
    spine.add(shoulder);

    const shoulderCap = new THREE.Mesh(new THREE.SphereGeometry(0.05, 10, 8), jacketMaterial);
    shoulder.add(shoulderCap);

    const upperArm = buildLimbCylinder(0.044, 0.038, 0.24, jacketMaterial);
    shoulder.add(upperArm);

    const elbow = new THREE.Group();
    elbow.position.set(0, -0.24, 0);
    shoulder.add(elbow);

    const elbowJoint = new THREE.Mesh(new THREE.SphereGeometry(0.038, 10, 8), jacketMaterial);
    elbow.add(elbowJoint);

    const forearm = buildLimbCylinder(0.037, 0.029, 0.225, jacketMaterial);
    elbow.add(forearm);

    const cuff = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.031, 0.024, 10), shirtMaterial);
    cuff.position.y = -0.218;
    elbow.add(cuff);

    const wrist = new THREE.Group();
    wrist.position.set(0, -0.232, 0);
    elbow.add(wrist);

    const hand = buildHand(skinMaterial);
    wrist.add(hand);

    return { shoulder, elbow, wrist };
  };

  const leftArm = buildArm(-1);
  const rightArm = buildArm(1);

  // Neck & Head
  const neck = new THREE.Group();
  neck.position.set(0, 0.405, 0.008);
  spine.add(neck);

  const neckCyl = new THREE.Mesh(new THREE.CylinderGeometry(0.042, 0.048, 0.078, 12), skinMaterial);
  neckCyl.position.y = 0.035;
  neck.add(neckCyl);

  const head = new THREE.Group();
  head.position.set(0, 0.145, 0.012);
  neck.add(head);

  const cranium = new THREE.Mesh(new THREE.SphereGeometry(0.106, 18, 16), skinMaterial);
  cranium.scale.set(0.9, 1.04, 0.96);
  head.add(cranium);

  const jaw = new THREE.Mesh(new THREE.BoxGeometry(0.125, 0.068, 0.115), skinMaterial);
  jaw.position.set(0, -0.056, 0.018);
  head.add(jaw);

  const earL = new THREE.Mesh(new THREE.SphereGeometry(0.024, 8, 8), skinMaterial);
  earL.scale.set(0.45, 1.0, 0.8);
  earL.position.set(-0.095, -0.004, -0.004);
  head.add(earL);

  const earR = new THREE.Mesh(new THREE.SphereGeometry(0.024, 8, 8), skinMaterial);
  earR.scale.set(0.45, 1.0, 0.8);
  earR.position.set(0.095, -0.004, -0.004);
  head.add(earR);

  const nose = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.034, 0.024), skinMaterial);
  nose.position.set(0, -0.012, 0.098);
  nose.rotation.x = -0.15;
  head.add(nose);

  const mouth = new THREE.Mesh(new THREE.BoxGeometry(0.036, 0.007, 0.008), hairMaterial);
  mouth.position.set(0, -0.052, 0.088);
  head.add(mouth);

  // Eyes + Eyebrows + Eyelids
  const makeEye = (sideSign: number) => {
    const x = sideSign * 0.036;
    const sclera = new THREE.Mesh(new THREE.SphereGeometry(0.016, 10, 8), scleraMaterial);
    sclera.scale.set(1.0, 0.85, 0.6);
    sclera.position.set(x, 0.015, 0.089);
    head.add(sclera);

    const iris = new THREE.Mesh(new THREE.SphereGeometry(0.009, 10, 8), irisMaterial);
    iris.scale.set(1.0, 1.0, 0.55);
    iris.position.set(x, 0.015, 0.096);
    head.add(iris);

    const brow = new THREE.Mesh(new THREE.BoxGeometry(0.032, 0.008, 0.01), hairMaterial);
    brow.position.set(x, 0.036, 0.094);
    brow.rotation.z = sideSign * -0.08;
    head.add(brow);

    const eyelid = new THREE.Mesh(new THREE.BoxGeometry(0.034, 0.026, 0.014), skinMaterial);
    eyelid.position.set(x, 0.022, 0.095);
    eyelid.scale.y = 0.08;
    head.add(eyelid);
    return eyelid;
  };

  const eyelidLeft = makeEye(-1);
  const eyelidRight = makeEye(1);

  // Sculpted 3D Hair
  const hair = buildHairGroup(hairVariant, hairMaterial);
  head.add(hair);

  // Eyewear / Headgear Accessories
  const { visorGroup, glassesGroup, headsetGroup } = buildEyewearGroups(
    frameMaterial,
    visorGlowMaterial,
    padMaterial
  );
  head.add(visorGroup);
  head.add(glassesGroup);
  head.add(headsetGroup);

  tagTree(root, session.sessionKey);

  const rig: OfficeCharacterRig = {
    root,
    pelvis,
    spine,
    neck,
    head,
    eyelidLeft,
    eyelidRight,
    leftShoulder: leftArm.shoulder,
    leftElbow: leftArm.elbow,
    leftWrist: leftArm.wrist,
    rightShoulder: rightArm.shoulder,
    rightElbow: rightArm.elbow,
    rightWrist: rightArm.wrist,
    leftUpperLeg: leftLeg.upperLeg,
    leftLowerLeg: leftLeg.lowerLeg,
    rightUpperLeg: rightLeg.upperLeg,
    rightLowerLeg: rightLeg.lowerLeg,
    visorGroup,
    glassesGroup,
    headsetGroup,
    jacketMaterial,
    shirtMaterial,
    trouserMaterial,
    shoeMaterial,
    skinMaterial,
    hairMaterial,
    visorGlowMaterial,
    badgeLedMaterial,
    baseJacketColor,
    baseTrouserColor,
    baseAccentColor,
    phaseOffset: ((hash % 628) / 100),
    availability: session.availability,
    posture: session.persona.posture,
    recentPulse: session.activity.recentPulse,
  };

  applySeatedBasePose(rig);
  updateOfficeCharacter(rig, session, palette);
  return rig;
}

function applySeatedBasePose(rig: OfficeCharacterRig): void {
  // Seated thighs forward (+Z -> negative rx), shins straight down
  rig.leftUpperLeg.rotation.set(-1.46, 0.08, 0);
  rig.leftLowerLeg.rotation.set(1.46, 0, 0);
  rig.rightUpperLeg.rotation.set(-1.46, -0.08, 0);
  rig.rightLowerLeg.rotation.set(1.46, 0, 0);
}

export function updateOfficeCharacter(
  rig: OfficeCharacterRig,
  session: OfficeSessionItem,
  palette: OfficeScenePalette
): void {
  rig.availability = session.availability;
  rig.posture = session.persona.posture;
  rig.recentPulse = session.activity.recentPulse;

  // Eyewear / headset state
  const visorStyle = session.persona.visorStyle;
  rig.visorGroup.visible = visorStyle === 'visor';
  rig.glassesGroup.visible = visorStyle === 'glasses';
  rig.headsetGroup.visible = visorStyle === 'headset';

  // Clothing and LED state differentiation
  const mutedColor = new THREE.Color('#445364');
  if (session.availability === 'exited') {
    rig.jacketMaterial.color.copy(rig.baseJacketColor).lerp(mutedColor, 0.72);
    rig.trouserMaterial.color.copy(rig.baseTrouserColor).lerp(mutedColor, 0.55);
    rig.badgeLedMaterial.color.set('#586b80');
    rig.badgeLedMaterial.emissive.set('#2b3645');
    rig.badgeLedMaterial.emissiveIntensity = 0.25;
    rig.visorGlowMaterial.emissiveIntensity = 0.12;
  } else if (session.availability === 'unavailable') {
    rig.jacketMaterial.color.copy(rig.baseJacketColor).lerp(mutedColor, 0.38);
    rig.trouserMaterial.color.copy(rig.baseTrouserColor);
    rig.badgeLedMaterial.color.set(palette.warningHex);
    rig.badgeLedMaterial.emissive.set(palette.warningHex);
    rig.badgeLedMaterial.emissiveIntensity = 0.95;
    rig.visorGlowMaterial.emissiveIntensity = 0.4;
  } else if (session.availability === 'directory-only') {
    rig.jacketMaterial.color.copy(rig.baseJacketColor);
    rig.trouserMaterial.color.copy(rig.baseTrouserColor);
    rig.badgeLedMaterial.color.set(palette.accentHex);
    rig.badgeLedMaterial.emissive.set(palette.accentHex);
    rig.badgeLedMaterial.emissiveIntensity = 1.25;
    rig.visorGlowMaterial.emissiveIntensity = 0.75;
  } else {
    // interactive
    rig.jacketMaterial.color.copy(rig.baseJacketColor);
    rig.trouserMaterial.color.copy(rig.baseTrouserColor);
    rig.badgeLedMaterial.color.set(palette.successHex);
    rig.badgeLedMaterial.emissive.set(palette.successHex);
    rig.badgeLedMaterial.emissiveIntensity = session.activity.recentPulse ? 2.0 : 1.35;
    rig.visorGlowMaterial.emissiveIntensity = session.activity.recentPulse ? 1.25 : 0.9;
  }

  animateOfficeCharacter(rig, 0, true);
}

export function animateOfficeCharacter(
  rig: OfficeCharacterRig,
  elapsedSec: number,
  reducedMotion: boolean
): void {
  const t = reducedMotion ? 0 : elapsedSec + rig.phaseOffset;
  const active = rig.availability === 'interactive' || rig.availability === 'directory-only';

  if (rig.availability === 'exited') {
    rig.spine.rotation.set(-0.08, 0, 0);
    rig.head.rotation.set(0.22, 0, 0);
    rig.leftShoulder.rotation.set(-0.08, 0.05, 0.08);
    rig.leftElbow.rotation.set(-1.12, 0, 0);
    rig.leftWrist.rotation.set(0.35, 0, 0);
    rig.rightShoulder.rotation.set(-0.08, -0.05, -0.08);
    rig.rightElbow.rotation.set(-1.12, 0, 0);
    rig.rightWrist.rotation.set(0.35, 0, 0);
    rig.eyelidLeft.scale.y = 0.95;
    rig.eyelidRight.scale.y = 0.95;
    return;
  }

  if (rig.availability === 'unavailable') {
    rig.spine.rotation.set(0.02, 0, 0);
    rig.head.rotation.set(0.08, 0.04, 0);
    rig.leftShoulder.rotation.set(-0.14, 0.12, 0.12);
    rig.leftElbow.rotation.set(-1.42, 0, 0);
    rig.leftWrist.rotation.set(0.28, 0, 0);
    rig.rightShoulder.rotation.set(-0.14, -0.12, -0.12);
    rig.rightElbow.rotation.set(-1.42, 0, 0);
    rig.rightWrist.rotation.set(0.28, 0, 0);
    rig.eyelidLeft.scale.y = 0.12;
    rig.eyelidRight.scale.y = 0.12;
    return;
  }

  // Periodic natural blink
  const blinkCycle = t % 4.6;
  const blinkScale = !reducedMotion && active && blinkCycle > 4.44 ? 0.92 : 0.08;
  rig.eyelidLeft.scale.y = blinkScale;
  rig.eyelidRight.scale.y = blinkScale;

  const breath = reducedMotion ? 0 : Math.sin(t * 2.1) * 0.016;
  const pulseLift = !reducedMotion && rig.recentPulse ? Math.sin(t * 7.2) * 0.04 : 0;

  if (rig.posture === 'typing') {
    const typeL = reducedMotion ? 0 : Math.sin(t * 10.5) * 0.055;
    const typeR = reducedMotion ? 0 : Math.sin(t * 10.5 + 2.4) * 0.055;
    const headScan = reducedMotion ? 0 : Math.sin(t * 1.4) * 0.055;

    rig.spine.rotation.set(0.11 + breath, headScan * 0.25, 0);
    rig.head.rotation.set(0.06 + pulseLift, headScan, 0);

    rig.leftShoulder.rotation.set(-0.24, 0.16, 0.11);
    rig.leftElbow.rotation.set(-1.66 + typeL, 0, 0);
    rig.leftWrist.rotation.set(0.28 - typeL * 0.8, 0, 0);

    rig.rightShoulder.rotation.set(-0.24, -0.16, -0.11);
    rig.rightElbow.rotation.set(-1.66 + typeR, 0, 0);
    rig.rightWrist.rotation.set(0.28 - typeR * 0.8, 0, 0);
  } else if (rig.posture === 'reading') {
    // Leaning slightly back/alert reading monitor or incoming mail
    const headNod = reducedMotion ? 0 : Math.sin(t * 2.6) * 0.035;
    rig.spine.rotation.set(-0.04 + breath, -0.05, 0);
    rig.head.rotation.set(-0.04 + headNod + pulseLift, 0.08, 0.03);

    rig.leftShoulder.rotation.set(-0.18, 0.14, 0.1);
    rig.leftElbow.rotation.set(-1.58, 0, 0);
    rig.leftWrist.rotation.set(0.24, 0, 0);

    rig.rightShoulder.rotation.set(-0.34, -0.22, -0.08);
    rig.rightElbow.rotation.set(-1.72, 0, 0);
    rig.rightWrist.rotation.set(0.18, 0, 0);
  } else {
    // monitoring
    const glance = reducedMotion ? 0 : Math.sin(t * 0.9) * 0.04;
    rig.spine.rotation.set(0.04 + breath, 0, 0);
    rig.head.rotation.set(0.02 + pulseLift, glance, 0);

    rig.leftShoulder.rotation.set(-0.18, 0.15, 0.12);
    rig.leftElbow.rotation.set(-1.56, 0, 0);
    rig.leftWrist.rotation.set(0.24, 0, 0);

    rig.rightShoulder.rotation.set(-0.22, -0.12, -0.1);
    rig.rightElbow.rotation.set(-1.58, 0, 0);
    rig.rightWrist.rotation.set(0.24, 0, 0);
  }

  if (rig.recentPulse && !reducedMotion) {
    rig.visorGlowMaterial.emissiveIntensity = 1.0 + Math.abs(Math.sin(t * 5.2)) * 0.65;
  }
}
