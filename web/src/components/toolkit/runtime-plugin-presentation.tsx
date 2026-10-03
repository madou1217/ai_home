import type { ReactNode } from 'react';
import {
  BuildOutlined,
  CodeOutlined,
  ExperimentOutlined,
  ThunderboltOutlined
} from '@ant-design/icons';
import type { EnvironmentRuntimePlugin } from '@/types';

/**
 * 运行环境插件的展示层：插件列表由服务端（environment/plugins）下发，
 * 这里只提供图标映射与缺省顺序，新增运行时无需改动页面。
 */
const RUNTIME_PLUGIN_ORDER: readonly EnvironmentRuntimePlugin[] = Object.freeze([
  { id: 'node', name: 'Node.js', icon: 'node' },
  { id: 'python', name: 'Python', icon: 'python' },
  { id: 'rust', name: 'Rust', icon: 'rust' },
  { id: 'go', name: 'Go', icon: 'go' }
]);

const RUNTIME_ICONS: Readonly<Record<string, ReactNode>> = Object.freeze({
  node: <CodeOutlined />,
  python: <ExperimentOutlined />,
  rust: <BuildOutlined />,
  go: <ThunderboltOutlined />
});

export function runtimePluginIcon(id: string): ReactNode {
  return RUNTIME_ICONS[id] || <CodeOutlined />;
}

/** 优先使用服务端插件清单；旧服务端只给出工具时，按工具的 runtime 推导并保持缺省顺序。 */
export function resolveRuntimePlugins(
  declared: EnvironmentRuntimePlugin[] | undefined,
  items: Array<{ runtime: string }> = []
): EnvironmentRuntimePlugin[] {
  if (declared && declared.length) return declared;
  const present = new Set(items.map((item) => item.runtime));
  const known = RUNTIME_PLUGIN_ORDER.filter((plugin) => present.has(plugin.id));
  const unknown = Array.from(present)
    .filter((id) => !RUNTIME_PLUGIN_ORDER.some((plugin) => plugin.id === id))
    .map((id) => ({ id, name: id, icon: id }));
  return [...known, ...unknown];
}

export function runtimePluginName(plugins: EnvironmentRuntimePlugin[], id: string) {
  return plugins.find((plugin) => plugin.id === id)?.name
    || RUNTIME_PLUGIN_ORDER.find((plugin) => plugin.id === id)?.name
    || id;
}
