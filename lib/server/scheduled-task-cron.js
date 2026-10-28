'use strict';

// **标准 5 段 cron 的解析 / 校验 / 下一次运行 / 中文解读**（唯一实现处）。
//
// 支持：`*`、`a`、`a-b`、`a-b/n`、`*/n`、`a,b,c`（段内可混用），字段顺序
// `分 时 日 月 周`；周 0/7 = 周日。**刻意不支持** `@daily`、秒字段、`?`、`L`、`W`、`#`
// —— 不认识的写法一律拒绝（`cron_invalid`），而不是猜一个近似语义。
//
// dom 与 dow 同时被限制时按 cron 惯例取**并集**（OR）；只限制一个时按交集语义（= 只按那个）。
// 下一次运行用**逐分钟前扫**（上限 `MAX_SCAN_DAYS` 天），保证结果与 cron 语义一致且可解释。

const FIELD_RANGES = Object.freeze([
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'dayOfMonth', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'dayOfWeek', min: 0, max: 6 }
]);
const MAX_SCAN_DAYS = 366;
const WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function pad2(value) {
  return String(value).padStart(2, '0');
}

function parseField(raw, range) {
  const text = String(raw || '').trim();
  if (!text) return null;
  const values = new Set();
  for (const part of text.split(',')) {
    const chunk = part.trim();
    if (!chunk) return null;
    let step = 1;
    let body = chunk;
    const slash = chunk.indexOf('/');
    if (slash >= 0) {
      body = chunk.slice(0, slash);
      const stepText = chunk.slice(slash + 1);
      if (!/^\d+$/.test(stepText)) return null;
      step = Number(stepText);
      if (step <= 0) return null;
    }
    let start;
    let end;
    if (body === '*') {
      start = range.min;
      end = range.max;
    } else if (body.includes('-')) {
      const [left, right] = body.split('-');
      if (!/^\d+$/.test(left) || !/^\d+$/.test(right)) return null;
      start = Number(left);
      end = Number(right);
    } else {
      if (!/^\d+$/.test(body)) return null;
      start = Number(body);
      end = slash >= 0 ? range.max : start;
    }
    // 周日的 7 归一化成 0（只对 dayOfWeek 生效）。
    if (range.name === 'dayOfWeek') {
      if (start === 7) start = 0;
      if (end === 7) end = 0;
    }
    if (start < range.min || start > range.max) return null;
    if (end < range.min || end > range.max) return null;
    if (end < start) return null;
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return values.size > 0 ? values : null;
}

/** 解析 5 段 cron；非法返回 null。 */
function parseCron(expression) {
  const text = String(expression || '').trim().replace(/\s+/g, ' ');
  if (!text) return null;
  const parts = text.split(' ');
  if (parts.length !== 5) return null;
  const parsed = {};
  for (let index = 0; index < FIELD_RANGES.length; index += 1) {
    const range = FIELD_RANGES[index];
    const values = parseField(parts[index], range);
    if (!values) return null;
    parsed[range.name] = values;
  }
  return {
    expression: text,
    minute: parsed.minute,
    hour: parsed.hour,
    dayOfMonth: parsed.dayOfMonth,
    month: parsed.month,
    dayOfWeek: parsed.dayOfWeek
  };
}

function isWildcard(field, range) {
  return field.size === range.max - range.min + 1;
}

function matchesCron(cron, date) {
  if (!cron.minute.has(date.getMinutes())) return false;
  if (!cron.hour.has(date.getHours())) return false;
  if (!cron.month.has(date.getMonth() + 1)) return false;
  const domRestricted = !isWildcard(cron.dayOfMonth, FIELD_RANGES[2]);
  const dowRestricted = !isWildcard(cron.dayOfWeek, FIELD_RANGES[4]);
  const domHit = cron.dayOfMonth.has(date.getDate());
  const dowHit = cron.dayOfWeek.has(date.getDay());
  if (domRestricted && dowRestricted) return domHit || dowHit;
  if (domRestricted) return domHit;
  if (dowRestricted) return dowHit;
  return true;
}

/** 下一次运行时间（毫秒）；找不到（366 天内不匹配）返回 0。 */
function nextCronRunAt(cron, fromMs) {
  if (!cron) return 0;
  const base = new Date(Number.isFinite(Number(fromMs)) ? Number(fromMs) : Date.now());
  // 从下一分钟整点开始找（当前这一分钟已经过去）。
  const cursor = new Date(base.getFullYear(), base.getMonth(), base.getDate(), base.getHours(), base.getMinutes() + 1, 0, 0);
  const limit = cursor.getTime() + MAX_SCAN_DAYS * 24 * 60 * 60 * 1000;
  while (cursor.getTime() <= limit) {
    if (matchesCron(cron, cursor)) return cursor.getTime();
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  return 0;
}

/** 中文解读（给界面直接展示，避免用户对着表达式猜）。 */
function describeCron(expression) {
  const cron = parseCron(expression);
  if (!cron) return '';
  const minutes = [...cron.minute].sort((a, b) => a - b);
  const hours = [...cron.hour].sort((a, b) => a - b);
  const pieces = [];
  const dowValues = [...cron.dayOfWeek].sort((a, b) => a - b);
  const domRestricted = !isWildcard(cron.dayOfMonth, FIELD_RANGES[2]);
  const monthRestricted = !isWildcard(cron.month, FIELD_RANGES[3]);
  const clock = (hour, minute) => `${pad2(hour)}:${pad2(minute)}`;

  if (hours.length === 1 && minutes.length === 1) {
    // `30 9 * * *` / `0 20 * * 1` 这类：直接说「每天 09:30」「每周一 20:00」。
    const times = [clock(hours[0], minutes[0])];
    if (dowValues.length > 0 && dowValues.length < 7) {
      pieces.push(`${dowValues.map((value) => WEEKDAY_NAMES[value] || `周${value}`).join('、')} ${times[0]}`);
    } else if (domRestricted) {
      pieces.push(`每月 ${[...cron.dayOfMonth].sort((a, b) => a - b).join('、')} 日 ${times[0]}`);
    } else {
      pieces.push(`每天 ${times[0]}`);
    }
  } else if (hours.length === 1) {
    pieces.push(`每天 ${clock(hours[0], 0).slice(0, 2)} 点的 ${minutes.join('、')} 分`);
  } else if (hours.length < 24) {
    pieces.push(`每天 ${hours.map((hour) => `${pad2(hour)}:${pad2(minutes[0] ?? 0)}`).join('、')}`);
  } else if (minutes.length === 1) {
    pieces.push(`每小时的第 ${minutes[0]} 分`);
  } else {
    pieces.push(`每小时的第 ${minutes.join('、')} 分`);
  }
  if (monthRestricted) pieces.push(`仅 ${[...cron.month].sort((a, b) => a - b).join('、')} 月`);
  return pieces.join(' · ');
}

module.exports = {
  MAX_SCAN_DAYS,
  WEEKDAY_NAMES,
  parseCron,
  matchesCron,
  nextCronRunAt,
  describeCron
};
