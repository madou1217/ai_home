// 「启动权限」Tab 的纯逻辑：把服务端下发的权限目录翻译成可渲染的分组、选中态、
// 互斥禁用集合与提示文案。
//
// 这里是前端唯一理解「权限参数怎么拼」的地方，页面只做渲染与回调；
// 互斥规则本身仍然只来自服务端目录（`permissionCatalog.conflicts`），
// 前端不维护任何 provider 名单，也不自己判断哪些旗标互斥。

import type {
  ToolPermissionCatalog,
  ToolPermissionConflict,
  ToolPermissionFlagEntry,
  ToolPermissionOverride
} from '@/types';

/** 选中一项权限参数：值为空表示无值开关（`none`）或需要用户手填（`list`/未枚举）。 */
export interface PermissionSelection {
  flag: string;
  value: string;
}

export interface PermissionGroupView {
  key: string;
  label: string;
  entries: ToolPermissionFlagEntry[];
}

const GROUP_ORDER = ['bypass', 'approval', 'sandbox', 'allow', 'deny', 'policy'];

/** 按服务端声明顺序分组；未登记到顺序表的分组排在最后，不丢条目。 */
export function groupPermissionFlags(catalog: ToolPermissionCatalog | null): PermissionGroupView[] {
  const flags = catalog?.flags || [];
  const groups = catalog?.groups || {};
  const buckets = new Map<string, ToolPermissionFlagEntry[]>();
  for (const entry of flags) {
    const key = entry.group || 'other';
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(entry);
  }
  const keys = [...buckets.keys()].sort((left, right) => {
    const leftIndex = GROUP_ORDER.indexOf(left);
    const rightIndex = GROUP_ORDER.indexOf(right);
    if (leftIndex === -1 && rightIndex === -1) return left.localeCompare(right);
    if (leftIndex === -1) return 1;
    if (rightIndex === -1) return -1;
    return leftIndex - rightIndex;
  });
  return keys.map((key) => ({
    key,
    label: groups[key] || key,
    entries: buckets.get(key) || []
  }));
}

export function findFlagEntry(
  catalog: ToolPermissionCatalog | null,
  flag: string
): ToolPermissionFlagEntry | null {
  const list = catalog?.flags || [];
  const normalized = String(flag || '').trim();
  return list.find((entry) => entry.flag === normalized
    || (entry.aliases || []).includes(normalized)) || null;
}

/** 该旗标是否需要单独给值（`value` / `list`）。 */
export function flagTakesValue(entry: ToolPermissionFlagEntry | null): boolean {
  if (!entry) return false;
  return entry.value === 'value' || entry.value === 'list';
}

/**
 * 把落盘的 argv token 还原成选择列表。
 *
 * 只认目录里登记过的旗标：用户手写的别名（`-s`）归一成规范名（`--sandbox`），
 * 未知 token 直接丢弃——它们不属于「启动权限」这一层，写回时会污染启动参数。
 */
export function parsePermissionArgs(
  catalog: ToolPermissionCatalog | null,
  args: string[] | null | undefined
): PermissionSelection[] {
  const list = Array.isArray(args) ? args : [];
  const selections: PermissionSelection[] = [];
  for (let index = 0; index < list.length; index += 1) {
    const token = String(list[index] ?? '');
    if (!token.startsWith('-')) continue;
    const eqIndex = token.indexOf('=');
    const name = eqIndex > 0 ? token.slice(0, eqIndex) : token;
    const entry = findFlagEntry(catalog, name);
    if (!entry) continue;
    if (entry.value === 'none') {
      selections.push({ flag: entry.flag, value: '' });
      continue;
    }
    if (eqIndex > 0) {
      selections.push({ flag: entry.flag, value: token.slice(eqIndex + 1) });
      continue;
    }
    const next = list[index + 1];
    if (next !== undefined && next !== null && !String(next).startsWith('-')) {
      selections.push({ flag: entry.flag, value: String(next) });
      index += 1;
    } else {
      selections.push({ flag: entry.flag, value: '' });
    }
  }
  return selections;
}

