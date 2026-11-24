import * as THREE from 'three';
import { getTileUvRect, type VoxelTileId } from './office-voxel-atlas';

/**
 * Minecraft 体素几何构建引擎：
 * 1. 严格轴对齐盒子几何（最小细节单位 0.0625 world unit）。
 * 2. 经典逐面亮度分层：顶面 1.00，±X 0.80，±Z 0.65，底面 0.52。
 * 3. 四档体素环境光遮蔽（AO）：1.00 / 0.75 / 0.50 / 0.25，烘焙至顶点色，支持对角线翻转防插值锯齿。
 * 4. 整数网格体素器（VoxelGrid）自动执行相邻实心面剔除并按渲染层合批输出单个 BufferGeometry。
 * 5. 精细家具盒构建器（VoxelBoxBuilder）支持 0.0625 精度子体素合批与接触面近邻 AO 烘焙。
 */

export const VOXEL_UNIT = 0.0625;

export type VoxelFaceDir = 'px' | 'nx' | 'py' | 'ny' | 'pz' | 'nz';

export type VoxelRenderLayer = 'opaque' | 'cutout' | 'glass' | 'water' | 'emissive';

/** Minecraft 经典六面亮度系数 */
export const FACE_SHADE: Readonly<Record<VoxelFaceDir, number>> = {
  py: 1.0,
  px: 0.8,
  nx: 0.8,
  pz: 0.65,
  nz: 0.65,
  ny: 0.52,
};

/** 四档体素 AO 亮度表：索引 = 3 - 遮挡数（0=最暗 0.25，3=无遮挡 1.0） */
export const AO_LEVELS: readonly [number, number, number, number] = [0.25, 0.5, 0.75, 1.0];

export interface VoxelBlockFaceTiles {
  px?: VoxelTileId;
  nx?: VoxelTileId;
  py?: VoxelTileId;
  ny?: VoxelTileId;
  pz?: VoxelTileId;
  nz?: VoxelTileId;
  top?: VoxelTileId;
  bottom?: VoxelTileId;
  side?: VoxelTileId;
  all?: VoxelTileId;
}

export interface VoxelBlockSpec {
  tiles: VoxelTileId | VoxelBlockFaceTiles;
  layer?: VoxelRenderLayer;
  tint?: string;
  /** 是否对相邻方块产生遮挡/AO，默认 opaque 与 emissive 为 true，glass/water/cutout 为 false */
  occludes?: boolean;
}

export interface VoxelBoxInput {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
  tiles: VoxelTileId | VoxelBlockFaceTiles;
  tint?: string;
  occludes?: boolean;
  hiddenFaces?: Partial<Record<VoxelFaceDir, boolean>>;
  /** 地面/桌面接触高度：若某顶点贴近此平面，则在侧面上自动施加底角 AO */
  floorY?: number;
}

export interface SolidColorBoxInput {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
  color?: string;
  shadeFaces?: boolean;
}

export function snapToVoxel(value: number): number {
  return Math.round(value / VOXEL_UNIT) * VOXEL_UNIT;
}

export function resolveFaceTile(
  tiles: VoxelTileId | VoxelBlockFaceTiles,
  dir: VoxelFaceDir
): VoxelTileId {
  if (typeof tiles === 'string') return tiles;
  const exact = tiles[dir];
  if (exact) return exact;
  if (dir === 'py' && tiles.top) return tiles.top;
  if (dir === 'ny' && tiles.bottom) return tiles.bottom;
  if (dir !== 'py' && dir !== 'ny' && tiles.side) return tiles.side;
  return tiles.all ?? tiles.side ?? tiles.top ?? 'stone';
}

interface RawBuffers {
  positions: number[];
  normals: number[];
  uvs: number[];
  colors: number[];
  indices: number[];
}

function createRawBuffers(): RawBuffers {
  return {
    positions: [],
    normals: [],
    uvs: [],
    colors: [],
    indices: [],
  };
}

function buffersToGeometry(buf: RawBuffers): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(buf.positions, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(buf.normals, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(buf.uvs, 2));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(buf.colors, 3));
  geo.setIndex(buf.indices);
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

interface FaceCornerSpec {
  /** 顶点相对方块 [0,1]^3 的局部坐标 */
  pos: readonly [number, number, number];
  /** 顶点在图集格内的 UV 标记 (0 或 1)，u: 左->右, v: 下->上 */
  uv: readonly [0 | 1, 0 | 1];
  /** 用于体素 AO 查询的 3 个邻格偏移（在法线 +1 层内） */
  side1: readonly [number, number, number];
  side2: readonly [number, number, number];
  corner: readonly [number, number, number];
}

