import type { AggregatorProbePort, AggregatorProbeResult, AggregatorSource, AggregatorSourceInput } from './types';

/** 手动节点：节点库字段原样保存（protocol / name / server / port / 各协议字段）。 */
export type ManualNode = Record<string, unknown> & { protocol: string; name: string; server: string; port: number };

/** 手动节点存成一个本地订阅源，内容是本系统的中立 JSON（与 json 输出同一格式）。 */
export function parseManualContent(content: string | undefined): ManualNode[] | null {
  try {
    const document = JSON.parse(String(content || ''));
    if (!document || typeof document !== 'object' || Number(document.version) !== 1 || !Array.isArray(document.nodes)) return null;
    return document.nodes.filter((node: unknown) => node && typeof node === 'object' && typeof (node as ManualNode).protocol === 'string');
  } catch (_error) {
    return null;
  }
}

export function serializeManualNodes(nodes: ManualNode[]) {
  return `${JSON.stringify({ version: 1, nodes }, null, 2)}\n`;
}

/** 去掉空值（空串、空数组、undefined / null），保存的 JSON 只留填了的字段。 */
export function compactNode(node: Record<string, unknown>): ManualNode {
  const entries = Object.entries(node).filter(([, value]) => value !== undefined && value !== null && value !== ''
    && !(Array.isArray(value) && value.length === 0));
  return Object.fromEntries(entries) as ManualNode;
}

export const MANUAL_SOURCE_NAME = '手动节点';

/** 手动添加的节点追加到第一个手动节点源（内容是中立 JSON 的本地源）；还没有就新建一个。 */
export function manualNodeSaveInput(sources: Array<Pick<AggregatorSource, 'id' | 'name' | 'kind' | 'content'>>, node: ManualNode): AggregatorSourceInput {
  const target = sources.find((source) => source.kind === 'local' && parseManualContent(source.content) !== null);
  if (!target) return { name: MANUAL_SOURCE_NAME, kind: 'local', content: serializeManualNodes([node]) };
  return { id: target.id, name: target.name, kind: 'local', content: serializeManualNodes([...(parseManualContent(target.content) || []), node]) };
}

/** 新增（index 为 -1）或替换第 index 个节点。 */
export function upsertManualNode(nodes: ManualNode[], node: ManualNode, index = -1) {
  if (index < 0 || index >= nodes.length) return [...nodes, node];
  return nodes.map((item, position) => (position === index ? node : item));
}

export function removeManualNode(nodes: ManualNode[], index: number) {
  return nodes.filter((_node, position) => position !== index);
}

const TLS_CANDIDATES = new Set(['trojan', 'vless', 'vmess', 'anytls', 'https']);

/**
 * 用探测结果预填表单：取第一个识别出协议的开放端口和它最可能的协议；TLS 端口打开 TLS，
 * 证书与地址不符（疑似 REALITY）时安全层选 reality、SNI 填证书上的网站。
 */
export function prefillFromProbe(result: Pick<AggregatorProbeResult, 'host'>, port: AggregatorProbePort, protocol = port.candidates[0]) {
  const node: Record<string, unknown> = { protocol, server: result.host, port: port.port, name: `${result.host}:${port.port}` };
  if (port.tls && TLS_CANDIDATES.has(protocol)) {
    node.tls = true;
    if (port.tls.sniMatch === false && port.tls.names.length) {
      node.sni = port.tls.names[0].replace(/^\*\./, 'www.');
      if (protocol === 'vless') node.security = 'reality';
    } else if (port.tls.sniMatch) {
      node.sni = result.host;
    }
    if (port.tls.alpn) node.alpn = [port.tls.alpn];
  }
  return compactNode(node);
}
