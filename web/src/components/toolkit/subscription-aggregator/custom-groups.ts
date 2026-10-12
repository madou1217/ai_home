import { policyLabel, type PolicyContext } from './aggregator-presentation.ts';
import type {
  AggregatorCustomGroup,
  AggregatorDraftNode,
  AggregatorPolicy,
  AggregatorPresetInfo,
  AggregatorProfileInput
} from './types';

const GROUP_PREFIX = 'group:';

type Rules = AggregatorProfileInput['rules'];
type GroupRef = Pick<AggregatorCustomGroup, 'id' | 'name' | 'members'>;

/** 自建组的策略引用。 */
export function groupPolicy(groupId: string): AggregatorPolicy {
  return `${GROUP_PREFIX}${groupId}`;
}

function randomHex(bytes: number) {
  const values = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(values);
  return [...values].map((value) => value.toString(16).padStart(2, '0')).join('');
}

/** 新建组：id 与服务端同格式（grp_ + 8 位十六进制），名称取第一个没用过的「策略组 N」，默认延迟最低。 */
export function createCustomGroup(existing: Array<Pick<AggregatorCustomGroup, 'id' | 'name'>>, random = randomHex): AggregatorCustomGroup {
  const ids = new Set(existing.map((group) => group.id));
  const names = new Set(existing.map((group) => group.name));
  let id = `grp_${random(4)}`;
  while (ids.has(id)) id = `grp_${random(4)}`;
  let index = existing.length + 1;
  while (names.has(`策略组 ${index}`)) index += 1;
  return {
    id,
    name: `策略组 ${index}`,
    type: 'url-test',
    members: [],
    nodes: { include: '', exclude: '', names: [] },
    testUrl: '',
    interval: null,
    tolerance: 50
  };
}

/** 自建组名称的问题（与服务端校验一致：名称会出现在 Surge / Loon / QX 以逗号、等号分隔的行里）；没问题返回空串。 */
export function groupNameProblem(rawName: string, reservedNames: string[], groups: Array<Pick<AggregatorCustomGroup, 'name'> | undefined>) {
  const name = String(rawName || '').trim();
  if (!name) return '';
  const hasControl = [...name].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
  if (/[,=]/.test(name) || hasControl) return '名称不能包含逗号、等号或换行';
  if (reservedNames.includes(name)) return '和自动生成的策略组重名';
  if (groups.filter((group) => String(group?.name || '').trim() === name).length > 1) return '和其它策略组重名';
  return '';
}

/** 可以套用的自建组：排除自己，以及（间接）套用了自己的组——再套回来会成环。 */
export function memberCandidateGroups<T extends Pick<AggregatorCustomGroup, 'id' | 'members'>>(groups: T[], selfId: string): T[] {
  const byId = new Map(groups.map((group) => [group.id, group]));
  const reaches = (group: T, seen: Set<string>): boolean => {
    if (seen.has(group.id)) return false;
    seen.add(group.id);
    return group.members.some((member) => {
      if (!member.startsWith(GROUP_PREFIX)) return false;
      const id = member.slice(GROUP_PREFIX.length);
      const next = byId.get(id);
      return id === selfId || (next ? reaches(next, seen) : false);
    });
  };
  return groups.filter((group) => group.id !== selfId && !reaches(group, new Set()));
}

export interface GroupNodeMatch {
  /** 选入的节点（按节点列表顺序） */
  nodes: AggregatorDraftNode[];
  /** 勾选了、但当前节点列表里已经没有的名称（订阅更新或改名后消失） */
  missingNames: string[];
  /** 正则写错的字段 */
  invalid: '' | 'include' | 'exclude';
}

function compilePattern(pattern: string | undefined) {
  if (!pattern) return null;
  try {
    return new RegExp(pattern, 'i');
  } catch (_error) {
    return undefined;
  }
}

/** 与服务端规划同样的判断：勾选的或名称命中「选入」的节点，再去掉命中「排除」的。 */
export function matchGroupNodes(selection: Partial<AggregatorCustomGroup['nodes']> | undefined, nodes: AggregatorDraftNode[]): GroupNodeMatch {
  const include = compilePattern(selection?.include);
  const exclude = compilePattern(selection?.exclude);
  if (include === undefined) return { nodes: [], missingNames: [], invalid: 'include' };
  if (exclude === undefined) return { nodes: [], missingNames: [], invalid: 'exclude' };
  const picked = new Set(selection?.names || []);
  const available = new Set(nodes.map((node) => node.name));
  return {
    nodes: nodes.filter((node) => (picked.has(node.name) || Boolean(include?.test(node.name))) && !exclude?.test(node.name)),
    missingNames: [...picked].filter((name) => !available.has(name)),
    invalid: ''
  };
}

