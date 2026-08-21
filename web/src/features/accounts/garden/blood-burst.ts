import { stableGardenRandom, stableGardenRange } from './stable-random';

/** 一次爆开最少/最多溅出多少滴。 */
export const BLOOD_MIN_DROPLETS = 5;
export const BLOOD_MAX_DROPLETS = 16;
/** 溅射的最长存活时间（ms）；越大的一口飞得越久。 */
export const BLOOD_MIN_LIFE_MS = 420;
export const BLOOD_MAX_LIFE_MS = 900;

export interface BloodDroplet {
  id: string;
  /** 水平漂移（px，带正负）。 */
  driftPx: number;
  /** 上抛的最高点（px，正数向上）。 */
  risePx: number;
  /** 最终落到起点下方多少 px。自由落体，所以总是往下收。 */
  fallPx: number;
  sizePx: number;
  /** 血滴被拉长的比例：飞得快的更细长。 */
  stretch: number;
  spinDeg: number;
  delayMs: number;
  lifeMs: number;
  /** 明度不同，一团血才有层次。 */
  color: string;
}

/**
 * 一次咬合溅出来的血。
 *
 * 每滴都按 (账号, 事件, 序号) 取值，所以同一次伤害重渲染时长一个样，不同伤害
 * 之间又互不相同——不会每次爆开都是同一张图。数量跟着这一口的大小走：吃掉
 * 的 token 越多，溅得越多、飞得越久。
 *
 * 物理上只做一件事：所有血滴都被同一个重力拉回来。上抛越高的落得越远，水平
 * 漂移与竖直运动互不干扰。
 */
export function buildBloodBurst(
  accountRef: string,
  dropId: string,
  deltaTokens: number
): BloodDroplet[] {
  const magnitude = Math.max(0, Number(deltaTokens) || 0);
  // 用量跨好几个数量级，取对数才不会让大额度一口气刷屏。
  const weight = Math.min(1, Math.log10(magnitude + 10) / 6);
  // 上下界都跟着量走，大额那一口才明显比小额溅得多，而不是"上限更高但常常取到低值"。
  const span = BLOOD_MAX_DROPLETS - BLOOD_MIN_DROPLETS;
  const count = Math.round(
    stableGardenRange(
      BLOOD_MIN_DROPLETS + span * weight * 0.55,
      BLOOD_MIN_DROPLETS + span * weight,
      accountRef,
      dropId,
      'blood-count'
    )
  );

  return Array.from({ length: Math.max(BLOOD_MIN_DROPLETS, count) }, (_value, index) => {
    const seed = [accountRef, dropId, index] as const;
    // 向上的扇形：大部分朝斜上方飞，少数几乎垂直。
    const angleDeg = stableGardenRange(-158, -22, ...seed, 'blood-angle');
    /*
     * 咬合那一刻头被放大到近 3 倍（直径 70px 上下）。溅射必须飞得出这颗头，
     * 否则整团血都落在头的范围里——画了等于没画。
     */
    const speed = stableGardenRange(78, 210, ...seed, 'blood-speed') * (0.62 + weight * 0.7);
    const angle = (angleDeg * Math.PI) / 180;
    const lifeMs = Math.round(stableGardenRange(
      BLOOD_MIN_LIFE_MS,
      BLOOD_MAX_LIFE_MS,
      ...seed,
      'blood-life'
    ));
    const seconds = lifeMs / 1000;
    const risePx = Math.max(6, Math.abs(Math.sin(angle)) * speed * 0.6);
    // 自由落体：落差由重力和存活时间决定，所以飞得久的一定落得更深。
    const fallPx = Math.max(4, 380 * seconds * seconds - risePx * 0.4);

    return {
      id: `${dropId}-blood-${index}`,
      driftPx: Number((Math.cos(angle) * speed * seconds).toFixed(2)),
      risePx: Number(risePx.toFixed(2)),
      fallPx: Number(fallPx.toFixed(2)),
      sizePx: Number(stableGardenRange(1.6, 4.4, ...seed, 'blood-size').toFixed(2)),
      stretch: Number(stableGardenRange(1.1, 2.3, ...seed, 'blood-stretch').toFixed(2)),
      spinDeg: Math.round(stableGardenRange(-90, 90, ...seed, 'blood-spin')),
      // 溅射不是同时发生的：几毫秒的错峰就足以让它看起来是炸开而不是排队出场。
      delayMs: Math.round(stableGardenRandom(...seed, 'blood-delay') * 90),
      lifeMs,
      // 比头深得多：同色系的血溅在头上就是看不见的。
      color: stableGardenRandom(...seed, 'blood-shade') > 0.68
        ? 'hsl(354 82% 34%)'
        : 'hsl(356 74% 21%)'
    };
  });
}
