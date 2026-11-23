import type {
  NativeResourceKind,
  NativeResourceManagedRecord,
  NativeResourceReport
} from '@/types';

export interface NativeResourceGroup {
  key: string;
  kind: NativeResourceKind;
  id: string;
  description?: string;
  version?: string;
  records: NativeResourceManagedRecord[];
}

export interface NativeResourceOwnerOption {
  value: string;
  label: string;
}

export const RESOURCE_KINDS: NativeResourceKind[] = ['plugin', 'skill', 'mcp'];

export const KIND_LABELS: Record<NativeResourceKind, string> = {
  plugin: '插件',
  skill: 'Skill',
  mcp: 'MCP'
};

export function resourceOwner(record: NativeResourceManagedRecord): string {
  return record.host ? `宿主 ${record.host}` : record.provider || '未标注';
}

export function resourceKey(record: NativeResourceManagedRecord): string {
  return `${record.host ? `host/${record.host}` : record.provider}:${record.kind}:${record.id}`;
}

export function groupNativeResources(report: NativeResourceReport | null): NativeResourceGroup[] {
  if (!report) return [];
  const groups = new Map<string, NativeResourceGroup>();
  for (const kind of RESOURCE_KINDS) {
    for (const record of report.managed?.[kind] || []) {
      if (record.removed) continue;
      const key = `${kind}:${record.id}`;
      const group = groups.get(key) || { key, kind, id: record.id, records: [] };
      group.records.push(record);
      group.description = group.description || record.description;
      group.version = group.version || record.version;
      groups.set(key, group);
    }
  }
  for (const group of groups.values()) {
    group.records.sort((left, right) => resourceOwner(left).localeCompare(resourceOwner(right)));
  }
  return Array.from(groups.values()).sort((left, right) => {
    if (left.kind !== right.kind) return RESOURCE_KINDS.indexOf(left.kind) - RESOURCE_KINDS.indexOf(right.kind);
    return left.id.localeCompare(right.id);
  });
}

export function isEnabled(record: NativeResourceManagedRecord): boolean {
  return record.enabled !== false;
}

export function providerSupportsKind(
  report: NativeResourceReport | null,
  kind: NativeResourceKind,
  provider: string
): boolean {
  const row = report?.providers?.find((item) => item.provider === provider);
  const capability = row?.resources?.[kind];
  if (!capability || capability.state === 'unsupported') return false;
  if (kind === 'mcp') return Boolean(capability.projection);
  return true;
}

export function hostSupportsPlugin(report: NativeResourceReport | null, host: string): boolean {
  const row = report?.hosts?.find((item) => item.host === host);
  return Boolean(row && row.resources?.plugin?.state !== 'unsupported');
}

export function ownerOptions(report: NativeResourceReport | null, kind: NativeResourceKind): NativeResourceOwnerOption[] {
  if (!report) return [];
  const options: NativeResourceOwnerOption[] = (report.providers || [])
    .filter((row) => providerSupportsKind(report, kind, row.provider))
    .map((row) => ({ value: `provider:${row.provider}`, label: row.provider }));
  if (kind === 'plugin') {
    for (const row of report.hosts || []) {
      if (hostSupportsPlugin(report, row.host)) {
        options.push({ value: `host:${row.host}`, label: `宿主 ${row.host}` });
      }
    }
  }
  return options;
}

export function ownerPayload(ownerValue: string): { provider?: string; host?: string } {
  if (ownerValue.startsWith('host:')) return { host: ownerValue.slice('host:'.length) };
  return { provider: ownerValue.replace(/^provider:/, '') };
}

export function resourceSummary(record: NativeResourceManagedRecord): string {
  if (record.command) {
    const args = record.argCount ? ` · ${record.argCount} 个参数` : '';
    return `${record.command}${args}`;
  }
  return record.mode || 'native';
}