interface FaceTemplate {
  dir: VoxelFaceDir;
  normal: readonly [number, number, number];
  /** 逆时针（CCW）向外绕序的 4 个顶点 */
  corners: readonly [FaceCornerSpec, FaceCornerSpec, FaceCornerSpec, FaceCornerSpec];
}

// 严格验证逆时针向外绕序（叉积 (v1-v0) × (v2-v0) 与法线同向）
const FACE_TEMPLATES: readonly FaceTemplate[] = [
  {
    dir: 'py',
    normal: [0, 1, 0],
    corners: [
      { pos: [0, 1, 1], uv: [0, 0], side1: [-1, 1, 0], side2: [0, 1, 1], corner: [-1, 1, 1] },
      { pos: [1, 1, 1], uv: [1, 0], side1: [1, 1, 0], side2: [0, 1, 1], corner: [1, 1, 1] },
      { pos: [1, 1, 0], uv: [1, 1], side1: [1, 1, 0], side2: [0, 1, -1], corner: [1, 1, -1] },
      { pos: [0, 1, 0], uv: [0, 1], side1: [-1, 1, 0], side2: [0, 1, -1], corner: [-1, 1, -1] },
    ],
  },
  {
    dir: 'ny',
    normal: [0, -1, 0],
    corners: [
      { pos: [0, 0, 0], uv: [0, 0], side1: [-1, -1, 0], side2: [0, -1, -1], corner: [-1, -1, -1] },
      { pos: [1, 0, 0], uv: [1, 0], side1: [1, -1, 0], side2: [0, -1, -1], corner: [1, -1, -1] },
      { pos: [1, 0, 1], uv: [1, 1], side1: [1, -1, 0], side2: [0, -1, 1], corner: [1, -1, 1] },
      { pos: [0, 0, 1], uv: [0, 1], side1: [-1, -1, 0], side2: [0, -1, 1], corner: [-1, -1, 1] },
    ],
  },
  {
    dir: 'px',
    normal: [1, 0, 0],
    corners: [
      { pos: [1, 0, 1], uv: [0, 0], side1: [1, -1, 0], side2: [1, 0, 1], corner: [1, -1, 1] },
      { pos: [1, 0, 0], uv: [1, 0], side1: [1, -1, 0], side2: [1, 0, -1], corner: [1, -1, -1] },
      { pos: [1, 1, 0], uv: [1, 1], side1: [1, 1, 0], side2: [1, 0, -1], corner: [1, 1, -1] },
      { pos: [1, 1, 1], uv: [0, 1], side1: [1, 1, 0], side2: [1, 0, 1], corner: [1, 1, 1] },
    ],
  },
  {
    dir: 'nx',
    normal: [-1, 0, 0],
    corners: [
      { pos: [0, 0, 0], uv: [0, 0], side1: [-1, -1, 0], side2: [-1, 0, -1], corner: [-1, -1, -1] },
      { pos: [0, 0, 1], uv: [1, 0], side1: [-1, -1, 0], side2: [-1, 0, 1], corner: [-1, -1, 1] },
      { pos: [0, 1, 1], uv: [1, 1], side1: [-1, 1, 0], side2: [-1, 0, 1], corner: [-1, 1, 1] },
      { pos: [0, 1, 0], uv: [0, 1], side1: [-1, 1, 0], side2: [-1, 0, -1], corner: [-1, 1, -1] },
    ],
  },
  {
    dir: 'pz',
    normal: [0, 0, 1],
    corners: [
      { pos: [0, 0, 1], uv: [0, 0], side1: [-1, 0, 1], side2: [0, -1, 1], corner: [-1, -1, 1] },
      { pos: [1, 0, 1], uv: [1, 0], side1: [1, 0, 1], side2: [0, -1, 1], corner: [1, -1, 1] },
      { pos: [1, 1, 1], uv: [1, 1], side1: [1, 0, 1], side2: [0, 1, 1], corner: [1, 1, 1] },
      { pos: [0, 1, 1], uv: [0, 1], side1: [-1, 0, 1], side2: [0, 1, 1], corner: [-1, 1, 1] },
    ],
  },
  {
    dir: 'nz',
    normal: [0, 0, -1],
    corners: [
      { pos: [1, 0, 0], uv: [0, 0], side1: [1, 0, -1], side2: [0, -1, -1], corner: [1, -1, -1] },
      { pos: [0, 0, 0], uv: [1, 0], side1: [-1, 0, -1], side2: [0, -1, -1], corner: [-1, -1, -1] },
      { pos: [0, 1, 0], uv: [1, 1], side1: [-1, 0, -1], side2: [0, 1, -1], corner: [-1, 1, -1] },
      { pos: [1, 1, 0], uv: [0, 1], side1: [1, 0, -1], side2: [0, 1, -1], corner: [1, 1, -1] },
    ],
  },
];

