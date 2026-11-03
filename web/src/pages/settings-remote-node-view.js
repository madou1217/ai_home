const EMPTY_VALUE = '未加载';

function normalizeText(value) {
  return String(value == null ? '' : value).trim();
}

export function formatRemoteNodeIdentity(defaults) {
  const name = normalizeText(defaults && defaults.name);
  const nodeId = normalizeText(defaults && defaults.nodeId);
  if (name && nodeId) return `${name} (${nodeId})`;
  return name || nodeId || EMPTY_VALUE;
}

export function buildRemoteNodeDefaultPreview(defaults, transportDefaults = {}) {
  const source = defaults || {};
  return [
    {
      id: 'nodeId',
      label: '默认节点 ID',
      value: normalizeText(source.nodeId) || EMPTY_VALUE
    },
    {
      id: 'name',
      label: '默认显示名称',
      value: normalizeText(source.name) || EMPTY_VALUE
    },
    {
      id: 'provider',
      label: '派生 Provider',
      value: normalizeText(source.provider) || normalizeText(transportDefaults.provider) || EMPTY_VALUE
    }
  ];
}
