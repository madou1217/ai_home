import type { ConfigLanguage } from './config-language';
import type { Plugin } from 'prettier';

interface TaploFormatterModule {
  format(source: string): string;
}

let taploPromise: Promise<TaploFormatterModule> | null = null;

function resolvePrettierPlugin(loadedModule: unknown): Plugin {
  if (loadedModule && typeof loadedModule === 'object' && 'default' in loadedModule) {
    return (loadedModule as { default: Plugin }).default;
  }
  return loadedModule as Plugin;
}

async function getTaploFormatter() {
  if (!taploPromise) {
    taploPromise = import('@wasm-fmt/taplo_fmt/web').then(async (loadedModule) => {
      await loadedModule.default();
      if (typeof loadedModule.format !== 'function') {
        throw new Error('TOML 格式化组件加载失败');
      }
      return loadedModule;
    });
  }
  return taploPromise;
}

async function formatJson(source: string) {
  const [prettierModule, babelModule, estreeModule] = await Promise.all([
    import('prettier/standalone.js'),
    import('prettier/parser-babel.js'),
    import('prettier/plugins/estree.js')
  ]);
  return prettierModule.format(source, {
    parser: 'json',
    plugins: [resolvePrettierPlugin(babelModule), resolvePrettierPlugin(estreeModule)],
    tabWidth: 2
  });
}

async function formatYaml(source: string) {
  const [prettierModule, yamlModule] = await Promise.all([
    import('prettier/standalone.js'),
    import('prettier/parser-yaml.js')
  ]);
  return prettierModule.format(source, {
    parser: 'yaml',
    plugins: [resolvePrettierPlugin(yamlModule)],
    tabWidth: 2
  });
}

export async function formatConfigContent(language: ConfigLanguage, source: string) {
  if (!source.trim()) return source;

  switch (language) {
    case 'json':
    case 'jsonc':
      return formatJson(source);
    case 'yaml':
      return formatYaml(source);
    case 'toml': {
      const formatter = await getTaploFormatter();
      return formatter.format(source);
    }
    default:
      throw new Error('当前格式只提供语法高亮，不会自动改写内容');
  }
}
