import { Tag, Tooltip } from 'antd';
import type { EndpointCapability } from '../../types';

/**
 * 客户端入口路径的展示名。
 *
 * 后端给的是真实 HTTP 路径（与 LiteLLM 的 supported_endpoints 一致），
 * 直接显示路径太长，这里映射成业界通行的短名。未知路径原样显示——
 * 不吞掉事实，新增入口时不会显示成空白。
 */
const ENDPOINT_LABELS: Record<string, string> = {
  '/v1/messages': 'Anthropic',
  '/v1/chat/completions': 'OpenAI Chat',
  '/v1/responses': 'OpenAI Responses',
  '/v1beta/models/{model}:generateContent': 'Gemini'
};

export function endpointLabel(path: string): string {
  return ENDPOINT_LABELS[path] || path;
}

/**
 * EndpointCapabilityTags 展示某模型可被调用的客户端入口。
 *
 * 只渲染能力标签，不使用整块提示容器：状态应当由标签和留白表达，
 * 而不是横贯页面的色块。原生入口与转换入口用不同色调区分——
 * 原生表示上游直接按该协议应答，转换表示网关做了跨协议重建，
 * 二者可用性相同但行为可能有差异，属于管理页需要看见的事实。
 */
export function EndpointCapabilityTags({
  paths,
  capabilities
}: {
  paths?: string[];
  capabilities?: EndpointCapability[];
}) {
  // capabilities 提供更准确的来源；缺失时退化成只有路径。
  const entries: Array<{ path: string; mode?: EndpointCapability['mode'] }> =
    capabilities && capabilities.length > 0
      ? capabilities.map((capability) => ({ path: capability.path, mode: capability.mode }))
      : (paths || []).map((path) => ({ path }));

  if (entries.length === 0) {
    return null;
  }
  return (
    <>
      {entries.map((entry) => {
        const native = entry.mode === 'native';
        const tooltip = native
          ? `${entry.path} · 上游原生承接`
          : entry.mode === 'convert'
            ? `${entry.path} · 网关协议转换`
            : entry.path;
        return (
          <Tooltip key={entry.path} title={tooltip}>
            <Tag
              className="models-endpoint-tag"
              color={native ? 'green' : undefined}
              icon={<span aria-hidden="true">{native ? '◆' : '◇'}</span>}
            >
              {endpointLabel(entry.path)}
            </Tag>
          </Tooltip>
        );
      })}
    </>
  );
}
