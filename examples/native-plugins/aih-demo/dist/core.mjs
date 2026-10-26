export const pluginId = 'aih-demo';
export const marker = 'AIH_PLUGIN_DEMO_OK';

// The business operation and its lifetime are shared by every host entry.
export function setupDemo(ports) {
  let active = true;
  const invoke = async ({ text = '' } = {}, { signal } = {}) => {
    if (!active) throw new Error('portable_plugin_disposed');
    signal?.throwIfAborted();
    if (typeof text !== 'string' || text.length > 1024) throw new Error('portable_plugin_arguments_invalid');
    return `${marker}:${text}`;
  };
  const disposers = [];
  const own = value => { if (typeof value === 'function') disposers.push(value); };
  own(ports.tools.register({ name: 'aih_demo', description: 'Return the portable plugin marker and supplied text.', invoke }));
  if (ports.commands) own(ports.commands.register('aih-demo', text => invoke({ text })));
  return () => {
    if (!active) return;
    active = false;
    for (const dispose of disposers.reverse()) dispose();
  };
}