/** 勾选节点的下拉选项：按订阅源分组；已经不在节点列表里的勾选项单独列出，方便去掉。 */
export function buildNodeOptions(nodes: AggregatorDraftNode[], picked: string[] = []) {
  const bySource = new Map<string, Array<{ label: string; value: string }>>();
  for (const node of nodes) {
    if (!bySource.has(node.source)) bySource.set(node.source, []);
    bySource.get(node.source)?.push({ label: node.name, value: node.name });
  }
  const options = [...bySource].map(([source, list]) => ({ label: source, options: list }));
  const available = new Set(nodes.map((node) => node.name));
  const missing = picked.filter((name) => !available.has(name));
  if (missing.length) {
    options.push({ label: '已不在订阅里', options: missing.map((name) => ({ label: `${name}（已失效）`, value: name })) });
  }
  return options;
}

/**
 * 「套用策略组」的下拉选项：内置、可套用的自建组、地区（附节点数；没开启的地区分组会被跳过，
 * 标出来但不禁用——禁用后已选的标签就删不掉了）、开启按订阅源分组时的订阅源。
 */
export function buildMemberOptions(context: PolicyContext & {
  selfId: string;
  groups: GroupRef[];
  enabledRegions: string[];
  includeSources: boolean;
  nodes: AggregatorDraftNode[] | null;
}) {
  const option = (value: string, suffix = '') => ({ label: `${policyLabel(value, context)}${suffix}`, value });
  const options = [{ label: '内置', options: ['proxy', 'auto', 'direct', 'reject'].map((value) => option(value)) }];
  const candidates = memberCandidateGroups(context.groups, context.selfId);
  if (candidates.length) options.push({ label: '自建组', options: candidates.map((group) => option(groupPolicy(group.id))) });
  options.push({
    label: '地区',
    options: context.catalog.regions.map((region) => {
      if (!context.enabledRegions.includes(region.id)) return option(`region:${region.id}`, '（未开启这个地区分组）');
      const count = context.nodes ? context.nodes.filter((node) => node.region === region.id).length : null;
      return option(`region:${region.id}`, count === null ? '' : ` · ${count} 个节点`);
    })
  });
  if (context.includeSources && context.sources.length) {
    options.push({ label: '订阅源', options: context.sources.map((source) => option(`source:${source.id}`)) });
  }
  return options;
}

/** 删除组之前统计谁在用它。 */
export function countGroupReferences(groups: GroupRef[], rules: Rules, groupId: string) {
  const policy = groupPolicy(groupId);
  return {
    groups: groups.filter((group) => group.id !== groupId && group.members.includes(policy)).map((group) => group.name),
    presets: rules.presets.filter((preset) => preset.policy === policy).length,
    rules: rules.custom.filter((rule) => rule.policy === policy).length,
    final: rules.finalPolicy === policy
  };
}

/** 删除确认里的影响说明；没有引用返回空串。 */
export function describeGroupRemoval(references: ReturnType<typeof countGroupReferences>) {
  const parts: string[] = [];
  if (references.groups.length) parts.push(`从「${references.groups.join('」「')}」里去掉`);
  if (references.presets) parts.push(`${references.presets} 个规则组恢复默认策略`);
  const toProxy = [references.rules ? `${references.rules} 条自定义规则` : '', references.final ? '漏网之鱼' : ''].filter(Boolean);
  if (toProxy.length) parts.push(`${toProxy.join('和')}改走节点选择`);
  return parts.join('；');
}

/** 删除组之后的值：其它组不再套用它，规则组恢复目录默认策略，自定义规则与漏网之鱼改走节点选择。 */
export function removeGroupReferences<T extends GroupRef>(
  groups: T[],
  rules: Rules,
  groupId: string,
  presets: Array<Pick<AggregatorPresetInfo, 'id' | 'defaultPolicy'>>
): { groups: T[]; rules: Rules } {
  const policy = groupPolicy(groupId);
  const defaults = new Map(presets.map((preset) => [preset.id, preset.defaultPolicy]));
  return {
    groups: groups
      .filter((group) => group.id !== groupId)
      .map((group) => (group.members.includes(policy) ? { ...group, members: group.members.filter((member) => member !== policy) } : group)),
    rules: {
      ...rules,
      presets: rules.presets.map((preset) => (preset.policy === policy ? { ...preset, policy: defaults.get(preset.id) || 'proxy' } : preset)),
      custom: rules.custom.map((rule) => (rule.policy === policy ? { ...rule, policy: 'proxy' } : rule)),
      finalPolicy: rules.finalPolicy === policy ? 'proxy' : rules.finalPolicy
    }
  };
}

/** 「用于」里勾选规则组：选中的启用并默认走这个组，取消的恢复目录默认策略。 */
export function assignPresetsToGroup(
  presets: Rules['presets'],
  presetIds: string[],
  groupId: string,
  catalogPresets: Array<Pick<AggregatorPresetInfo, 'id' | 'defaultPolicy'>>
): Rules['presets'] {
  const policy = groupPolicy(groupId);
  const defaults = new Map(catalogPresets.map((preset) => [preset.id, preset.defaultPolicy]));
  return presets.map((preset) => {
    const selected = presetIds.includes(preset.id);
    if (selected && (preset.policy !== policy || !preset.enabled)) return { ...preset, enabled: true, policy };
    if (!selected && preset.policy === policy) return { ...preset, policy: defaults.get(preset.id) || 'proxy' };
    return preset;
  });
}

