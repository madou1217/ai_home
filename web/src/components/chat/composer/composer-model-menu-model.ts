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
 * 目录里是否含 OpenCode 命名空间模型：只有这种目录才显示免费/Zen/Go 芯片与分组，
 * 其他 Provider（claude / codex / …）保持单一「全部模型」分组，不引入空分组。
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
 * 分组标题渲染用：非 OpenCode 目录只返回一个「全部模型」组（保持服务端顺序）；
 * OpenCode 目录按 免费 → Zen → Go → 其他 分组，组内保持服务端顺序（不重排，
 * 免得和模型页的顺序打架）。
 */
export function buildComposerModelGroups(
  models: readonly ComposerModelEntry[],
  filters: { readonly query: string; readonly chip: ComposerModelChip },
): readonly ComposerModelGroup[] {
  const filtered = filterComposerModels(models, filters);
  if (!isOpenCodeModelCatalog(models)) {
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
