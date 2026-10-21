import type { ProviderConfigSchema, ProviderConfigSchemaField } from '@/types';
import {
  buildProviderConfigOutline,
  describeFieldCompatibility,
  findProviderConfigSchemaField
} from './provider-config-outline';
// 「参数解读」的行模型：只描述当前配置文件里**真实出现**的键。
//
// 与编辑器里的字段目录不同，这里不列 schema 全量字段 —— 用户在配置文件里看到的每一个键
// 都能在左侧找到对应解读，没写的字段不占位置。问题项（未收录 / 已弃用 / 当前版本不支持）
// 跟正常项分开标记，供界面用告警色高亮。

export type ProviderConfigReferenceIssue = 'none' | 'unknown' | 'deprecated' | 'unsupported';

export interface ProviderConfigReferenceRow {
  path: string;
  line: number;
  field: ProviderConfigSchemaField | null;
  issue: ProviderConfigReferenceIssue;
  messages: string[];
}

export const REFERENCE_ISSUE_LABELS: Record<Exclude<ProviderConfigReferenceIssue, 'none'>, string> = {
  unknown: '未收录',
  deprecated: '已弃用',
  unsupported: '当前版本不支持'
};

export const REFERENCE_TYPE_LABELS: Record<string, string> = {
  string: '字符串',
  number: '数字',
  integer: '整数',
  boolean: '布尔',
  array: '数组',
  object: '对象',
  enum: '枚举'
};

export function describeReferenceIssue(
  field: ProviderConfigSchemaField | null,
  cliVersion: string
): { issue: ProviderConfigReferenceIssue; messages: string[] } {
  if (!field) {
    return {
      issue: 'unknown',
      messages: ['离线字段快照没有收录这个键。它仍会按原样保存，但含义以官方文档为准。']
    };
  }
  const compatibility = describeFieldCompatibility(field, cliVersion);
  if (compatibility.state === 'unsupported') {
    return { issue: 'unsupported', messages: compatibility.messages };
  }
  if (compatibility.state === 'deprecated' || field.deprecated) {
    return {
      issue: 'deprecated',
      messages: compatibility.messages.length ? compatibility.messages : ['该配置已被标记为弃用。']
    };
  }
  return { issue: 'none', messages: [] };
}

function isPlaceholderSegment(segment: string): boolean {
  return /^<[^>]+>$/.test(segment) || segment === '*';
}

function matchPlaceholderPath(
  schemaSegments: string[],
  actualSegments: string[],
  schemaIndex: number,
  actualIndex: number
): number | null {
  if (schemaIndex === schemaSegments.length) {
    return actualIndex === actualSegments.length ? 0 : null;
  }
  const segment = schemaSegments[schemaIndex];
  const remainingSchema = schemaSegments.length - schemaIndex - 1;
  if (isPlaceholderSegment(segment)) {
    // `<id>` / `<path>` 这类占位符通常只吃一个层级；TOML 的引号键里带点号时
    // 一个逻辑层级会被拆成多段，所以允许它多吃几段，但要给后面的段留够位置。
    const maxTake = actualSegments.length - actualIndex - remainingSchema;
    for (let take = 1; take <= maxTake; take += 1) {
      const rest = matchPlaceholderPath(schemaSegments, actualSegments, schemaIndex + 1, actualIndex + take);
      if (rest !== null) return rest - (take - 1);
    }
    return null;
  }
  if (actualSegments[actualIndex] !== segment) return null;
  return matchPlaceholderPath(schemaSegments, actualSegments, schemaIndex + 1, actualIndex + 1);
}

/**
 * 字段查找：先走与后端一致的「精确 → 逐级回退父路径」，失败后再按 schema 里的
 * `<id>` / `<path>` 占位符匹配。
 *
 * 为什么需要第二段：真实配置里 `model_providers.aih_server.name`、
 * `projects."/Users/x".trust_level` 这类键在 schema 里写作 `model_providers.<id>.name` /
 * `projects.<path>.trust_level`，精确匹配必然落空。没有它，几乎每个真实配置文件都会被
 * 整片标成「未收录」，参数解读也就失去意义。
 */
export function findReferenceField(
  fields: ProviderConfigSchemaField[] | undefined,
  keyPath: string
): ProviderConfigSchemaField | null {
  if (!fields || !fields.length || !keyPath) return null;
  const direct = findProviderConfigSchemaField(fields, keyPath);
  if (direct) return direct;
  const actualSegments = String(keyPath).split('.').filter(Boolean);
  if (!actualSegments.length) return null;
  let best: { field: ProviderConfigSchemaField; score: number } | null = null;
  fields.forEach((field) => {
    const schemaSegments = String(field.path || '').split('.').filter(Boolean);
    if (!schemaSegments.length) return;
    if (!schemaSegments.some(isPlaceholderSegment)) return;
    const penalty = matchPlaceholderPath(schemaSegments, actualSegments, 0, 0);
    if (penalty === null) return;
    const literals = schemaSegments.filter((segment) => !isPlaceholderSegment(segment)).length;
    const score = literals * 100 - penalty;
    if (!best || score > best.score) best = { field, score };
  });
  return best ? best.field : null;
}

/** 从配置文件内容里抽出「出现过的键」，按文件顺序去重。 */export function buildProviderConfigReferenceRows(
  schema: ProviderConfigSchema | null,
  content: string,
  format: string,
  cliVersion: string
): ProviderConfigReferenceRow[] {
  const outline = buildProviderConfigOutline(content, format);
  const seen = new Set<string>();
  const rows: ProviderConfigReferenceRow[] = [];
  outline.forEach((entry) => {
    if (!entry.path || seen.has(entry.path)) return;
    seen.add(entry.path);
    const field = findReferenceField(schema?.fields, entry.path);
    const { issue, messages } = describeReferenceIssue(field, cliVersion);
    rows.push({ path: entry.path, line: entry.line, field, issue, messages });
  });
  return rows;
}

export function countReferenceIssues(rows: ProviderConfigReferenceRow[]): number {
  return rows.filter((row) => row.issue === 'deprecated' || row.issue === 'unsupported').length;
}

/** 「未收录」单独计数：它不是错误，只是离线快照还没覆盖这个键。 */
export function countUnrecordedKeys(rows: ProviderConfigReferenceRow[]): number {
  return rows.filter((row) => row.issue === 'unknown').length;
}

/** 搜索按「键路径 + 字段说明」过滤，保持文件顺序。 */
export function filterReferenceRows(
  rows: ProviderConfigReferenceRow[],
  keyword: string
): ProviderConfigReferenceRow[] {
  const needle = keyword.trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter((row) => `${row.path} ${row.field?.description || ''}`.toLowerCase().includes(needle));
}