function computeVertexAoIndex(side1: boolean, side2: boolean, corner: boolean): 0 | 1 | 2 | 3 {
  if (side1 && side2) return 0;
  const occ = (side1 ? 1 : 0) + (side2 ? 1 : 0) + (corner ? 1 : 0);
  return (3 - occ) as 0 | 1 | 2 | 3;
}

const SCRATCH_COLOR = new THREE.Color();

function emitQuad(
  buf: RawBuffers,
  corners: readonly [
    readonly [number, number, number],
    readonly [number, number, number],
    readonly [number, number, number],
    readonly [number, number, number],
  ],
  normal: readonly [number, number, number],
  uvCorners: readonly [
    readonly [number, number],
    readonly [number, number],
    readonly [number, number],
    readonly [number, number],
  ],
  aoLevels: readonly [number, number, number, number],
  faceShade: number,
  tintColor: THREE.Color
): void {
  const baseIndex = buf.positions.length / 3;
  for (let i = 0; i < 4; i += 1) {
    const p = corners[i];
    const uv = uvCorners[i];
    const shade = faceShade * aoLevels[i];
    buf.positions.push(p[0], p[1], p[2]);
    buf.normals.push(normal[0], normal[1], normal[2]);
    buf.uvs.push(uv[0], uv[1]);
    buf.colors.push(tintColor.r * shade, tintColor.g * shade, tintColor.b * shade);
  }
  // Minecraft 对角线翻转规则：防止 AO 插值在四边形上产生不对称折痕
  if (aoLevels[0] + aoLevels[2] > aoLevels[1] + aoLevels[3]) {
    buf.indices.push(baseIndex, baseIndex + 1, baseIndex + 2, baseIndex, baseIndex + 2, baseIndex + 3);
  } else {
    buf.indices.push(baseIndex + 1, baseIndex + 2, baseIndex + 3, baseIndex + 1, baseIndex + 3, baseIndex);
  }
}

interface StoredCell {
  x: number;
  y: number;
  z: number;
  spec: VoxelBlockSpec;
  layer: VoxelRenderLayer;
  occludes: boolean;
}

function cellKey(x: number, y: number, z: number): string {
  return `${x},${y},${z}`;
}

/**
 * 整数网格体素世界构建器：
 * 适用于房间地面、砖墙、窗户、屋顶、室外草地、泥土崖壁、方块树与水池。
 */
export class VoxelGrid {
  private readonly cells = new Map<string, StoredCell>();

  public set(x: number, y: number, z: number, spec: VoxelBlockSpec): void {
    const ix = Math.round(x);
    const iy = Math.round(y);
    const iz = Math.round(z);
    const layer: VoxelRenderLayer = spec.layer ?? 'opaque';
    const occludes = spec.occludes ?? (layer === 'opaque' || layer === 'emissive');
    this.cells.set(cellKey(ix, iy, iz), {
      x: ix,
      y: iy,
      z: iz,
      spec,
      layer,
      occludes,
    });
  }

  public fill(
    x0: number,
    y0: number,
    z0: number,
    x1: number,
    y1: number,
    z1: number,
    spec: VoxelBlockSpec
  ): void {
    const minX = Math.min(Math.round(x0), Math.round(x1));
    const maxX = Math.max(Math.round(x0), Math.round(x1));
    const minY = Math.min(Math.round(y0), Math.round(y1));
    const maxY = Math.max(Math.round(y0), Math.round(y1));
    const minZ = Math.min(Math.round(z0), Math.round(z1));
    const maxZ = Math.max(Math.round(z0), Math.round(z1));
    for (let y = minY; y <= maxY; y += 1) {
      for (let z = minZ; z <= maxZ; z += 1) {
        for (let x = minX; x <= maxX; x += 1) {
          this.set(x, y, z, spec);
        }
      }
    }
  }

  public delete(x: number, y: number, z: number): void {
    this.cells.delete(cellKey(Math.round(x), Math.round(y), Math.round(z)));
  }

