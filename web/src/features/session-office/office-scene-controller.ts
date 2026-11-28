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
  type OfficeMonitorDragMode,
  type OfficeMonitorIndex,
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
  acquireOfficeWallpaperCacheRef,
  getOfficeWallpaperRasterVersion,
  releaseOfficeWallpaperCacheRef,
  subscribeOfficeWallpaperRasterReady,
} from './office-computer-wallpapers';
import {
  applyDualMonitorTransforms,
  computeMonitorFocusAnchor,
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
  syncWorkstationPod,
  type OfficeStationRig,
} from './office-scene-station';
import {
  acquireVoxelMaterialSet,
  isSharedVoxelMaterial,
  isSharedVoxelTexture,
  releaseVoxelMaterialSet,
  type VoxelMaterialSet,
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

interface MonitorEditState {
  enabled: boolean;
  activeMonitorIndex: OfficeMonitorIndex;
  dragMode: OfficeMonitorDragMode;
}

interface MonitorDragSession {
  active: boolean;
  pointerId: number;
  serverId: string;
  sessionKey: string;
  monitorIndex: OfficeMonitorIndex;
  startClientX: number;
  startClientY: number;
  startTransform: OfficeMonitorTransform;
  currentTransform: OfficeMonitorTransform;
  dragPlane: THREE.Plane;
  planeStartHit: THREE.Vector3;
}

type PanDirectionKey = 'w' | 'a' | 's' | 'd';

interface SkyRig {
  root: THREE.Group;
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

const CLICK_DRAG_THRESHOLD_SQ = 36; // 6px 拖拽判定半径
const CLOUD_LAYER_Y = 28.0;
const CLOUD_RING_CLEARANCE = 6.5; // 严格 > outerHalf + 6 的内缘安全距离
const CLOUD_INNER_BAND_SPAN = 15.5;
const CLOUD_OUTER_BAND_SPAN = 18.0;
const CLOUD_ORBIT_SPEED_RAD = 0.014;
const FOCUS_MONITOR_DISTANCE = 2.7;
const FOCUS_CAMERA_ELEVATION_OFFSET = 0.98;
const WORLD_UP = new THREE.Vector3(0, 1, 0);

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

/** 构建 Minecraft 天空元素：岛屿外侧环带漂浮小方块云（y≈28 随距离淡出）、方块太阳、月亮与远空星点 */
function createMinecraftSkyRig(initialOuterHalf = 11): SkyRig {
  const root = new THREE.Group();
  const cloudGroup = new THREE.Group();
  cloudGroup.position.set(0, CLOUD_LAYER_Y, 0);
  root.add(cloudGroup);

  const innerMinR = Math.max(12, initialOuterHalf + CLOUD_RING_CLEARANCE);
  const innerMaxR = innerMinR + CLOUD_INNER_BAND_SPAN;
  const outerMinR = innerMaxR;
  const outerMaxR = outerMinR + CLOUD_OUTER_BAND_SPAN;

  // 1. 内外双环带小方块云（严格位于半径 > outerHalf + 6 环带内，外环更低透明度并叠加雾距淡出）
  const cloudInnerGeo = createBlockyCloudRingGeometry(innerMinR, innerMaxR, 11, 2026);
  const cloudInnerMaterial = new THREE.MeshBasicMaterial({
    color: '#ffffff',
    vertexColors: true,
    transparent: true,
    opacity: 0.78,
    fog: true,
    depthWrite: false,
  });
  const cloudInnerMesh = new THREE.Mesh(cloudInnerGeo, cloudInnerMaterial);
  cloudInnerMesh.name = 'sky-clouds-inner-ring';
  cloudGroup.add(cloudInnerMesh);

  const cloudOuterGeo = createBlockyCloudRingGeometry(outerMinR, outerMaxR, 14, 4093);
  const cloudOuterMaterial = new THREE.MeshBasicMaterial({
    color: '#ffffff',
    vertexColors: true,
    transparent: true,
    opacity: 0.42,
    fog: true,
    depthWrite: false,
  });
  const cloudOuterMesh = new THREE.Mesh(cloudOuterGeo, cloudOuterMaterial);
  cloudOuterMesh.name = 'sky-clouds-outer-ring';
  cloudGroup.add(cloudOuterMesh);

  // 2. 白天方块太阳（外层暖金光框 + 内层亮黄方块核，置于 maxDistance=60 之外避免相机穿模）
  const sunGeo = createSolidColorVoxelGeometry([
    { minX: -2.4, minY: -2.4, minZ: -0.25, maxX: 2.4, maxY: 2.4, maxZ: 0.25, color: '#ffd94a', shadeFaces: false },
    { minX: -1.6, minY: -1.6, minZ: -0.32, maxX: 1.6, maxY: 1.6, maxZ: 0.32, color: '#fff8b8', shadeFaces: false },
  ]);
  const sunMat = new THREE.MeshBasicMaterial({ vertexColors: true, fog: false });
  const sunMesh = new THREE.Mesh(sunGeo, sunMat);
  sunMesh.position.set(38, 44, 28);
  root.add(sunMesh);

  // 3. 夜晚方块月亮（银白方块 + 经典灰像素月坑，置于 maxDistance=60 之外）
  const moonGeo = createSolidColorVoxelGeometry([
    { minX: -2.0, minY: -2.0, minZ: -0.25, maxX: 2.0, maxY: 2.0, maxZ: 0.25, color: '#e8f0ff', shadeFaces: false },
    { minX: -1.35, minY: 0.25, minZ: -0.3, maxX: -0.35, maxY: 1.25, maxZ: 0.3, color: '#b7c7e6', shadeFaces: false },
    { minX: 0.35, minY: -1.1, minZ: -0.3, maxX: 1.35, maxY: -0.25, maxZ: 0.3, color: '#b7c7e6', shadeFaces: false },
    { minX: -0.6, minY: -1.35, minZ: -0.3, maxX: 0.15, maxY: -0.75, maxZ: 0.3, color: '#cad7f0', shadeFaces: false },
  ]);
  const moonMat = new THREE.MeshBasicMaterial({ vertexColors: true, fog: false });
  const moonMesh = new THREE.Mesh(moonGeo, moonMat);
  moonMesh.position.set(-36, 42, 26);
  root.add(moonMesh);

  // 4. 夜空远距方块星点群（置于半径 72..98，大视距下不穿入相机球面）
  const starsGeo = createStarFieldGeometry(72, 98, 96, 9001);
  const starsMat = new THREE.MeshBasicMaterial({ vertexColors: true, fog: false });
  const starsMesh = new THREE.Mesh(starsGeo, starsMat);
  root.add(starsMesh);

  return {
    root,
    cloudGroup,
    cloudInnerMesh,
    cloudOuterMesh,
    cloudInnerMaterial,
    cloudOuterMaterial,
    cloudInnerBaseOpacity: 0.78,
    cloudOuterBaseOpacity: 0.42,
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

const CAMERA_FOV_DEG = 42;
const TAN_HALF_VFOV = Math.tan(THREE.MathUtils.degToRad(CAMERA_FOV_DEG * 0.5));

/** 计算 Minecraft 视角预设：按画布宽高比与室外草坪/树木尺度精准标定视距，避免裁切 */
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
      // 45° 等距斜俯视：确保「整间房 + 四周草地 + 至少 2 棵树与水池」完整入画并留出边距
      const spanX = halfW + 4.0;
      const spanZ = halfD + 4.0;
      const halfH = 2.6;
      const horizHalf = (spanX + spanZ) * 0.7071;
      const vertHalf = horizHalf * 0.54 + halfH * 0.84;
      const distV = (vertHalf / TAN_HALF_VFOV) * 1.12;
      const distH = (horizHalf / tanHalfH) * 1.12;
      const dist = Math.max(distV, distH);
      const target = new THREE.Vector3(0, 0.72, 0.35);
      // 单位方向向量 (0.59, 0.55, 0.59)，方位角 45°、俯角约 33.4°
      return {
        position: new THREE.Vector3(
          target.x + dist * 0.59,
          target.y + dist * 0.55,
          target.z + dist * 0.59
        ),
        target,
      };
    }
    case 'corridor': {
      // 低角度走廊视角：覆盖整间房宽度、前门廊、两侧树影与后墙面板，不裁切左右边缘
      const target = new THREE.Vector3(0, 1.15, -0.35);
      const needDistH = ((halfW + 3.2) / tanHalfH) * 1.08;
      const needDistV = (4.2 / TAN_HALF_VFOV) * 1.08;
      const distZ = Math.max(halfD + 6.4, Math.max(needDistH, needDistV));
      return {
        position: new THREE.Vector3(
          Math.max(1.2, halfW * 0.24),
          3.15,
          distZ
        ),
        target,
      };
    }
    case 'overview': {
      // 全景正俯视（自动隐藏屋顶层）：完整收纳全部室内工位、外围草地、树木与水池
      const target = new THREE.Vector3(0, 0.35, 0);
      const needHByDepth = ((halfD + 4.8) / TAN_HALF_VFOV) * 1.12;
      const needHByWidth = ((halfW + 4.8) / tanHalfH) * 1.12;
      const height = Math.max(needHByDepth, needHByWidth);
      return {
        position: new THREE.Vector3(0, height, 2.6),
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
  private readonly dragHitPoint = new THREE.Vector3();

  private readonly hemiLight: THREE.HemisphereLight;
  private readonly sunLight: THREE.DirectionalLight;
  private readonly lanternLightA: THREE.PointLight;
  private readonly lanternLightB: THREE.PointLight;
  private readonly skyRig: SkyRig;
  private readonly roomRig: OfficeRoomRig;
  private readonly voxelMaterials: VoxelMaterialSet;
  private readonly stations = new Map<string, OfficeStationRig>();
  private readonly behaviourManager = new OfficeBehaviourManager();

  private currentState: OfficeSceneSyncState | null = null;
  private currentPalette: OfficeScenePalette;
  private currentMetrics: BayGridMetrics = computeBayGridMetrics(2);
  private viewportWidth = 1280;
  private viewportHeight = 720;
  private rasterVersion = getOfficeWallpaperRasterVersion();

  private lastRoomKey = '';
  private lastPreset: OfficeCameraPreset = 'isometric';
  private lastSessionCount = 0;
  private activeCameraGoal: CameraGoal | null = null;
  private applyingCameraTransition = false;
  private userMovedCamera = false;

  private hoveredTarget: OfficeHitTarget | null = null;
  private pointerDownTarget: OfficeHitTarget | null = null;
  private pointerTrack: PointerTrackState = {
    active: false,
    startX: 0,
    startY: 0,
    maxDistSq: 0,
  };
  private lastClickMaxDistSq = 0;

  private monitorEditState: MonitorEditState = {
    enabled: false,
    activeMonitorIndex: 0,
    dragMode: 'xz',
  };
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
  private readonly panForwardScratch = new THREE.Vector3();
  private readonly panRightScratch = new THREE.Vector3();
  private readonly panDeltaScratch = new THREE.Vector3();
  private readonly panTargetVelScratch = new THREE.Vector3();
  private readonly panFallbackUpScratch = new THREE.Vector3();

  private rafId: number | null = null;
  private behaviourWakeTimerId: number | null = null;
  private lastFrameTimeMs = 0;
  private lastBehaviourClockMs = 0;
  private elapsedActiveSec = 0;
  private controlsInteracting = false;
  private cameraSettleFrames = 0;
  private readonly prevCamPosScratch = new THREE.Vector3();
  private readonly prevCamTargetScratch = new THREE.Vector3();
  private needsStaticRender = true;
  private singleFrameRendering = false;
  private contextLost = false;
  private disposed = false;

  private readonly resizeObserver: ResizeObserver;
  private readonly unsubscribeWallpaperRaster: () => void;
  private readonly acquiredWallpaperCacheRef: boolean;
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
    this.scene.fog = new THREE.Fog(this.currentPalette.fogHex, 26, 68);

    const rect = container.getBoundingClientRect();
    this.viewportWidth = Math.max(320, Math.round(rect.width || 1200));
    this.viewportHeight = Math.max(260, Math.round(rect.height || 680));

    this.camera = new THREE.PerspectiveCamera(
      CAMERA_FOV_DEG,
      this.viewportWidth / this.viewportHeight,
      0.15,
      240
    );

    // Minecraft 日夜四光源管线：天空/地面半球光 + 2048 硬阴影太阳/月亮平行光 + 2 盏暖色灯笼点光源
    this.hemiLight = new THREE.HemisphereLight('#d6eeff', '#7da658', 0.82);
    this.scene.add(this.hemiLight);

    this.sunLight = new THREE.DirectionalLight('#fffbeb', 1.05);
    this.sunLight.position.set(15, 22, 12);
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.set(2048, 2048);
    this.sunLight.shadow.camera.near = 2;
    this.sunLight.shadow.camera.far = 68;
    this.sunLight.shadow.camera.left = -16;
    this.sunLight.shadow.camera.right = 16;
    this.sunLight.shadow.camera.top = 16;
    this.sunLight.shadow.camera.bottom = -16;
    this.sunLight.shadow.bias = -0.0004;
    this.sunLight.shadow.normalBias = 0.015;
    this.scene.add(this.sunLight);

    this.lanternLightA = new THREE.PointLight('#ffb95e', 4.6, 20, 1.15);
    this.lanternLightA.position.set(-1.5, 3.05, -0.25);
    this.scene.add(this.lanternLightA);

    this.lanternLightB = new THREE.PointLight('#ffb95e', 4.6, 20, 1.15);
    this.lanternLightB.position.set(1.5, 3.05, 0.35);
    this.scene.add(this.lanternLightB);

    let renderer: THREE.WebGLRenderer | null = null;
    let canvas: HTMLCanvasElement | null = null;
    let controls: OrbitControls | null = null;
    let roomRig: OfficeRoomRig | null = null;
    let skyRig: SkyRig | null = null;
    let voxelMaterials: VoxelMaterialSet | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let acquiredWallpaperRef = false;
    let acquiredVoxelRef = false;
    let unsubscribeWallpaperRaster: (() => void) | null = null;
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
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(this.viewportWidth, this.viewportHeight, false);
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      // Minecraft 饱和明亮直出：禁用偏暗电影感 ACES，采用 NoToneMapping + 1.08 曝光
      renderer.toneMapping = THREE.NoToneMapping;
      renderer.toneMappingExposure = 1.08;
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFShadowMap;

      canvas = renderer.domElement;
      canvas.className = 'office-webgl-canvas';
      canvas.style.width = '100%';
      canvas.style.height = '100%';
      canvas.style.display = 'block';
      this.container.appendChild(canvas);

      controls = new OrbitControls(this.camera, canvas);
      controls.enableDamping = !initialReducedMotion;
      controls.dampingFactor = 0.085;
      controls.enableRotate = true;
      controls.enableZoom = true;
      controls.enablePan = true;
      controls.screenSpacePanning = true;
      // 平移由控制器自己在捕获阶段实现（右键/中键/Shift+左键），OrbitControls 只保留左键旋转。
      // 这样右键不会被浏览器菜单或其它手势抢走，中键也回到「平移」而不是极弱的缩放。
      controls.mouseButtons = {
        LEFT: THREE.MOUSE.ROTATE,
        MIDDLE: null,
        RIGHT: null,
      } as unknown as typeof controls.mouseButtons;
      controls.rotateSpeed = 0.78;
      controls.zoomSpeed = 1.4;
      controls.zoomToCursor = true;
      controls.panSpeed = 0.85;
      controls.minDistance = 1.2;
      controls.maxDistance = 60;
      controls.minPolarAngle = 0.02;
      controls.maxPolarAngle = Math.PI * 0.62;

      const anisotropy = Math.max(4, renderer.capabilities.getMaxAnisotropy());
      roomRig = createOfficeRoomRig(this.currentPalette, anisotropy);
      this.scene.add(roomRig.root);

      const initialOuterHalf = Math.max(roomRig.outerHalfWidth, roomRig.outerHalfDepth);
      skyRig = createMinecraftSkyRig(initialOuterHalf);
      this.scene.add(skyRig.root);

      this.renderer = renderer;
      this.controls = controls;
      this.roomRig = roomRig;
      this.skyRig = skyRig;
      this.voxelMaterials = voxelMaterials;

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

      acquireOfficeWallpaperCacheRef();
      acquiredWallpaperRef = true;
      unsubscribeWallpaperRaster = subscribeOfficeWallpaperRasterReady(
        this.handleWallpaperRasterReady
      );
      this.unsubscribeWallpaperRaster = unsubscribeWallpaperRaster;
      this.acquiredWallpaperCacheRef = true;
      this.acquiredVoxelMaterialsRef = true;
      this.lastBehaviourClockMs = performance.now();

      this.syncAnimationSchedule();
    } catch (error: unknown) {
      this.disposed = true;
      this.stopAnimationLoop();
      unsubscribeWallpaperRaster?.();
      if (acquiredWallpaperRef) {
        releaseOfficeWallpaperCacheRef();
      }
      resizeObserver?.disconnect();
      if (listenersAttached && canvas && controls) {
        this.detachEventListeners(canvas, controls);
      }
      controls?.dispose();
      if (roomRig) {
        disposeOfficeRoomRig(roomRig);
      }
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

  private applyThemeLightingAndSky(theme: 'dark' | 'light'): void {
    const palette = this.currentPalette;
    const skyHex = palette.skyHex ?? palette.backgroundHex;
    if (this.scene.background instanceof THREE.Color) {
      this.scene.background.set(skyHex);
    } else {
      this.scene.background = new THREE.Color(skyHex);
    }
    if (this.scene.fog instanceof THREE.Fog) {
      this.scene.fog.color.set(palette.fogHex);
    }

    this.voxelMaterials.syncTheme(theme);

    const isLight = theme === 'light';
    if (isLight) {
      // 明亮饱和的 Minecraft 白天：晴朗蓝天白云 + 暖金太阳硬阴影 + 灯笼实体辨识不喧宾夺主
      this.hemiLight.color.set('#d6eeff');
      this.hemiLight.groundColor.set('#7da658');
      this.hemiLight.intensity = 0.82;

      this.sunLight.color.set('#fffbeb');
      this.sunLight.intensity = 1.05;
      this.sunLight.position.set(15, 22, 12);

      this.lanternLightA.color.set(palette.lanternGlowHex ?? '#ffc45e');
      this.lanternLightB.color.set(palette.lanternGlowHex ?? '#ffc45e');
      this.lanternLightA.intensity = 0.25;
      this.lanternLightB.intensity = 0.25;

      this.skyRig.cloudInnerMaterial.color.set(palette.cloudHex ?? '#ffffff');
      this.skyRig.cloudOuterMaterial.color.set(palette.cloudHex ?? '#ffffff');
      this.skyRig.cloudInnerBaseOpacity = 0.78;
      this.skyRig.cloudOuterBaseOpacity = 0.42;
      this.skyRig.sunMesh.visible = true;
      this.skyRig.moonMesh.visible = false;
      this.skyRig.starsMesh.visible = false;
    } else {
      // 清澈可读的 Minecraft 夜晚：深蓝夜空 + 月光与星点 + 充足室内暖光，确保桌面/键盘/边框/角色清晰无死黑
      this.hemiLight.color.set('#6b90d6');
      this.hemiLight.groundColor.set('#3c4b68');
      this.hemiLight.intensity = 0.72;

      this.sunLight.color.set('#bad6ff');
      this.sunLight.intensity = 0.58;
      this.sunLight.position.set(-12, 18, 10);

      this.lanternLightA.color.set(palette.lanternGlowHex ?? '#ffb95e');
      this.lanternLightB.color.set(palette.lanternGlowHex ?? '#ffb95e');
      this.lanternLightA.intensity = 4.6;
      this.lanternLightB.intensity = 4.6;

      this.skyRig.cloudInnerMaterial.color.set(palette.cloudHex ?? '#526899');
      this.skyRig.cloudOuterMaterial.color.set(palette.cloudHex ?? '#526899');
      this.skyRig.cloudInnerBaseOpacity = 0.52;
      this.skyRig.cloudOuterBaseOpacity = 0.26;
      this.skyRig.sunMesh.visible = false;
      this.skyRig.moonMesh.visible = true;
      this.skyRig.starsMesh.visible = true;
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
    this.skyRig.cloudInnerMesh.geometry = createBlockyCloudRingGeometry(innerMinR, innerMaxR, 11, 2026);
    this.skyRig.cloudOuterMesh.geometry.dispose();
    this.skyRig.cloudOuterMesh.geometry = createBlockyCloudRingGeometry(outerMinR, outerMaxR, 14, 4093);

    this.skyRig.cloudInnerMinR = innerMinR;
    this.skyRig.cloudInnerMaxR = innerMaxR;
    this.skyRig.cloudOuterMinR = outerMinR;
    this.skyRig.cloudOuterMaxR = outerMaxR;
    this.skyRig.cloudOuterHalfBuilt = outerHalf;
  }

  /** 根据相机到内外云环带的空间距离动态淡出云层，杜绝任何相机姿态下出现贴脸大云板 */
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

  private updateDynamicSceneForCamera(): boolean {
    const cullingChanged = updateOfficeRoomDynamicCulling(this.roomRig, this.camera.position);
    this.updateCloudProximityFade();
    // 贴近读屏时隐藏选中描边框，避免青色边框压在屏幕上。
    const selectedKey = this.currentState?.selectedSessionKey || '';
    const readingDistance = this.camera.position.distanceTo(this.controls.target) <= 3.4;
    for (const rig of this.stations.values()) {
      rig.selectionFrameMesh.visible = Boolean(selectedKey) && rig.sessionKey === selectedKey && !readingDistance;
    }
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
      shadowCam.far = extent * 3.8 + 16;
      shadowCam.updateProjectionMatrix();
    }

    if (this.scene.fog instanceof THREE.Fog) {
      this.scene.fog.near = Math.max(38, outerSpan * 3.4);
      this.scene.fog.far = Math.max(94, outerSpan * 8.0);
    }

    const lanternRadius = Math.max(18, outerSpan * 1.9);
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

  private attachEventListeners(canvas: HTMLCanvasElement, controls: OrbitControls): void {
    controls.addEventListener('change', this.handleControlsChange);
    controls.addEventListener('start', this.handleControlsStart);
    controls.addEventListener('end', this.handleControlsEnd);
    // 捕获阶段优先接管编辑模式下的显示器拖拽，抢先于 OrbitControls 的冒泡阶段 pointerdown
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

    // 切换服务器/房间/选中目标或关闭双屏前先围栏回滚进行中的显示器拖拽，防止跨作用域误提交
    if (this.monitorDrag?.active) {
      const drag = this.monitorDrag;
      const nextSessionStillPresent = state.sessions.some(
        (item) => item.sessionKey === drag.sessionKey
      );
      const nextPrefs =
        state.computerPreferences[drag.sessionKey] ?? DEFAULT_OFFICE_COMPUTER_PREFERENCES;
      const roomWillChange = this.lastRoomKey !== '' && state.roomKey !== this.lastRoomKey;
      const dragTargetInvalidated =
        drag.serverId !== state.serverId
        || roomWillChange
        || state.selectedSessionKey !== drag.sessionKey
        || !nextSessionStillPresent
        || (drag.monitorIndex === 1 && !nextPrefs.dualMonitor);
      if (dragTargetInvalidated) {
        this.cancelMonitorDrag();
      }
    }

    const prevReducedMotion = this.currentState?.reducedMotion ?? false;
    this.currentState = state;
    this.currentPalette = getOfficeScenePalette(state.theme);

    this.applyThemeLightingAndSky(state.theme);
    this.controls.enableDamping = !state.reducedMotion;

    const metrics = computeBayGridMetrics(state.sessions.length);
    this.currentMetrics = metrics;

    // 按稳定 sessionKey 增量复用工位网格，不因状态刷新重建场景
    const activeKeys = new Set<string>();
    const anisotropy = Math.max(4, this.renderer.capabilities.getMaxAnisotropy());

    state.sessions.forEach((session, index) => {
      activeKeys.add(session.sessionKey);
      const bay = metrics.bayPositions[index] || { x: 0, z: 0 };
      let stationRig = this.stations.get(session.sessionKey);
      const isNew = !stationRig;

      if (!stationRig) {
        stationRig = createWorkstationPod(session, this.currentPalette, anisotropy);
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
      const isEditingThisStation = this.monitorEditState.enabled && isSelected;

      syncWorkstationPod(stationRig, session, this.currentPalette, {
        isSelected,
        isHovered,
        preferences: effectivePrefs,
        rasterVersion: this.rasterVersion,
        isEditingThisStation,
        activeEditMonitorIndex: this.monitorEditState.activeMonitorIndex,
      });
    });

    // 卸载离开当前房间/分区的工位并彻底释放 GPU 资源
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
      this.lastBehaviourClockMs = performance.now();
    } else if (this.rafId === null && !prevReducedMotion && !state.reducedMotion) {
      // 按需静止期间发生数据同步时，补齐真实经过的坐姿计时，不丢失定时进度
      this.advanceBehaviourIdleClock(performance.now());
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
    const countChanged = state.sessions.length !== this.lastSessionCount;
    this.lastSessionCount = state.sessions.length;
    if (roomChanged) {
      this.lastRoomKey = state.roomKey;
      this.userMovedCamera = false;
    }
    if (presetChanged) {
      if (this.monitorDrag?.active) {
        this.cancelMonitorDrag();
      }
      this.lastPreset = state.cameraPreset;
      this.userMovedCamera = false;
    }

    if (
      roomChanged
      || presetChanged
      || (countChanged && !this.userMovedCamera && !this.monitorDrag?.active)
    ) {
      this.applyCameraPreset(state.cameraPreset, roomChanged || state.reducedMotion);
    } else {
      this.clampControlsTarget();
      this.updateDynamicSceneForCamera();
    }

    this.needsStaticRender = true;
    this.syncAnimationSchedule();
  }

  public setMonitorEditState(
    enabled: boolean,
    activeMonitorIndex: OfficeMonitorIndex,
    dragMode: OfficeMonitorDragMode
  ): void {
    if (this.disposed) return;

    if (!enabled) {
      if (this.monitorDrag?.active) {
        this.cancelMonitorDrag();
      } else {
        this.controls.enabled = true;
      }
    } else if (
      this.monitorDrag?.active
      && activeMonitorIndex !== this.monitorEditState.activeMonitorIndex
      && this.monitorDrag.monitorIndex !== activeMonitorIndex
    ) {
      this.cancelMonitorDrag();
    }

    const changed =
      this.monitorEditState.enabled !== enabled
      || this.monitorEditState.activeMonitorIndex !== activeMonitorIndex
      || this.monitorEditState.dragMode !== dragMode;

    this.monitorEditState = {
      enabled,
      activeMonitorIndex,
      dragMode,
    };

    if (changed && this.currentState) {
      this.resyncAllStationsOnly();
    }
  }

  public previewStationMonitorTransform(
    sessionKey: string,
    monitorIndex: OfficeMonitorIndex,
    transform: OfficeMonitorTransform
  ): void {
    if (this.disposed) return;
    const rig = this.stations.get(sessionKey);
    if (!rig) return;
    const prefs = this.getStationPreferences(sessionKey);
    const nextMonitors: [OfficeMonitorTransform, OfficeMonitorTransform] = [
      monitorIndex === 0 ? transform : prefs.monitors[0],
      monitorIndex === 1 ? transform : prefs.monitors[1],
    ];
    applyDualMonitorTransforms(rig.monitorAssembly, nextMonitors, prefs.dualMonitor);
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
    this.userMovedCamera = false;
    this.applyCameraPreset(targetPreset, Boolean(this.currentState?.reducedMotion));
  }

  public focusStation(sessionKey: string): void {
    if (this.disposed) return;
    if (this.monitorDrag?.active) {
      this.cancelMonitorDrag();
    }
    const rig = this.stations.get(sessionKey);
    if (!rig) return;

    const { screenTopTarget, screenForward } = computeMonitorFocusAnchor(
      rig.monitorAssembly,
      rig.targetPosition,
      0
    );
    const horizDist = Math.sqrt(
      Math.max(
        0.25,
        FOCUS_MONITOR_DISTANCE * FOCUS_MONITOR_DISTANCE
          - FOCUS_CAMERA_ELEVATION_OFFSET * FOCUS_CAMERA_ELEVATION_OFFSET
      )
    );
    const cameraPos = new THREE.Vector3(
      screenTopTarget.x + screenForward.x * horizDist,
      screenTopTarget.y + FOCUS_CAMERA_ELEVATION_OFFSET,
      screenTopTarget.z + screenForward.z * horizDist
    );

    const goal: CameraGoal = {
      position: cameraPos,
      target: screenTopTarget,
    };
    this.clearKeyboardPanState();
    this.userMovedCamera = true;
    if (this.currentState?.reducedMotion) {
      this.setCameraImmediate(goal);
    } else {
      this.activeCameraGoal = goal;
      this.syncAnimationSchedule();
    }
  }

  public projectStationPartToRect(
    sessionKey: string,
    part: 'monitor',
    monitorIndex: OfficeMonitorIndex = 0
  ): DesktopOriginRect | undefined {
    const rig = this.stations.get(sessionKey);
    if (!rig) return undefined;

    const targetObj = part === 'monitor' ? getStationMonitorScreenMesh(rig, monitorIndex) : null;
    if (!targetObj) return undefined;

    const box = new THREE.Box3().setFromObject(targetObj);
    if (box.isEmpty()) return undefined;

    const corners = [
      new THREE.Vector3(box.min.x, box.min.y, box.min.z),
      new THREE.Vector3(box.min.x, box.min.y, box.max.z),
      new THREE.Vector3(box.min.x, box.max.y, box.min.z),
      new THREE.Vector3(box.min.x, box.max.y, box.max.z),
      new THREE.Vector3(box.max.x, box.min.y, box.min.z),
      new THREE.Vector3(box.max.x, box.min.y, box.max.z),
      new THREE.Vector3(box.max.x, box.max.y, box.min.z),
      new THREE.Vector3(box.max.x, box.max.y, box.max.z),
    ];

    const canvasRect = this.renderer.domElement.getBoundingClientRect();
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;

    for (const corner of corners) {
      corner.project(this.camera);
      const sx = canvasRect.left + ((corner.x + 1) * 0.5) * canvasRect.width;
      const sy = canvasRect.top + ((1 - corner.y) * 0.5) * canvasRect.height;
      minX = Math.min(minX, sx);
      minY = Math.min(minY, sy);
      maxX = Math.max(maxX, sx);
      maxY = Math.max(maxY, sy);
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
    this.clearBehaviourWakeTimer();
    this.behaviourManager.resetRoom();
    this.resizeObserver.disconnect();
    this.unsubscribeWallpaperRaster();
    if (this.acquiredWallpaperCacheRef) {
      releaseOfficeWallpaperCacheRef();
    }
    this.detachEventListeners(this.renderer.domElement, this.controls);
    this.controls.dispose();

    for (const rig of this.stations.values()) {
      disposeStationTextureBundles(rig);
    }
    this.stations.clear();

    disposeOfficeRoomRig(this.roomRig);
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
      return {
        ...prefs,
        monitors: [
          drag.monitorIndex === 0 ? drag.currentTransform : prefs.monitors[0],
          drag.monitorIndex === 1 ? drag.currentTransform : prefs.monitors[1],
        ],
      };
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
        rasterVersion: this.rasterVersion,
        isEditingThisStation: this.monitorEditState.enabled && isSelected,
        activeEditMonitorIndex: this.monitorEditState.activeMonitorIndex,
      });
    }
    this.needsStaticRender = true;
    if (this.rafId === null) {
      this.renderSingleFrame();
    }
  }

  private readonly handleWallpaperRasterReady = (): void => {
    if (this.disposed) return;
    this.rasterVersion = getOfficeWallpaperRasterVersion();
    this.resyncAllStationsOnly();
  };

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
    this.updateDynamicSceneForCamera();
    this.applyingCameraTransition = false;
    this.needsStaticRender = true;
    if (this.rafId === null) {
      this.renderSingleFrame();
    }
  }

  /** 将 controls.target 夹紧在岛屿边界 ±(outerHalfWidth + 2)、±(outerHalfDepth + 2)、y ∈ [0, 3] 内，并同步校正相机避免拖歪 */
  /** 屏幕像素位移 → 世界平移；与 OrbitControls 的 screenSpacePanning 同一手感。 */
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
    this.controls.update();
    this.updateDynamicSceneForCamera();
    this.userMovedCamera = true;
    this.renderSingleFrame();
  }

  private endSurfacePan(pointerId: number): void {
    if (!this.surfacePan.active) return;
    this.surfacePan.active = false;
    try {
      this.renderer.domElement.releasePointerCapture(pointerId);
    } catch {
      // 捕获已释放时忽略
    }
    this.controls.enabled = true;
    this.updateCursorForState(this.hoveredTarget);
    this.renderSingleFrame();
  }

  private readonly handleContextMenu = (event: MouseEvent): void => {
    // 右键平移全程不得弹出浏览器菜单。
    event.preventDefault();
    event.stopPropagation();
  };

  private readonly handleWheel = (event: WheelEvent): void => {
    if (this.disposed || this.contextLost) return;
    const horizontal = event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY) * 1.2;
    if (!horizontal) return; // 纵向滚轮交给 OrbitControls 缩放
    event.preventDefault();
    event.stopPropagation();
    const amount = event.shiftKey && event.deltaX === 0 ? event.deltaY : event.deltaX;
    this.panByScreenPixels(-amount * 0.6, 0);
  };

  private clampControlsTarget(): void {
    const prevX = this.controls.target.x;
    const prevY = this.controls.target.y;
    const prevZ = this.controls.target.z;
    const maxPanX = Math.max(6, this.roomRig.outerHalfWidth + 2);
    const maxPanZ = Math.max(6, this.roomRig.outerHalfDepth + 2);
    const nextX = THREE.MathUtils.clamp(prevX, -maxPanX, maxPanX);
    const nextY = THREE.MathUtils.clamp(prevY, 0, 3);
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
    const maxPanX = Math.max(6, this.roomRig.outerHalfWidth + 2);
    const maxPanZ = Math.max(6, this.roomRig.outerHalfDepth + 2);

    const nextX = THREE.MathUtils.clamp(prevX + delta.x, -maxPanX, maxPanX);
    const nextY = THREE.MathUtils.clamp(prevY + delta.y, 0, 3);
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

    const panKey = normalizePanKey(event);
    if (!panKey) return;
    if (isEditableOrOverlayEventTarget(event.target)) return;

    const rect = this.container.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    event.preventDefault();
    this.activeCameraGoal = null;
    this.userMovedCamera = true;
    this.panShiftHeld = event.shiftKey;

    if (this.currentState?.reducedMotion) {
      // reducedMotion 下保留键盘平移，采用非平滑离散步进并即时重绘
      this.computeGroundPanBasis(this.panForwardScratch, this.panRightScratch);
      const forwardSign = panKey === 'w' ? 1 : panKey === 's' ? -1 : 0;
      const rightSign = panKey === 'd' ? 1 : panKey === 'a' ? -1 : 0;
      const camDist = this.camera.position.distanceTo(this.controls.target);
      const step = Math.max(0.45, Math.min(2.2, camDist * 0.055)) * (event.shiftKey ? 2.4 : 1.0);
      this.panDeltaScratch
        .set(0, 0, 0)
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
      // 轻按单次按键也给予微小平滑初速，保证点按与长按都跟手
      this.computeGroundPanBasis(this.panForwardScratch, this.panRightScratch);
      const forwardSign = panKey === 'w' ? 1 : panKey === 's' ? -1 : 0;
      const rightSign = panKey === 'd' ? 1 : panKey === 'a' ? -1 : 0;
      const camDist = this.camera.position.distanceTo(this.controls.target);
      const speed = Math.max(5.5, Math.min(26, camDist * 0.5)) * (event.shiftKey ? 2.4 : 1.0);
      this.panVelocity
        .addScaledVector(this.panForwardScratch, forwardSign * speed * 0.35)
        .addScaledVector(this.panRightScratch, rightSign * speed * 0.35);
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
    this.controlsInteracting = true;
    this.cameraSettleFrames = 3;
    if (!this.applyingCameraTransition) {
      this.activeCameraGoal = null;
      this.userMovedCamera = true;
    }
    if (!this.currentState?.reducedMotion) {
      this.syncAnimationSchedule();
    }
  };

  private readonly handleControlsEnd = (): void => {
    this.controlsInteracting = false;
    this.cameraSettleFrames = Math.max(this.cameraSettleFrames, 2);
  };

  private readonly handleControlsChange = (): void => {
    this.clampControlsTarget();
    const cullingChanged = this.updateDynamicSceneForCamera();
    if (cullingChanged) {
      this.needsStaticRender = true;
    }

    if (!this.applyingCameraTransition && !this.singleFrameRendering) {
      if (this.currentState?.reducedMotion) {
        this.needsStaticRender = true;
        this.renderSingleFrame();
      } else if (this.rafId === null) {
        // 滚轮缩放或外部触发相机变化时启动短时 RAF 让阻尼平滑收尾，静止后自动停表
        this.cameraSettleFrames = Math.max(this.cameraSettleFrames, 3);
        this.syncAnimationSchedule();
      }
    }
  };

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
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(nextW, nextH, false);

    if (!this.userMovedCamera && this.currentState) {
      this.applyCameraPreset(this.currentState.cameraPreset, true);
    } else {
      this.needsStaticRender = true;
      if (this.rafId === null) {
        this.renderSingleFrame();
      }
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
      this.clearBehaviourWakeTimer();
    } else {
      const now = performance.now();
      this.lastFrameTimeMs = now;
      this.lastBehaviourClockMs = now;
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
    this.clearBehaviourWakeTimer();
    if (!this.disposed) {
      this.callbacks.onContextLostChange?.(true);
    }
  };

  private readonly handleContextRestored = (): void => {
    if (this.disposed) return;
    this.contextLost = false;
    this.lastBehaviourClockMs = performance.now();
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

    // 隐藏的墙体与附着在其上的房间邮件终端自动退出拾取，不被 raycast 命中
    const pickables: THREE.Object3D[] = [];
    if (isObjectHierarchyVisible(this.roomRig.roomTerminalGroup)) {
      pickables.push(this.roomRig.roomTerminalGroup);
    }
    for (const rig of this.stations.values()) {
      if (isObjectHierarchyVisible(rig.root)) {
        pickables.push(rig.root);
      }
    }

    const hits = this.raycaster.intersectObjects(pickables, true);
    for (const hit of hits) {
      if (!isObjectHierarchyVisible(hit.object)) {
        continue;
      }
      let node: THREE.Object3D | null = hit.object;
      let hitKind: OfficeHitKind | undefined;
      let sessionKey: string | undefined;
      let monitorIndex: OfficeMonitorIndex | undefined;

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
        if (
          monitorIndex === undefined
          && (node.userData.monitorIndex === 0 || node.userData.monitorIndex === 1)
        ) {
          monitorIndex = node.userData.monitorIndex;
        }
        node = node.parent;
      }

      if (hitKind) {
        return { kind: hitKind, sessionKey, monitorIndex };
      }
    }

    return null;
  }

  private updateCursorForState(target: OfficeHitTarget | null): void {
    const canvas = this.renderer.domElement;
    if (this.monitorDrag?.active) {
      canvas.style.cursor = 'grabbing';
      return;
    }
    if (this.pointerTrack.active && this.pointerTrack.maxDistSq > CLICK_DRAG_THRESHOLD_SQ) {
      canvas.style.cursor = 'grabbing';
      return;
    }
    if (
      this.monitorEditState.enabled
      && target?.kind === 'monitor'
      && target.sessionKey === this.currentState?.selectedSessionKey
    ) {
      canvas.style.cursor = this.monitorEditState.dragMode === 'yaw'
        ? 'ew-resize'
        : this.monitorEditState.dragMode === 'y'
          ? 'ns-resize'
          : 'move';
      return;
    }
    canvas.style.cursor = target ? 'pointer' : 'grab';
  }

  private updateHoverAtPoint(clientX: number, clientY: number): void {
    const target = this.raycastAtClientPoint(clientX, clientY);
    const prev = this.hoveredTarget;
    const changed =
      prev?.kind !== target?.kind
      || prev?.sessionKey !== target?.sessionKey
      || prev?.monitorIndex !== target?.monitorIndex;
    this.hoveredTarget = target;

    this.updateCursorForState(target);

    if (changed) {
      if (this.currentState) {
        this.resyncAllStationsOnly();
        syncOfficeRoomRig(
          this.roomRig,
          this.currentState,
          this.currentPalette,
          this.currentMetrics.roomWidth,
          this.currentMetrics.roomDepth
        );
        if (this.rafId === null) {
          this.renderSingleFrame();
        }
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
      const prefs = target.sessionKey
        ? this.getStationPreferences(target.sessionKey)
        : DEFAULT_OFFICE_COMPUTER_PREFERENCES;
      const screenTag = target.monitorIndex === 1 ? '副屏 #2' : '主屏 #1';
      if (
        this.monitorEditState.enabled
        && target.sessionKey === this.currentState?.selectedSessionKey
      ) {
        return {
          kind: 'monitor',
          sessionKey: target.sessionKey,
          monitorIndex: target.monitorIndex,
          label: `${label} · ${screenTag}`,
          hint: '拖拽调整显示器 · Shift+拖拽旋转 · Alt+拖拽调高',
          clientX,
          clientY,
        };
      }
      if (prefs.power === 'off') {
        return {
          kind: 'monitor',
          sessionKey: target.sessionKey,
          monitorIndex: target.monitorIndex,
          label,
          hint: '虚拟电脑已关机 · 点击打开开机面板',
          clientX,
          clientY,
        };
      }
      return {
        kind: 'monitor',
        sessionKey: target.sessionKey,
        monitorIndex: target.monitorIndex,
        label: prefs.dualMonitor ? `${label} · ${screenTag}` : label,
        hint: '点击打开员工电脑桌面',
        clientX,
        clientY,
      };
    }
    const pose = target.sessionKey ? this.behaviourManager.getPose(target.sessionKey) : null;
    let stationHint = '点击选中工位 · 双击打开桌面';
    if (pose && pose.phase !== 'seated') {
      if (
        pose.goal === 'coffee'
        || pose.phase === 'brewing_coffee'
        || pose.phase === 'drinking_coffee'
        || pose.holdingCoffee
      ) {
        stationHint = '点击选中工位 · 正在接咖啡 · 双击打开桌面';
      } else if (pose.goal === 'stroll') {
        stationHint = '点击选中工位 · 正在散步 · 双击打开桌面';
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
    if (currentMatchesOrigin) {
      const authoritativePrefs = this.getStationPreferences(drag.sessionKey);
      applyDualMonitorTransforms(
        rig.monitorAssembly,
        authoritativePrefs.monitors,
        authoritativePrefs.dualMonitor
      );
      return;
    }

    const fallbackPrefs = this.getStationPreferences(drag.sessionKey);
    const restoredMonitors: [OfficeMonitorTransform, OfficeMonitorTransform] = [
      drag.monitorIndex === 0 ? drag.startTransform : fallbackPrefs.monitors[0],
      drag.monitorIndex === 1 ? drag.startTransform : fallbackPrefs.monitors[1],
    ];
    applyDualMonitorTransforms(
      rig.monitorAssembly,
      restoredMonitors,
      fallbackPrefs.dualMonitor
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
      this.callbacks.onCancelMonitorTransform?.(
        drag.serverId,
        drag.sessionKey,
        drag.monitorIndex
      );
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

    const nextPrefs = this.getStationPreferences(drag.sessionKey);
    const canCommitOrigin =
      !this.disposed
      && this.monitorEditState.enabled
      && Boolean(this.currentState)
      && this.currentState?.serverId === drag.serverId
      && this.currentState?.selectedSessionKey === drag.sessionKey
      && Boolean(this.currentState?.sessions.some((item) => item.sessionKey === drag.sessionKey))
      && (drag.monitorIndex === 0 || nextPrefs.dualMonitor);

    if (!canCommitOrigin) {
      this.cancelMonitorDrag();
      return;
    }

    // 释放捕获前先清空拖拽句柄，防止 lostpointercapture 误回滚已提交变换
    this.monitorDrag = null;
    this.controls.enabled = true;
    this.controls.enableDamping = !this.currentState?.reducedMotion;
    this.releasePointerCaptureSafe(drag.pointerId);

    this.callbacks.onCommitMonitorTransform?.(
      drag.serverId,
      drag.sessionKey,
      drag.monitorIndex,
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
    // 右键 / 中键 / Shift+左键：控制器自己平移。捕获阶段抢占，OrbitControls 与浏览器右键菜单都不能插手。
    const wantsPan =
      event.button === 2
      || event.button === 1
      || (event.button === 0 && event.shiftKey && !this.monitorEditState.enabled);
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
        // 合成事件环境下忽略指针捕获异常
      }
      this.renderer.domElement.style.cursor = 'grabbing';
      return;
    }
    if (event.button !== 0) return;

    if (this.monitorEditState.enabled && this.currentState?.selectedSessionKey) {
      const target = this.raycastAtClientPoint(event.clientX, event.clientY);
      if (
        target?.kind === 'monitor'
        && target.sessionKey === this.currentState.selectedSessionKey
      ) {
        const rig = this.stations.get(target.sessionKey);
        if (rig) {
          // 捕获阶段抢占指针，阻止 OrbitControls 接管拖拽
          event.stopPropagation();
          event.stopImmediatePropagation();
          event.preventDefault();
          this.cancelPointerTrack();
          this.freezeOrbitMotion();
          this.controls.enabled = false;

          const prefs = this.getStationPreferences(target.sessionKey);
          const monitorIndex: OfficeMonitorIndex =
            target.monitorIndex === 1 && prefs.dualMonitor ? 1 : 0;
          const unit = rig.monitorAssembly.monitors[monitorIndex];

          const worldPos = new THREE.Vector3();
          unit.screenMesh.getWorldPosition(worldPos);
          const dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -worldPos.y);
          const planeStartHit = new THREE.Vector3();
          if (
            !this.setRayFromClientPoint(event.clientX, event.clientY)
            || !this.raycaster.ray.intersectPlane(dragPlane, planeStartHit)
          ) {
            planeStartHit.copy(worldPos);
          }

          const startTransform = { ...prefs.monitors[monitorIndex] };
          try {
            this.renderer.domElement.setPointerCapture(event.pointerId);
          } catch {
            // 合成事件环境下忽略指针捕获异常
          }

          this.monitorDrag = {
            active: true,
            pointerId: event.pointerId,
            serverId: this.currentState.serverId,
            sessionKey: target.sessionKey,
            monitorIndex,
            startClientX: event.clientX,
            startClientY: event.clientY,
            startTransform,
            currentTransform: { ...startTransform },
            dragPlane,
            planeStartHit,
          };

          this.callbacks.onActiveEditMonitorChange?.(monitorIndex);
          this.renderer.domElement.style.cursor = 'grabbing';
          return;
        }
      }
    }

    this.pointerDownTarget = this.raycastAtClientPoint(event.clientX, event.clientY);
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

      const mode: OfficeMonitorDragMode = event.shiftKey
        ? 'yaw'
        : event.altKey
          ? 'y'
          : this.monitorEditState.dragMode;

      let candidate: OfficeMonitorTransform = { ...drag.currentTransform };
      if (mode === 'yaw') {
        const dxPx = event.clientX - drag.startClientX;
        candidate = {
          ...drag.startTransform,
          yaw: drag.startTransform.yaw + dxPx * 0.0085,
        };
      } else if (mode === 'y') {
        const dyPx = event.clientY - drag.startClientY;
        candidate = {
          ...drag.startTransform,
          y: drag.startTransform.y - dyPx * 0.0022,
        };
      } else if (
        this.setRayFromClientPoint(event.clientX, event.clientY)
        && this.raycaster.ray.intersectPlane(drag.dragPlane, this.dragHitPoint)
      ) {
        const deltaX = this.dragHitPoint.x - drag.planeStartHit.x;
        const deltaZ = this.dragHitPoint.z - drag.planeStartHit.z;
        candidate = {
          ...drag.startTransform,
          x: drag.startTransform.x + deltaX,
          z: drag.startTransform.z + deltaZ,
        };
      }

      const clamped = clampOfficeMonitorTransform(candidate, drag.startTransform);
      drag.currentTransform = clamped;

      this.previewStationMonitorTransform(drag.sessionKey, drag.monitorIndex, clamped);
      this.callbacks.onPreviewMonitorTransform?.(
        drag.serverId,
        drag.sessionKey,
        drag.monitorIndex,
        clamped
      );
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
      // 轻拖跟随走动中的角色时仍选中其所属工位（不误触桌面/大范围环绕拖拽）
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

    // 走动中的角色若在按下到抬起瞬间微移出光标正下方，回落至按下命中的目标确保点击稳定选中
    const target = upTarget ?? downTarget;
    if (!target) return;

    if (!target.sessionKey) return;

    this.callbacks.onSelectStation(target.sessionKey);
    if (this.monitorEditState.enabled) {
      return;
    }
    if (target.kind === 'monitor') {
      const originRect = this.projectStationPartToRect(
        target.sessionKey,
        'monitor',
        target.monitorIndex ?? 0
      );
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
    if (
      this.disposed
      || this.contextLost
      || this.monitorEditState.enabled
      || this.monitorDrag?.active
    ) {
      return;
    }
    if (this.pointerTrack.active || this.lastClickMaxDistSq > CLICK_DRAG_THRESHOLD_SQ) return;
    const target = this.raycastAtClientPoint(event.clientX, event.clientY);
    if (!target || !target.sessionKey) return;
    this.callbacks.onSelectStation(target.sessionKey);
    const originRect = this.projectStationPartToRect(
      target.sessionKey,
      'monitor',
      target.monitorIndex ?? 0
    );
    this.callbacks.onOpenMonitor(target.sessionKey, originRect);
  };

  private hasStationsSettling(): boolean {
    for (const rig of this.stations.values()) {
      if (rig.root.position.distanceToSquared(rig.targetPosition) > 1e-5) {
        return true;
      }
    }
    return false;
  }

  /** 是否需要启用连续 RAF：存在离座行为、相机缓动/阻尼、键盘平移或工位过渡 */
  private needsContinuousAnimation(): boolean {
    if (this.disposed || this.contextLost || document.hidden) return false;
    const reduced = Boolean(this.currentState?.reducedMotion);
    const draggingMonitor = Boolean(this.monitorDrag?.active);
    if (this.activeCameraGoal && !draggingMonitor) return true;
    if (reduced) return false;
    if (this.behaviourManager.hasActiveBehaviour()) return true;
    if (!draggingMonitor && (this.pressedPanKeys.size > 0 || this.panVelocity.lengthSq() > 1e-4)) {
      return true;
    }
    if (this.controlsInteracting || this.cameraSettleFrames > 0) return true;
    if (this.hasStationsSettling()) return true;
    return false;
  }

  private clearBehaviourWakeTimer(): void {
    if (this.behaviourWakeTimerId !== null) {
      window.clearTimeout(this.behaviourWakeTimerId);
      this.behaviourWakeTimerId = null;
    }
  }

  private advanceBehaviourIdleClock(nowMs: number): void {
    if (this.disposed || this.contextLost || document.hidden || this.currentState?.reducedMotion) {
      this.lastBehaviourClockMs = nowMs;
      return;
    }
    const elapsedSec = Math.max(0, (nowMs - this.lastBehaviourClockMs) / 1000);
    this.lastBehaviourClockMs = nowMs;
    if (elapsedSec > 0) {
      this.behaviourManager.step(elapsedSec);
    }
  }

  private readonly handleBehaviourWakeup = (): void => {
    this.behaviourWakeTimerId = null;
    if (this.disposed || this.contextLost || document.hidden || this.currentState?.reducedMotion) {
      return;
    }
    this.advanceBehaviourIdleClock(performance.now());
    if (this.behaviourManager.hasActiveBehaviour()) {
      this.syncAnimationSchedule();
    } else {
      this.scheduleBehaviourWakeTimer();
    }
  };

  /** 全员回座静止后关闭 RAF，仅挂单次 setTimeout 在下一个行为触发时刻精准唤醒 */
  private scheduleBehaviourWakeTimer(): void {
    this.clearBehaviourWakeTimer();
    if (this.disposed || this.contextLost || document.hidden) return;
    if (this.currentState?.reducedMotion || this.rafId !== null) return;
    const delayMs = this.behaviourManager.getNextWakeDelayMs();
    if (delayMs === null) return;
    this.behaviourWakeTimerId = window.setTimeout(this.handleBehaviourWakeup, delayMs);
  }

  /** 按需与连续渲染切换：有角色移动/行为动画或相机/平移过渡时启用 RAF，全员坐姿静止后立即停表 */
  private syncAnimationSchedule(): void {
    if (this.disposed || this.contextLost || document.hidden) {
      this.stopAnimationLoop();
      this.clearBehaviourWakeTimer();
      return;
    }
    if (this.needsContinuousAnimation()) {
      this.clearBehaviourWakeTimer();
      if (this.rafId === null) {
        const now = performance.now();
        this.lastFrameTimeMs = now;
        this.lastBehaviourClockMs = now;
        this.rafId = window.requestAnimationFrame(this.tickFrame);
      }
      return;
    }
    this.stopAnimationLoop();
    if (this.needsStaticRender) {
      this.renderSingleFrame();
    }
    this.scheduleBehaviourWakeTimer();
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
        this.controls.update();
      }
      this.clampControlsTarget();
      this.updateDynamicSceneForCamera();
      this.renderer.render(this.scene, this.camera);
      this.needsStaticRender = false;
    } finally {
      this.singleFrameRendering = false;
    }
  }

  private readonly tickFrame = (nowMs: number): void => {
    this.rafId = null;
    if (this.disposed || this.contextLost || document.hidden) return;

    const rawDtSec = Math.max(0.001, (nowMs - this.lastFrameTimeMs) / 1000);
    this.lastFrameTimeMs = nowMs;
    this.lastBehaviourClockMs = nowMs;
    const dtSec = Math.min(0.05, rawDtSec);
    const reduced = Boolean(this.currentState?.reducedMotion);
    const draggingMonitor = Boolean(this.monitorDrag?.active);

    if (!reduced) {
      this.elapsedActiveSec += dtSec;
      this.behaviourManager.step(dtSec);
      // 云环绕 Y 轴缓慢旋转，所有云块始终严格保持在半径 > outerHalf + 6 环带内
      this.skyRig.cloudGroup.rotation.y =
        (this.elapsedActiveSec * CLOUD_ORBIT_SPEED_RAD) % (Math.PI * 2);

      // WASD / 方向键平滑地面平移（Shift 加速）
      if (!draggingMonitor && (this.pressedPanKeys.size > 0 || this.panVelocity.lengthSq() > 1e-4)) {
        const forwardInput =
          (this.pressedPanKeys.has('w') ? 1 : 0) - (this.pressedPanKeys.has('s') ? 1 : 0);
        const rightInput =
          (this.pressedPanKeys.has('d') ? 1 : 0) - (this.pressedPanKeys.has('a') ? 1 : 0);
        this.panTargetVelScratch.set(0, 0, 0);
        if (forwardInput !== 0 || rightInput !== 0) {
          this.computeGroundPanBasis(this.panForwardScratch, this.panRightScratch);
          const norm = Math.hypot(forwardInput, rightInput);
          const camDist = this.camera.position.distanceTo(this.controls.target);
          const speed = Math.max(5.5, Math.min(26, camDist * 0.5)) * (this.panShiftHeld ? 2.4 : 1.0);
          this.panTargetVelScratch
            .addScaledVector(this.panForwardScratch, (forwardInput / norm) * speed)
            .addScaledVector(this.panRightScratch, (rightInput / norm) * speed);
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
      const lerpAlpha = reduced ? 1 : 1 - Math.exp(-dtSec * 7.5);
      this.applyingCameraTransition = true;
      this.camera.position.lerp(this.activeCameraGoal.position, lerpAlpha);
      this.controls.target.lerp(this.activeCameraGoal.target, lerpAlpha);
      this.applyingCameraTransition = false;

      if (
        this.camera.position.distanceToSquared(this.activeCameraGoal.position) < 0.0004
        && this.controls.target.distanceToSquared(this.activeCameraGoal.target) < 0.0004
      ) {
        this.camera.position.copy(this.activeCameraGoal.position);
        this.controls.target.copy(this.activeCameraGoal.target);
        this.activeCameraGoal = null;
      }
    }

    for (const rig of this.stations.values()) {
      const pose = this.behaviourManager.getPose(rig.sessionKey);
      animateWorkstationPod(rig, this.elapsedActiveSec, dtSec, reduced, pose);
    }

    this.prevCamPosScratch.copy(this.camera.position);
    this.prevCamTargetScratch.copy(this.controls.target);
    if (!draggingMonitor) {
      this.applyingCameraTransition = true;
      this.controls.update();
      this.applyingCameraTransition = false;
    }
    this.clampControlsTarget();
    const camSettling =
      this.prevCamPosScratch.distanceToSquared(this.camera.position) > 1e-8
      || this.prevCamTargetScratch.distanceToSquared(this.controls.target) > 1e-8;
    if (camSettling) {
      this.cameraSettleFrames = 2;
    } else if (this.cameraSettleFrames > 0) {
      this.cameraSettleFrames -= 1;
    }

    this.updateDynamicSceneForCamera();
    this.renderer.render(this.scene, this.camera);
    this.needsStaticRender = false;

    if (this.needsContinuousAnimation()) {
      this.rafId = window.requestAnimationFrame(this.tickFrame);
    } else {
      this.scheduleBehaviourWakeTimer();
    }
  };
}
