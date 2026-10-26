import { setupDemo } from '../core.mjs';

export const name = 'aih-demo';
export const inject = ['tools'];
export function apply(ctx, config = {}) {
  ctx.effect(() => setupDemo({
    tools: {
      register(definition) {
        return ctx.tools.register({
          name: definition.name,
          description: config.description || definition.description,
          parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
          output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
          execute: (args, exec) => definition.invoke(args, { signal: exec.signal })
        });
      }
    }
  }));
}
export default { name, inject, apply };