  public get(x: number, y: number, z: number): VoxelBlockSpec | undefined {
    return this.cells.get(cellKey(Math.round(x), Math.round(y), Math.round(z)))?.spec;
  }

  public hasOccluding(x: number, y: number, z: number): boolean {
    return this.cells.get(cellKey(x, y, z))?.occludes === true;
  }

  public buildGeometries(
    origin: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 }
  ): Record<VoxelRenderLayer, THREE.BufferGeometry | null> {
    const layerBuffers: Record<VoxelRenderLayer, RawBuffers> = {
      opaque: createRawBuffers(),
      cutout: createRawBuffers(),
      glass: createRawBuffers(),
      water: createRawBuffers(),
      emissive: createRawBuffers(),
    };

    for (const cell of this.cells.values()) {
      const buf = layerBuffers[cell.layer];
      if (cell.spec.tint) {
        SCRATCH_COLOR.set(cell.spec.tint);
      } else {
        SCRATCH_COLOR.setRGB(1, 1, 1);
      }

      for (let f = 0; f < FACE_TEMPLATES.length; f += 1) {
        const tpl = FACE_TEMPLATES[f];
        const nx = cell.x + tpl.normal[0];
        const ny = cell.y + tpl.normal[1];
        const nz = cell.z + tpl.normal[2];
        const neighbor = this.cells.get(cellKey(nx, ny, nz));

        // 隐藏面剔除：实心邻块遮挡所有面；玻璃/水在同类邻块之间自动合并消除内墙
        if (neighbor) {
          if (neighbor.occludes) {
            continue;
          }
          if ((cell.layer === 'glass' || cell.layer === 'water') && neighbor.layer === cell.layer) {
            continue;
          }
        }

        const tileId = resolveFaceTile(cell.spec.tiles, tpl.dir);
        const uvRect = getTileUvRect(tileId);
        const shade = cell.layer === 'emissive' ? 1.0 : FACE_SHADE[tpl.dir];

        const positions: [
          [number, number, number],
          [number, number, number],
          [number, number, number],
          [number, number, number],
        ] = [
          [0, 0, 0],
          [0, 0, 0],
          [0, 0, 0],
          [0, 0, 0],
        ];
        const uvs: [
          [number, number],
          [number, number],
          [number, number],
          [number, number],
        ] = [
          [0, 0],
          [0, 0],
          [0, 0],
          [0, 0],
        ];
        const ao: [number, number, number, number] = [1, 1, 1, 1];

        for (let c = 0; c < 4; c += 1) {
          const corner = tpl.corners[c];
          positions[c] = [
            origin.x + cell.x + corner.pos[0],
            origin.y + cell.y + corner.pos[1],
            origin.z + cell.z + corner.pos[2],
          ];
          uvs[c] = [
            corner.uv[0] === 0 ? uvRect.u0 : uvRect.u1,
            corner.uv[1] === 0 ? uvRect.v0 : uvRect.v1,
          ];
          if (cell.layer === 'emissive' || cell.layer === 'water') {
            ao[c] = 1.0;
          } else {
            const s1 = this.hasOccluding(
              cell.x + corner.side1[0],
              cell.y + corner.side1[1],
              cell.z + corner.side1[2]
            );
            const s2 = this.hasOccluding(
              cell.x + corner.side2[0],
              cell.y + corner.side2[1],
              cell.z + corner.side2[2]
            );
            const cn = this.hasOccluding(
              cell.x + corner.corner[0],
              cell.y + corner.corner[1],
              cell.z + corner.corner[2]
            );
            ao[c] = AO_LEVELS[computeVertexAoIndex(s1, s2, cn)];
          }
        }

        emitQuad(buf, positions, tpl.normal, uvs, ao, shade, SCRATCH_COLOR);
      }
    }

    return {
      opaque: layerBuffers.opaque.positions.length > 0 ? buffersToGeometry(layerBuffers.opaque) : null,
      cutout: layerBuffers.cutout.positions.length > 0 ? buffersToGeometry(layerBuffers.cutout) : null,
      glass: layerBuffers.glass.positions.length > 0 ? buffersToGeometry(layerBuffers.glass) : null,
      water: layerBuffers.water.positions.length > 0 ? buffersToGeometry(layerBuffers.water) : null,
      emissive: layerBuffers.emissive.positions.length > 0 ? buffersToGeometry(layerBuffers.emissive) : null,
    };
  }
}

/**
 * 精细子体素轴对齐盒合批器（支持 0.0625 精度、逐面亮度与盒间接触 AO）。
 * 用于工位书桌、椅子、显示器外壳、PC 机箱、键盘、鼠标、箱子与装饰物。
 */