/** 选择列表 → 启动参数 token（按目录声明顺序输出，保证结果稳定）。 */
export function serializePermissionArgs(
  catalog: ToolPermissionCatalog | null,
  selections: PermissionSelection[]
): string[] {
  const order = (catalog?.flags || []).map((entry) => entry.flag);
  const picked = new Map<string, string>();
  for (const selection of selections) {
    if (!selection || !selection.flag) continue;
    picked.set(selection.flag, selection.value ?? '');
  }
  const tokens: string[] = [];
  for (const flag of order) {
    if (!picked.has(flag)) continue;
    const value = picked.get(flag) || '';
    tokens.push(flag);
    if (value) tokens.push(value);
  }
  return tokens;
}

function flagSet(selections: PermissionSelection[]): Set<string> {
  const set = new Set<string>();
  for (const selection of selections) {
    if (selection && selection.flag) set.add(selection.flag);
  }
  return set;
}

/** 已经选中的互斥对（正常流程里不会出现；服务端拒绝后仍要能提示）。 */
export function findSelectionConflicts(
  catalog: ToolPermissionCatalog | null,
  selections: PermissionSelection[]
): ToolPermissionConflict[] {
  const selected = flagSet(selections);
  return (catalog?.conflicts || []).filter((rule) => selected.has(rule.a) && selected.has(rule.b));
}

export function findSelectionOverrides(
  catalog: ToolPermissionCatalog | null,
  selections: PermissionSelection[]
): ToolPermissionOverride[] {
  const selected = flagSet(selections);
  return (catalog?.overrides || []).filter((rule) => selected.has(rule.by) && selected.has(rule.over));
}

/**
 * 在当前选中态下被禁用的旗标：与任一已选项互斥的都禁掉。
 *
 * 这样「选 --a 就不能选 --b，反之亦然」自动成立（先选的留着，后选的禁用），
 * 而禁用集合完全由服务端目录推导，不新增任何前端规则。
 */
export function disabledFlags(
  catalog: ToolPermissionCatalog | null,
  selections: PermissionSelection[]
): Set<string> {
  const selected = flagSet(selections);
  const disabled = new Set<string>();
  for (const rule of catalog?.conflicts || []) {
    if (selected.has(rule.a) && selected.has(rule.b)) continue;
    if (selected.has(rule.a)) disabled.add(rule.b);
    if (selected.has(rule.b)) disabled.add(rule.a);
  }
  return disabled;
}

/** 追加/替换一项选择；同旗标重复选中时保留一个。 */
export function upsertSelection(
  selections: PermissionSelection[],
  flag: string,
  value: string
): PermissionSelection[] {
  const next = selections.filter((item) => item.flag !== flag);
  next.push({ flag, value });
  return next;
}

export function removeSelection(
  selections: PermissionSelection[],
  flag: string
): PermissionSelection[] {
  return selections.filter((item) => item.flag !== flag);
}

/** 该旗标对应的取值输入方式：有枚举就给下拉，否则给自由输入。 */
export function flagValueOptions(entry: ToolPermissionFlagEntry | null): {
  options: string[];
  freeform: boolean;
} {
  if (!flagTakesValue(entry)) return { options: [], freeform: false };
  const options = entry?.options || [];
  return { options, freeform: options.length === 0 };
}

/** 折叠展示用的单行命令预览，例如 `codex -s danger-full-access -a never`。 */
export function describeSelectionCommand(
  executable: string,
  selections: PermissionSelection[]
): string {
  const tokens: string[] = [];
  for (const selection of selections) {
    tokens.push(selection.flag);
    if (selection.value) tokens.push(selection.value);
  }
  return [executable || 'cli', ...tokens].join(' ').trim();
}

/** 目录里是否声明了「这些子命令不接受权限覆盖」（如 codex resume/fork）。 */
export function blockingSubcommands(catalog: ToolPermissionCatalog | null): string[] {
  return catalog?.subcommandsBlockingPermissionOverrides || [];
}
