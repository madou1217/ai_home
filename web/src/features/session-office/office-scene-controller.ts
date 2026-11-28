import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { DesktopOriginRect, OfficeCameraPreset } from './session-office-types';
import {
  computeBayGridMetrics,
  getOfficeScenePalette,
  type BayGridMetrics,
  type OfficeHitKind,
  type OfficeHitTarget,
  type OfficeHoverInfo,
  type OfficeSceneCallbacks,
  type OfficeScenePalette,
  type OfficeSceneSyncState,
} from './office-scene-types';
import {
  clampOfficeMonitorTransform,
  DEFAULT_OFFICE_COMPUTER_PREFERENCES,
  type OfficeComputerPreferences,
  type OfficeMonitorTransform,
} from './office-computer-state';
import {
  applyMonitorTransform,
  computeMonitorFocusAnchor,
  MONITOR_SCREEN_HEIGHT,
  MONITOR_SCREEN_WIDTH,
} from './office-monitor-rig';
import {
  createOfficeRoomRig,
  disposeOfficeRoomRig,
  syncOfficeRoomRig,
  updateOfficeRoomDynamicCulling,
  type OfficeRoomRig,
} from './office-scene-room';
import {
  animateWorkstationPod,
  createWorkstationPod,
  disposeStationTextureBundles,
  getStationMonitorScreenMesh,
  setStationScreenLod,
  syncStationQualityTier,
  syncWorkstationPod,
  writeStationMonitorCenterWorld,
  type OfficeStationRig,
} from './office-scene-station';
import {
  acquireVoxelMaterialSet,
  isSharedVoxelMaterial,
  isSharedVoxelTexture,
  releaseVoxelMaterialSet,
  type VoxelMaterialSet,
  type VoxelQualityTier,
} from './office-voxel-atlas';
import { createSolidColorVoxelGeometry } from './office-voxel-builder';
import { createBlockyCloudRingGeometry, createStarFieldGeometry } from './office-voxel-kit';
import {
  OfficeBehaviourManager,
  type StationSeatAnchor,
} from './office-voxel-behaviour';

interface CameraGoal {
  position: THREE.Vector3;
  target: THREE.Vector3;
}

interface PointerTrackState {
  active: boolean;
  startX: number;
  startY: number;
  maxDistSq: number;
}

interface MonitorDragSession {
  active: boolean;
  pointerId: number;
  serverId: string;
  sessionKey: string;
  startClientX: number;
  startClientY: number;
  startTransform: OfficeMonitorTransform;
  currentTransform: OfficeMonitorTransform;
  moved: boolean;
}

type PanDirectionKey = 'w' | 'a' | 's' | 'd' | 'q' | 'e';

interface SkyRig {
  root: THREE.Group;
  skyDomeMesh: THREE.Mesh;
  skyDomeUniforms: {
    uTopColor: { value: THREE.Color };
    uMidColor: { value: THREE.Color };
    uHorizonColor: { value: THREE.Color };
    uGroundColor: { value: THREE.Color };
    uSunDir: { value: THREE.Vector3 };
    uSunGlowColor: { value: THREE.Color };
    uSunGlowStrength: { value: number };
  };
  cloudGroup: THREE.Group;
  cloudInnerMesh: THREE.Mesh;
  cloudOuterMesh: THREE.Mesh;
  cloudInnerMaterial: THREE.MeshBasicMaterial;
  cloudOuterMaterial: THREE.MeshBasicMaterial;
  cloudInnerBaseOpacity: number;
  cloudOuterBaseOpacity: number;
  cloudInnerMinR: number;
  cloudInnerMaxR: number;
  cloudOuterMinR: number;
  cloudOuterMaxR: number;
  cloudOuterHalfBuilt: number;
  sunMesh: THREE.Mesh;
  moonMesh: THREE.Mesh;
  starsMesh: THREE.Mesh;
}

interface AmbientMoteSeed {
  kind: 'mote' | 'steam';
  baseX: number;
  baseY: number;
  baseZ: number;
  speed: number;
  phase: number;
  driftRadius: number;
  size: number;
}

interface LodCandidate {
  rig: OfficeStationRig;
  distSq: number;
}

const CLICK_DRAG_THRESHOLD_SQ = 36;
const CLOUD_LAYER_Y = 28.0;
const CLOUD_RING_CLEARANCE = 6.5;
const CLOUD_INNER_BAND_SPAN = 16.0;
const CLOUD_OUTER_BAND_SPAN = 19.0;
const CLOUD_ORBIT_SPEED_RAD = 0.012;
const WORLD_UP = new THREE.Vector3(0, 1, 0);

const CAMERA_FOV_DEG = 42;
const TAN_HALF_VFOV = Math.tan(THREE.MathUtils.degToRad(CAMERA_FOV_DEG * 0.5));

const MONITOR_LOD_PROMOTE_DIST_SQ = 3.2 * 3.2;
const MONITOR_LOD_DEMOTE_DIST_SQ = 4.1 * 4.1;
const MONITOR_LOD_MAX_CLOSEUP = 2;
const MONITOR_LOD_THROTTLE_MS = 140;

const QUALITY_PIXEL_RATIO_CAP: Readonly<Record<VoxelQualityTier, number>> = {
  high: 2.0,
  medium: 1.5,
  low: 1.15,
};

const QUALITY_SHADOW_SIZE: Readonly<Record<VoxelQualityTier, number>> = {
  high: 2048,
  medium: 1024,
  low: 512,
};

const SKY_DOME_VERT = /* glsl */ `
  varying vec3 vWorldDir;
  void main() {
    vWorldDir = normalize(position);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const SKY_DOME_FRAG = /* glsl */ `
  uniform vec3 uTopColor;
  uniform vec3 uMidColor;
  uniform vec3 uHorizonColor;
  uniform vec3 uGroundColor;
  uniform vec3 uSunDir;
  uniform vec3 uSunGlowColor;
  uniform float uSunGlowStrength;
  varying vec3 vWorldDir;
  void main() {
    vec3 dir = normalize(vWorldDir);
    float y = dir.y;
    vec3 col;
    if (y >= 0.0) {
      float tLow = smoothstep(0.0, 0.28, y);
      float tHigh = smoothstep(0.22, 0.85, y);
      col = mix(uHorizonColor, uMidColor, tLow);
      col = mix(col, uTopColor, tHigh);
    } else {
      float tDown = smoothstep(0.0, -0.45, y);
      col = mix(uHorizonColor, uGroundColor, tDown);
    }
    float sunDot = max(dot(dir, normalize(uSunDir)), 0.0);
    float halo = pow(sunDot, 14.0) * 0.45 + pow(sunDot, 64.0) * 0.55;
    col += uSunGlowColor * halo * uSunGlowStrength;
    gl_FragColor = vec4(col, 1.0);
  }