export class VoxelBoxBuilder {
  private readonly boxes: VoxelBoxInput[] = [];

  public addBox(input: VoxelBoxInput): this {
    this.boxes.push(input);
    return this;
  }

  public addCenteredBox(
    cx: number,
    cy: number,
    cz: number,
    sx: number,
    sy: number,
    sz: number,
    tiles: VoxelTileId | VoxelBlockFaceTiles,
    options?: {
      tint?: string;
      occludes?: boolean;
      hiddenFaces?: Partial<Record<VoxelFaceDir, boolean>>;
      floorY?: number;
    }
  ): this {
    const hx = sx * 0.5;
    const hy = sy * 0.5;
    const hz = sz * 0.5;
    return this.addBox({
      minX: cx - hx,
      minY: cy - hy,
      minZ: cz - hz,
      maxX: cx + hx,
      maxY: cy + hy,
      maxZ: cz + hz,
      tiles,
      tint: options?.tint,
      occludes: options?.occludes,
      hiddenFaces: options?.hiddenFaces,
      floorY: options?.floorY,
    });
  }

  private sampleOccluded(
    px: number,
    py: number,
    pz: number,
    skipIdx: number,
    floorY: number | undefined
  ): boolean {
    if (floorY !== undefined && py <= floorY + 0.002) {
      return true;
    }
    const eps = 0.004;
    for (let i = 0; i < this.boxes.length; i += 1) {
      if (i === skipIdx) continue;
      const b = this.boxes[i];
      if (b.occludes === false) continue;
      if (
        px >= b.minX - eps && px <= b.maxX + eps
        && py >= b.minY - eps && py <= b.maxY + eps
        && pz >= b.minZ - eps && pz <= b.maxZ + eps
      ) {
        return true;
      }
    }
    return false;
  }

  public build(enableAo = true): THREE.BufferGeometry {
    const buf = createRawBuffers();
    const probe = VOXEL_UNIT * 0.45;

    for (let i = 0; i < this.boxes.length; i += 1) {
      const box = this.boxes[i];
      const dx = box.maxX - box.minX;
      const dy = box.maxY - box.minY;
      const dz = box.maxZ - box.minZ;
      if (dx <= 1e-6 || dy <= 1e-6 || dz <= 1e-6) continue;

      if (box.tint) {
        SCRATCH_COLOR.set(box.tint);
      } else {
        SCRATCH_COLOR.setRGB(1, 1, 1);
      }

      for (let f = 0; f < FACE_TEMPLATES.length; f += 1) {
        const tpl = FACE_TEMPLATES[f];
        if (box.hiddenFaces?.[tpl.dir]) continue;

        const tileId = resolveFaceTile(box.tiles, tpl.dir);
        const uvRect = getTileUvRect(tileId);
        const shade = FACE_SHADE[tpl.dir];

        const positions: [
          [number, number, number],
          [number, number, number],
          [number, number, number],
          [number, number, number],
        ] = [
          [0, 0, 0],
          [0, 0, 0],
          [0, 0, 0],
          [0, 0, 0],
        ];
        const uvs: [
          [number, number],
          [number, number],
          [number, number],
          [number, number],
        ] = [
          [0, 0],
          [0, 0],
          [0, 0],
          [0, 0],
        ];
        const ao: [number, number, number, number] = [1, 1, 1, 1];

        for (let c = 0; c < 4; c += 1) {
          const corner = tpl.corners[c];
          const vx = box.minX + corner.pos[0] * dx;
          const vy = box.minY + corner.pos[1] * dy;
          const vz = box.minZ + corner.pos[2] * dz;
          positions[c] = [vx, vy, vz];
          uvs[c] = [
            corner.uv[0] === 0 ? uvRect.u0 : uvRect.u1,
            corner.uv[1] === 0 ? uvRect.v0 : uvRect.v1,
          ];

          if (enableAo) {
            // 在法线外侧微小探针点检测相邻体素与地面遮挡
            const s1 = this.sampleOccluded(
              vx + corner.side1[0] * probe,
              vy + corner.side1[1] * probe,
              vz + corner.side1[2] * probe,
              i,
              box.floorY
            );
            const s2 = this.sampleOccluded(
              vx + corner.side2[0] * probe,
              vy + corner.side2[1] * probe,
              vz + corner.side2[2] * probe,
              i,
              box.floorY
            );
            const cn = this.sampleOccluded(
              vx + corner.corner[0] * probe,
              vy + corner.corner[1] * probe,
              vz + corner.corner[2] * probe,
              i,
              box.floorY
            );
            ao[c] = AO_LEVELS[computeVertexAoIndex(s1, s2, cn)];
          }
        }

        emitQuad(buf, positions, tpl.normal, uvs, ao, shade, SCRATCH_COLOR);
      }
    }

    return buffersToGeometry(buf);
  }
}

