export default async function aihDemoDeepSeekPlugin(context) {
  return { pluginId: 'aih-demo', marker: 'AIH_PLUGIN_DEMO_OK', context: Boolean(context) };
}
