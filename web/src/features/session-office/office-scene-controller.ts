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
import { applyDualMonitorTransforms } from './office-monitor-rig';
import { createOfficeRoomRig, syncOfficeRoomRig, type OfficeRoomRig } from './office-scene-room';
import {
  animateWorkstationPod,
  createWorkstationPod,
  disposeStationTextureBundles,
  getStationMonitorScreenMesh,
  syncWorkstationPod,
  type OfficeStationRig,
} from './office-scene-station';

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

const CLICK_DRAG_THRESHOLD_SQ = 36; // 6px radius

function isOfficeHitKind(value: unknown): value is OfficeHitKind {
  return value === 'station' || value === 'monitor' || value === 'mail-tray' || value === 'room-mailbox';
}

function disposeTextureIfPresent(
  texture: THREE.Texture | null | undefined,
  disposedTextures: Set<THREE.Texture>
): void {
  if (texture && !disposedTextures.has(texture)) {
    disposedTextures.add(texture);
    texture.dispose();
  }
}

function disposeMaterialAndTextures(
  material: THREE.Material,
  disposedTextures: Set<THREE.Texture>,
  disposedMaterials: Set<THREE.Material>
): void {
  if (disposedMaterials.has(material)) return;
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

function computePresetGoal(
  preset: OfficeCameraPreset,
  metrics: BayGridMetrics,
  aspect: number
): CameraGoal {
  const safeAspect = Math.max(0.95, Math.min(2.2, aspect || 1.6));
  const widthFactor = Math.max(1.0, metrics.roomWidth / 7.2);
  const depthFactor = Math.max(1.0, metrics.roomDepth / 5.8);
  const aspectZoom = safeAspect < 1.35 ? 1.35 / safeAspect : 1.0;
  const span = Math.max(widthFactor, depthFactor) * aspectZoom;

  switch (preset) {
    case 'isometric':
      return {
        position: new THREE.Vector3(2.85 * span, 3.6 * span, 5.55 * span),
        target: new THREE.Vector3(0, 0.72, 0.1),
      };
    case 'corridor':
      return {
        position: new THREE.Vector3(
          1.35 * span,
          2.15 * Math.min(1.4, span),
          metrics.roomDepth * 0.5 + 2.75 * span
        ),
        target: new THREE.Vector3(-0.15, 0.88, -0.25),
      };
    case 'overview':
      return {
        position: new THREE.Vector3(0, 6.8 * span + 1.0, 3.35 * span),
        target: new THREE.Vector3(0, 0.45, 0.05),
      };
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

  private readonly ambientLight: THREE.HemisphereLight;
  private readonly keyLight: THREE.DirectionalLight;
  private readonly rimLight: THREE.DirectionalLight;
  private readonly selectionLight: THREE.PointLight;
  private readonly roomRig: OfficeRoomRig;
  private readonly stations = new Map<string, OfficeStationRig>();

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

  private rafId: number | null = null;
  private lastFrameTimeMs = 0;
  private elapsedActiveSec = 0;
  private needsStaticRender = true;
  private singleFrameRendering = false;
  private contextLost = false;
  private disposed = false;

  private readonly resizeObserver: ResizeObserver;
  private readonly unsubscribeWallpaperRaster: () => void;
  private readonly acquiredWallpaperCacheRef: boolean;

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
    this.scene.background = new THREE.Color(this.currentPalette.backgroundHex);
    this.scene.fog = new THREE.Fog(this.currentPalette.fogHex, 16, 36);

    const rect = container.getBoundingClientRect();
    this.viewportWidth = Math.max(320, Math.round(rect.width || 1200));
    this.viewportHeight = Math.max(260, Math.round(rect.height || 680));

    this.camera = new THREE.PerspectiveCamera(
      40,
      this.viewportWidth / this.viewportHeight,
      0.1,
      80
    );

    // Studio & Window Daylight Lighting (strictly bounded 4-light rig)
    this.ambientLight = new THREE.HemisphereLight('#b5dcff', '#1b2638', 0.95);
    this.scene.add(this.ambientLight);

    this.keyLight = new THREE.DirectionalLight('#f4f9ff', 2.05);
    this.keyLight.position.set(-7.5, 9.2, 5.2);
    this.keyLight.castShadow = true;
    this.keyLight.shadow.mapSize.set(2048, 2048);
    this.keyLight.shadow.camera.near = 1.0;
    this.keyLight.shadow.camera.far = 32;
    this.keyLight.shadow.camera.left = -11;
    this.keyLight.shadow.camera.right = 11;
    this.keyLight.shadow.camera.top = 11;
    this.keyLight.shadow.camera.bottom = -11;
    this.keyLight.shadow.bias = -0.0005;
    this.keyLight.shadow.normalBias = 0.02;
    this.scene.add(this.keyLight);

    this.rimLight = new THREE.DirectionalLight('#60d5ff', 0.72);
    this.rimLight.position.set(6.5, 5.2, -5.5);
    this.scene.add(this.rimLight);

    this.selectionLight = new THREE.PointLight('#00e5ff', 0, 4.5, 1.5);
    this.selectionLight.position.set(0, 2.2, 0);
    this.scene.add(this.selectionLight);

    let renderer: THREE.WebGLRenderer | null = null;
    let canvas: HTMLCanvasElement | null = null;
    let controls: OrbitControls | null = null;
    let roomRig: OfficeRoomRig | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let acquiredWallpaperRef = false;
    let unsubscribeWallpaperRaster: (() => void) | null = null;
    let listenersAttached = false;

    try {
      renderer = new THREE.WebGLRenderer({
        antialias: true,
        powerPreference: 'high-performance',
        alpha: false,
      });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(this.viewportWidth, this.viewportHeight, false);
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.1;
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
      controls.rotateSpeed = 0.78;
      controls.zoomSpeed = 0.9;
      controls.panSpeed = 0.75;
      controls.minDistance = 1.45;
      controls.maxDistance = 24;
      controls.minPolarAngle = 0.14;
      controls.maxPolarAngle = Math.PI * 0.46;

      const anisotropy = renderer.capabilities.getMaxAnisotropy();
      roomRig = createOfficeRoomRig(this.currentPalette, anisotropy);
      this.scene.add(roomRig.root);

      const initialGoal = computePresetGoal(
        'isometric',
        this.currentMetrics,
        this.viewportWidth / this.viewportHeight
      );
      this.camera.position.copy(initialGoal.position);
      controls.target.copy(initialGoal.target);
      controls.update();

      resizeObserver = new ResizeObserver(this.handleResize);
      resizeObserver.observe(this.container);

      this.renderer = renderer;
      this.controls = controls;
      this.roomRig = roomRig;
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
        roomRig.floorBundle.texture.dispose();
        roomRig.skyBundle.texture.dispose();
        roomRig.plaqueBundle.texture.dispose();
        roomRig.terminalBundle.texture.dispose();
      }
      disposeObjectSubtree(this.scene);
      renderer?.dispose();
      if (canvas && canvas.parentElement === this.container) {
        this.container.removeChild(canvas);
      }
      throw error;
    }
  }

  private attachEventListeners(canvas: HTMLCanvasElement, controls: OrbitControls): void {
    controls.addEventListener('change', this.handleControlsChange);
    controls.addEventListener('start', this.handleControlsStart);
    // Capture phase ensures edit-mode monitor drag claims ownership before OrbitControls bubble-phase pointerdown
    canvas.addEventListener('pointerdown', this.handlePointerDown, true);
    canvas.addEventListener('pointermove', this.handlePointerMove);
    canvas.addEventListener('pointerup', this.handlePointerUp);
    canvas.addEventListener('pointerleave', this.handlePointerLeave);
    canvas.addEventListener('pointercancel', this.handlePointerCancel);
    canvas.addEventListener('lostpointercapture', this.handleLostPointerCapture);
    canvas.addEventListener('dblclick', this.handleDoubleClick);
    canvas.addEventListener('webglcontextlost', this.handleContextLost);
    canvas.addEventListener('webglcontextrestored', this.handleContextRestored);
    window.addEventListener('blur', this.handleWindowBlur);
    document.addEventListener('visibilitychange', this.handleVisibilityChange);
  }

  private detachEventListeners(canvas: HTMLCanvasElement, controls: OrbitControls): void {
    controls.removeEventListener('change', this.handleControlsChange);
    controls.removeEventListener('start', this.handleControlsStart);
    canvas.removeEventListener('pointerdown', this.handlePointerDown, true);
    canvas.removeEventListener('pointermove', this.handlePointerMove);
    canvas.removeEventListener('pointerup', this.handlePointerUp);
    canvas.removeEventListener('pointerleave', this.handlePointerLeave);
    canvas.removeEventListener('pointercancel', this.handlePointerCancel);
    canvas.removeEventListener('lostpointercapture', this.handleLostPointerCapture);
    canvas.removeEventListener('dblclick', this.handleDoubleClick);
    canvas.removeEventListener('webglcontextlost', this.handleContextLost);
    canvas.removeEventListener('webglcontextrestored', this.handleContextRestored);
    window.removeEventListener('blur', this.handleWindowBlur);
    document.removeEventListener('visibilitychange', this.handleVisibilityChange);
  }

  public syncState(state: OfficeSceneSyncState): void {
    if (this.disposed) return;

    // Fence any active drag BEFORE adopting new server/room/selection/preference state
    // so server switches or removals roll back without persisting across server scopes.
    if (this.monitorDrag?.active) {
      const drag = this.monitorDrag;
      const nextSessionStillPresent = state.sessions.some(
        (item) => item.sessionKey === drag.sessionKey
      );
      const nextPrefs = state.computerPreferences[drag.sessionKey] ?? DEFAULT_OFFICE_COMPUTER_PREFERENCES;
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

    this.scene.background = new THREE.Color(this.currentPalette.backgroundHex);
    if (this.scene.fog instanceof THREE.Fog) {
      this.scene.fog.color.set(this.currentPalette.fogHex);
    }

    if (state.theme === 'light') {
      this.ambientLight.color.set('#e8f4ff');
      this.ambientLight.groundColor.set('#8ca0b5');
      this.ambientLight.intensity = 1.15;
      this.keyLight.intensity = 2.2;
      this.rimLight.intensity = 0.55;
    } else {
      this.ambientLight.color.set('#b5dcff');
      this.ambientLight.groundColor.set('#141e2e');
      this.ambientLight.intensity = 0.92;
      this.keyLight.intensity = 1.95;
      this.rimLight.intensity = 0.78;
    }

    this.controls.enableDamping = !state.reducedMotion;

    const metrics = computeBayGridMetrics(state.sessions.length);
    this.currentMetrics = metrics;

    // Reconcile stations by stable sessionKey without recreating existing station meshes
    const activeKeys = new Set<string>();
    const anisotropy = this.renderer.capabilities.getMaxAnisotropy();

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

    // Dispose and remove stations that left the visible zone/room
    for (const [key, rig] of this.stations.entries()) {
      if (!activeKeys.has(key)) {
        if (this.monitorDrag?.sessionKey === key) {
          this.cancelMonitorDrag();
        }
        this.scene.remove(rig.root);
        disposeObjectSubtree(rig.root);
        disposeStationTextureBundles(rig);
        this.stations.delete(key);
      }
    }

    // Highlight selected station gently with point light
    const selectedStation = state.selectedSessionKey
      ? this.stations.get(state.selectedSessionKey)
      : undefined;
    if (selectedStation) {
      this.selectionLight.position.set(
        selectedStation.targetPosition.x,
        2.15,
        selectedStation.targetPosition.z + 0.15
      );
      this.selectionLight.color.set(this.currentPalette.accentHex);
      this.selectionLight.intensity = state.theme === 'dark' ? 2.4 : 1.25;
    } else {
      this.selectionLight.intensity = 0;
    }

    syncOfficeRoomRig(
      this.roomRig,
      state,
      this.currentPalette,
      metrics.roomWidth,
      metrics.roomDepth,
      this.hoveredTarget?.kind === 'room-mailbox'
    );

    const roomChanged = state.roomKey !== this.lastRoomKey;
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

    if (roomChanged || presetChanged || (countChanged && !this.userMovedCamera && !this.monitorDrag?.active)) {
      this.applyCameraPreset(state.cameraPreset, roomChanged || state.reducedMotion);
    }

    this.needsStaticRender = true;
    if (prevReducedMotion !== state.reducedMotion) {
      this.syncAnimationSchedule();
    } else if (state.reducedMotion) {
      this.renderSingleFrame();
    }
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
    if (this.currentState?.reducedMotion) {
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
    const pos = rig.targetPosition;
    const goal: CameraGoal = {
      position: new THREE.Vector3(pos.x + 1.25, 1.72, pos.z + 2.15),
      target: new THREE.Vector3(pos.x - 0.18, 0.96, pos.z + 0.02),
    };
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
    part: 'monitor' | 'mail-tray',
    monitorIndex: OfficeMonitorIndex = 0
  ): DesktopOriginRect | undefined {
    const rig = this.stations.get(sessionKey);
    if (!rig) return undefined;

    const targetObj = part === 'monitor'
      ? getStationMonitorScreenMesh(rig, monitorIndex)
      : rig.mailTrayGroup;
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

    this.cancelMonitorDrag();
    this.stopAnimationLoop();
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

    this.roomRig.floorBundle.texture.dispose();
    this.roomRig.skyBundle.texture.dispose();
    this.roomRig.plaqueBundle.texture.dispose();
    this.roomRig.terminalBundle.texture.dispose();

    disposeObjectSubtree(this.scene);
    this.renderer.dispose();

    const canvas = this.renderer.domElement;
    if (canvas.parentElement === this.container) {
      this.container.removeChild(canvas);
    }
  }

  private getStationPreferences(sessionKey: string): OfficeComputerPreferences {
    return this.currentState?.computerPreferences[sessionKey] ?? DEFAULT_OFFICE_COMPUTER_PREFERENCES;
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
    if (this.currentState.reducedMotion) {
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
    this.controls.update();
    this.applyingCameraTransition = false;
    this.needsStaticRender = true;
    if (this.currentState?.reducedMotion) {
      this.renderSingleFrame();
    }
  }

  private readonly handleControlsStart = (): void => {
    if (!this.applyingCameraTransition) {
      this.activeCameraGoal = null;
      this.userMovedCamera = true;
    }
  };

  private readonly handleControlsChange = (): void => {
    // Clamp OrbitControls pan target within comfortable room bounds
    const maxPanX = this.currentMetrics.roomWidth * 0.55;
    const maxPanZ = this.currentMetrics.roomDepth * 0.55;
    this.controls.target.x = Math.max(-maxPanX, Math.min(maxPanX, this.controls.target.x));
    this.controls.target.z = Math.max(-maxPanZ, Math.min(maxPanZ, this.controls.target.z));
    this.controls.target.y = Math.max(0.15, Math.min(2.8, this.controls.target.y));

    if (!this.applyingCameraTransition && this.currentState?.reducedMotion) {
      this.needsStaticRender = true;
      this.renderSingleFrame();
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
      if (this.currentState?.reducedMotion) {
        this.renderSingleFrame();
      }
    }
  };

  private cancelPointerTrack(): void {
    if (this.pointerTrack.active) {
      this.pointerTrack.active = false;
      this.lastClickMaxDistSq = CLICK_DRAG_THRESHOLD_SQ + 1;
    }
  }

  private readonly handleVisibilityChange = (): void => {
    if (this.disposed) return;
    if (document.hidden) {
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
    this.cancelPointerTrack();
    this.cancelMonitorDrag();
  };

  private readonly handleContextLost = (event: Event): void => {
    event.preventDefault();
    this.contextLost = true;
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

    const pickables: THREE.Object3D[] = [this.roomRig.roomTerminalGroup];
    for (const rig of this.stations.values()) {
      pickables.push(rig.root);
    }

    const hits = this.raycaster.intersectObjects(pickables, true);
    for (const hit of hits) {
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
          this.currentMetrics.roomDepth,
          target?.kind === 'room-mailbox'
        );
        if (this.currentState.reducedMotion) {
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
    if (target.kind === 'room-mailbox') {
      return {
        kind: target.kind,
        label: 'ROOM MAIL TERMINAL',
        hint: '点击打开房间协作邮箱',
        clientX,
        clientY,
      };
    }

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
    if (target.kind === 'mail-tray') {
      return {
        kind: 'mail-tray',
        sessionKey: target.sessionKey,
        label,
        hint: session
          ? `会话邮件 · 收 ${session.inboxCount} / 发 ${session.sentCount}`
          : '点击打开会话邮箱',
        clientX,
        clientY,
      };
    }
    return {
      kind: 'station',
      sessionKey: target.sessionKey,
      label,
      hint: '点击选中工位 · 双击打开桌面',
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
      // Ignore release failures when element is detached
    }
  }

  private freezeOrbitMotion(): void {
    this.activeCameraGoal = null;
    const savedEnableDamping = this.controls.enableDamping;
    const prevApplying = this.applyingCameraTransition;
    this.applyingCameraTransition = true;
    try {
      // Snapshot current camera pose before flushing residual damping deltas, then restore pose cleanly.
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
        if (this.currentState?.reducedMotion) {
          this.renderSingleFrame();
        } else {
          this.syncAnimationSchedule();
        }
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

    // Clear active drag BEFORE releasing capture so trailing lostpointercapture cannot roll back a commit.
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
      if (this.currentState?.reducedMotion) {
        this.renderSingleFrame();
      } else {
        this.syncAnimationSchedule();
      }
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
    if (event.button !== 0) return;

    if (this.monitorEditState.enabled && this.currentState?.selectedSessionKey) {
      const target = this.raycastAtClientPoint(event.clientX, event.clientY);
      if (
        target?.kind === 'monitor'
        && target.sessionKey === this.currentState.selectedSessionKey
      ) {
        const rig = this.stations.get(target.sessionKey);
        if (rig) {
          // Claim exclusive pointer ownership BEFORE bubble-phase OrbitControls handles pointerdown.
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
            // Pointer capture unavailable in synthetic/fallback environments
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

    this.pointerTrack = {
      active: true,
      startX: event.clientX,
      startY: event.clientY,
      maxDistSq: 0,
    };
  };

  private readonly handlePointerMove = (event: PointerEvent): void => {
    if (this.disposed || this.contextLost) return;
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

    if (maxDistSq > CLICK_DRAG_THRESHOLD_SQ) {
      this.updateCursorForState(this.hoveredTarget);
      return;
    }

    const target = this.raycastAtClientPoint(event.clientX, event.clientY);
    if (!target) return;

    if (target.kind === 'room-mailbox') {
      this.callbacks.onOpenRoomMailbox();
      return;
    }
    if (!target.sessionKey) return;

    this.callbacks.onSelectStation(target.sessionKey);
    if (this.monitorEditState.enabled) {
      // Never open terminal while dragging/editing monitor positions
      return;
    }
    if (target.kind === 'monitor') {
      const originRect = this.projectStationPartToRect(
        target.sessionKey,
        'monitor',
        target.monitorIndex ?? 0
      );
      this.callbacks.onOpenMonitor(target.sessionKey, originRect);
    } else if (target.kind === 'mail-tray') {
      const originRect = this.projectStationPartToRect(target.sessionKey, 'mail-tray');
      this.callbacks.onOpenSessionMail(target.sessionKey, originRect);
    }
  };

  private readonly handlePointerCancel = (event: PointerEvent): void => {
    this.cancelPointerTrack();
    if (this.monitorDrag?.active && event.pointerId === this.monitorDrag.pointerId) {
      this.cancelMonitorDrag();
    } else if (!this.monitorDrag?.active) {
      this.controls.enabled = true;
    }
  };

  private readonly handleLostPointerCapture = (event: PointerEvent): void => {
    this.cancelPointerTrack();
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
      const hasCapture = typeof canvas.hasPointerCapture === 'function'
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
    if (this.disposed || this.contextLost || this.monitorEditState.enabled || this.monitorDrag?.active) {
      return;
    }
    if (this.pointerTrack.active || this.lastClickMaxDistSq > CLICK_DRAG_THRESHOLD_SQ) return;
    const target = this.raycastAtClientPoint(event.clientX, event.clientY);
    if (!target || !target.sessionKey) return;
    this.callbacks.onSelectStation(target.sessionKey);
    if (target.kind === 'mail-tray') {
      const originRect = this.projectStationPartToRect(target.sessionKey, 'mail-tray');
      this.callbacks.onOpenSessionMail(target.sessionKey, originRect);
    } else {
      const originRect = this.projectStationPartToRect(
        target.sessionKey,
        'monitor',
        target.monitorIndex ?? 0
      );
      this.callbacks.onOpenMonitor(target.sessionKey, originRect);
    }
  };

  private syncAnimationSchedule(): void {
    if (this.disposed || this.contextLost || document.hidden) {
      this.stopAnimationLoop();
      return;
    }
    if (this.currentState?.reducedMotion && !this.activeCameraGoal) {
      this.stopAnimationLoop();
      if (this.needsStaticRender) {
        this.renderSingleFrame();
      }
      return;
    }
    if (this.rafId === null) {
      this.lastFrameTimeMs = performance.now();
      this.rafId = window.requestAnimationFrame(this.tickFrame);
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
      for (const rig of this.stations.values()) {
        animateWorkstationPod(rig, this.elapsedActiveSec, 0.016, reduced);
      }
      if (!this.monitorDrag?.active) {
        this.controls.update();
      }
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
    const dtSec = Math.min(0.05, rawDtSec);
    const reduced = Boolean(this.currentState?.reducedMotion);
    const draggingMonitor = Boolean(this.monitorDrag?.active);

    if (!reduced) {
      this.elapsedActiveSec += dtSec;
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
      animateWorkstationPod(rig, this.elapsedActiveSec, dtSec, reduced);
    }

    if (!draggingMonitor) {
      this.controls.update();
    }
    this.renderer.render(this.scene, this.camera);

    if (!reduced || (this.activeCameraGoal && !draggingMonitor)) {
      this.rafId = window.requestAnimationFrame(this.tickFrame);
    }
  };
}
