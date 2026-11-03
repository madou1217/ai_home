/**
 * 时间戳安全格式化工具。
 *
 * 表格里直接 `dayjs(value).format(...)` 的写法只用 `if (!value)` 兜底,
 * 拦不住「truthy 但 dayjs 无法解析」的值（数字字符串、非 ISO 串、NaN 等），
 * 这类值会渲染成字面量 "Invalid Date"。本工具统一做有效性校验：
 * 仅当入参可归一为正有限毫秒数且 dayjs 判定有效时才返回格式化结果，否则返回 null。
 */
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import 'dayjs/locale/zh-cn';

// 自包含：不依赖调用方页面先 import 副作用，extend 幂等可重复调用。
dayjs.extend(relativeTime);

export function formatTimeCell(value?: unknown): { absolute: string; relative: string } | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = dayjs(n);
  if (!d.isValid()) return null;
  return {
    absolute: d.format('MM-DD HH:mm'),
    relative: d.fromNow()
  };
}