`;

function normalizePanKey(event: KeyboardEvent): PanDirectionKey | null {
  switch (event.code) {
    case 'KeyW':
    case 'ArrowUp':
      return 'w';
    case 'KeyS':
    case 'ArrowDown':
      return 's';
    case 'KeyA':
    case 'ArrowLeft':
      return 'a';
    case 'KeyD':
    case 'ArrowRight':
      return 'd';
    case 'KeyQ':
      return 'q';
    case 'KeyE':
      return 'e';
    default:
      break;
  }
  switch (event.key) {
    case 'w':
    case 'W':
    case 'ArrowUp':
      return 'w';
    case 's':
    case 'S':
    case 'ArrowDown':
      return 's';
    case 'a':
    case 'A':
    case 'ArrowLeft':
      return 'a';
    case 'd':
    case 'D':
    case 'ArrowRight':
      return 'd';
    case 'q':
    case 'Q':
      return 'q';
    case 'e':
    case 'E':
      return 'e';
    default:
      return null;
  }
}

function isEditableOrOverlayEventTarget(target: EventTarget | null): boolean {
  if (typeof Element !== 'undefined' && target instanceof Element) {
    const tag = target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      return true;
    }
    if (target instanceof HTMLElement && target.isContentEditable) {
      return true;
    }
    if (
      target.closest(
        'input, textarea, select, [contenteditable="true"], .xterm, [role="dialog"], [aria-modal="true"], .ant-modal, .ant-drawer, .session-desktop-overlay'
      )
    ) {
      return true;
    }
  }
  if (typeof document !== 'undefined') {
    const activeOverlay = document.querySelector(
      '[aria-modal="true"], .session-desktop-overlay'
    );
    if (activeOverlay) {
      return true;
    }
  }
  return false;
}

function isObjectHierarchyVisible(object: THREE.Object3D | null): boolean {
  let node = object;
  while (node) {
    if (!node.visible) return false;
    node = node.parent;
  }
  return true;
}

function isOfficeHitKind(value: unknown): value is OfficeHitKind {
  return value === 'station' || value === 'monitor';
}

function disposeTextureIfPresent(
  texture: THREE.Texture | null | undefined,
  disposedTextures: Set<THREE.Texture>
): void {
  if (!texture || disposedTextures.has(texture) || isSharedVoxelTexture(texture)) return;
  disposedTextures.add(texture);
  texture.dispose();
}

function disposeMaterialAndTextures(
  material: THREE.Material,
  disposedTextures: Set<THREE.Texture>,
  disposedMaterials: Set<THREE.Material>
): void {
  if (disposedMaterials.has(material) || isSharedVoxelMaterial(material)) return;
  disposedMaterials.add(material);

  if (material instanceof THREE.MeshStandardMaterial) {
    disposeTextureIfPresent(material.map, disposedTextures);
    disposeTextureIfPresent(material.emissiveMap, disposedTextures);
    disposeTextureIfPresent(material.roughnessMap, disposedTextures);
    disposeTextureIfPresent(material.metalnessMap, disposedTextures);
    disposeTextureIfPresent(material.alphaMap, disposedTextures);
    disposeTextureIfPresent(material.aoMap, disposedTextures);
    disposeTextureIfPresent(material.bumpMap, disposedTextures);
    disposeTextureIfPresent(material.normalMap, disposedTextures);
  } else if (material instanceof THREE.MeshLambertMaterial) {
    disposeTextureIfPresent(material.map, disposedTextures);
    disposeTextureIfPresent(material.emissiveMap, disposedTextures);
    disposeTextureIfPresent(material.alphaMap, disposedTextures);
    disposeTextureIfPresent(material.aoMap, disposedTextures);
  } else if (material instanceof THREE.MeshBasicMaterial) {
    disposeTextureIfPresent(material.map, disposedTextures);
    disposeTextureIfPresent(material.alphaMap, disposedTextures);
    disposeTextureIfPresent(material.aoMap, disposedTextures);
  }
  material.dispose();
}

function disposeObjectSubtree(root: THREE.Object3D): void {
  const disposedGeometries = new Set<THREE.BufferGeometry>();
  const disposedMaterials = new Set<THREE.Material>();
  const disposedTextures = new Set<THREE.Texture>();

  root.traverse((obj) => {
    if (obj instanceof THREE.InstancedMesh) {
      obj.dispose();
    }
    if (obj instanceof THREE.Mesh) {
      if (obj.geometry instanceof THREE.BufferGeometry && !disposedGeometries.has(obj.geometry)) {
        disposedGeometries.add(obj.geometry);
        obj.geometry.dispose();
      }
      if (Array.isArray(obj.material)) {
        for (const mat of obj.material) {
          if (mat instanceof THREE.Material) {
            disposeMaterialAndTextures(mat, disposedTextures, disposedMaterials);
          }
        }
      } else if (obj.material instanceof THREE.Material) {
        disposeMaterialAndTextures(obj.material, disposedTextures, disposedMaterials);
      }
    }
  });
}

/** 探测设备渲染能力并选择初始画质档位（自动降级移动端与软件渲染器） */
function detectInitialQualityProfile(
  renderer: THREE.WebGLRenderer
): { tier: VoxelQualityTier; isSoftwareRenderer: boolean } {
  let isSoftwareRenderer = false;
  try {
    const gl = renderer.getContext();
    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
    if (debugInfo) {
      const rendererStr = String(gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) || '');
      if (/swiftshader|llvmpipe|software|mesa offscreen/i.test(rendererStr)) {
        isSoftwareRenderer = true;
      }
    }
  } catch {
    // 忽略受限上下文查询异常
  }

  if (isSoftwareRenderer) {
    return { tier: 'low', isSoftwareRenderer: true };
  }

  const isCoarsePointer =
    typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(pointer: coarse)').matches;
  const smallViewport = typeof window !== 'undefined' && window.innerWidth < 820;
  const cores = typeof navigator !== 'undefined' ? (navigator.hardwareConcurrency || 8) : 8;

  if ((isCoarsePointer && smallViewport) || cores <= 2) {
    return { tier: 'low', isSoftwareRenderer: false };
  }
  if (isCoarsePointer || smallViewport || cores <= 4) {
    return { tier: 'medium', isSoftwareRenderer: false };
  }
  return { tier: 'high', isSoftwareRenderer: false };
}

/** 程序化构建轻量级天空/地面反射环境贴图（PMREM），赋予金属/玻璃/水面真实 Minecraft 光影质感 */
function buildProceduralEnvRenderTarget(
  pmrem: THREE.PMREMGenerator,
  theme: 'dark' | 'light'
): THREE.WebGLRenderTarget {
  const envScene = new THREE.Scene();
  const isLight = theme === 'light';
  envScene.background = new THREE.Color(isLight ? '#8ec8ff' : '#112142');

  const topMat = new THREE.MeshBasicMaterial({ color: isLight ? '#5da8ff' : '#0b1736', side: THREE.BackSide });
  const horizonMat = new THREE.MeshBasicMaterial({ color: isLight ? '#d8efff' : '#1f3660', side: THREE.BackSide });
  const groundMat = new THREE.MeshBasicMaterial({ color: isLight ? '#6e944d' : '#2d241b', side: THREE.BackSide });
  const sunBounceMat = new THREE.MeshBasicMaterial({ color: isLight ? '#fff5d1' : '#ffb85c' });
  const accentBounceMat = new THREE.MeshBasicMaterial({ color: isLight ? '#a6dcff' : '#4a7cc7' });

  const boxGeo = new THREE.BoxGeometry(10, 10, 10);
  const envRoom = new THREE.Mesh(boxGeo, [
    horizonMat,
    horizonMat,
    topMat,
    groundMat,
    horizonMat,
    horizonMat,
  ]);
  envScene.add(envRoom);

  const keyCardGeo = new THREE.PlaneGeometry(3.6, 3.6);
  const keyCard = new THREE.Mesh(keyCardGeo, sunBounceMat);
  keyCard.position.set(3.2, 3.4, 2.6);
  keyCard.lookAt(0, 0, 0);
  envScene.add(keyCard);

  const fillCardGeo = new THREE.PlaneGeometry(3.2, 2.4);
  const fillCard = new THREE.Mesh(fillCardGeo, accentBounceMat);
  fillCard.position.set(-3.4, 2.2, -2.6);
  fillCard.lookAt(0, 0, 0);
  envScene.add(fillCard);

  const rt = pmrem.fromScene(envScene, 0.04);

  boxGeo.dispose();
  keyCardGeo.dispose();
  fillCardGeo.dispose();
  topMat.dispose();
  horizonMat.dispose();
  groundMat.dispose();
  sunBounceMat.dispose();
  accentBounceMat.dispose();

  return rt;
}

/** 构建 Minecraft 大气渐变天穹 + 双层环带方块云 + 方块太阳/月亮与远空星群 */
function createMinecraftSkyRig(initialOuterHalf = 11): SkyRig {
  const root = new THREE.Group();

  // 1. 大气渐变天空穹顶（随日夜切换柔和天际线与太阳/月亮光晕）
  const skyDomeUniforms = {
    uTopColor: { value: new THREE.Color('#428be6') },
    uMidColor: { value: new THREE.Color('#7ec0ff') },
    uHorizonColor: { value: new THREE.Color('#d2ecff') },
    uGroundColor: { value: new THREE.Color('#8bb8df') },
    uSunDir: { value: new THREE.Vector3(38, 44, 28).normalize() },
    uSunGlowColor: { value: new THREE.Color('#fff2b2') },
    uSunGlowStrength: { value: 0.65 },
  };
  const skyDomeGeo = new THREE.SphereGeometry(145, 24, 16);
  const skyDomeMat = new THREE.ShaderMaterial({
    uniforms: skyDomeUniforms,
    vertexShader: SKY_DOME_VERT,
    fragmentShader: SKY_DOME_FRAG,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  });
  const skyDomeMesh = new THREE.Mesh(skyDomeGeo, skyDomeMat);
  skyDomeMesh.name = 'sky-atmosphere-dome';
  skyDomeMesh.frustumCulled = false;
  skyDomeMesh.renderOrder = -10;
  root.add(skyDomeMesh);

  // 2. 双环带立体方块云群
  const cloudGroup = new THREE.Group();
  cloudGroup.position.set(0, CLOUD_LAYER_Y, 0);
  root.add(cloudGroup);

  const innerMinR = Math.max(12, initialOuterHalf + CLOUD_RING_CLEARANCE);
  const innerMaxR = innerMinR + CLOUD_INNER_BAND_SPAN;
  const outerMinR = innerMaxR;
  const outerMaxR = outerMinR + CLOUD_OUTER_BAND_SPAN;

  const cloudInnerGeo = createBlockyCloudRingGeometry(innerMinR, innerMaxR, 12, 2026);
  const cloudInnerMaterial = new THREE.MeshBasicMaterial({
    color: '#ffffff',
    vertexColors: true,
    transparent: true,
    opacity: 0.82,
    fog: true,
    depthWrite: false,
  });
  const cloudInnerMesh = new THREE.Mesh(cloudInnerGeo, cloudInnerMaterial);
  cloudInnerMesh.name = 'sky-clouds-inner-ring';
  cloudGroup.add(cloudInnerMesh);

  const cloudOuterGeo = createBlockyCloudRingGeometry(outerMinR, outerMaxR, 15, 4093);
  const cloudOuterMaterial = new THREE.MeshBasicMaterial({
    color: '#ffffff',
    vertexColors: true,
    transparent: true,
    opacity: 0.44,
    fog: true,
    depthWrite: false,
  });
  const cloudOuterMesh = new THREE.Mesh(cloudOuterGeo, cloudOuterMaterial);
  cloudOuterMesh.name = 'sky-clouds-outer-ring';
  cloudGroup.add(cloudOuterMesh);

  // 3. 白天方块太阳（外环暖金光晕框 + 亮黄核心）
  const sunGeo = createSolidColorVoxelGeometry([
    { minX: -2.8, minY: -2.8, minZ: -0.22, maxX: 2.8, maxY: 2.8, maxZ: 0.22, color: '#ffdf5c', shadeFaces: false },
    { minX: -1.8, minY: -1.8, minZ: -0.32, maxX: 1.8, maxY: 1.8, maxZ: 0.32, color: '#fffbe0', shadeFaces: false },
  ]);
  const sunMat = new THREE.MeshBasicMaterial({ vertexColors: true, fog: false, toneMapped: false });
  const sunMesh = new THREE.Mesh(sunGeo, sunMat);
  sunMesh.position.set(42, 48, 30);
  sunMesh.lookAt(0, 0, 0);
  root.add(sunMesh);

  // 4. 夜晚方块月亮（银白方块 + 经典灰像素月坑）
  const moonGeo = createSolidColorVoxelGeometry([
    { minX: -2.2, minY: -2.2, minZ: -0.22, maxX: 2.2, maxY: 2.2, maxZ: 0.22, color: '#edf4ff', shadeFaces: false },
    { minX: -1.4, minY: 0.3, minZ: -0.3, maxX: -0.35, maxY: 1.35, maxZ: 0.3, color: '#b8c9e8', shadeFaces: false },
    { minX: 0.35, minY: -1.15, minZ: -0.3, maxX: 1.4, maxY: -0.25, maxZ: 0.3, color: '#b8c9e8', shadeFaces: false },
    { minX: -0.65, minY: -1.4, minZ: -0.3, maxX: 0.15, maxY: -0.8, maxZ: 0.3, color: '#cddbf2', shadeFaces: false },
  ]);
  const moonMat = new THREE.MeshBasicMaterial({ vertexColors: true, fog: false, toneMapped: false });
  const moonMesh = new THREE.Mesh(moonGeo, moonMat);
  moonMesh.position.set(-40, 46, 28);
  moonMesh.lookAt(0, 0, 0);
  root.add(moonMesh);

  // 5. 夜空远距方块星点群
  const starsGeo = createStarFieldGeometry(76, 108, 120, 9001);
  const starsMat = new THREE.MeshBasicMaterial({ vertexColors: true, fog: false, toneMapped: false });
  const starsMesh = new THREE.Mesh(starsGeo, starsMat);
  root.add(starsMesh);

  return {
    root,
    skyDomeMesh,
    skyDomeUniforms,
    cloudGroup,
    cloudInnerMesh,
    cloudOuterMesh,
    cloudInnerMaterial,
    cloudOuterMaterial,
    cloudInnerBaseOpacity: 0.82,
    cloudOuterBaseOpacity: 0.44,
    cloudInnerMinR: innerMinR,
    cloudInnerMaxR: innerMaxR,
    cloudOuterMinR: outerMinR,
    cloudOuterMaxR: outerMaxR,
    cloudOuterHalfBuilt: initialOuterHalf,
    sunMesh,
    moonMesh,
    starsMesh,
  };
}

/** 创建环境氛围体素粒子（阳光微尘 / 咖啡机热蒸汽，单一 InstancedMesh 零每帧分配） */
function createAmbientMotesRig(): {
  mesh: THREE.InstancedMesh;
  material: THREE.MeshBasicMaterial;
  seeds: AmbientMoteSeed[];
} {
  const seeds: AmbientMoteSeed[] = [];
  // 20 颗飘浮体素光尘
  let s = 20261128;
  const nextRand = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
  for (let i = 0; i < 20; i += 1) {
    seeds.push({
      kind: 'mote',
      baseX: (nextRand() - 0.5) * 14,
      baseY: 0.8 + nextRand() * 3.1,
      baseZ: (nextRand() - 0.5) * 11,
      speed: 0.28 + nextRand() * 0.36,
      phase: nextRand() * Math.PI * 2,
      driftRadius: 0.25 + nextRand() * 0.45,
      size: 0.036 + nextRand() * 0.024,
    });
  }
  // 8 颗咖啡机上升小方块蒸汽
  for (let i = 0; i < 8; i += 1) {
    seeds.push({
      kind: 'steam',
      baseX: (nextRand() - 0.5) * 0.22,
      baseY: 0,
      baseZ: (nextRand() - 0.5) * 0.14,
      speed: 0.35 + nextRand() * 0.25,
      phase: i / 8,
      driftRadius: 0.06 + nextRand() * 0.05,
      size: 0.055,
    });
  }

  const geo = new THREE.BoxGeometry(1, 1, 1);
  const material = new THREE.MeshBasicMaterial({
    color: '#fff9e6',
    transparent: true,
    opacity: 0.42,
    depthWrite: false,
  });
  const mesh = new THREE.InstancedMesh(geo, material, seeds.length);
  mesh.name = 'office-ambient-voxels';
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  return { mesh, material, seeds };
}

/** 计算三种视角预设（等距 / 走廊 / 俯瞰）：保证房间与景观完整入画 */
function computePresetGoal(
  preset: OfficeCameraPreset,
  metrics: BayGridMetrics,
  aspect: number
): CameraGoal {
  const safeAspect = Math.max(0.75, Math.min(2.6, aspect || 1.6));
  const tanHalfH = TAN_HALF_VFOV * safeAspect;
  const halfW = Math.max(4, Math.ceil(metrics.roomWidth / 2));
  const halfD = Math.max(3, Math.ceil(metrics.roomDepth / 2));

  switch (preset) {
    case 'isometric': {
      const spanX = halfW + 4.0;
      const spanZ = halfD + 4.0;
      const halfH = 2.6;
      const horizHalf = (spanX + spanZ) * 0.7071;
      const vertHalf = horizHalf * 0.54 + halfH * 0.84;
      const distV = (vertHalf / TAN_HALF_VFOV) * 1.1;
      const distH = (horizHalf / tanHalfH) * 1.1;
      const dist = Math.max(distV, distH);
      const target = new THREE.Vector3(0, 0.75, 0.3);
      return {
        position: new THREE.Vector3(
          target.x + dist * 0.59,
          target.y + dist * 0.54,
          target.z + dist * 0.59
        ),
        target,
      };
    }
    case 'corridor': {
      const target = new THREE.Vector3(0, 1.2, -0.4);
      const needDistH = ((halfW + 2.8) / tanHalfH) * 1.06;
      const needDistV = (4.1 / TAN_HALF_VFOV) * 1.06;
      const distZ = Math.max(halfD + 6.2, Math.max(needDistH, needDistV));
      return {
        position: new THREE.Vector3(
          Math.max(0.6, halfW * 0.14),
          3.1,
          distZ
        ),
        target,
      };
    }
    case 'overview': {
      const target = new THREE.Vector3(0, 0.35, 0);
      const needHByDepth = ((halfD + 4.6) / TAN_HALF_VFOV) * 1.1;
      const needHByWidth = ((halfW + 4.6) / tanHalfH) * 1.1;
      const height = Math.max(needHByDepth, needHByWidth);
      return {
        position: new THREE.Vector3(0, height, 2.4),
        target,
      };
    }
  }
}

export class OfficeSceneController {
  private readonly container: HTMLElement;
  private readonly callbacks: OfficeSceneCallbacks;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointerNdc = new THREE.Vector2();

  private readonly pmremGenerator: THREE.PMREMGenerator;
  private envRenderTargetLight: THREE.WebGLRenderTarget | null = null;
  private envRenderTargetDark: THREE.WebGLRenderTarget | null = null;

  private readonly hemiLight: THREE.HemisphereLight;
  private readonly sunLight: THREE.DirectionalLight;
  private readonly rimLight: THREE.DirectionalLight;
  private readonly lanternLightA: THREE.PointLight;
  private readonly lanternLightB: THREE.PointLight;
  private readonly skyRig: SkyRig;
  private readonly roomRig: OfficeRoomRig;
  private readonly voxelMaterials: VoxelMaterialSet;
  private readonly stations = new Map<string, OfficeStationRig>();
  private readonly behaviourManager = new OfficeBehaviourManager();

  private readonly ambientMotesMesh: THREE.InstancedMesh;
  private readonly ambientMotesMaterial: THREE.MeshBasicMaterial;
  private readonly ambientMoteSeeds: AmbientMoteSeed[];

  private currentState: OfficeSceneSyncState | null = null;
  private currentPalette: OfficeScenePalette;
  private currentMetrics: BayGridMetrics = computeBayGridMetrics(2);
  private viewportWidth = 1280;
  private viewportHeight = 720;

  private qualityTier: VoxelQualityTier = 'high';
  private readonly isSoftwareRenderer: boolean;
  private smoothedFrameMs = 16.6;
  private slowFrameStreak = 0;

  private lastRoomKey = '';
  private lastPreset: OfficeCameraPreset = 'isometric';
  private lastSelectedSessionKey: string | null = null;
  private activeCameraGoal: CameraGoal | null = null;
  private applyingCameraTransition = false;

  private hoveredTarget: OfficeHitTarget | null = null;
  private pointerDownTarget: OfficeHitTarget | null = null;
  private pointerTrack: PointerTrackState = {
    active: false,
    startX: 0,
    startY: 0,
    maxDistSq: 0,
  };
  private lastClickMaxDistSq = 0;

  private monitorDrag: MonitorDragSession | null = null;

  private surfacePan: { active: boolean; pointerId: number; lastX: number; lastY: number } = {
    active: false,
    pointerId: 0,
    lastX: 0,
    lastY: 0,
  };

  private readonly pressedPanKeys = new Set<PanDirectionKey>();
  private panShiftHeld = false;
  private readonly panVelocity = new THREE.Vector3();

  // 零分配复用临时对象池
  private readonly panForwardScratch = new THREE.Vector3();
  private readonly panRightScratch = new THREE.Vector3();
  private readonly panDeltaScratch = new THREE.Vector3();
  private readonly panTargetVelScratch = new THREE.Vector3();
  private readonly panFallbackUpScratch = new THREE.Vector3();
  private readonly lodCenterScratch = new THREE.Vector3();
  private readonly pickablesScratch: THREE.Object3D[] = [];
  private readonly lodCandidatesScratch: LodCandidate[] = [];
  private readonly lodCandidatePool: LodCandidate[] = [];
  private readonly projectBoxScratch = new THREE.Box3();
  private readonly projectCornersScratch: readonly THREE.Vector3[] = [
    new THREE.Vector3(),
    new THREE.Vector3(),
    new THREE.Vector3(),
    new THREE.Vector3(),
    new THREE.Vector3(),
    new THREE.Vector3(),
    new THREE.Vector3(),
    new THREE.Vector3(),
  ];
  private readonly particleMatrixScratch = new THREE.Matrix4();
  private readonly particlePosScratch = new THREE.Vector3();
  private readonly particleQuatScratch = new THREE.Quaternion();
  private readonly particleScaleScratch = new THREE.Vector3();

  private rafId: number | null = null;
  private lastFrameTimeMs = 0;
  private lastLodEvalMs = 0;
  private elapsedActiveSec = 0;
  private baseLanternIntensity = 5.6;
  private needsStaticRender = true;
  private singleFrameRendering = false;
  private contextLost = false;
  private disposed = false;

  private readonly resizeObserver: ResizeObserver;
  private readonly acquiredVoxelMaterialsRef: boolean;

  constructor(
    container: HTMLElement,
    callbacks: OfficeSceneCallbacks,
    initialTheme: 'dark' | 'light',
    initialReducedMotion: boolean
  ) {
    this.container = container;
    this.callbacks = callbacks;
    this.currentPalette = getOfficeScenePalette(initialTheme);

    this.scene = new THREE.Scene();
    const initialSkyHex = this.currentPalette.skyHex ?? this.currentPalette.backgroundHex;
    this.scene.background = new THREE.Color(initialSkyHex);
    this.scene.fog = new THREE.Fog(this.currentPalette.fogHex, 42, 108);

    const rect = container.getBoundingClientRect();
    this.viewportWidth = Math.max(320, Math.round(rect.width || 1200));
    this.viewportHeight = Math.max(260, Math.round(rect.height || 680));

    // near = 0.04 确保贴近显示器阅读时绝不发生近裁剪穿模
    this.camera = new THREE.PerspectiveCamera(
      CAMERA_FOV_DEG,
      this.viewportWidth / this.viewportHeight,
      0.04,
      280
    );

    // Minecraft Shader 级五光源管线：半球天光 + 太阳/月亮软阴影主光 + 反侧轮廓补光 + 2 盏暖色室内灯笼点光源
    this.hemiLight = new THREE.HemisphereLight('#d9f0ff', '#78a352', 0.85);
    this.scene.add(this.hemiLight);

    this.sunLight = new THREE.DirectionalLight('#fff7e0', 1.5);
    this.sunLight.position.set(18, 26, 14);
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.set(2048, 2048);
    this.sunLight.shadow.camera.near = 2;
    this.sunLight.shadow.camera.far = 76;
    this.sunLight.shadow.camera.left = -16;
    this.sunLight.shadow.camera.right = 16;
    this.sunLight.shadow.camera.top = 16;
    this.sunLight.shadow.camera.bottom = -16;
    this.sunLight.shadow.bias = -0.00035;
    this.sunLight.shadow.normalBias = 0.022;
    this.sunLight.shadow.radius = 2.6;
    this.scene.add(this.sunLight);

    this.rimLight = new THREE.DirectionalLight('#b8dcff', 0.34);
    this.rimLight.position.set(-14, 12, -16);
    this.scene.add(this.rimLight);

    this.lanternLightA = new THREE.PointLight('#ffba5c', 5.8, 22, 1.3);
    this.lanternLightA.position.set(-1.5, 3.05, -0.25);
    this.scene.add(this.lanternLightA);

    this.lanternLightB = new THREE.PointLight('#ffba5c', 5.8, 22, 1.3);
    this.lanternLightB.position.set(1.5, 3.05, 0.35);
    this.scene.add(this.lanternLightB);

    let renderer: THREE.WebGLRenderer | null = null;
    let pmremGenerator: THREE.PMREMGenerator | null = null;
    let canvas: HTMLCanvasElement | null = null;
    let controls: OrbitControls | null = null;
    let roomRig: OfficeRoomRig | null = null;
    let skyRig: SkyRig | null = null;
    let voxelMaterials: VoxelMaterialSet | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let acquiredVoxelRef = false;
    let listenersAttached = false;

    try {
      voxelMaterials = acquireVoxelMaterialSet();
      acquiredVoxelRef = true;
      voxelMaterials.syncTheme(initialTheme);

      renderer = new THREE.WebGLRenderer({
        antialias: true,
        powerPreference: 'high-performance',
        alpha: false,
      });

      const detected = detectInitialQualityProfile(renderer);
      this.qualityTier = detected.tier;
      this.isSoftwareRenderer = detected.isSoftwareRenderer;

      renderer.setPixelRatio(
        Math.min(window.devicePixelRatio || 1, QUALITY_PIXEL_RATIO_CAP[this.qualityTier])
      );
      renderer.setSize(this.viewportWidth, this.viewportHeight, false);
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      // Khronos PBR Neutral 色调映射：保持 Minecraft 饱满鲜亮色泽且无高光过曝
      renderer.toneMapping = THREE.NeutralToneMapping;
      renderer.toneMappingExposure = initialTheme === 'light' ? 1.05 : 1.12;
      renderer.shadowMap.enabled = !this.isSoftwareRenderer;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;

      pmremGenerator = new THREE.PMREMGenerator(renderer);
      pmremGenerator.compileEquirectangularShader();

      canvas = renderer.domElement;
      canvas.className = 'office-webgl-canvas';
      canvas.style.width = '100%';
      canvas.style.height = '100%';
      canvas.style.display = 'block';
      this.container.appendChild(canvas);

      controls = new OrbitControls(this.camera, canvas);
      controls.enableDamping = !initialReducedMotion;
      controls.dampingFactor = 0.08;
      controls.enableRotate = true;
      controls.enableZoom = true;
      controls.enablePan = true;
      controls.screenSpacePanning = true;
      // 左键旋转由 OrbitControls 负责，右键/中键/Shift+左键平移由控制器在捕获阶段流畅接管
      controls.mouseButtons = {
        LEFT: THREE.MOUSE.ROTATE,
        MIDDLE: null,
        RIGHT: null,
      } as unknown as typeof controls.mouseButtons;
      controls.rotateSpeed = 0.82;
      controls.zoomSpeed = 1.35;
      controls.zoomToCursor = true;
      controls.panSpeed = 0.9;
      controls.minDistance = 0.25;
      controls.maxDistance = 68;
      controls.minPolarAngle = 0.02;
      controls.maxPolarAngle = Math.PI * 0.65;

      const maxAniso = Math.min(16, Math.max(4, renderer.capabilities.getMaxAnisotropy()));
      voxelMaterials.setQualityTier(this.qualityTier, maxAniso);

      roomRig = createOfficeRoomRig(this.currentPalette, maxAniso);
      this.scene.add(roomRig.root);

      const initialOuterHalf = Math.max(roomRig.outerHalfWidth, roomRig.outerHalfDepth);
      skyRig = createMinecraftSkyRig(initialOuterHalf);
      this.scene.add(skyRig.root);

      const motesBuilt = createAmbientMotesRig();
      this.ambientMotesMesh = motesBuilt.mesh;
      this.ambientMotesMaterial = motesBuilt.material;
      this.ambientMoteSeeds = motesBuilt.seeds;
      this.scene.add(this.ambientMotesMesh);

      this.renderer = renderer;
      this.pmremGenerator = pmremGenerator;
      this.controls = controls;
      this.roomRig = roomRig;
      this.skyRig = skyRig;
      this.voxelMaterials = voxelMaterials;

      this.applyQualityTierSettings(this.qualityTier);
      this.applyThemeLightingAndSky(initialTheme);
      this.syncShadowAndLanternBounds();

      const initialGoal = computePresetGoal(
        'isometric',
        this.currentMetrics,
        this.viewportWidth / this.viewportHeight
      );
      this.camera.position.copy(initialGoal.position);
      controls.target.copy(initialGoal.target);
      controls.update();
      this.updateDynamicSceneForCamera();

      resizeObserver = new ResizeObserver(this.handleResize);
      resizeObserver.observe(this.container);
      this.resizeObserver = resizeObserver;

      this.attachEventListeners(canvas, controls);
      listenersAttached = true;

      this.acquiredVoxelMaterialsRef = true;
      this.syncAnimationSchedule();
    } catch (error: unknown) {
      this.disposed = true;
      this.stopAnimationLoop();
      resizeObserver?.disconnect();
      if (listenersAttached && canvas && controls) {
        this.detachEventListeners(canvas, controls);
      }
      controls?.dispose();
      if (roomRig) {
        disposeOfficeRoomRig(roomRig);
      }
      this.envRenderTargetLight?.dispose();
      this.envRenderTargetDark?.dispose();
      pmremGenerator?.dispose();
      disposeObjectSubtree(this.scene);
      if (acquiredVoxelRef) {
        releaseVoxelMaterialSet();
      }
      renderer?.dispose();
      if (canvas && canvas.parentElement === this.container) {
        this.container.removeChild(canvas);
      }
      const msg = error instanceof Error ? error.message : '无法初始化 WebGL 3D 渲染器';
      this.callbacks.onInitError?.(msg);
      throw error;
    }
  }

  private getEffectiveMaxAnisotropy(): number {
    return Math.min(16, Math.max(4, this.renderer.capabilities.getMaxAnisotropy()));
  }

  private ensureThemeEnvMap(theme: 'dark' | 'light'): void {
    if (this.qualityTier === 'low') {
      this.scene.environment = null;
      return;
    }
    if (theme === 'light') {
      if (!this.envRenderTargetLight) {
        this.envRenderTargetLight = buildProceduralEnvRenderTarget(this.pmremGenerator, 'light');
      }
      this.scene.environment = this.envRenderTargetLight.texture;
    } else {
      if (!this.envRenderTargetDark) {
        this.envRenderTargetDark = buildProceduralEnvRenderTarget(this.pmremGenerator, 'dark');
      }
      this.scene.environment = this.envRenderTargetDark.texture;
    }
  }

  private applyQualityTierSettings(tier: VoxelQualityTier): void {
    this.qualityTier = tier;
    const dpr = Math.min(window.devicePixelRatio || 1, QUALITY_PIXEL_RATIO_CAP[tier]);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(this.viewportWidth, this.viewportHeight, false);

    const shadowsEnabled = !this.isSoftwareRenderer;
    this.renderer.shadowMap.enabled = shadowsEnabled;
    this.sunLight.castShadow = shadowsEnabled;
    if (shadowsEnabled) {
      const targetShadowSize = QUALITY_SHADOW_SIZE[tier];
      if (
        this.sunLight.shadow.mapSize.x !== targetShadowSize
        || this.sunLight.shadow.mapSize.y !== targetShadowSize
      ) {
        this.sunLight.shadow.mapSize.set(targetShadowSize, targetShadowSize);
        if (this.sunLight.shadow.map) {
          this.sunLight.shadow.map.dispose();
          this.sunLight.shadow.map = null;
        }
      }
    }

    const maxAniso = this.getEffectiveMaxAnisotropy();
    this.voxelMaterials.setQualityTier(tier, maxAniso);
    for (const rig of this.stations.values()) {
      syncStationQualityTier(rig, tier);
    }

    this.ensureThemeEnvMap(this.currentPalette.mode);
    const showParticles = tier !== 'low' && !this.currentState?.reducedMotion;
    this.ambientMotesMesh.visible = showParticles;
    this.ambientMotesMesh.count = tier === 'high' ? this.ambientMoteSeeds.length : 14;
  }

  private applyThemeLightingAndSky(theme: 'dark' | 'light'): void {
    const palette = this.currentPalette;
    const isLight = theme === 'light';
    const skyHex = isLight ? '#7ec0ff' : '#0d1a38';
    const fogHex = isLight ? '#cbe7ff' : '#142548';

    if (this.scene.background instanceof THREE.Color) {
      this.scene.background.set(skyHex);
    } else {
      this.scene.background = new THREE.Color(skyHex);
    }
    if (this.scene.fog instanceof THREE.Fog) {
      this.scene.fog.color.set(fogHex);
    }

    this.renderer.toneMappingExposure = isLight ? 1.05 : 1.12;
    this.voxelMaterials.syncTheme(theme);
    this.ensureThemeEnvMap(theme);

    const u = this.skyRig.skyDomeUniforms;
    if (isLight) {
      u.uTopColor.value.set('#3b86e3');
      u.uMidColor.value.set('#7fc2ff');
      u.uHorizonColor.value.set('#d2ecff');
      u.uGroundColor.value.set('#8db4d8');
      u.uSunDir.value.set(42, 48, 30).normalize();
      u.uSunGlowColor.value.set('#fff3bd');
      u.uSunGlowStrength.value = 0.72;

      this.hemiLight.color.set('#dff2ff');
      this.hemiLight.groundColor.set('#7ea654');
      this.hemiLight.intensity = 0.88;

      this.sunLight.color.set('#fff6dc');
      this.sunLight.intensity = 1.55;
      this.sunLight.position.set(18, 26, 14);

      this.rimLight.color.set('#b8deff');
      this.rimLight.intensity = 0.34;
      this.rimLight.position.set(-14, 12, -16);

      this.lanternLightA.color.set(palette.lanternGlowHex ?? '#ffc45e');
      this.lanternLightB.color.set(palette.lanternGlowHex ?? '#ffc45e');
      this.baseLanternIntensity = 0.45;
      this.lanternLightA.intensity = this.baseLanternIntensity;
      this.lanternLightB.intensity = this.baseLanternIntensity;

      this.skyRig.cloudInnerMaterial.color.set('#ffffff');
      this.skyRig.cloudOuterMaterial.color.set('#f2f8ff');
      this.skyRig.cloudInnerBaseOpacity = 0.82;
      this.skyRig.cloudOuterBaseOpacity = 0.44;
      this.skyRig.sunMesh.visible = true;
      this.skyRig.moonMesh.visible = false;
      this.skyRig.starsMesh.visible = false;

      this.ambientMotesMaterial.color.set('#fff8d6');
      this.ambientMotesMaterial.opacity = 0.4;
    } else {
      u.uTopColor.value.set('#071024');
      u.uMidColor.value.set('#102247');
      u.uHorizonColor.value.set('#1f3866');
      u.uGroundColor.value.set('#0a1428');
      u.uSunDir.value.set(-40, 46, 28).normalize();
      u.uSunGlowColor.value.set('#8db8ff');
      u.uSunGlowStrength.value = 0.46;

      this.hemiLight.color.set('#648cd9');
      this.hemiLight.groundColor.set('#374663');
      this.hemiLight.intensity = 0.78;

      this.sunLight.color.set('#bad7ff');
      this.sunLight.intensity = 0.72;
      this.sunLight.position.set(-14, 22, 12);

      this.rimLight.color.set('#6b8fc9');
      this.rimLight.intensity = 0.28;
      this.rimLight.position.set(16, 11, -14);

      this.lanternLightA.color.set(palette.lanternGlowHex ?? '#ffb652');
      this.lanternLightB.color.set(palette.lanternGlowHex ?? '#ffb652');
      this.baseLanternIntensity = 6.2;
      this.lanternLightA.intensity = this.baseLanternIntensity;
      this.lanternLightB.intensity = this.baseLanternIntensity;

      this.skyRig.cloudInnerMaterial.color.set('#4c6496');
      this.skyRig.cloudOuterMaterial.color.set('#394d78');
      this.skyRig.cloudInnerBaseOpacity = 0.54;
      this.skyRig.cloudOuterBaseOpacity = 0.28;
      this.skyRig.sunMesh.visible = false;
      this.skyRig.moonMesh.visible = true;
      this.skyRig.starsMesh.visible = true;

      this.ambientMotesMaterial.color.set('#ffdf9e');
      this.ambientMotesMaterial.opacity = 0.48;
    }
    this.updateCloudProximityFade();
  }

  private syncCloudRingToRoom(outerHalf: number): void {
    if (Math.abs(outerHalf - this.skyRig.cloudOuterHalfBuilt) < 0.25) return;
    const innerMinR = Math.max(12, outerHalf + CLOUD_RING_CLEARANCE);
    const innerMaxR = innerMinR + CLOUD_INNER_BAND_SPAN;
    const outerMinR = innerMaxR;
    const outerMaxR = outerMinR + CLOUD_OUTER_BAND_SPAN;

    this.skyRig.cloudInnerMesh.geometry.dispose();
    this.skyRig.cloudInnerMesh.geometry = createBlockyCloudRingGeometry(innerMinR, innerMaxR, 12, 2026);
    this.skyRig.cloudOuterMesh.geometry.dispose();
    this.skyRig.cloudOuterMesh.geometry = createBlockyCloudRingGeometry(outerMinR, outerMaxR, 15, 4093);

    this.skyRig.cloudInnerMinR = innerMinR;
    this.skyRig.cloudInnerMaxR = innerMaxR;
    this.skyRig.cloudOuterMinR = outerMinR;
    this.skyRig.cloudOuterMaxR = outerMaxR;
    this.skyRig.cloudOuterHalfBuilt = outerHalf;
  }

  private updateCloudProximityFade(): void {
    const camPos = this.camera.position;
    const radialDist = Math.hypot(camPos.x, camPos.z);
    const dy = Math.max(0, Math.abs(camPos.y - CLOUD_LAYER_Y) - 1.4);

    const computeBandFade = (rMin: number, rMax: number): number => {
      const dr = radialDist < rMin ? rMin - radialDist : radialDist > rMax ? radialDist - rMax : 0;
      const dist = Math.hypot(dr, dy);
      return THREE.MathUtils.smoothstep(dist, 3.0, 12.0);
    };

    const innerOpacity =
      this.skyRig.cloudInnerBaseOpacity
      * computeBandFade(this.skyRig.cloudInnerMinR, this.skyRig.cloudInnerMaxR);
    const outerOpacity =
      this.skyRig.cloudOuterBaseOpacity
      * computeBandFade(this.skyRig.cloudOuterMinR, this.skyRig.cloudOuterMaxR);

    this.skyRig.cloudInnerMaterial.opacity = innerOpacity;
    this.skyRig.cloudInnerMesh.visible = innerOpacity > 0.01;
    this.skyRig.cloudOuterMaterial.opacity = outerOpacity;
    this.skyRig.cloudOuterMesh.visible = outerOpacity > 0.01;
  }

  /** 按相机与每台显示器屏幕中心的距离动态切换高清近距 LOD（零每帧分配，最多同时保持 2 台高清屏） */
  private updateMonitorScreenLods(forceNow = false): void {
    const state = this.currentState;
    if (!state || this.stations.size === 0) return;

    const now = performance.now();
    if (!forceNow && now - this.lastLodEvalMs < MONITOR_LOD_THROTTLE_MS) {
      return;
    }
    this.lastLodEvalMs = now;

    const candidates = this.lodCandidatesScratch;
    candidates.length = 0;

    let poolIdx = 0;
    for (const rig of this.stations.values()) {
      writeStationMonitorCenterWorld(rig, this.lodCenterScratch);
      const distSq = this.lodCenterScratch.distanceToSquared(this.camera.position);
      let entry = this.lodCandidatePool[poolIdx];
      if (!entry) {
        entry = { rig, distSq };
        this.lodCandidatePool.push(entry);
      } else {
        entry.rig = rig;
        entry.distSq = distSq;
      }
      poolIdx += 1;
      candidates.push(entry);
    }
    candidates.sort((a, b) => a.distSq - b.distSq);

    const maxAniso = this.getEffectiveMaxAnisotropy();
    let closeupBudget = MONITOR_LOD_MAX_CLOSEUP;
    let anyChanged = false;

    for (let i = 0; i < candidates.length; i += 1) {
      const { rig, distSq } = candidates[i];
      const session = state.sessions.find((item) => item.sessionKey === rig.sessionKey);
      if (!session) continue;
      const isSelected = state.selectedSessionKey === rig.sessionKey;
      const currentLod = rig.monitorAssembly.monitor.currentLod;

      let desiredLod: 'standard' | 'closeup' = currentLod;
      if (distSq <= MONITOR_LOD_PROMOTE_DIST_SQ && closeupBudget > 0) {
        desiredLod = 'closeup';
        closeupBudget -= 1;
      } else if (distSq >= MONITOR_LOD_DEMOTE_DIST_SQ || closeupBudget <= 0) {
        desiredLod = 'standard';
      } else if (currentLod === 'closeup') {
        closeupBudget -= 1;
      }

      if (
        setStationScreenLod(
          rig,
          desiredLod,
          this.qualityTier,
          session,
          isSelected,
          this.currentPalette,
          maxAniso
        )
      ) {
        anyChanged = true;
      }
    }

    if (anyChanged) {
      this.needsStaticRender = true;
    }
  }

  private updateDynamicSceneForCamera(forceLod = false): boolean {
    const cullingChanged = updateOfficeRoomDynamicCulling(
      this.roomRig,
      this.camera.position,
      this.controls.target
    );
    this.updateCloudProximityFade();

    // 贴地式选框不会挡屏幕，但仍同步选中显隐状态
    const selectedKey = this.currentState?.selectedSessionKey || '';
    for (const rig of this.stations.values()) {
      rig.selectionFrameMesh.visible = Boolean(selectedKey) && rig.sessionKey === selectedKey;
    }

    this.updateMonitorScreenLods(forceLod);
    return cullingChanged;
  }

  private syncShadowAndLanternBounds(): void {
    const outerSpan = Math.max(this.roomRig.outerHalfWidth, this.roomRig.outerHalfDepth);
    this.syncCloudRingToRoom(outerSpan);
    const extent = Math.max(12, outerSpan + 2.5);
    const shadowCam = this.sunLight.shadow.camera;
    if (
      Math.abs(shadowCam.right - extent) > 0.25
      || Math.abs(shadowCam.top - extent) > 0.25
    ) {
      shadowCam.left = -extent;
      shadowCam.right = extent;
      shadowCam.top = extent;
      shadowCam.bottom = -extent;
      shadowCam.near = 2;
      shadowCam.far = extent * 3.8 + 18;
      shadowCam.updateProjectionMatrix();
    }

    if (this.scene.fog instanceof THREE.Fog) {
      this.scene.fog.near = Math.max(42, outerSpan * 3.8);
      this.scene.fog.far = Math.max(106, outerSpan * 8.8);
    }

    const lanternRadius = Math.max(20, outerSpan * 2.0);
    this.lanternLightA.distance = lanternRadius;
    this.lanternLightB.distance = lanternRadius;

    const lanternPos = this.roomRig.lanternLightPositions;
    if (lanternPos[0]) {
      this.lanternLightA.position.copy(lanternPos[0]);
    }
    if (lanternPos[1]) {
      this.lanternLightB.position.copy(lanternPos[1]);
    }
  }

  private updateAmbientParticles(elapsedSec: number): void {
    if (!this.ambientMotesMesh.visible) return;
    const coffee = this.roomRig.coffeeStation;
    const count = this.ambientMotesMesh.count;
    for (let i = 0; i < count; i += 1) {
      const seed = this.ambientMoteSeeds[i];
      if (seed.kind === 'steam') {
        // 咖啡机冲煮口缓慢上升的白色体素小蒸汽
        const cycle = (elapsedSec * seed.speed + seed.phase) % 1;
        const px = coffee.anchorX - 0.1 + seed.baseX + Math.sin(elapsedSec * 2.1 + seed.phase * 6) * seed.driftRadius;
        const py = 1.24 + cycle * 0.72;
        const pz = coffee.anchorZ + 0.12 + seed.baseZ + Math.cos(elapsedSec * 1.8 + seed.phase * 5) * seed.driftRadius;
        const fadeScale = Math.sin(cycle * Math.PI) * seed.size;
        this.particlePosScratch.set(px, py, pz);
        this.particleScaleScratch.set(fadeScale, fadeScale, fadeScale);
      } else {
        const px = seed.baseX + Math.sin(elapsedSec * seed.speed + seed.phase) * seed.driftRadius;
        const py = seed.baseY + Math.cos(elapsedSec * seed.speed * 0.7 + seed.phase) * 0.22;
        const pz = seed.baseZ + Math.cos(elapsedSec * seed.speed * 0.85 + seed.phase) * seed.driftRadius;
        const pulse = seed.size * (0.78 + 0.22 * Math.sin(elapsedSec * 1.6 + seed.phase));
        this.particlePosScratch.set(px, py, pz);
        this.particleScaleScratch.set(pulse, pulse, pulse);
      }
      this.particleMatrixScratch.compose(
        this.particlePosScratch,
        this.particleQuatScratch,
        this.particleScaleScratch
      );
      this.ambientMotesMesh.setMatrixAt(i, this.particleMatrixScratch);
    }
    this.ambientMotesMesh.instanceMatrix.needsUpdate = true;
  }

  private attachEventListeners(canvas: HTMLCanvasElement, controls: OrbitControls): void {
    controls.addEventListener('change', this.handleControlsChange);
    controls.addEventListener('start', this.handleControlsStart);
    controls.addEventListener('end', this.handleControlsEnd);
    canvas.addEventListener('pointerdown', this.handlePointerDown, true);
    canvas.addEventListener('pointermove', this.handlePointerMove);
    canvas.addEventListener('pointerup', this.handlePointerUp);
    canvas.addEventListener('pointerleave', this.handlePointerLeave);
    canvas.addEventListener('pointercancel', this.handlePointerCancel);
    canvas.addEventListener('contextmenu', this.handleContextMenu);
    canvas.addEventListener('wheel', this.handleWheel, { passive: false, capture: true });
    canvas.addEventListener('lostpointercapture', this.handleLostPointerCapture);
    canvas.addEventListener('dblclick', this.handleDoubleClick);
    canvas.addEventListener('webglcontextlost', this.handleContextLost);
    canvas.addEventListener('webglcontextrestored', this.handleContextRestored);
    window.addEventListener('keydown', this.handleKeyDown);
    window.addEventListener('keyup', this.handleKeyUp);
    window.addEventListener('blur', this.handleWindowBlur);
    document.addEventListener('visibilitychange', this.handleVisibilityChange);
  }

  private detachEventListeners(canvas: HTMLCanvasElement, controls: OrbitControls): void {
    controls.removeEventListener('change', this.handleControlsChange);
    controls.removeEventListener('start', this.handleControlsStart);
    controls.removeEventListener('end', this.handleControlsEnd);
    canvas.removeEventListener('pointerdown', this.handlePointerDown, true);
    canvas.removeEventListener('pointermove', this.handlePointerMove);
    canvas.removeEventListener('pointerup', this.handlePointerUp);
    canvas.removeEventListener('pointerleave', this.handlePointerLeave);
    canvas.removeEventListener('pointercancel', this.handlePointerCancel);
    canvas.removeEventListener('contextmenu', this.handleContextMenu);
    canvas.removeEventListener('wheel', this.handleWheel, { capture: true } as EventListenerOptions);
    canvas.removeEventListener('lostpointercapture', this.handleLostPointerCapture);
    canvas.removeEventListener('dblclick', this.handleDoubleClick);
    canvas.removeEventListener('webglcontextlost', this.handleContextLost);
    canvas.removeEventListener('webglcontextrestored', this.handleContextRestored);
    window.removeEventListener('keydown', this.handleKeyDown);
    window.removeEventListener('keyup', this.handleKeyUp);
    window.removeEventListener('blur', this.handleWindowBlur);
    document.removeEventListener('visibilitychange', this.handleVisibilityChange);
  }

  public syncState(state: OfficeSceneSyncState): void {
    if (this.disposed) return;

    if (this.monitorDrag?.active) {
      const drag = this.monitorDrag;
      const nextSessionStillPresent = state.sessions.some(
        (item) => item.sessionKey === drag.sessionKey
      );
      const roomWillChange = this.lastRoomKey !== '' && state.roomKey !== this.lastRoomKey;
      const dragTargetInvalidated =
        drag.serverId !== state.serverId
        || roomWillChange
        || !nextSessionStillPresent;
      if (dragTargetInvalidated) {
        this.cancelMonitorDrag();
      }
    }

    const prevSelectedKey = this.lastSelectedSessionKey;
    const prevTheme = this.currentPalette.mode;
    this.currentState = state;
    this.currentPalette = getOfficeScenePalette(state.theme);

    if (prevTheme !== state.theme) {
      this.applyThemeLightingAndSky(state.theme);
    }
    this.controls.enableDamping = !state.reducedMotion;
    this.ambientMotesMesh.visible = this.qualityTier !== 'low' && !state.reducedMotion;

    const metrics = computeBayGridMetrics(state.sessions.length);
    this.currentMetrics = metrics;

    const activeKeys = new Set<string>();
    const anisotropy = this.getEffectiveMaxAnisotropy();

    state.sessions.forEach((session, index) => {
      activeKeys.add(session.sessionKey);
      const bay = metrics.bayPositions[index] || { x: 0, z: 0 };
      let stationRig = this.stations.get(session.sessionKey);
      const isNew = !stationRig;

      if (!stationRig) {
        stationRig = createWorkstationPod(session, this.currentPalette, anisotropy, this.qualityTier);
        stationRig.root.position.set(bay.x, 0, bay.z);
        this.stations.set(session.sessionKey, stationRig);
        this.scene.add(stationRig.root);
      }

      stationRig.targetPosition.set(bay.x, 0, bay.z);
      if (isNew || state.reducedMotion) {
        stationRig.root.position.set(bay.x, 0, bay.z);
      }

      const isSelected = state.selectedSessionKey === session.sessionKey;
      const isHovered = this.hoveredTarget?.sessionKey === session.sessionKey;
      const effectivePrefs = this.getEffectiveStationPreferences(session.sessionKey);

      syncWorkstationPod(stationRig, session, this.currentPalette, {
        isSelected,
        isHovered,
        preferences: effectivePrefs,
      });
    });

    for (const [key, rig] of this.stations.entries()) {
      if (!activeKeys.has(key)) {
        if (this.monitorDrag?.sessionKey === key) {
          this.cancelMonitorDrag();
        }
        this.scene.remove(rig.root);
        disposeStationTextureBundles(rig);
        disposeObjectSubtree(rig.root);
        this.stations.delete(key);
      }
    }

    const roomChanged = state.roomKey !== this.lastRoomKey;
    const isRealRoomSwitch = this.lastRoomKey !== '' && roomChanged;
    if (isRealRoomSwitch) {
      this.behaviourManager.resetRoom();
    }

    syncOfficeRoomRig(
      this.roomRig,
      state,
      this.currentPalette,
      metrics.roomWidth,
      metrics.roomDepth
    );
    this.syncShadowAndLanternBounds();

    const seatAnchors: StationSeatAnchor[] = state.sessions.map((session, index) => {
      const bay = metrics.bayPositions[index] || { x: 0, z: 0 };
      return { sessionKey: session.sessionKey, bayX: bay.x, bayZ: bay.z };
    });
    this.behaviourManager.syncSessions(
      this.roomRig.walkLayout,
      state.sessions,
      seatAnchors,
      state.reducedMotion
    );

    const presetChanged = state.cameraPreset !== this.lastPreset;
    if (roomChanged) {
      this.lastRoomKey = state.roomKey;
    }
    if (presetChanged) {
      if (this.monitorDrag?.active) {
        this.cancelMonitorDrag();
      }
      this.lastPreset = state.cameraPreset;
    }

    const nextSelectedKey = state.selectedSessionKey;
    this.lastSelectedSessionKey = nextSelectedKey;

    if (roomChanged || presetChanged) {
      // 仅首次进入房间、切换项目房间或用户主动切换相机预设时重置视角；绝不被 8 秒轮询或会话增减重置
      this.applyCameraPreset(state.cameraPreset, roomChanged || state.reducedMotion);
    } else if (
      nextSelectedKey
      && prevSelectedKey
      && nextSelectedKey !== prevSelectedKey
      && activeKeys.has(prevSelectedKey)
      && activeKeys.has(nextSelectedKey)
      && !this.monitorDrag?.active
    ) {
      // 用户在同房间内主动切换工位（点击 3D 工位、底部工位栏或键盘切换）：平滑过渡到目标工位
      this.smoothTransitionToStation(nextSelectedKey);
    } else {
      // 8 秒目录轮询 / 会话数变化：保持当前自由视角一动不动，只更新动态剖切与高清 LOD
      this.updateDynamicSceneForCamera(true);
    }

    this.needsStaticRender = true;
    this.syncAnimationSchedule();
  }

  public previewStationMonitorTransform(
    sessionKey: string,
    transform: OfficeMonitorTransform
  ): void {
    if (this.disposed) return;
    const rig = this.stations.get(sessionKey);
    if (!rig) return;
    applyMonitorTransform(rig.monitorAssembly, transform);
    this.needsStaticRender = true;
    if (this.rafId === null) {
      this.renderSingleFrame();
    }
  }

  public resetCamera(preset?: OfficeCameraPreset): void {
    if (this.disposed) return;
    if (this.monitorDrag?.active) {
      this.cancelMonitorDrag();
    }
    const targetPreset = preset ?? this.currentState?.cameraPreset ?? 'isometric';
    this.lastPreset = targetPreset;
    this.applyCameraPreset(targetPreset, Boolean(this.currentState?.reducedMotion));
  }

  /** 计算面向指定工位显示器屏幕中心的理想高清阅读机位（自适应视口宽高比） */
  private buildMonitorReadingGoal(rig: OfficeStationRig, preferredDistance?: number): CameraGoal {
    const { screenCenterTarget, screenForward } = computeMonitorFocusAnchor(
      rig.monitorAssembly,
      rig.targetPosition
    );
    const aspect = Math.max(0.75, Math.min(2.6, this.viewportWidth / Math.max(1, this.viewportHeight)));
    const tanHalfH = TAN_HALF_VFOV * aspect;
    // 默认使 16:10 显示屏占满视口高度约 66% 且不超过宽度的 74%，近距离清晰可读且四周保留体素桌面语境
    const fitV = (MONITOR_SCREEN_HEIGHT * 0.5) / (TAN_HALF_VFOV * 0.66);
    const fitH = (MONITOR_SCREEN_WIDTH * 0.5) / (tanHalfH * 0.74);
    const optimalDist = Math.max(1.02, Math.min(1.85, Math.max(fitV, fitH)));
    const dist = preferredDistance !== undefined
      ? THREE.MathUtils.clamp(preferredDistance, 0.85, 2.05)
      : optimalDist;

    const elevOffset = Math.min(0.12, dist * 0.055);
    const horizDist = Math.sqrt(Math.max(0.2, dist * dist - elevOffset * elevOffset));
    const position = new THREE.Vector3(
      screenCenterTarget.x + screenForward.x * horizDist,
      screenCenterTarget.y + elevOffset,
      screenCenterTarget.z + screenForward.z * horizDist
    );

    return {
      position,
      target: screenCenterTarget,
    };
  }

  /** 主动聚焦到指定工位显示器正前方高清阅读位（菜单「聚焦」或按 F 键触发） */
  public focusStation(sessionKey: string): void {
    if (this.disposed) return;
    if (this.monitorDrag?.active) {
      this.cancelMonitorDrag();
    }
    const rig = this.stations.get(sessionKey);
    if (!rig) return;

    const goal = this.buildMonitorReadingGoal(rig);
    this.clearKeyboardPanState();
    this.promoteStationToCloseupImmediately(sessionKey);

    if (this.currentState?.reducedMotion) {
      this.setCameraImmediate(goal);
    } else {
      this.activeCameraGoal = goal;
      this.syncAnimationSchedule();
    }
  }

  /**
   * 工位切换平滑过渡：
   * - 若当前处于近距读屏距离（<= 3.1m），顺滑切到新工位显示器正前阅读位（延续当前读屏习惯距离）；
   * - 若处于大视角（等距/走廊/俯瞰），保持当前俯仰角、方位角与缩放距离，平滑平移焦点到新工位中心。
   */
  private smoothTransitionToStation(sessionKey: string): void {
    const rig = this.stations.get(sessionKey);
    if (!rig) return;

    const curDist = this.camera.position.distanceTo(this.controls.target);
    let goal: CameraGoal;

    if (curDist <= 3.1) {
      goal = this.buildMonitorReadingGoal(rig, curDist);
      this.promoteStationToCloseupImmediately(sessionKey);
    } else {
      const { screenCenterTarget } = computeMonitorFocusAnchor(
        rig.monitorAssembly,
        rig.targetPosition
      );
      const nextTarget = new THREE.Vector3(
        screenCenterTarget.x,
        Math.min(Math.max(this.controls.target.y, 0.55), 1.35),
        screenCenterTarget.z
      );
      const offset = this.camera.position.clone().sub(this.controls.target);
      goal = {
        position: nextTarget.clone().add(offset),
        target: nextTarget,
      };
    }

    this.clearKeyboardPanState();
    if (this.currentState?.reducedMotion) {
      this.setCameraImmediate(goal);
    } else {
      this.activeCameraGoal = goal;
      this.syncAnimationSchedule();
    }
  }

  private promoteStationToCloseupImmediately(sessionKey: string): void {
    const state = this.currentState;
    if (!state) return;
    const rig = this.stations.get(sessionKey);
    const session = state.sessions.find((item) => item.sessionKey === sessionKey);
    if (!rig || !session) return;
    setStationScreenLod(
      rig,
      'closeup',
      this.qualityTier,
      session,
      state.selectedSessionKey === sessionKey,
      this.currentPalette,
      this.getEffectiveMaxAnisotropy()
    );
  }

  public projectStationPartToRect(sessionKey: string): DesktopOriginRect | undefined {
    const rig = this.stations.get(sessionKey);
    if (!rig) return undefined;

    const targetObj = getStationMonitorScreenMesh(rig);
    if (!targetObj) return undefined;

    const box = this.projectBoxScratch.setFromObject(targetObj);
    if (box.isEmpty()) return undefined;

    const corners = this.projectCornersScratch;
    corners[0].set(box.min.x, box.min.y, box.min.z);
    corners[1].set(box.min.x, box.min.y, box.max.z);
    corners[2].set(box.min.x, box.max.y, box.min.z);
    corners[3].set(box.min.x, box.max.y, box.max.z);
    corners[4].set(box.max.x, box.min.y, box.min.z);
    corners[5].set(box.max.x, box.min.y, box.max.z);
    corners[6].set(box.max.x, box.max.y, box.min.z);
    corners[7].set(box.max.x, box.max.y, box.max.z);

    const canvasRect = this.renderer.domElement.getBoundingClientRect();
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;

    for (let i = 0; i < 8; i += 1) {
      const c = corners[i];
      c.project(this.camera);
      const sx = canvasRect.left + ((c.x + 1) * 0.5) * canvasRect.width;
      const sy = canvasRect.top + ((1 - c.y) * 0.5) * canvasRect.height;
      if (sx < minX) minX = sx;
      if (sy < minY) minY = sy;
      if (sx > maxX) maxX = sx;
      if (sy > maxY) maxY = sy;
    }

    if (!Number.isFinite(minX) || maxX <= minX || maxY <= minY) {
      return undefined;
    }

    return {
      left: minX,
      top: minY,
      width: Math.max(48, maxX - minX),
      height: Math.max(36, maxY - minY),
    };
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    this.clearKeyboardPanState();
    this.cancelMonitorDrag();
    this.stopAnimationLoop();
    this.behaviourManager.resetRoom();
    this.resizeObserver.disconnect();
    this.detachEventListeners(this.renderer.domElement, this.controls);
    this.controls.dispose();

    for (const rig of this.stations.values()) {
      disposeStationTextureBundles(rig);
    }
    this.stations.clear();

    disposeOfficeRoomRig(this.roomRig);
    this.envRenderTargetLight?.dispose();
    this.envRenderTargetDark?.dispose();
    this.envRenderTargetLight = null;
    this.envRenderTargetDark = null;
    this.scene.environment = null;
    this.pmremGenerator.dispose();
    disposeObjectSubtree(this.scene);

    if (this.acquiredVoxelMaterialsRef) {
      releaseVoxelMaterialSet();
    }

    this.renderer.dispose();

    const canvas = this.renderer.domElement;
    if (canvas.parentElement === this.container) {
      this.container.removeChild(canvas);
    }
  }

  private getStationPreferences(sessionKey: string): OfficeComputerPreferences {
    return (
      this.currentState?.computerPreferences[sessionKey] ?? DEFAULT_OFFICE_COMPUTER_PREFERENCES
    );
  }

  private getEffectiveStationPreferences(sessionKey: string): OfficeComputerPreferences {
    const prefs = this.getStationPreferences(sessionKey);
    const drag = this.monitorDrag;
    if (
      drag?.active
      && drag.sessionKey === sessionKey
      && drag.serverId === this.currentState?.serverId
    ) {
      return { ...prefs, monitor: drag.currentTransform };
    }
    return prefs;
  }

  private resyncAllStationsOnly(): void {
    if (!this.currentState) return;
    for (const session of this.currentState.sessions) {
      const rig = this.stations.get(session.sessionKey);
      if (!rig) continue;
      const isSelected = this.currentState.selectedSessionKey === session.sessionKey;
      const isHovered = this.hoveredTarget?.sessionKey === session.sessionKey;
      const effectivePrefs = this.getEffectiveStationPreferences(session.sessionKey);
      syncWorkstationPod(rig, session, this.currentPalette, {
        isSelected,
        isHovered,
        preferences: effectivePrefs,
      });
    }
    this.needsStaticRender = true;
    if (this.rafId === null) {
      this.renderSingleFrame();
    }
  }

  private applyCameraPreset(preset: OfficeCameraPreset, immediate: boolean): void {
    if (this.monitorDrag?.active) {
      this.cancelMonitorDrag();
    }
    this.clearKeyboardPanState();
    this.needsStaticRender = true;

    const aspect = this.viewportWidth / Math.max(1, this.viewportHeight);
    const goal = computePresetGoal(preset, this.currentMetrics, aspect);
    if (immediate) {
      this.setCameraImmediate(goal);
    } else {
      this.activeCameraGoal = goal;
      this.syncAnimationSchedule();
    }
  }

  private setCameraImmediate(goal: CameraGoal): void {
    this.activeCameraGoal = null;
    this.applyingCameraTransition = true;
    this.camera.position.copy(goal.position);
    this.controls.target.copy(goal.target);
    this.clampControlsTarget();
    this.controls.update();
    this.updateDynamicSceneForCamera(true);
    this.applyingCameraTransition = false;
    this.needsStaticRender = true;
    if (this.rafId === null) {
      this.renderSingleFrame();
    }
  }

  private panByScreenPixels(dx: number, dy: number): void {
    const height = Math.max(1, this.viewportHeight);
    const distance = this.camera.position.distanceTo(this.controls.target);
    const fovRad = (this.camera.fov * Math.PI) / 180;
    const scale = (2 * distance * Math.tan(fovRad / 2)) / height;
    this.camera.matrixWorld.extractBasis(
      this.panRightScratch,
      this.panForwardScratch,
      this.panDeltaScratch
    );
    const delta = this.panTargetVelScratch;
    delta.set(0, 0, 0);
    delta.addScaledVector(this.panRightScratch, -dx * scale);
    delta.addScaledVector(this.panForwardScratch, dy * scale);
    this.controls.target.add(delta);
    this.camera.position.add(delta);
    this.clampControlsTarget();
    this.applyingCameraTransition = true;
    this.controls.update();
    this.applyingCameraTransition = false;
    this.updateDynamicSceneForCamera();
    if (this.rafId === null) {
      this.renderSingleFrame();
    }
  }

  private endSurfacePan(pointerId: number): void {
    if (!this.surfacePan.active) return;
    this.surfacePan.active = false;
    this.releasePointerCaptureSafe(pointerId);
    this.controls.enabled = true;
    this.updateCursorForState(this.hoveredTarget);
    if (this.rafId === null) {
      this.renderSingleFrame();
    }
  }

  private readonly handleContextMenu = (event: MouseEvent): void => {
    event.preventDefault();
    event.stopPropagation();
  };

  private readonly handleWheel = (event: WheelEvent): void => {
    if (this.disposed || this.contextLost) return;
    // 用户滚动滚轮时立即让出任何自动过渡动画
    this.activeCameraGoal = null;
    const horizontal = event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY) * 1.2;
    if (!horizontal) return;
    event.preventDefault();
    event.stopPropagation();
    const amount = event.shiftKey && event.deltaX === 0 ? event.deltaY : event.deltaX;
    this.panByScreenPixels(-amount * 0.6, 0);
  };

  /** 宽松目标平移护栏：允许充分自由浏览浮空岛与高处建筑，且绝不在房间微缩时生硬拉扯相机 */
  private clampControlsTarget(): void {
    const prevX = this.controls.target.x;
    const prevY = this.controls.target.y;
    const prevZ = this.controls.target.z;
    const maxPanX = Math.max(18, this.roomRig.outerHalfWidth + 8);
    const maxPanZ = Math.max(18, this.roomRig.outerHalfDepth + 8);
    const nextX = THREE.MathUtils.clamp(prevX, -maxPanX, maxPanX);
    const nextY = THREE.MathUtils.clamp(prevY, -1.0, 9.5);
    const nextZ = THREE.MathUtils.clamp(prevZ, -maxPanZ, maxPanZ);
    if (nextX !== prevX || nextY !== prevY || nextZ !== prevZ) {
      this.controls.target.set(nextX, nextY, nextZ);
      this.camera.position.x += nextX - prevX;
      this.camera.position.y += nextY - prevY;
      this.camera.position.z += nextZ - prevZ;
    }
  }

  private clearKeyboardPanState(): void {
    this.pressedPanKeys.clear();
    this.panShiftHeld = false;
    this.panVelocity.set(0, 0, 0);
  }

  private computeGroundPanBasis(forwardOut: THREE.Vector3, rightOut: THREE.Vector3): void {
    this.camera.getWorldDirection(forwardOut);
    forwardOut.y = 0;
    if (forwardOut.lengthSq() < 1e-6) {
      this.panFallbackUpScratch.set(0, 1, 0).applyQuaternion(this.camera.quaternion);
      this.panFallbackUpScratch.y = 0;
      if (this.panFallbackUpScratch.lengthSq() > 1e-6) {
        forwardOut.copy(this.panFallbackUpScratch).normalize();
      } else {
        forwardOut.set(0, 0, -1);
      }
    } else {
      forwardOut.normalize();
    }
    rightOut.crossVectors(forwardOut, WORLD_UP).normalize();
  }

  private applyWorldPanDisplacement(delta: THREE.Vector3): boolean {
    if (delta.lengthSq() < 1e-10) return false;
    const prevX = this.controls.target.x;
    const prevY = this.controls.target.y;
    const prevZ = this.controls.target.z;
    const maxPanX = Math.max(18, this.roomRig.outerHalfWidth + 8);
    const maxPanZ = Math.max(18, this.roomRig.outerHalfDepth + 8);

    const nextX = THREE.MathUtils.clamp(prevX + delta.x, -maxPanX, maxPanX);
    const nextY = THREE.MathUtils.clamp(prevY + delta.y, -1.0, 9.5);
    const nextZ = THREE.MathUtils.clamp(prevZ + delta.z, -maxPanZ, maxPanZ);

    const appliedX = nextX - prevX;
    const appliedY = nextY - prevY;
    const appliedZ = nextZ - prevZ;
    if (appliedX === 0 && appliedY === 0 && appliedZ === 0) {
      return false;
    }

    this.controls.target.set(nextX, nextY, nextZ);
    this.camera.position.x += appliedX;
    this.camera.position.y += appliedY;
    this.camera.position.z += appliedZ;
    this.updateDynamicSceneForCamera();
    return true;
  }

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    if (this.disposed || this.contextLost || document.hidden || this.monitorDrag?.active) return;
    if (event.key === 'Shift') {
      this.panShiftHeld = true;
      return;
    }
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
    if (isEditableOrOverlayEventTarget(event.target)) return;

    const rect = this.container.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    // F 键一键平滑贴近当前选中工位显示器阅读
    if (event.code === 'KeyF' || event.key === 'f' || event.key === 'F') {
      const targetKey = this.currentState?.selectedSessionKey;
      if (targetKey && this.stations.has(targetKey)) {
        event.preventDefault();
        this.focusStation(targetKey);
      }
      return;
    }

    const panKey = normalizePanKey(event);
    if (!panKey) return;

    event.preventDefault();
    this.activeCameraGoal = null;
    this.panShiftHeld = event.shiftKey;

    if (this.currentState?.reducedMotion) {
      this.computeGroundPanBasis(this.panForwardScratch, this.panRightScratch);
      const forwardSign = panKey === 'w' ? 1 : panKey === 's' ? -1 : 0;
      const rightSign = panKey === 'd' ? 1 : panKey === 'a' ? -1 : 0;
      const upSign = panKey === 'e' ? 1 : panKey === 'q' ? -1 : 0;
      const camDist = this.camera.position.distanceTo(this.controls.target);
      const step = Math.max(0.32, Math.min(2.2, camDist * 0.06)) * (event.shiftKey ? 2.2 : 1.0);
      this.panDeltaScratch
        .set(0, upSign * step * 0.65, 0)
        .addScaledVector(this.panForwardScratch, forwardSign * step)
        .addScaledVector(this.panRightScratch, rightSign * step);
      if (this.applyWorldPanDisplacement(this.panDeltaScratch)) {
        this.applyingCameraTransition = true;
        this.controls.update();
        this.applyingCameraTransition = false;
        this.needsStaticRender = true;
        this.renderSingleFrame();
      }
      return;
    }

    this.pressedPanKeys.add(panKey);
    if (!event.repeat) {
      this.computeGroundPanBasis(this.panForwardScratch, this.panRightScratch);
      const forwardSign = panKey === 'w' ? 1 : panKey === 's' ? -1 : 0;
      const rightSign = panKey === 'd' ? 1 : panKey === 'a' ? -1 : 0;
      const upSign = panKey === 'e' ? 1 : panKey === 'q' ? -1 : 0;
      const camDist = this.camera.position.distanceTo(this.controls.target);
      const speed = Math.max(3.6, Math.min(24, camDist * 0.55)) * (event.shiftKey ? 2.2 : 1.0);
      this.panVelocity
        .addScaledVector(this.panForwardScratch, forwardSign * speed * 0.35)
        .addScaledVector(this.panRightScratch, rightSign * speed * 0.35);
      this.panVelocity.y += upSign * speed * 0.25;
    }
    this.syncAnimationSchedule();
  };

  private readonly handleKeyUp = (event: KeyboardEvent): void => {
    if (event.key === 'Shift') {
      this.panShiftHeld = false;
      return;
    }
    const panKey = normalizePanKey(event);
    if (panKey) {
      this.pressedPanKeys.delete(panKey);
    }
  };

  private readonly handleControlsStart = (): void => {
    if (!this.applyingCameraTransition) {
      this.activeCameraGoal = null;
    }
    if (!this.currentState?.reducedMotion) {
      this.syncAnimationSchedule();
    }
  };

  private readonly handleControlsEnd = (): void => {
    this.updateMonitorScreenLods(true);
  };

  private readonly handleControlsChange = (): void => {
    this.clampControlsTarget();
    const cullingChanged = this.updateDynamicSceneForCamera();
    if (cullingChanged) {
      this.needsStaticRender = true;
    }

    if (!this.applyingCameraTransition && !this.singleFrameRendering && this.rafId === null) {
      this.needsStaticRender = true;
      this.renderSingleFrame();
    }
  };

  /** 容器 resize 仅更新投影矩阵与画布分辨率，绝不重置当前自由相机位姿 */
  private readonly handleResize = (entries: ResizeObserverEntry[]): void => {
    if (this.disposed) return;
    const entry = entries[0];
    if (!entry || entry.contentRect.width <= 0 || entry.contentRect.height <= 0) return;
    const nextW = Math.max(320, Math.round(entry.contentRect.width));
    const nextH = Math.max(260, Math.round(entry.contentRect.height));
    if (nextW === this.viewportWidth && nextH === this.viewportHeight) return;

    this.viewportWidth = nextW;
    this.viewportHeight = nextH;
    this.camera.aspect = nextW / nextH;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(
      Math.min(window.devicePixelRatio || 1, QUALITY_PIXEL_RATIO_CAP[this.qualityTier])
    );
    this.renderer.setSize(nextW, nextH, false);

    this.needsStaticRender = true;
    if (this.rafId === null) {
      this.renderSingleFrame();
    }
  };

  private cancelPointerTrack(): void {
    this.pointerDownTarget = null;
    if (this.pointerTrack.active) {
      this.pointerTrack.active = false;
      this.lastClickMaxDistSq = CLICK_DRAG_THRESHOLD_SQ + 1;
    }
  }

  private readonly handleVisibilityChange = (): void => {
    if (this.disposed) return;
    if (document.hidden) {
      this.clearKeyboardPanState();
      this.cancelPointerTrack();
      this.cancelMonitorDrag();
      this.stopAnimationLoop();
    } else {
      this.lastFrameTimeMs = performance.now();
      this.needsStaticRender = true;
      this.syncAnimationSchedule();
    }
  };

  private readonly handleWindowBlur = (): void => {
    if (this.disposed) return;
    this.clearKeyboardPanState();
    this.cancelPointerTrack();
    this.cancelMonitorDrag();
  };

  private readonly handleContextLost = (event: Event): void => {
    event.preventDefault();
    this.contextLost = true;
    this.clearKeyboardPanState();
    this.cancelPointerTrack();
    this.cancelMonitorDrag();
    this.stopAnimationLoop();
    if (!this.disposed) {
      this.callbacks.onContextLostChange?.(true);
    }
  };

  private readonly handleContextRestored = (): void => {
    if (this.disposed) return;
    this.contextLost = false;
    this.callbacks.onContextLostChange?.(false);
    this.needsStaticRender = true;
    this.syncAnimationSchedule();
  };

  private setRayFromClientPoint(clientX: number, clientY: number): boolean {
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    this.pointerNdc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.pointerNdc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointerNdc, this.camera);
    return true;
  }

  private raycastAtClientPoint(clientX: number, clientY: number): OfficeHitTarget | null {
    if (!this.setRayFromClientPoint(clientX, clientY)) return null;

    const pickables = this.pickablesScratch;
    pickables.length = 0;
    if (isObjectHierarchyVisible(this.roomRig.roomTerminalGroup)) {
      pickables.push(this.roomRig.roomTerminalGroup);
    }
    for (const rig of this.stations.values()) {
      if (isObjectHierarchyVisible(rig.root)) {
        pickables.push(rig.root);
      }
    }

    const hits = this.raycaster.intersectObjects(pickables, true);
    for (let i = 0; i < hits.length; i += 1) {
      const hit = hits[i];
      if (!isObjectHierarchyVisible(hit.object)) continue;
      let node: THREE.Object3D | null = hit.object;
      let hitKind: OfficeHitKind | undefined;
      let sessionKey: string | undefined;

      while (node) {
        if (!node.visible) {
          hitKind = undefined;
          break;
        }
        if (hitKind === undefined && isOfficeHitKind(node.userData.hitKind)) {
          hitKind = node.userData.hitKind;
        }
        if (sessionKey === undefined && typeof node.userData.sessionKey === 'string') {
          sessionKey = node.userData.sessionKey;
        }
        node = node.parent;
      }

      if (hitKind) {
        return { kind: hitKind, sessionKey };
      }
    }

    return null;
  }

  private updateCursorForState(target: OfficeHitTarget | null): void {
    const canvas = this.renderer.domElement;
    if (this.monitorDrag?.active || this.surfacePan.active) {
      canvas.style.cursor = 'grabbing';
      return;
    }
    if (this.pointerTrack.active && this.pointerTrack.maxDistSq > CLICK_DRAG_THRESHOLD_SQ) {
      canvas.style.cursor = 'grabbing';
      return;
    }
    if (target?.kind === 'monitor') {
      canvas.style.cursor = 'ew-resize';
      return;
    }
    canvas.style.cursor = target ? 'pointer' : 'grab';
  }

  private updateHoverAtPoint(clientX: number, clientY: number): void {
    const target = this.raycastAtClientPoint(clientX, clientY);
    const prev = this.hoveredTarget;
    const changed =
      prev?.kind !== target?.kind
      || prev?.sessionKey !== target?.sessionKey;
    this.hoveredTarget = target;

    this.updateCursorForState(target);

    if (changed) {
      if (this.currentState) {
        this.resyncAllStationsOnly();
      }

      if (!target) {
        this.callbacks.onHoverTarget(null);
      } else {
        this.callbacks.onHoverTarget(this.buildHoverInfo(target, clientX, clientY));
      }
    }
  }

  private buildHoverInfo(
    target: OfficeHitTarget,
    clientX: number,
    clientY: number
  ): OfficeHoverInfo {
    const session = this.currentState?.sessions.find(
      (item) => item.sessionKey === target.sessionKey
    );
    const label = session ? `${session.persona.badgeCode} · ${session.shortLabel}` : '工位';

    if (target.kind === 'monitor') {
      return {
        kind: 'monitor',
        sessionKey: target.sessionKey,
        label,
        hint: '按住拖动旋转角度 · 点击打开员工电脑桌面 · 按 F 贴近读屏',
        clientX,
        clientY,
      };
    }
    const pose = target.sessionKey ? this.behaviourManager.getPose(target.sessionKey) : null;
    let stationHint = '点击平滑切换工位 · 双击打开桌面 · 按 F 贴近读屏';
    if (pose && pose.phase !== 'seated') {
      if (
        pose.goal === 'coffee'
        || pose.phase === 'brewing_coffee'
        || pose.phase === 'drinking_coffee'
        || pose.holdingCoffee
      ) {
        stationHint = '点击平滑切换工位 · 正在接咖啡 · 双击打开桌面';
      } else if (pose.goal === 'stroll') {
        stationHint = '点击平滑切换工位 · 正在散步 · 双击打开桌面';
      }
    }
    return {
      kind: 'station',
      sessionKey: target.sessionKey,
      label,
      hint: stationHint,
      clientX,
      clientY,
    };
  }

  private releasePointerCaptureSafe(pointerId: number): void {
    const canvas = this.renderer.domElement;
    try {
      if (typeof canvas.hasPointerCapture === 'function' && canvas.hasPointerCapture(pointerId)) {
        canvas.releasePointerCapture(pointerId);
      }
    } catch {
      // 忽略元素卸载时的指针释放异常
    }
  }

  private freezeOrbitMotion(): void {
    this.activeCameraGoal = null;
    const savedEnableDamping = this.controls.enableDamping;
    const prevApplying = this.applyingCameraTransition;
    this.applyingCameraTransition = true;
    try {
      this.controls.saveState();
      this.controls.enableDamping = false;
      this.controls.update();
      this.controls.reset();
    } finally {
      this.controls.enableDamping = savedEnableDamping;
      this.applyingCameraTransition = prevApplying;
    }
  }

  private restoreMonitorDragTransform(drag: MonitorDragSession): void {
    const rig = this.stations.get(drag.sessionKey);
    if (!rig) return;

    const currentMatchesOrigin = this.currentState?.serverId === drag.serverId;
    applyMonitorTransform(
      rig.monitorAssembly,
      currentMatchesOrigin
        ? this.getStationPreferences(drag.sessionKey).monitor
        : drag.startTransform
    );
  }

  private cancelMonitorDrag(): void {
    const drag = this.monitorDrag;
    this.monitorDrag = null;
    this.controls.enabled = true;
    this.controls.enableDamping = !this.currentState?.reducedMotion;

    if (!drag) return;

    this.releasePointerCaptureSafe(drag.pointerId);
    this.restoreMonitorDragTransform(drag);

    this.needsStaticRender = true;
    if (!this.disposed) {
      if (!this.contextLost) {
        this.syncAnimationSchedule();
      }
      this.updateCursorForState(this.hoveredTarget);
    }
  }

  private commitMonitorDrag(): void {
    const drag = this.monitorDrag;
    if (!drag) {
      this.controls.enabled = true;
      return;
    }
    if (!drag.moved) {
      const serverMatches = this.currentState?.serverId === drag.serverId;
      this.cancelMonitorDrag();
      if (serverMatches) {
        this.callbacks.onSelectStation(drag.sessionKey);
        const originRect = this.projectStationPartToRect(drag.sessionKey);
        this.callbacks.onOpenMonitor(drag.sessionKey, originRect);
      }
      return;
    }

    const canCommitOrigin =
      !this.disposed
      && Boolean(this.currentState)
      && this.currentState?.serverId === drag.serverId
      && Boolean(this.currentState?.sessions.some((item) => item.sessionKey === drag.sessionKey));

    if (!canCommitOrigin) {
      this.cancelMonitorDrag();
      return;
    }

    this.monitorDrag = null;
    this.controls.enabled = true;
    this.controls.enableDamping = !this.currentState?.reducedMotion;
    this.lastClickMaxDistSq = CLICK_DRAG_THRESHOLD_SQ + 1;
    this.releasePointerCaptureSafe(drag.pointerId);

    this.callbacks.onCommitMonitorTransform?.(
      drag.serverId,
      drag.sessionKey,
      drag.currentTransform
    );

    this.needsStaticRender = true;
    if (!this.contextLost) {
      this.syncAnimationSchedule();
    }
    this.updateCursorForState(this.hoveredTarget);
  }

  private readonly handlePointerDown = (event: PointerEvent): void => {
    if (this.disposed || this.contextLost) return;
    if (this.monitorDrag?.active) {
      event.stopPropagation();
      event.stopImmediatePropagation();
      event.preventDefault();
      return;
    }
    const wantsPan =
      event.button === 2
      || event.button === 1
      || (event.button === 0 && event.shiftKey);
    if (wantsPan) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      this.cancelPointerTrack();
      this.freezeOrbitMotion();
      this.controls.enabled = false;
      this.surfacePan = {
        active: true,
        pointerId: event.pointerId,
        lastX: event.clientX,
        lastY: event.clientY,
      };
      try {
        this.renderer.domElement.setPointerCapture(event.pointerId);
      } catch {
        // 忽略合成事件异常
      }
      this.renderer.domElement.style.cursor = 'grabbing';
      return;
    }
    if (event.button !== 0) return;

    const downTarget = this.raycastAtClientPoint(event.clientX, event.clientY);
    if (downTarget?.kind === 'monitor' && downTarget.sessionKey && this.currentState) {
      const rig = this.stations.get(downTarget.sessionKey);
      if (rig) {
        event.stopPropagation();
        event.stopImmediatePropagation();
        this.cancelPointerTrack();
        this.freezeOrbitMotion();
        this.controls.enabled = false;

        const prefs = this.getStationPreferences(downTarget.sessionKey);
        const startTransform = { ...prefs.monitor };
        try {
          this.renderer.domElement.setPointerCapture(event.pointerId);
        } catch {
          // 忽略合成事件异常
        }

        this.monitorDrag = {
          active: true,
          pointerId: event.pointerId,
          serverId: this.currentState.serverId,
          sessionKey: downTarget.sessionKey,
          startClientX: event.clientX,
          startClientY: event.clientY,
          startTransform,
          currentTransform: { ...startTransform },
          moved: false,
        };

        this.renderer.domElement.style.cursor = 'grabbing';
        return;
      }
    }

    this.pointerDownTarget = downTarget;
    this.pointerTrack = {
      active: true,
      startX: event.clientX,
      startY: event.clientY,
      maxDistSq: 0,
    };
  };

  private readonly handlePointerMove = (event: PointerEvent): void => {
    if (this.disposed || this.contextLost) return;
    if (this.surfacePan.active) {
      if (event.pointerId !== this.surfacePan.pointerId) return;
      const dx = event.clientX - this.surfacePan.lastX;
      const dy = event.clientY - this.surfacePan.lastY;
      this.surfacePan.lastX = event.clientX;
      this.surfacePan.lastY = event.clientY;
      this.panByScreenPixels(dx, dy);
      event.preventDefault();
      return;
    }
    if (this.monitorDrag?.active) {
      if (event.pointerId !== this.monitorDrag.pointerId) return;

      const drag = this.monitorDrag;
      if (!this.currentState || drag.serverId !== this.currentState.serverId) {
        this.cancelMonitorDrag();
        return;
      }

      const dxPx = event.clientX - drag.startClientX;
      const dyPx = event.clientY - drag.startClientY;
      if (!drag.moved && dxPx * dxPx + dyPx * dyPx <= CLICK_DRAG_THRESHOLD_SQ) {
        return;
      }
      drag.moved = true;

      const candidate: OfficeMonitorTransform = {
        ...drag.startTransform,
        yaw: drag.startTransform.yaw + dxPx * 0.0085,
      };
      const clamped = clampOfficeMonitorTransform(candidate, drag.startTransform);
      drag.currentTransform = clamped;

      this.previewStationMonitorTransform(drag.sessionKey, clamped);
      this.callbacks.onPreviewMonitorTransform?.(drag.serverId, drag.sessionKey, clamped);
      return;
    }

    if (this.pointerTrack.active) {
      const dx = event.clientX - this.pointerTrack.startX;
      const dy = event.clientY - this.pointerTrack.startY;
      this.pointerTrack.maxDistSq = Math.max(this.pointerTrack.maxDistSq, dx * dx + dy * dy);
    }
    this.updateHoverAtPoint(event.clientX, event.clientY);
  };

  private readonly handlePointerUp = (event: PointerEvent): void => {
    if (this.disposed) return;
    if (this.surfacePan.active && event.pointerId === this.surfacePan.pointerId) {
      this.endSurfacePan(event.pointerId);
      return;
    }
    if (this.monitorDrag?.active) {
      if (event.pointerId === this.monitorDrag.pointerId) {
        this.commitMonitorDrag();
      }
      return;
    }

    if (event.button !== 0 || !this.pointerTrack.active) return;
    const dx = event.clientX - this.pointerTrack.startX;
    const dy = event.clientY - this.pointerTrack.startY;
    const maxDistSq = Math.max(this.pointerTrack.maxDistSq, dx * dx + dy * dy);
    this.lastClickMaxDistSq = maxDistSq;
    this.pointerTrack.active = false;
    const downTarget = this.pointerDownTarget;
    this.pointerDownTarget = null;

    const upTarget = this.raycastAtClientPoint(event.clientX, event.clientY);

    if (maxDistSq > CLICK_DRAG_THRESHOLD_SQ) {
      if (
        maxDistSq <= 400
        && downTarget?.kind === 'station'
        && downTarget.sessionKey
        && upTarget?.kind === 'station'
        && upTarget.sessionKey === downTarget.sessionKey
      ) {
        this.callbacks.onSelectStation(downTarget.sessionKey);
      }
      this.updateCursorForState(this.hoveredTarget);
      return;
    }

    const target = upTarget ?? downTarget;
    if (!target || !target.sessionKey) return;

    this.callbacks.onSelectStation(target.sessionKey);
    if (target.kind === 'monitor') {
      const originRect = this.projectStationPartToRect(target.sessionKey);
      this.callbacks.onOpenMonitor(target.sessionKey, originRect);
    }
  };

  private readonly handlePointerCancel = (event: PointerEvent): void => {
    this.cancelPointerTrack();
    if (this.surfacePan.active && event.pointerId === this.surfacePan.pointerId) {
      this.endSurfacePan(event.pointerId);
      return;
    }
    if (this.monitorDrag?.active && event.pointerId === this.monitorDrag.pointerId) {
      this.cancelMonitorDrag();
    } else if (!this.monitorDrag?.active) {
      this.controls.enabled = true;
    }
  };

  private readonly handleLostPointerCapture = (event: PointerEvent): void => {
    this.cancelPointerTrack();
    if (this.surfacePan.active && event.pointerId === this.surfacePan.pointerId) {
      this.endSurfacePan(event.pointerId);
      return;
    }
    if (this.monitorDrag?.active && event.pointerId === this.monitorDrag.pointerId) {
      this.cancelMonitorDrag();
    } else if (!this.monitorDrag?.active) {
      this.controls.enabled = true;
    }
  };

  private readonly handlePointerLeave = (): void => {
    this.cancelPointerTrack();
    if (this.monitorDrag?.active) {
      const canvas = this.renderer.domElement;
      const hasCapture =
        typeof canvas.hasPointerCapture === 'function'
        && canvas.hasPointerCapture(this.monitorDrag.pointerId);
      if (!hasCapture) {
        this.cancelMonitorDrag();
      }
      return;
    }
    if (this.hoveredTarget && !this.disposed) {
      this.hoveredTarget = null;
      this.callbacks.onHoverTarget(null);
    }
    this.renderer.domElement.style.cursor = 'grab';
  };

  private readonly handleDoubleClick = (event: MouseEvent): void => {
    if (this.disposed || this.contextLost || this.monitorDrag?.active) {
      return;
    }
    if (this.pointerTrack.active || this.lastClickMaxDistSq > CLICK_DRAG_THRESHOLD_SQ) return;
    const target = this.raycastAtClientPoint(event.clientX, event.clientY);
    if (!target || !target.sessionKey) return;
    this.callbacks.onSelectStation(target.sessionKey);
    const originRect = this.projectStationPartToRect(target.sessionKey);
    this.callbacks.onOpenMonitor(target.sessionKey, originRect);
  };

  /** 非减弱动态模式下保持 60fps 鲜活动画（敲键盘、呼吸、流动水池、飘云、热蒸汽与自主行为）；切后台自动暂停 */
  private needsContinuousAnimation(): boolean {
    if (this.disposed || this.contextLost || document.hidden) return false;
    if (this.currentState?.reducedMotion) {
      return Boolean(this.activeCameraGoal && !this.monitorDrag?.active);
    }
    return true;
  }

  private syncAnimationSchedule(): void {
    if (this.disposed || this.contextLost || document.hidden) {
      this.stopAnimationLoop();
      return;
    }
    if (this.needsContinuousAnimation()) {
      if (this.rafId === null) {
        this.lastFrameTimeMs = performance.now();
        this.rafId = window.requestAnimationFrame(this.tickFrame);
      }
      return;
    }
    this.stopAnimationLoop();
    if (this.needsStaticRender) {
      this.renderSingleFrame();
    }
  }

  private stopAnimationLoop(): void {
    if (this.rafId !== null) {
      window.cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  private renderSingleFrame(): void {
    if (this.disposed || this.contextLost || this.singleFrameRendering) return;
    this.singleFrameRendering = true;
    try {
      const reduced = Boolean(this.currentState?.reducedMotion);
      if (reduced) {
        this.skyRig.cloudGroup.rotation.y = 0;
      }
      for (const rig of this.stations.values()) {
        const pose = this.behaviourManager.getPose(rig.sessionKey);
        animateWorkstationPod(rig, this.elapsedActiveSec, 0.016, reduced, pose);
      }
      if (!this.monitorDrag?.active) {
        this.applyingCameraTransition = true;
        this.controls.update();
        this.applyingCameraTransition = false;
      }
      this.clampControlsTarget();
      this.updateDynamicSceneForCamera(true);
      this.renderer.render(this.scene, this.camera);
      this.needsStaticRender = false;
    } finally {
      this.singleFrameRendering = false;
    }
  }

  /** 自适应帧率看门狗：连续高耗时时自动降档画质保流畅 60fps（零分配） */
  private monitorAdaptivePerformance(rawDtMs: number): void {
    if (this.qualityTier === 'low' || rawDtMs > 120) return;
    this.smoothedFrameMs = this.smoothedFrameMs * 0.92 + rawDtMs * 0.08;
    if (this.smoothedFrameMs > 30) {
      this.slowFrameStreak += 1;
      if (this.slowFrameStreak >= 60) {
        this.slowFrameStreak = 0;
        this.smoothedFrameMs = 16.6;
        const nextTier: VoxelQualityTier = this.qualityTier === 'high' ? 'medium' : 'low';
        this.applyQualityTierSettings(nextTier);
      }
    } else if (this.slowFrameStreak > 0) {
      this.slowFrameStreak -= 1;
    }
  }

  private readonly tickFrame = (nowMs: number): void => {
    this.rafId = null;
    if (this.disposed || this.contextLost || document.hidden) return;

    const rawDtMs = Math.max(1, nowMs - this.lastFrameTimeMs);
    this.lastFrameTimeMs = nowMs;
    const dtSec = Math.min(0.05, rawDtMs / 1000);
    const reduced = Boolean(this.currentState?.reducedMotion);
    const draggingMonitor = Boolean(this.monitorDrag?.active);

    if (!reduced) {
      this.monitorAdaptivePerformance(rawDtMs);
      this.elapsedActiveSec += dtSec;
      this.behaviourManager.step(dtSec);

      // 流动池塘水面、外环缓慢飘云、夜间灯笼柔和呼吸与空气体素光尘/蒸汽
      this.voxelMaterials.animateWater(this.elapsedActiveSec);
      this.skyRig.cloudGroup.rotation.y =
        (this.elapsedActiveSec * CLOUD_ORBIT_SPEED_RAD) % (Math.PI * 2);

      if (this.currentPalette.mode === 'dark') {
        const flickerA = 1 + Math.sin(this.elapsedActiveSec * 3.1) * 0.03 + Math.sin(this.elapsedActiveSec * 7.3) * 0.015;
        const flickerB = 1 + Math.cos(this.elapsedActiveSec * 2.7) * 0.03 + Math.sin(this.elapsedActiveSec * 6.5 + 1.2) * 0.015;
        this.lanternLightA.intensity = this.baseLanternIntensity * flickerA;
        this.lanternLightB.intensity = this.baseLanternIntensity * flickerB;
      }

      this.updateAmbientParticles(this.elapsedActiveSec);

      // WASD / 方向键平滑地面平移 + Q/E 垂直升降（Shift 加速）
      if (!draggingMonitor && (this.pressedPanKeys.size > 0 || this.panVelocity.lengthSq() > 1e-4)) {
        const forwardInput =
          (this.pressedPanKeys.has('w') ? 1 : 0) - (this.pressedPanKeys.has('s') ? 1 : 0);
        const rightInput =
          (this.pressedPanKeys.has('d') ? 1 : 0) - (this.pressedPanKeys.has('a') ? 1 : 0);
        const upInput =
          (this.pressedPanKeys.has('e') ? 1 : 0) - (this.pressedPanKeys.has('q') ? 1 : 0);

        this.panTargetVelScratch.set(0, 0, 0);
        if (forwardInput !== 0 || rightInput !== 0 || upInput !== 0) {
          this.computeGroundPanBasis(this.panForwardScratch, this.panRightScratch);
          const camDist = this.camera.position.distanceTo(this.controls.target);
          const speed = Math.max(3.6, Math.min(24, camDist * 0.55)) * (this.panShiftHeld ? 2.2 : 1.0);
          const horizNorm = Math.hypot(forwardInput, rightInput);
          if (horizNorm > 0) {
            this.panTargetVelScratch
              .addScaledVector(this.panForwardScratch, (forwardInput / horizNorm) * speed)
              .addScaledVector(this.panRightScratch, (rightInput / horizNorm) * speed);
          }
          if (upInput !== 0) {
            this.panTargetVelScratch.y = upInput * speed * 0.65;
          }
        }
        const dampAlpha = 1 - Math.exp(-dtSec * 14);
        this.panVelocity.lerp(this.panTargetVelScratch, dampAlpha);
        if (this.panVelocity.lengthSq() < 1e-4 && this.pressedPanKeys.size === 0) {
          this.panVelocity.set(0, 0, 0);
        } else {
          this.panDeltaScratch.copy(this.panVelocity).multiplyScalar(dtSec);
          this.applyWorldPanDisplacement(this.panDeltaScratch);
        }
      }
    }

    if (this.activeCameraGoal && !draggingMonitor) {
      const lerpAlpha = reduced ? 1 : 1 - Math.exp(-dtSec * 8.5);
      this.applyingCameraTransition = true;
      this.camera.position.lerp(this.activeCameraGoal.position, lerpAlpha);
      this.controls.target.lerp(this.activeCameraGoal.target, lerpAlpha);
      this.applyingCameraTransition = false;

      if (
        this.camera.position.distanceToSquared(this.activeCameraGoal.position) < 0.0003
        && this.controls.target.distanceToSquared(this.activeCameraGoal.target) < 0.0003
      ) {
        this.camera.position.copy(this.activeCameraGoal.position);
        this.controls.target.copy(this.activeCameraGoal.target);
        this.activeCameraGoal = null;
        this.updateMonitorScreenLods(true);
      }
    }

    for (const rig of this.stations.values()) {
      const pose = this.behaviourManager.getPose(rig.sessionKey);
      animateWorkstationPod(rig, this.elapsedActiveSec, dtSec, reduced, pose);
    }

    if (!draggingMonitor) {
      this.applyingCameraTransition = true;
      this.controls.update();
      this.applyingCameraTransition = false;
    }
    this.clampControlsTarget();
    this.updateDynamicSceneForCamera();
    this.renderer.render(this.scene, this.camera);
    this.needsStaticRender = false;

    if (this.needsContinuousAnimation()) {
      this.rafId = window.requestAnimationFrame(this.tickFrame);
    }
  };
}
