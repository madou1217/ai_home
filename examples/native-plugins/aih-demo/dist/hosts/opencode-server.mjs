import { setupDemo } from '../core.mjs';

export default async function aihDemoPlugin() {
  const tools = {};
  const dispose = setupDemo({
    tools: {
      register(definition) {
        tools[definition.name] = {
          description: definition.description,
          args: {},
          execute: (_args, context) => definition.invoke({ text: 'portable-input' }, { signal: context.abort })
        };
        return () => { delete tools[definition.name]; };
      }
    }
  });
  return {
    tool: tools,
    async event({ event }) {
      if (event.type === 'server.instance.disposed') dispose();
    }
  };
}
