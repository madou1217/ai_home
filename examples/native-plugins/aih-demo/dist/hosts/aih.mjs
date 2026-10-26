import { setupDemo } from '../core.mjs';

export default {
  name: 'aih-demo',
  apply(ctx) {
    ctx.effect(() => setupDemo({
      tools: {
        register(definition) {
          return ctx.aih.register(`aih-demo.tool.${definition.name}`, (args, context) =>
            definition.invoke(args, { signal: context.signal }));
        }
      }
    }));
  }
};
