import type { OfficeSessionItem, SessionAvailability } from './session-office-types';

/**
 * 办公室角色自主行为与路径规划模块：
 * 1. 基于 0.5 world unit 网格的可通行地图（自动将墙体、书架、咖啡台、水池、所有工位桌椅与主机标记为不可通行，并保留 0.35 安全边距）。
 * 2. 8 方向防切角 A* 寻路 + 视线折线简化（string pulling），保证折线每段严格满足最小家具间距。
 * 3. 确定性伪随机（由 sessionKey 播种，刷新可复现）驱动「工作中接咖啡」与「空闲散步」两种行为，同屏最多 2 人离座。
 * 4. 角色间最小间距 >= 0.35 world unit，路径冲突时后到者等待 1~2 秒再走，必要时局部绕行。
 */

export const WALK_GRID_CELL_SIZE = 0.5;
export const FURNITURE_MIN_CLEARANCE = 0.35;
export const CHARACTER_MIN_SPACING = 0.35;
export const CHARACTER_YIELD_DISTANCE = 0.56;
export const CHARACTER_HARD_SPACING = 0.38;
export const MAX_CONCURRENT_AWAY = 2;

export const COFFEE_RUNNING_MIN_SEC = 20;
export const COFFEE_COOLDOWN_MIN_SEC = 90;
export const STROLL_IDLE_MIN_SEC = 15;
export const STROLL_DURATION_MIN_SEC = 30;
export const STROLL_DURATION_MAX_SEC = 60;
export const SIT_STAND_TRANSITION_SEC = 0.4;
export const COFFEE_BREW_SEC = 2.2;
export const COFFEE_DRINK_SEC = 3.6;

export const NORMAL_WALK_SPEED = 1.08;
export const COFFEE_RETURN_WALK_SPEED = 0.78;
export const TURN_RATE_RAD_PER_SEC = 9.0;

/** 角色相对工位原点的椅子坐姿与离座踏步坐标 */
export const SEAT_LOCAL_X = 0.5625;
export const SEAT_LOCAL_Z = 0;
export const SEAT_FACING_YAW = -Math.PI / 2;
export const SEAT_STEP_LOCAL_X = 0.65;
export const SEAT_STEP_LOCAL_Z = 0.52;
export const SEAT_EXIT_LOCAL_X = 0.72;
export const SEAT_EXIT_LOCAL_Z = 0.72;

export type CharacterBehaviourPhase =
  | 'seated'
  | 'standing_up'
  | 'walking_to_coffee'
  | 'brewing_coffee'
  | 'drinking_coffee'
  | 'strolling'
  | 'stroll_pause'
  | 'walking_return'
  | 'sitting_down';

export type CharacterBehaviourGoal = 'none' | 'coffee' | 'stroll';

export interface WorldRect2D {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface CoffeeStationAnchor {
  anchorX: number;
  anchorZ: number;
  interactX: number;
  interactZ: number;
  facingYaw: number;
  footprint: WorldRect2D;
}

export interface RoomWalkLayout {
  halfW: number;
  halfD: number;
  coffeeStation: CoffeeStationAnchor;
  staticObstacles: readonly WorldRect2D[];
}

export interface StationSeatAnchor {
  sessionKey: string;
  bayX: number;
  bayZ: number;
}

export interface CharacterPoseOutput {
  phase: CharacterBehaviourPhase;
  goal: CharacterBehaviourGoal;
  worldX: number;
  worldZ: number;
  yaw: number;
  /** 0 = 完全坐姿，1 = 完全站立 */
  standBlend: number;
  /** 0 = 静止站立/等待，1 = 正常迈步行走 */
  walkBlend: number;
  /** 累计步态相位（弧度），仅在实际迈步时推进 */
  walkPhase: number;
  /** 0..1：取杯/喝咖啡阶段归一化进度 */
  actionProgress: number;
  /** 右手是否端着方块咖啡杯 */
  holdingCoffee: boolean;
  /** 是否正因避让而临时等待 */
  isYielding: boolean;
}

export interface Waypoint2D {
  x: number;
  z: number;
}

interface GridCell {
  ix: number;
  iz: number;
}

/** FNV-1a 32 位哈希，将 sessionKey 映射为稳定非零种子 */
export function hashBehaviourSeed(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) || 0x9e3779b9;
}

