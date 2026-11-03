import { modelMatchesGroup, type ModelGroupFilter } from '@/features/models/account-models';

/**
 * 聊天输入框模型选择器的纯数据层：分组、筛选、搜索。
 *
 * 模型目录可能上百条（opencode 账号 123 条），一个平铺列表既找不到也没法筛。
 * 这里把「怎么分组、怎么筛」从渲染层抽出来，渲染层只负责画。
 *
 * 两种视角刻意分开：
 * - **筛选芯片**沿用模型页的语义（`modelMatchesGroup`）：`free` = 以 `-free` 结尾、
 *   `zen` = `opencode/*`、`go` = `opencode-go/*`，彼此**可重叠**（免费模型同时属于 zen/go）。
 * - **分组标题**必须互斥，否则同一个模型会出现两次；因此先按「免费 → Zen → Go → 其他」
 *   取唯一归属，免费优先。
 */

export interface ComposerModelEntry {
  readonly id: string;
  readonly label: string;
}

export interface ComposerModelGroup {
  readonly id: string;
  readonly label: string;
  readonly models: readonly ComposerModelEntry[];
}

export type ComposerModelChip = Extract<ModelGroupFilter, 'all' | 'free' | 'zen' | 'go'>;

export const COMPOSER_MODEL_CHIPS: readonly { readonly id: ComposerModelChip; readonly label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'free', label: '免费' },
  { id: 'zen', label: 'Zen' },
  { id: 'go', label: 'Go' },
];

/** 单一归属（互斥）：免费 → Zen → Go → 其他。 */
export function composerModelBucketOf(id: string): 'free' | 'zen' | 'go' | 'other' {
  const value = String(id || '');
  if (value.endsWith('-free')) return 'free';
  if (value.startsWith('opencode-go/')) return 'go';
  if (value.startsWith('opencode/')) return 'zen';
  return 'other';
}

const BUCKET_LABELS: Readonly<Record<'free' | 'zen' | 'go' | 'other', string>> = {
  free: '免费模型',
  zen: 'OpenCode Zen',
  go: 'OpenCode Go',
  other: '其他模型',
};

const BUCKET_ORDER: readonly ('free' | 'zen' | 'go' | 'other')[] = ['free', 'zen', 'go', 'other'];

/**
 * 目录里是否含 OpenCode 命名空间模型。
 *
 * **不要用它决定分组**：aih-server 是全量网关目录，必然含 opencode 模型，按内容判断
 * 会给跨 provider 目标套上 OpenCode 专属分组（2026-10-21 真机反馈）。分组该由调用方
 * 按**选中的目标**声明（见 ComposerModelMenu 的 openCodeCatalog prop）。保留此函数只
 * 用于「这个目录里有没有 opencode 模型」这类事实判断。
 */
export function isOpenCodeModelCatalog(models: readonly ComposerModelEntry[]): boolean {
  return models.some((model) => {
    const id = String(model && model.id || '');
    return id.startsWith('opencode/') || id.startsWith('opencode-go/') || id.endsWith('-free');
  });
}

export function filterComposerModels(
  models: readonly ComposerModelEntry[],
  filters: { readonly query: string; readonly chip: ComposerModelChip },
): readonly ComposerModelEntry[] {
  const query = String(filters.query || '').trim().toLowerCase();
  return models.filter((model) => {
    if (filters.chip !== 'all' && !modelMatchesGroup({ id: model.id }, filters.chip)) return false;
    if (!query) return true;
    return String(model.id || '').toLowerCase().includes(query)
      || String(model.label || '').toLowerCase().includes(query);
  });
}

/**
 * 分组标题渲染用。
 *
 * @param filters.openCodeCatalog **必需**：当前目标是不是 OpenCode 目录。true 时按
 *   免费 → Zen → Go → 其他分组并显示芯片；false 时只返回一个「全部模型」组。
 *   刻意不做成可选，避免调用方漏传后又被目录内容兜底回错误行为。
 */
export function buildComposerModelGroups(
  models: readonly ComposerModelEntry[],
  filters: { readonly query: string; readonly chip: ComposerModelChip; readonly openCodeCatalog: boolean },
): readonly ComposerModelGroup[] {
  const filtered = filterComposerModels(models, filters);
  if (!filters.openCodeCatalog) {
    return filtered.length > 0 ? [{ id: 'all', label: '全部模型', models: filtered }] : [];
  }
  const buckets = new Map<string, ComposerModelEntry[]>();
  filtered.forEach((model) => {
    const bucket = composerModelBucketOf(model.id);
    const entries = buckets.get(bucket) || [];
    if (!buckets.has(bucket)) buckets.set(bucket, entries);
    entries.push(model);
  });
  return BUCKET_ORDER
    .filter((bucket) => (buckets.get(bucket) || []).length > 0)
    .map((bucket) => ({ id: bucket, label: BUCKET_LABELS[bucket], models: buckets.get(bucket) || [] }));
}
