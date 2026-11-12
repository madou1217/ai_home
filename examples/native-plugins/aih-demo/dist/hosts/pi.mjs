import { setupDemo } from '../core.mjs';

export default function aihDemoPiExtension(pi) {
  const dispose = setupDemo({
    tools: {
      register(definition) {
        pi.registerTool({
          name: definition.name,
          label: 'AIH portable demo',
          description: definition.description,
          parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
          async execute(_id, args, signal) {
            return { content: [{ type: 'text', text: await definition.invoke(args, { signal }) }], details: {} };
          }
        });
      }
    },
    commands: {
      register(name, invoke) {
        pi.registerCommand(name, {
          description: 'Invoke the shared portable core without a model request.',
          async handler(args) {
            pi.sendMessage({ customType: name, content: await invoke(args), display: true });
          }
        });
      }
    }
  });
  pi.on('session_shutdown', dispose);
}