/** Mulberry32 确定性伪随机生成器，每次推进返回 [0, 1) */
function nextSeededUnit(state: { seed: number }): number {
  state.seed = (state.seed + 0x6d2b79f5) | 0;
  let t = Math.imul(state.seed ^ (state.seed >>> 15), 1 | state.seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function wrapAngleRad(angle: number): number {
  let a = angle;
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

export function stepAngleShortest(currentYaw: number, targetYaw: number, maxStep: number): number {
  const diff = wrapAngleRad(targetYaw - currentYaw);
  if (Math.abs(diff) <= maxStep) {
    return wrapAngleRad(targetYaw);
  }
  return wrapAngleRad(currentYaw + Math.sign(diff) * maxStep);
}

function smoothstep01(t: number): number {
  const c = Math.max(0, Math.min(1, t));
  return c * c * (3 - 2 * c);
}

function pointInsideExpandedRect(
  x: number,
  z: number,
  rect: WorldRect2D,
  pad: number
): boolean {
  return (
    x > rect.minX - pad
    && x < rect.maxX + pad
    && z > rect.minZ - pad
    && z < rect.maxZ + pad
  );
}

/** 0.5 world unit 房间可通行网格与 A* + 视线折线简化器 */
export class OfficeWalkabilityGrid {
  public readonly halfW: number;
  public readonly halfD: number;
  public readonly cellSize: number;
  public readonly cols: number;
  public readonly rows: number;
  private readonly blocked: Uint8Array;
  private readonly obstacles: WorldRect2D[];
  private readonly roamCandidates: Waypoint2D[];

  constructor(
    halfW: number,
    halfD: number,
    obstacles: readonly WorldRect2D[],
    coffeeInteract: Waypoint2D,
    cellSize = WALK_GRID_CELL_SIZE
  ) {
    this.halfW = halfW;
    this.halfD = halfD;
    this.cellSize = cellSize;
    this.cols = Math.max(2, Math.round((halfW * 2) / cellSize));
    this.rows = Math.max(2, Math.round((halfD * 2) / cellSize));
    this.blocked = new Uint8Array(this.cols * this.rows);
    this.obstacles = obstacles.map((r) => ({ ...r }));
    this.roamCandidates = [];

    for (let iz = 0; iz < this.rows; iz += 1) {
      for (let ix = 0; ix < this.cols; ix += 1) {
        const wx = this.cellCenterX(ix);
        const wz = this.cellCenterZ(iz);
        const walkable = this.isPointClear(wx, wz, FURNITURE_MIN_CLEARANCE);
        this.blocked[iz * this.cols + ix] = walkable ? 0 : 1;
      }
    }

    // 保障咖啡机正面交互格可通行
    const coffeeCell = this.worldToCell(coffeeInteract.x, coffeeInteract.z);
    if (this.inBounds(coffeeCell.ix, coffeeCell.iz)) {
      this.blocked[coffeeCell.iz * this.cols + coffeeCell.ix] = 0;
    }

    // 预收集走道合法漫游格（避开紧贴咖啡机交互点的格子，优先室内开阔走道）
    for (let iz = 1; iz < this.rows - 1; iz += 1) {
      for (let ix = 1; ix < this.cols - 1; ix += 1) {
        if (!this.isCellWalkable(ix, iz)) continue;
        const wx = this.cellCenterX(ix);
        const wz = this.cellCenterZ(iz);
        const distCoffee = Math.hypot(wx - coffeeInteract.x, wz - coffeeInteract.z);
        if (distCoffee < 0.9) continue;
        // 优先选择至少有 2 个相邻可通行格的真正走道点，避免拐角死格
        let openNeighbors = 0;
        if (this.isCellWalkable(ix + 1, iz)) openNeighbors += 1;
        if (this.isCellWalkable(ix - 1, iz)) openNeighbors += 1;
        if (this.isCellWalkable(ix, iz + 1)) openNeighbors += 1;
        if (this.isCellWalkable(ix, iz - 1)) openNeighbors += 1;
        if (openNeighbors >= 2) {
          this.roamCandidates.push({ x: wx, z: wz });
        }
      }
    }
  }

  public cellCenterX(ix: number): number {
    return -this.halfW + (ix + 0.5) * this.cellSize;
  }

  public cellCenterZ(iz: number): number {
    return -this.halfD + (iz + 0.5) * this.cellSize;
  }

  public inBounds(ix: number, iz: number): boolean {
    return ix >= 0 && ix < this.cols && iz >= 0 && iz < this.rows;
  }

  public worldToCell(x: number, z: number): GridCell {
    const ix = Math.max(0, Math.min(this.cols - 1, Math.floor((x + this.halfW) / this.cellSize)));
    const iz = Math.max(0, Math.min(this.rows - 1, Math.floor((z + this.halfD) / this.cellSize)));
    return { ix, iz };
  }

  public isCellWalkable(ix: number, iz: number): boolean {
    if (!this.inBounds(ix, iz)) return false;
    return this.blocked[iz * this.cols + ix] === 0;
  }

  public isPointClear(x: number, z: number, clearance = FURNITURE_MIN_CLEARANCE): boolean {
    // 墙体安全内边距（同时自然排除室外水池与室外草地）
    if (
      x < -this.halfW + clearance
      || x > this.halfW - clearance
      || z < -this.halfD + clearance
      || z > this.halfD - clearance
    ) {
      return false;
    }
    for (let i = 0; i < this.obstacles.length; i += 1) {
      if (pointInsideExpandedRect(x, z, this.obstacles[i], clearance)) {
        return false;
      }
    }
    return true;
  }

  public getRoamCandidates(): readonly Waypoint2D[] {
    return this.roamCandidates;
  }

  /** 将任意世界点吸附到最近的可通行网格中心 */
  public findNearestWalkableCell(x: number, z: number, tempBlockedIdx = -1): GridCell | null {
    const start = this.worldToCell(x, z);
    const startIdx = start.iz * this.cols + start.ix;
    if (this.isCellWalkable(start.ix, start.iz) && startIdx !== tempBlockedIdx) {
      return start;
    }

    let best: GridCell | null = null;
    let bestDistSq = Number.POSITIVE_INFINITY;
    for (let iz = 0; iz < this.rows; iz += 1) {
      for (let ix = 0; ix < this.cols; ix += 1) {
        const idx = iz * this.cols + ix;
        if (this.blocked[idx] !== 0 || idx === tempBlockedIdx) continue;
        const dx = this.cellCenterX(ix) - x;
        const dz = this.cellCenterZ(iz) - z;
        const dSq = dx * dx + dz * dz;
        if (dSq < bestDistSq) {
          bestDistSq = dSq;
          best = { ix, iz };
        }
      }
    }
    return best;
  }

  /** 检查两点连线是否全段保持至少 FURNITURE_MIN_CLEARANCE 家具与墙体间距 */
  public hasLineOfSight(
    ax: number,
    az: number,
    bx: number,
    bz: number,
    tempBlockedCell?: GridCell | null
  ): boolean {
    const dist = Math.hypot(bx - ax, bz - az);
    const steps = Math.max(2, Math.ceil(dist / 0.12));
    for (let i = 1; i < steps; i += 1) {
      const t = i / steps;
      const sx = ax + (bx - ax) * t;
      const sz = az + (bz - az) * t;
      if (!this.isPointClear(sx, sz, FURNITURE_MIN_CLEARANCE)) {
        return false;
      }
      if (tempBlockedCell) {
        const bxCenter = this.cellCenterX(tempBlockedCell.ix);
        const bzCenter = this.cellCenterZ(tempBlockedCell.iz);
        if (Math.hypot(sx - bxCenter, sz - bzCenter) < CHARACTER_YIELD_DISTANCE * 0.9) {
          return false;
        }
      }
    }
    return true;
  }

  /** 8 方向防切角 A* 寻路 + 视线折线简化 */
  public findPath(
    startX: number,
    startZ: number,
    goalX: number,
    goalZ: number,
    avoidPoint?: Waypoint2D | null
  ): Waypoint2D[] {
    const avoidCell = avoidPoint ? this.worldToCell(avoidPoint.x, avoidPoint.z) : null;
    const tempBlockedIdx =
      avoidCell && this.inBounds(avoidCell.ix, avoidCell.iz)
        ? avoidCell.iz * this.cols + avoidCell.ix
        : -1;

    const startCell = this.findNearestWalkableCell(startX, startZ, -1);
    const goalCell = this.findNearestWalkableCell(goalX, goalZ, tempBlockedIdx);
    if (!startCell || !goalCell) {
      return [{ x: goalX, z: goalZ }];
    }

    const total = this.cols * this.rows;
    const startIdx = startCell.iz * this.cols + startCell.ix;
    const goalIdx = goalCell.iz * this.cols + goalCell.ix;

    if (startIdx === goalIdx) {
      const destX = this.isPointClear(goalX, goalZ, FURNITURE_MIN_CLEARANCE)
        ? goalX
        : this.cellCenterX(goalCell.ix);
      const destZ = this.isPointClear(goalX, goalZ, FURNITURE_MIN_CLEARANCE)
        ? goalZ
        : this.cellCenterZ(goalCell.iz);
      return [{ x: destX, z: destZ }];
    }

    const gScore = new Float32Array(total);
    const fScore = new Float32Array(total);
    const cameFrom = new Int32Array(total);
    const state = new Uint8Array(total); // 0=unvisited, 1=open, 2=closed
    gScore.fill(Number.POSITIVE_INFINITY);
    fScore.fill(Number.POSITIVE_INFINITY);
    cameFrom.fill(-1);

    const heuristic = (ix: number, iz: number): number => {
      const dx = Math.abs(ix - goalCell.ix);
      const dz = Math.abs(iz - goalCell.iz);
      return Math.max(dx, dz) + (Math.SQRT2 - 1) * Math.min(dx, dz);
    };

    const openList: number[] = [startIdx];
    gScore[startIdx] = 0;
    fScore[startIdx] = heuristic(startCell.ix, startCell.iz);
    state[startIdx] = 1;

    const dirs: readonly [number, number, number][] = [
      [1, 0, 1],
      [-1, 0, 1],
      [0, 1, 1],
      [0, -1, 1],
      [1, 1, Math.SQRT2],
      [1, -1, Math.SQRT2],
      [-1, 1, Math.SQRT2],
      [-1, -1, Math.SQRT2],
    ];

    let found = false;
    while (openList.length > 0) {
      let bestPos = 0;
      let current = openList[0];
      let bestF = fScore[current];
      for (let i = 1; i < openList.length; i += 1) {
        const candidate = openList[i];
        if (fScore[candidate] < bestF) {
          bestF = fScore[candidate];
          current = candidate;
          bestPos = i;
        }
      }

      if (current === goalIdx) {
        found = true;
        break;
      }

      openList[bestPos] = openList[openList.length - 1];
      openList.pop();
      state[current] = 2;

      const cx = current % this.cols;
      const cz = Math.floor(current / this.cols);

      for (let d = 0; d < dirs.length; d += 1) {
        const dx = dirs[d][0];
        const dz = dirs[d][1];
        const stepCost = dirs[d][2];
        const nx = cx + dx;
        const nz = cz + dz;
        if (!this.isCellWalkable(nx, nz)) continue;
        const nIdx = nz * this.cols + nx;
        if (nIdx === tempBlockedIdx && nIdx !== goalIdx && nIdx !== startIdx) continue;
        if (state[nIdx] === 2) continue;

        // 对角移动禁止切过障碍角点
        if (dx !== 0 && dz !== 0) {
          if (!this.isCellWalkable(cx + dx, cz) || !this.isCellWalkable(cx, cz + dz)) {
            continue;
          }
          const sideA = cz * this.cols + (cx + dx);
          const sideB = (cz + dz) * this.cols + cx;
          if (sideA === tempBlockedIdx || sideB === tempBlockedIdx) {
            continue;
          }
        }

        const tentativeG = gScore[current] + stepCost;
        if (tentativeG < gScore[nIdx]) {
          cameFrom[nIdx] = current;
          gScore[nIdx] = tentativeG;
          fScore[nIdx] = tentativeG + heuristic(nx, nz);
          if (state[nIdx] !== 1) {
            state[nIdx] = 1;
            openList.push(nIdx);
          }
        }
      }
    }

    if (!found) {
      // 若带临时避让格失败，回退为不带避让格的静态路径
      if (avoidPoint) {
        return this.findPath(startX, startZ, goalX, goalZ, null);
      }
      return [{ x: this.cellCenterX(goalCell.ix), z: this.cellCenterZ(goalCell.iz) }];
    }

    const rawPoints: Waypoint2D[] = [];
    let cursor = goalIdx;
    while (cursor !== -1) {
      const cx = cursor % this.cols;
      const cz = Math.floor(cursor / this.cols);
      rawPoints.push({ x: this.cellCenterX(cx), z: this.cellCenterZ(cz) });
      cursor = cameFrom[cursor];
    }
    rawPoints.reverse();

    // 终格若目标精确点合法，替换为精确目标坐标（例如咖啡机交互点或工位踏步点）
    if (this.isPointClear(goalX, goalZ, FURNITURE_MIN_CLEARANCE)) {
      rawPoints[rawPoints.length - 1] = { x: goalX, z: goalZ };
    }

    // 视线折线简化（string pulling）：跳过共线与无遮挡中间点
    const simplified: Waypoint2D[] = [];
    let anchorX = this.isPointClear(startX, startZ, FURNITURE_MIN_CLEARANCE)
      ? startX
      : rawPoints[0].x;
    let anchorZ = this.isPointClear(startX, startZ, FURNITURE_MIN_CLEARANCE)
      ? startZ
      : rawPoints[0].z;

    let i = 0;
    while (i < rawPoints.length) {
      let furthest = i;
      for (let j = rawPoints.length - 1; j > i; j -= 1) {
        if (this.hasLineOfSight(anchorX, anchorZ, rawPoints[j].x, rawPoints[j].z, avoidCell)) {
          furthest = j;
          break;
        }
      }
      const nextPt = rawPoints[furthest];
      if (Math.hypot(nextPt.x - anchorX, nextPt.z - anchorZ) > 0.04 || furthest === rawPoints.length - 1) {
        simplified.push(nextPt);
        anchorX = nextPt.x;
        anchorZ = nextPt.z;
      }
      if (furthest === rawPoints.length - 1) break;
      i = furthest + 1;
    }

    if (simplified.length === 0) {
      simplified.push(rawPoints[rawPoints.length - 1]);
    }
    return simplified;
  }
}

interface AgentRecord {
  sessionKey: string;
  rng: { seed: number };
  bayX: number;
  bayZ: number;
  availability: SessionAvailability;
  isRunningEligible: boolean;
  isPureIdle: boolean;
  isIdleActivity: boolean;
  phase: CharacterBehaviourPhase;
  goal: CharacterBehaviourGoal;
  phaseElapsedSec: number;
  /** 本次会话连续运行累计秒数（用于触发 >=20s 接咖啡） */
  runningSeatedSec: number;
  /** 本次会话连续空闲累计秒数（用于触发 >=15s 散步） */
  idleSeatedSec: number;
  nextCoffeeTriggerSec: number;
  nextStrollTriggerSec: number;
  /** 上一次喝咖啡结束时的行为时钟秒数，-Infinity 表示尚未接过咖啡 */
  lastCoffeeEndClockSec: number;
  nextCoffeeCooldownSec: number;
  lastStrollEndClockSec: number;
  nextStrollCooldownSec: number;
  /** 离座序号，用于路径冲突时判定先到者/后到者 */
  departOrder: number;
  /** 当前世界坐标与朝向 */
  worldX: number;
  worldZ: number;
  yaw: number;
  standBlend: number;
  walkBlend: number;
  walkPhase: number;
  holdingCoffee: boolean;
  /** 路径队列 */
  path: Waypoint2D[];
  pathIndex: number;
  /** 漫游队列与停顿时长 */
  strollTargets: Waypoint2D[];
  strollDwells: number[];
  strollIndex: number;
  strollStartedClockSec: number;
  currentDwellDurationSec: number;
  sitStartX: number;
  sitStartZ: number;
  /** 冲突等待计时器（1~2 秒） */
  yieldRemainingSec: number;
  yieldBlockedByKey: string | null;
  rerouteAttempts: number;
  /** 复用输出对象，避免每帧分配 */
  poseOut: CharacterPoseOutput;
}

/** 根据工位数组生成每个工位的家具不可通行矩形列表（桌 + 椅 + 桌旁落地机箱） */
export function buildStationFurnitureObstacles(
  stations: readonly StationSeatAnchor[]
): WorldRect2D[] {
  const obstacles: WorldRect2D[] = [];
  for (let i = 0; i < stations.length; i += 1) {
    const s = stations[i];
    // 书桌本体：x ∈ [-1.00, +0.3125], z ∈ [-0.6875, +0.50]
    obstacles.push({
      minX: s.bayX - 1.0,
      maxX: s.bayX + 0.3125,
      minZ: s.bayZ - 0.6875,
      maxZ: s.bayZ + 0.5,
    });
    // 方块椅子：x ∈ [+0.3125, +0.8125], z ∈ [-0.3125, +0.3125]
    obstacles.push({
      minX: s.bayX + 0.3125,
      maxX: s.bayX + 0.8125,
      minZ: s.bayZ - 0.3125,
      maxZ: s.bayZ + 0.3125,
    });
    // 桌旁落地 PC 机箱（已移至右后方地面）：x ∈ [+0.375, +0.625], z ∈ [-0.75, -0.375]
    obstacles.push({
      minX: s.bayX + 0.375,
      maxX: s.bayX + 0.625,
      minZ: s.bayZ - 0.75,
      maxZ: s.bayZ - 0.375,
    });
  }
  return obstacles;
}

/** 办公室全房间角色行为调度器 */
export class OfficeBehaviourManager {
  private readonly agents = new Map<string, AgentRecord>();
  private layout: RoomWalkLayout | null = null;
  private grid: OfficeWalkabilityGrid | null = null;
  private layoutSignature = '';
  private clockSec = 0;
  private nextDepartOrder = 1;
  private coffeeReservedBy: string | null = null;
  private reducedMotion = false;

  public getClockSec(): number {
    return this.clockSec;
  }

  public getGrid(): OfficeWalkabilityGrid | null {
    return this.grid;
  }

  public getCoffeeReservedBy(): string | null {
    return this.coffeeReservedBy;
  }

  public setReducedMotion(enabled: boolean): void {
    if (this.reducedMotion === enabled) return;
    this.reducedMotion = enabled;
    if (enabled) {
      this.resetAllToSeated();
    }
  }

  /** 重置整个房间状态（切换项目房间时调用） */
  public resetRoom(): void {
    this.agents.clear();
    this.coffeeReservedBy = null;
    this.layoutSignature = '';
    this.grid = null;
    this.clockSec = 0;
    this.nextDepartOrder = 1;
  }

  /** 将全部角色立即归位为坐姿（用于 reducedMotion 切换） */
  public resetAllToSeated(): void {
    this.coffeeReservedBy = null;
    for (const agent of this.agents.values()) {
      this.snapAgentToSeat(agent);
    }
  }

  public removeAgent(sessionKey: string): void {
    if (this.coffeeReservedBy === sessionKey) {
      this.coffeeReservedBy = null;
    }
    this.agents.delete(sessionKey);
  }

  /** 增量同步房间布局、工位坐标与会话活动状态（不打断正在进行的行为） */
  public syncSessions(
    layout: RoomWalkLayout,
    sessions: readonly OfficeSessionItem[],
    anchors: readonly StationSeatAnchor[],
    reducedMotion: boolean
  ): void {
    this.layout = layout;
    this.setReducedMotion(reducedMotion);

    const anchorMap = new Map<string, StationSeatAnchor>();
    for (let i = 0; i < anchors.length; i += 1) {
      anchorMap.set(anchors[i].sessionKey, anchors[i]);
    }

    const sigParts: string[] = [
      String(layout.halfW),
      String(layout.halfD),
      layout.coffeeStation.interactX.toFixed(2),
      layout.coffeeStation.interactZ.toFixed(2),
    ];
    for (let i = 0; i < anchors.length; i += 1) {
      sigParts.push(`${anchors[i].sessionKey}:${anchors[i].bayX.toFixed(2)},${anchors[i].bayZ.toFixed(2)}`);
    }
    const nextSig = sigParts.join('|');
    const layoutChanged = nextSig !== this.layoutSignature;
    if (layoutChanged) {
      this.layoutSignature = nextSig;
      const obstacles: WorldRect2D[] = [
        ...layout.staticObstacles,
        layout.coffeeStation.footprint,
        ...buildStationFurnitureObstacles(anchors),
      ];
      this.grid = new OfficeWalkabilityGrid(
        layout.halfW,
        layout.halfD,
        obstacles,
        {
          x: layout.coffeeStation.interactX,
          z: layout.coffeeStation.interactZ,
        },
        WALK_GRID_CELL_SIZE
      );
    }

    const activeKeys = new Set<string>();
    for (let i = 0; i < sessions.length; i += 1) {
      const session = sessions[i];
      activeKeys.add(session.sessionKey);
      const anchor = anchorMap.get(session.sessionKey) ?? {
        sessionKey: session.sessionKey,
        bayX: 0,
        bayZ: 0,
      };

      const isInteractive = session.availability === 'interactive';
      const isDirOnly = session.availability === 'directory-only';
      const hasMailOrPulse =
        session.activity.kind !== 'idle'
        || session.activity.recentPulse
        || session.pendingCount > 0;

      // 对齐 OfficeSessionItem：interactive 为「运行中」，directory-only 且无脉冲为「空闲」
      const isRunningEligible = isInteractive || (isDirOnly && hasMailOrPulse);
      const isPureIdle = isDirOnly && !hasMailOrPulse;
      const isIdleActivity = !hasMailOrPulse && (isInteractive || isDirOnly);

      let agent = this.agents.get(session.sessionKey);
      if (!agent) {
        const rng = { seed: hashBehaviourSeed(session.sessionKey) };
        const seatX = anchor.bayX + SEAT_LOCAL_X;
        const seatZ = anchor.bayZ + SEAT_LOCAL_Z;
        agent = {
          sessionKey: session.sessionKey,
          rng,
          bayX: anchor.bayX,
          bayZ: anchor.bayZ,
          availability: session.availability,
          isRunningEligible,
          isPureIdle,
          isIdleActivity,
          phase: 'seated',
          goal: 'none',
          phaseElapsedSec: 0,
          runningSeatedSec: 0,
          idleSeatedSec: 0,
          nextCoffeeTriggerSec: COFFEE_RUNNING_MIN_SEC + nextSeededUnit(rng) * 5.0,
          nextStrollTriggerSec: STROLL_IDLE_MIN_SEC + nextSeededUnit(rng) * 5.0,
          lastCoffeeEndClockSec: Number.NEGATIVE_INFINITY,
          nextCoffeeCooldownSec: COFFEE_COOLDOWN_MIN_SEC + nextSeededUnit(rng) * 14.0,
          lastStrollEndClockSec: Number.NEGATIVE_INFINITY,
          nextStrollCooldownSec: 22.0 + nextSeededUnit(rng) * 14.0,
          departOrder: 0,
          worldX: seatX,
          worldZ: seatZ,
          yaw: SEAT_FACING_YAW,
          standBlend: 0,
          walkBlend: 0,
          walkPhase: 0,
          holdingCoffee: false,
          path: [],
          pathIndex: 0,
          strollTargets: [],
          strollDwells: [],
          strollIndex: 0,
          strollStartedClockSec: 0,
          currentDwellDurationSec: 0,
          sitStartX: seatX,
          sitStartZ: seatZ,
          yieldRemainingSec: 0,
          yieldBlockedByKey: null,
          rerouteAttempts: 0,
          poseOut: {
            phase: 'seated',
            goal: 'none',
            worldX: seatX,
            worldZ: seatZ,
            yaw: SEAT_FACING_YAW,
            standBlend: 0,
            walkBlend: 0,
            walkPhase: 0,
            actionProgress: 0,
            holdingCoffee: false,
            isYielding: false,
          },
        };
        this.agents.set(session.sessionKey, agent);
      } else {
        const bayMoved =
          Math.abs(agent.bayX - anchor.bayX) > 1e-4
          || Math.abs(agent.bayZ - anchor.bayZ) > 1e-4;
        agent.bayX = anchor.bayX;
        agent.bayZ = anchor.bayZ;
        agent.availability = session.availability;
        agent.isRunningEligible = isRunningEligible;
        agent.isPureIdle = isPureIdle;
        agent.isIdleActivity = isIdleActivity;

        if (agent.phase === 'seated') {
          agent.worldX = anchor.bayX + SEAT_LOCAL_X;
          agent.worldZ = anchor.bayZ + SEAT_LOCAL_Z;
          agent.yaw = SEAT_FACING_YAW;
          if (!isRunningEligible) agent.runningSeatedSec = 0;
          if (!isIdleActivity) agent.idleSeatedSec = 0;
        } else {
          // 会话退化为 exited/unavailable 时，平滑引导回座而非瞬间闪现
          if (
            (session.availability === 'exited' || session.availability === 'unavailable')
            && agent.phase !== 'walking_return'
            && agent.phase !== 'sitting_down'
          ) {
            this.beginReturnToSeat(agent);
          } else if ((layoutChanged || bayMoved) && this.grid) {
            this.repathActiveAgentAfterLayoutChange(agent);
          }
        }
      }

      if (reducedMotion && agent.phase !== 'seated') {
        this.snapAgentToSeat(agent);
      } else {
        this.syncPoseOutput(agent);
      }
    }

    for (const key of [...this.agents.keys()]) {
      if (!activeKeys.has(key)) {
        this.removeAgent(key);
      }
    }
  }

  /** 是否存在任一角色正在离座移动/执行行为动画（用于控制器启停连续 RAF） */
  public hasActiveBehaviour(): boolean {
    if (this.reducedMotion) return false;
    for (const agent of this.agents.values()) {
      if (agent.phase !== 'seated') return true;
    }
    return false;
  }

  /** 返回当前离座角色数量（严格 <= MAX_CONCURRENT_AWAY） */
  public getAwayCount(): number {
    let count = 0;
    for (const agent of this.agents.values()) {
      if (agent.phase !== 'seated') count += 1;
    }
    return count;
  }

  /**
   * 估算下一次将有角色离座的等待毫秒数（用于在全体回座静止后关闭 RAF、仅靠单次 setTimeout 唤醒）。
   * 若当前没有任何会话可能触发行为，返回 null。
   */
  public getNextWakeDelayMs(): number | null {
    if (this.reducedMotion || !this.grid || !this.layout) return null;
    if (this.hasActiveBehaviour()) return 0;

    let minRemainSec = Number.POSITIVE_INFINITY;
    for (const agent of this.agents.values()) {
      if (agent.phase !== 'seated') return 0;
      if (agent.availability === 'exited' || agent.availability === 'unavailable') continue;

      if (agent.isRunningEligible) {
        const runRemain = Math.max(0, agent.nextCoffeeTriggerSec - agent.runningSeatedSec);
        const coolRemain = Number.isFinite(agent.lastCoffeeEndClockSec)
          ? Math.max(0, agent.lastCoffeeEndClockSec + agent.nextCoffeeCooldownSec - this.clockSec)
          : 0;
        const coffeeWait = Math.max(runRemain, coolRemain);
        if (coffeeWait < minRemainSec) {
          minRemainSec = coffeeWait;
        }
      }

      const strollEligibleNow =
        agent.isPureIdle
        || (
          agent.isIdleActivity
          && Number.isFinite(agent.lastCoffeeEndClockSec)
          && (this.clockSec - agent.lastCoffeeEndClockSec) < agent.nextCoffeeCooldownSec
        );
      if (strollEligibleNow) {
        const idleRemain = Math.max(0, agent.nextStrollTriggerSec - agent.idleSeatedSec);
        const strollCool = Number.isFinite(agent.lastStrollEndClockSec)
          ? Math.max(0, agent.lastStrollEndClockSec + agent.nextStrollCooldownSec - this.clockSec)
          : 0;
        const strollWait = Math.max(idleRemain, strollCool);
        if (strollWait < minRemainSec) {
          minRemainSec = strollWait;
        }
      }
    }

    if (!Number.isFinite(minRemainSec)) return null;
    return Math.max(40, Math.ceil(minRemainSec * 1000) + 25);
  }

  /** 推进全局行为时钟与所有角色状态机（支持小步动画帧与静止唤醒大步推进） */
  public step(dtSec: number): void {
    if (this.reducedMotion || !this.grid || !this.layout) return;
    if (!Number.isFinite(dtSec) || dtSec <= 0) return;

    // 若全体静止时收到较大唤醒步长，直接累计坐姿计时并检查是否触发新行为，不做多余插值
    if (!this.hasActiveBehaviour() && dtSec > 0.1) {
      this.clockSec += dtSec;
      for (const agent of this.agents.values()) {
        this.accumulateSeatedTimers(agent, dtSec);
      }
      this.tryDispatchNewBehaviours();
      for (const agent of this.agents.values()) {
        this.syncPoseOutput(agent);
      }
      return;
    }

    const safeDt = Math.min(0.05, dtSec);
    this.clockSec += safeDt;

    for (const agent of this.agents.values()) {
      if (agent.phase === 'seated') {
        this.accumulateSeatedTimers(agent, safeDt);
      } else {
        this.stepActiveAgent(agent, safeDt);
      }
    }

    this.tryDispatchNewBehaviours();

    for (const agent of this.agents.values()) {
      this.syncPoseOutput(agent);
    }
  }

  /** 读取指定角色当前姿态（复用预分配对象，零每帧分配） */
  public getPose(sessionKey: string): CharacterPoseOutput | null {
    return this.agents.get(sessionKey)?.poseOut ?? null;
  }

  private accumulateSeatedTimers(agent: AgentRecord, dtSec: number): void {
    if (agent.availability === 'exited' || agent.availability === 'unavailable') {
      agent.runningSeatedSec = 0;
      agent.idleSeatedSec = 0;
      return;
    }
    if (agent.isRunningEligible) {
      agent.runningSeatedSec += dtSec;
    } else {
      agent.runningSeatedSec = 0;
    }
    if (agent.isIdleActivity) {
      agent.idleSeatedSec += dtSec;
    } else {
      agent.idleSeatedSec = 0;
    }
  }

  private tryDispatchNewBehaviours(): void {
    if (!this.grid || !this.layout) return;
    let awayCount = this.getAwayCount();
    if (awayCount >= MAX_CONCURRENT_AWAY) return;

    // 确定性按 sessionKey 排序评估候选，保证刷新后行为序列完全可复现
    const sortedKeys = [...this.agents.keys()].sort();

    // 第一轮优先派发「工作中接咖啡」（需持续运行 >=20s 且距上次接咖啡 >=90s 且咖啡机空闲）
    if (!this.coffeeReservedBy && awayCount < MAX_CONCURRENT_AWAY) {
      for (let i = 0; i < sortedKeys.length; i += 1) {
        const agent = this.agents.get(sortedKeys[i]);
        if (!agent || agent.phase !== 'seated') continue;
        if (!agent.isRunningEligible) continue;
        if (agent.runningSeatedSec < agent.nextCoffeeTriggerSec) continue;
        if (
          Number.isFinite(agent.lastCoffeeEndClockSec)
          && (this.clockSec - agent.lastCoffeeEndClockSec) < agent.nextCoffeeCooldownSec
        ) {
          continue;
        }
        this.startCoffeeTrip(agent);
        awayCount += 1;
        break;
      }
    }

    if (awayCount >= MAX_CONCURRENT_AWAY) return;

    // 第二轮派发「空闲散步」（纯空闲 >=15s，或处于咖啡冷却期的空闲运行会话 >=15s）
    for (let i = 0; i < sortedKeys.length; i += 1) {
      if (awayCount >= MAX_CONCURRENT_AWAY) break;
      const agent = this.agents.get(sortedKeys[i]);
      if (!agent || agent.phase !== 'seated') continue;
      if (agent.availability === 'exited' || agent.availability === 'unavailable') continue;

      const onCoffeeCooldown =
        Number.isFinite(agent.lastCoffeeEndClockSec)
        && (this.clockSec - agent.lastCoffeeEndClockSec) < agent.nextCoffeeCooldownSec;
      const canStroll = agent.isPureIdle || (agent.isIdleActivity && onCoffeeCooldown);
      if (!canStroll) continue;
      if (agent.idleSeatedSec < agent.nextStrollTriggerSec) continue;
      if (
        Number.isFinite(agent.lastStrollEndClockSec)
        && (this.clockSec - agent.lastStrollEndClockSec) < agent.nextStrollCooldownSec
      ) {
        continue;
      }

      if (this.startStrollTrip(agent)) {
        awayCount += 1;
      }
    }
  }

  private getSeatExitPoint(agent: AgentRecord): Waypoint2D {
    const rawX = agent.bayX + SEAT_EXIT_LOCAL_X;
    const rawZ = agent.bayZ + SEAT_EXIT_LOCAL_Z;
    if (this.grid && !this.grid.isPointClear(rawX, rawZ, FURNITURE_MIN_CLEARANCE)) {
      const nearest = this.grid.findNearestWalkableCell(rawX, rawZ);
      if (nearest) {
        return {
          x: this.grid.cellCenterX(nearest.ix),
          z: this.grid.cellCenterZ(nearest.iz),
        };
      }
    }
    return { x: rawX, z: rawZ };
  }

  private startCoffeeTrip(agent: AgentRecord): void {
    if (!this.grid || !this.layout) return;
    this.coffeeReservedBy = agent.sessionKey;
    agent.goal = 'coffee';
    agent.phase = 'standing_up';
    agent.phaseElapsedSec = 0;
    agent.departOrder = this.nextDepartOrder;
    this.nextDepartOrder += 1;
    agent.holdingCoffee = false;
    agent.yieldRemainingSec = 0;
    agent.yieldBlockedByKey = null;
    agent.rerouteAttempts = 0;
    agent.strollTargets = [];
    agent.strollDwells = [];
    agent.strollIndex = 0;

    const exitPt = this.getSeatExitPoint(agent);
    const toCoffee = this.grid.findPath(
      exitPt.x,
      exitPt.z,
      this.layout.coffeeStation.interactX,
      this.layout.coffeeStation.interactZ
    );
    agent.path = [exitPt, ...toCoffee];
    agent.pathIndex = 0;
  }

  private startStrollTrip(agent: AgentRecord): boolean {
    if (!this.grid || !this.layout) return false;
    const candidates = this.grid.getRoamCandidates();
    if (candidates.length === 0) return false;

    const exitPt = this.getSeatExitPoint(agent);
    const waypointCount = nextSeededUnit(agent.rng) < 0.5 ? 2 : 3;
    const chosen: Waypoint2D[] = [];
    let prevX = exitPt.x;
    let prevZ = exitPt.z;

    for (let k = 0; k < waypointCount; k += 1) {
      let bestCandidate: Waypoint2D | null = null;
      // 从确定性采样池挑选距离上一个点足够远的合法走道格，保证漫游覆盖房间走道
      const sampleCount = Math.min(12, candidates.length);
      let bestScore = -1;
      for (let s = 0; s < sampleCount; s += 1) {
        const idx = Math.floor(nextSeededUnit(agent.rng) * candidates.length);
        const cand = candidates[idx];
        const distPrev = Math.hypot(cand.x - prevX, cand.z - prevZ);
        let minExisting = Number.POSITIVE_INFINITY;
        for (let c = 0; c < chosen.length; c += 1) {
          minExisting = Math.min(minExisting, Math.hypot(cand.x - chosen[c].x, cand.z - chosen[c].z));
        }
        const score = Math.min(distPrev, 6.0) + Math.min(minExisting, 4.0) * 0.6;
        if (score > bestScore) {
          bestScore = score;
          bestCandidate = cand;
        }
      }
      if (bestCandidate) {
        chosen.push(bestCandidate);
        prevX = bestCandidate.x;
        prevZ = bestCandidate.z;
      }
    }

    if (chosen.length === 0) return false;

    // 估算总行走耗时并分配每个路点的停留观望时间，使整趟漫游严格落在 30~60 秒区间
    let estWalkDist = 0;
    let curX = exitPt.x;
    let curZ = exitPt.z;
    for (let i = 0; i < chosen.length; i += 1) {
      estWalkDist += Math.hypot(chosen[i].x - curX, chosen[i].z - curZ) * 1.25;
      curX = chosen[i].x;
      curZ = chosen[i].z;
    }
    estWalkDist += Math.hypot(exitPt.x - curX, exitPt.z - curZ) * 1.25;
    const estWalkSec = estWalkDist / NORMAL_WALK_SPEED + SIT_STAND_TRANSITION_SEC * 2;
    const targetTotalSec = 34 + nextSeededUnit(agent.rng) * 20; // 34..54s 严格处于 [30, 60]
    const totalDwellBudget = Math.max(
      chosen.length * 4.0,
      Math.min(STROLL_DURATION_MAX_SEC - estWalkSec - 3.0, targetTotalSec - estWalkSec)
    );
    const dwells: number[] = [];
    const baseDwell = Math.max(3.5, totalDwellBudget / chosen.length);
    for (let i = 0; i < chosen.length; i += 1) {
      const factor = 0.85 + nextSeededUnit(agent.rng) * 0.3;
      dwells.push(Math.max(3.0, Math.min(18.0, baseDwell * factor)));
    }

    agent.goal = 'stroll';
    agent.phase = 'standing_up';
    agent.phaseElapsedSec = 0;
    agent.strollStartedClockSec = this.clockSec;
    agent.departOrder = this.nextDepartOrder;
    this.nextDepartOrder += 1;
    agent.holdingCoffee = false;
    agent.yieldRemainingSec = 0;
    agent.yieldBlockedByKey = null;
    agent.rerouteAttempts = 0;
    agent.strollTargets = chosen;
    agent.strollDwells = dwells;
    agent.strollIndex = 0;

    const firstLeg = this.grid.findPath(exitPt.x, exitPt.z, chosen[0].x, chosen[0].z);
    agent.path = [exitPt, ...firstLeg];
    agent.pathIndex = 0;
    return true;
  }

  private beginReturnToSeat(agent: AgentRecord): void {
    if (this.coffeeReservedBy === agent.sessionKey) {
      this.coffeeReservedBy = null;
    }
    const exitPt = this.getSeatExitPoint(agent);
    agent.phase = 'walking_return';
    agent.phaseElapsedSec = 0;
    agent.yieldRemainingSec = 0;
    agent.yieldBlockedByKey = null;
    agent.rerouteAttempts = 0;
    if (this.grid) {
      agent.path = this.grid.findPath(agent.worldX, agent.worldZ, exitPt.x, exitPt.z);
    } else {
      agent.path = [exitPt];
    }
    agent.pathIndex = 0;
  }

  private repathActiveAgentAfterLayoutChange(agent: AgentRecord): void {
    if (!this.grid || !this.layout) return;
    if (!this.grid.isPointClear(agent.worldX, agent.worldZ, FURNITURE_MIN_CLEARANCE)) {
      const safe = this.grid.findNearestWalkableCell(agent.worldX, agent.worldZ);
      if (safe) {
        agent.worldX = this.grid.cellCenterX(safe.ix);
        agent.worldZ = this.grid.cellCenterZ(safe.iz);
      }
    }
    if (agent.phase === 'walking_to_coffee') {
      agent.path = this.grid.findPath(
        agent.worldX,
        agent.worldZ,
        this.layout.coffeeStation.interactX,
        this.layout.coffeeStation.interactZ
      );
      agent.pathIndex = 0;
    } else if (agent.phase === 'brewing_coffee' || agent.phase === 'drinking_coffee') {
      agent.worldX = this.layout.coffeeStation.interactX;
      agent.worldZ = this.layout.coffeeStation.interactZ;
      agent.yaw = this.layout.coffeeStation.facingYaw;
    } else if (agent.phase === 'strolling') {
      const target = agent.strollTargets[agent.strollIndex];
      if (target) {
        agent.path = this.grid.findPath(agent.worldX, agent.worldZ, target.x, target.z);
        agent.pathIndex = 0;
      } else {
        this.beginReturnToSeat(agent);
      }
    } else if (agent.phase === 'walking_return') {
      const exitPt = this.getSeatExitPoint(agent);
      agent.path = this.grid.findPath(agent.worldX, agent.worldZ, exitPt.x, exitPt.z);
      agent.pathIndex = 0;
    }
  }

  private stepActiveAgent(agent: AgentRecord, dtSec: number): void {
    agent.phaseElapsedSec += dtSec;

    if (agent.phase === 'standing_up') {
      const u = Math.min(1, agent.phaseElapsedSec / SIT_STAND_TRANSITION_SEC);
      const s = smoothstep01(u);
      agent.standBlend = s;
      agent.walkBlend = 0;
      // 起身同时顺着椅侧 +Z 方向平滑挪步出椅，避免腿部展开穿模椅面
      const seatX = agent.bayX + SEAT_LOCAL_X;
      const seatZ = agent.bayZ + SEAT_LOCAL_Z;
      const stepX = agent.bayX + SEAT_STEP_LOCAL_X;
      const stepZ = agent.bayZ + SEAT_STEP_LOCAL_Z;
      agent.worldX = seatX + (stepX - seatX) * s;
      agent.worldZ = seatZ + (stepZ - seatZ) * s;
      agent.yaw = stepAngleShortest(agent.yaw, 0, dtSec * TURN_RATE_RAD_PER_SEC);
      if (u >= 1) {
        agent.standBlend = 1;
        agent.phase = agent.goal === 'coffee' ? 'walking_to_coffee' : 'strolling';
        agent.phaseElapsedSec = 0;
      }
      return;
    }

    if (agent.phase === 'sitting_down') {
      const u = Math.min(1, agent.phaseElapsedSec / SIT_STAND_TRANSITION_SEC);
      const s = smoothstep01(u);
      agent.standBlend = 1 - s;
      agent.walkBlend = 0;
      const seatX = agent.bayX + SEAT_LOCAL_X;
      const seatZ = agent.bayZ + SEAT_LOCAL_Z;
      agent.worldX = agent.sitStartX + (seatX - agent.sitStartX) * s;
      agent.worldZ = agent.sitStartZ + (seatZ - agent.sitStartZ) * s;
      agent.yaw = stepAngleShortest(agent.yaw, SEAT_FACING_YAW, dtSec * TURN_RATE_RAD_PER_SEC * 1.2);
      if (u >= 0.45) {
        // 坐下前顺手将咖啡杯放回桌面
        agent.holdingCoffee = false;
      }
      if (u >= 1) {
        this.finishTripAndSeat(agent);
      }
      return;
    }

    if (agent.phase === 'brewing_coffee') {
      agent.standBlend = 1;
      agent.walkBlend = 0;
      if (this.layout) {
        agent.yaw = stepAngleShortest(
          agent.yaw,
          this.layout.coffeeStation.facingYaw,
          dtSec * TURN_RATE_RAD_PER_SEC
        );
      }
      // 前伸取杯到一半时方块杯出现在右手上
      if (agent.phaseElapsedSec >= COFFEE_BREW_SEC * 0.5) {
        agent.holdingCoffee = true;
      }
      if (agent.phaseElapsedSec >= COFFEE_BREW_SEC) {
        agent.holdingCoffee = true;
        agent.phase = 'drinking_coffee';
        agent.phaseElapsedSec = 0;
      }
      return;
    }

    if (agent.phase === 'drinking_coffee') {
      agent.standBlend = 1;
      agent.walkBlend = 0;
      agent.holdingCoffee = true;
      if (this.layout) {
        agent.yaw = stepAngleShortest(
          agent.yaw,
          this.layout.coffeeStation.facingYaw,
          dtSec * TURN_RATE_RAD_PER_SEC
        );
      }
      if (agent.phaseElapsedSec >= COFFEE_DRINK_SEC) {
        // 喝完两口，端着杯子慢慢走回工位
        this.beginReturnToSeat(agent);
      }
      return;
    }

    if (agent.phase === 'stroll_pause') {
      agent.standBlend = 1;
      agent.walkBlend = Math.max(0, agent.walkBlend - dtSec * 8);
      const strollElapsed = this.clockSec - agent.strollStartedClockSec;
      const forceReturnForCap = strollElapsed >= STROLL_DURATION_MAX_SEC - 10;
      if (agent.phaseElapsedSec >= agent.currentDwellDurationSec || forceReturnForCap) {
        agent.strollIndex += 1;
        if (!forceReturnForCap && agent.strollIndex < agent.strollTargets.length && this.grid) {
          const nextTarget = agent.strollTargets[agent.strollIndex];
          agent.path = this.grid.findPath(agent.worldX, agent.worldZ, nextTarget.x, nextTarget.z);
          agent.pathIndex = 0;
          agent.phase = 'strolling';
          agent.phaseElapsedSec = 0;
        } else {
          this.beginReturnToSeat(agent);
        }
      }
      return;
    }

    // 行走阶段（walking_to_coffee / strolling / walking_return）
    this.stepWalkingAgent(agent, dtSec);
  }

  private stepWalkingAgent(agent: AgentRecord, dtSec: number): void {
    agent.standBlend = 1;

    // 路径冲突让行计时（1~2 秒）
    if (agent.yieldRemainingSec > 0) {
      agent.yieldRemainingSec = Math.max(0, agent.yieldRemainingSec - dtSec);
      agent.walkBlend = Math.max(0, agent.walkBlend - dtSec * 8);
      if (agent.yieldRemainingSec === 0 && agent.yieldBlockedByKey && this.grid) {
        const blocker = this.agents.get(agent.yieldBlockedByKey);
        agent.yieldBlockedByKey = null;
        if (
          blocker
          && blocker.phase !== 'seated'
          && Math.hypot(blocker.worldX - agent.worldX, blocker.worldZ - agent.worldZ) < CHARACTER_YIELD_DISTANCE * 1.15
          && agent.rerouteAttempts < 2
        ) {
          agent.rerouteAttempts += 1;
          const dest = agent.path[agent.path.length - 1];
          if (dest) {
            agent.path = this.grid.findPath(
              agent.worldX,
              agent.worldZ,
              dest.x,
              dest.z,
              { x: blocker.worldX, z: blocker.worldZ }
            );
            agent.pathIndex = 0;
          }
        }
      }
      return;
    }

    while (agent.pathIndex < agent.path.length) {
      const wp = agent.path[agent.pathIndex];
      const dx = wp.x - agent.worldX;
      const dz = wp.z - agent.worldZ;
      if (Math.hypot(dx, dz) <= 0.05) {
        agent.worldX = wp.x;
        agent.worldZ = wp.z;
        agent.pathIndex += 1;
      } else {
        break;
      }
    }

    if (agent.pathIndex >= agent.path.length) {
      this.onPathCompleted(agent);
      return;
    }

    const wp = agent.path[agent.pathIndex];
    const dx = wp.x - agent.worldX;
    const dz = wp.z - agent.worldZ;
    const dist = Math.hypot(dx, dz);
    const dirX = dx / Math.max(1e-6, dist);
    const dirZ = dz / Math.max(1e-6, dist);
    const speed = agent.holdingCoffee ? COFFEE_RETURN_WALK_SPEED : NORMAL_WALK_SPEED;
    const stepLen = Math.min(dist, speed * dtSec);
    const candX = agent.worldX + dirX * stepLen;
    const candZ = agent.worldZ + dirZ * stepLen;

    // 角色间距检测与后到者礼让（保证最小间距 >= 0.35 world unit）
    for (const other of this.agents.values()) {
      if (other.sessionKey === agent.sessionKey || other.phase === 'seated') continue;
      const curDist = Math.hypot(other.worldX - agent.worldX, other.worldZ - agent.worldZ);
      const nextDist = Math.hypot(other.worldX - candX, other.worldZ - candZ);

      // 硬间距兜底：禁止靠近至 0.38 以内（严格 >= 0.35）
      const violatesHardSpacing = nextDist < CHARACTER_HARD_SPACING && nextDist < curDist;
      const approachingConflict = nextDist < CHARACTER_YIELD_DISTANCE && nextDist < curDist - 1e-4;
      if (!violatesHardSpacing && !approachingConflict) continue;

      const otherIsStationary =
        other.phase === 'brewing_coffee'
        || other.phase === 'drinking_coffee'
        || other.phase === 'stroll_pause'
        || other.phase === 'standing_up'
        || other.phase === 'sitting_down';
      const selfIsLaterArriver = agent.departOrder > other.departOrder;

      if (violatesHardSpacing || otherIsStationary || selfIsLaterArriver) {
        agent.yieldRemainingSec = 1.0 + nextSeededUnit(agent.rng) * 1.0; // 1.0..2.0 秒
        agent.yieldBlockedByKey = other.sessionKey;
        agent.walkBlend = Math.max(0, agent.walkBlend - dtSec * 8);
        return;
      }
    }

    agent.worldX = candX;
    agent.worldZ = candZ;
    agent.rerouteAttempts = 0;

    // 朝向沿最短角平滑插值到移动方向
    const targetYaw = Math.atan2(dirX, dirZ);
    agent.yaw = stepAngleShortest(agent.yaw, targetYaw, dtSec * TURN_RATE_RAD_PER_SEC);
    agent.walkBlend = Math.min(1, agent.walkBlend + dtSec * 10);
    agent.walkPhase = (agent.walkPhase + stepLen * 5.6) % (Math.PI * 2);
  }

  private onPathCompleted(agent: AgentRecord): void {
    agent.walkBlend = 0;
    if (agent.phase === 'walking_to_coffee') {
      agent.phase = 'brewing_coffee';
      agent.phaseElapsedSec = 0;
      return;
    }
    if (agent.phase === 'strolling') {
      agent.phase = 'stroll_pause';
      agent.phaseElapsedSec = 0;
      agent.currentDwellDurationSec = agent.strollDwells[agent.strollIndex] ?? 5.0;
      return;
    }
    if (agent.phase === 'walking_return') {
      agent.sitStartX = agent.worldX;
      agent.sitStartZ = agent.worldZ;
      agent.phase = 'sitting_down';
      agent.phaseElapsedSec = 0;
    }
  }

  private finishTripAndSeat(agent: AgentRecord): void {
    if (this.coffeeReservedBy === agent.sessionKey) {
      this.coffeeReservedBy = null;
    }
    if (agent.goal === 'coffee') {
      agent.lastCoffeeEndClockSec = this.clockSec;
      agent.nextCoffeeCooldownSec = COFFEE_COOLDOWN_MIN_SEC + nextSeededUnit(agent.rng) * 15.0;
      agent.nextCoffeeTriggerSec = COFFEE_RUNNING_MIN_SEC + nextSeededUnit(agent.rng) * 5.0;
    } else if (agent.goal === 'stroll') {
      agent.lastStrollEndClockSec = this.clockSec;
      agent.nextStrollCooldownSec = 24.0 + nextSeededUnit(agent.rng) * 16.0;
      agent.nextStrollTriggerSec = STROLL_IDLE_MIN_SEC + nextSeededUnit(agent.rng) * 5.0;
    }
    agent.runningSeatedSec = 0;
    agent.idleSeatedSec = 0;
    this.snapAgentToSeat(agent);
  }

  private snapAgentToSeat(agent: AgentRecord): void {
    if (this.coffeeReservedBy === agent.sessionKey) {
      this.coffeeReservedBy = null;
    }
    agent.phase = 'seated';
    agent.goal = 'none';
    agent.phaseElapsedSec = 0;
    agent.worldX = agent.bayX + SEAT_LOCAL_X;
    agent.worldZ = agent.bayZ + SEAT_LOCAL_Z;
    agent.yaw = SEAT_FACING_YAW;
    agent.standBlend = 0;
    agent.walkBlend = 0;
    agent.walkPhase = 0;
    agent.holdingCoffee = false;
    agent.path = [];
    agent.pathIndex = 0;
    agent.strollTargets = [];
    agent.strollDwells = [];
    agent.strollIndex = 0;
    agent.yieldRemainingSec = 0;
    agent.yieldBlockedByKey = null;
    agent.rerouteAttempts = 0;
    this.syncPoseOutput(agent);
  }

  private syncPoseOutput(agent: AgentRecord): void {
    const out = agent.poseOut;
    out.phase = agent.phase;
    out.goal = agent.goal;
    out.worldX = agent.worldX;
    out.worldZ = agent.worldZ;
    out.yaw = agent.yaw;
    out.standBlend = agent.standBlend;
    out.walkBlend = agent.walkBlend;
    out.walkPhase = agent.walkPhase;
    out.holdingCoffee = agent.holdingCoffee;
    out.isYielding = agent.yieldRemainingSec > 0;
    if (agent.phase === 'brewing_coffee') {
      out.actionProgress = Math.min(1, agent.phaseElapsedSec / COFFEE_BREW_SEC);
    } else if (agent.phase === 'drinking_coffee') {
      out.actionProgress = Math.min(1, agent.phaseElapsedSec / COFFEE_DRINK_SEC);
    } else if (agent.phase === 'standing_up' || agent.phase === 'sitting_down') {
      out.actionProgress = Math.min(1, agent.phaseElapsedSec / SIT_STAND_TRANSITION_SEC);
    } else if (agent.phase === 'stroll_pause') {
      out.actionProgress = Math.min(
        1,
        agent.phaseElapsedSec / Math.max(0.1, agent.currentDwellDurationSec)
      );
    } else {
      out.actionProgress = 0;
    }
  }
}
