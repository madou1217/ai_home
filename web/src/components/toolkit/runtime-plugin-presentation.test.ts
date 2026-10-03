import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveRuntimePlugins, runtimePluginName } from './runtime-plugin-presentation.tsx';

test('prefers the server-declared plugin list', () => {
  const declared = [{ id: 'go', name: 'Go', icon: 'go' }];
  assert.deepEqual(resolveRuntimePlugins(declared, [{ runtime: 'node' }]), declared);
});

test('derives plugins from tool runtimes in the default order for older servers', () => {
  const plugins = resolveRuntimePlugins(undefined, [
    { runtime: 'go' },
    { runtime: 'node' },
    { runtime: 'zig' },
    { runtime: 'rust' }
  ]);
  assert.deepEqual(plugins.map((plugin) => plugin.id), ['node', 'rust', 'go', 'zig']);
  assert.equal(runtimePluginName(plugins, 'rust'), 'Rust');
});
