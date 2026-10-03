import { describe, expect, it } from 'bun:test';
import { resolveRuntimePlugins, runtimePluginName } from './runtime-plugin-presentation';

describe('runtime plugin presentation', () => {
  it('prefers the server-declared plugin list', () => {
    const declared = [{ id: 'go', name: 'Go', icon: 'go' }];
    expect(resolveRuntimePlugins(declared, [{ runtime: 'node' }])).toEqual(declared);
  });

  it('derives plugins from tool runtimes in the default order for older servers', () => {
    const plugins = resolveRuntimePlugins(undefined, [
      { runtime: 'go' },
      { runtime: 'node' },
      { runtime: 'zig' },
      { runtime: 'rust' }
    ]);
    expect(plugins.map((plugin) => plugin.id)).toEqual(['node', 'rust', 'go', 'zig']);
    expect(runtimePluginName(plugins, 'rust')).toBe('Rust');
  });
});