/**
 * 构建纯色轴对齐盒子合批几何（用于发光描边方框、云朵、星点、脉冲折线路径等）。
 */
export function createSolidColorVoxelGeometry(boxes: readonly SolidColorBoxInput[]): THREE.BufferGeometry {
  const buf = createRawBuffers();
  for (let i = 0; i < boxes.length; i += 1) {
    const box = boxes[i];
    const dx = box.maxX - box.minX;
    const dy = box.maxY - box.minY;
    const dz = box.maxZ - box.minZ;
    if (dx <= 1e-6 || dy <= 1e-6 || dz <= 1e-6) continue;

    if (box.color) {
      SCRATCH_COLOR.set(box.color);
    } else {
      SCRATCH_COLOR.setRGB(1, 1, 1);
    }
    const useFaceShade = box.shadeFaces !== false;

    for (let f = 0; f < FACE_TEMPLATES.length; f += 1) {
      const tpl = FACE_TEMPLATES[f];
      const shade = useFaceShade ? FACE_SHADE[tpl.dir] : 1.0;
      const positions: [
        [number, number, number],
        [number, number, number],
        [number, number, number],
        [number, number, number],
      ] = [
        [
          box.minX + tpl.corners[0].pos[0] * dx,
          box.minY + tpl.corners[0].pos[1] * dy,
          box.minZ + tpl.corners[0].pos[2] * dz,
        ],
        [
          box.minX + tpl.corners[1].pos[0] * dx,
          box.minY + tpl.corners[1].pos[1] * dy,
          box.minZ + tpl.corners[1].pos[2] * dz,
        ],
        [
          box.minX + tpl.corners[2].pos[0] * dx,
          box.minY + tpl.corners[2].pos[1] * dy,
          box.minZ + tpl.corners[2].pos[2] * dz,
        ],
        [
          box.minX + tpl.corners[3].pos[0] * dx,
          box.minY + tpl.corners[3].pos[1] * dy,
          box.minZ + tpl.corners[3].pos[2] * dz,
        ],
      ];
      const uvs: [
        [number, number],
        [number, number],
        [number, number],
        [number, number],
      ] = [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ];
      emitQuad(buf, positions, tpl.normal, uvs, [1, 1, 1, 1], shade, SCRATCH_COLOR);
    }
  }
  return buffersToGeometry(buf);
}

/**
 * 零外部依赖的 BufferGeometry 合批工具，合并 position / normal / uv / color 与 index。
 */
export function mergeVoxelGeometries(geometries: readonly THREE.BufferGeometry[]): THREE.BufferGeometry {
  const buf = createRawBuffers();
  let vertexOffset = 0;

  for (let g = 0; g < geometries.length; g += 1) {
    const geo = geometries[g];
    const posAttr = geo.getAttribute('position');
    if (!posAttr || posAttr.count === 0) continue;

    const normAttr = geo.getAttribute('normal');
    const uvAttr = geo.getAttribute('uv');
    const colorAttr = geo.getAttribute('color');
    const count = posAttr.count;

    for (let i = 0; i < count; i += 1) {
      buf.positions.push(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i));
      if (normAttr) {
        buf.normals.push(normAttr.getX(i), normAttr.getY(i), normAttr.getZ(i));
      } else {
        buf.normals.push(0, 1, 0);
      }
      if (uvAttr) {
        buf.uvs.push(uvAttr.getX(i), uvAttr.getY(i));
      } else {
        buf.uvs.push(0, 0);
      }
      if (colorAttr) {
        buf.colors.push(colorAttr.getX(i), colorAttr.getY(i), colorAttr.getZ(i));
      } else {
        buf.colors.push(1, 1, 1);
      }
    }

    const indexAttr = geo.getIndex();
    if (indexAttr) {
      for (let i = 0; i < indexAttr.count; i += 1) {
        buf.indices.push(indexAttr.getX(i) + vertexOffset);
      }
    } else {
      for (let i = 0; i < count; i += 1) {
        buf.indices.push(i + vertexOffset);
      }
    }

    vertexOffset += count;
  }

  return buffersToGeometry(buf);
}
