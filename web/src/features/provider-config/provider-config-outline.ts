import type {
  ProviderConfigSchemaField,
  ProviderConfigFieldCompatibility as ProviderConfigSchemaFieldCompatibility
} from '@/types';

// Provider 配置的轻量行级大纲。
//
// 编辑器只需要“当前光标/悬停所在行对应哪个键路径”，不需要完整 AST：
// - JSON / JSONC 用一个字符扫描器维护对象栈（字符串与注释会被跳过）；
// - TOML 用 section + key 行；
// - YAML 用缩进栈。
// JSONC 的注释、TOML 的多行数组、YAML 的锚点都会退化为“父级路径”，
// 不会把错误的键路径当成事实（找不到就展示 schema 总览）。

export interface ProviderConfigOutlineEntry {
  /** 点分键路径，例如 model_providers.aih.name */
  path: string;
  /** 1-based 行号 */
  line: number;
  /** 1-based 结束行（容器会覆盖整个范围） */
  endLine: number;
  key: string;
  depth: number;
}

type ConfigFormat = 'json' | 'jsonc' | 'toml' | 'yaml' | string;

function normalizeSegment(value: string): string {
  return String(value || '')
    .trim()
    .replace(/^["']+|["']+$/g, '')
    .replace(/^\[+|\]+$/g, '')
    .trim();
}

function normalizeTomlKey(value: string): string {
  return String(value || '')
    .split('.')
    .map((part) => normalizeSegment(part))
    .filter(Boolean)
    .join('.');
}

function countDepth(path: string): number {
  return path ? path.split('.').filter(Boolean).length : 0;
}

function computeRangedEndLines(entries: ProviderConfigOutlineEntry[], totalLines: number) {
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    let endLine = totalLines;
    for (let next = index + 1; next < entries.length; next += 1) {
      if (entries[next].depth <= entry.depth) {
        endLine = Math.max(entry.line, entries[next].line - 1);
        break;
      }
    }
    entry.endLine = endLine;
  }
}

function parseJsonOutline(text: string): ProviderConfigOutlineEntry[] {
  interface Frame {
    type: 'object' | 'array';
    path: string;
    expectingKey: boolean;
    currentKey: string;
    pendingEntry?: ProviderConfigOutlineEntry;
    entry?: ProviderConfigOutlineEntry;
  }
  const entries: ProviderConfigOutlineEntry[] = [];
  const stack: Frame[] = [{ type: 'object', path: '', expectingKey: true, currentKey: '' }];
  let line = 1;
  let index = 0;
  const top = () => stack[stack.length - 1];

  while (index < text.length) {
    const char = text[index];

    if (char === '\n') {
      line += 1;
      index += 1;
      continue;
    }
    if (char === '/' && text[index + 1] === '/') {
      while (index < text.length && text[index] !== '\n') index += 1;
      continue;
    }
    if (char === '/' && text[index + 1] === '*') {
      index += 2;
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) {
        if (text[index] === '\n') line += 1;
        index += 1;
      }
      index += 2;
      continue;
    }
    if (char === '"' || char === "'") {
      const quote = char;
      const startLine = line;
      index += 1;
      let value = '';
      while (index < text.length) {
        const current = text[index];
        if (current === '\\') {
          value += text[index + 1] || '';
          index += 2;
          continue;
        }
        if (current === quote) {
          index += 1;
          break;
        }
        if (current === '\n') line += 1;
        value += current;
        index += 1;
      }
      const frame = top();
      if (frame && frame.type === 'object' && frame.expectingKey) {
        frame.currentKey = value;
        frame.expectingKey = false;
        const entryPath = frame.path ? `${frame.path}.${value}` : value;
        const keyEntry: ProviderConfigOutlineEntry = {
          path: entryPath,
          line: startLine,
          endLine: startLine,
          key: value,
          depth: countDepth(entryPath)
        };
        entries.push(keyEntry);
        frame.pendingEntry = keyEntry;
      }
      continue;
    }
    if (char === ':') {
      index += 1;
      continue;
    }
    if (char === ',') {
      const frame = top();
      if (frame && frame.type === 'object') {
        frame.expectingKey = true;
        frame.currentKey = '';
        frame.pendingEntry = undefined;
      }
      index += 1;
      continue;
    }
    if (char === '{' || char === '[') {
      const parent = top();
      const type = char === '{' ? 'object' : 'array';
      let key = '';
      let childPath = parent ? parent.path : '';
      let entry: ProviderConfigOutlineEntry | undefined;
      if (parent && parent.type === 'object' && parent.currentKey) {
        key = parent.currentKey;
        childPath = parent.path ? `${parent.path}.${key}` : key;
        entry = parent.pendingEntry;
        parent.pendingEntry = undefined;
      }
      stack.push({
        type,
        path: childPath,
        expectingKey: type === 'object',
        currentKey: '',
        entry: type === 'object' ? entry : undefined
      });
      index += 1;
      continue;
    }
    if (char === '}' || char === ']') {
      const frame = stack.pop();
      if (frame && frame.entry) frame.entry.endLine = Math.max(frame.entry.line, line);
      index += 1;
      continue;
    }
    index += 1;
  }
  return entries;
}

function parseTomlOutline(text: string): ProviderConfigOutlineEntry[] {
  const entries: ProviderConfigOutlineEntry[] = [];
  const lines = text.split('\n');
  let section = '';
  lines.forEach((raw, index) => {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const sectionMatch = trimmed.match(/^\[\[?([^\]]+)\]\]?$/);
    if (sectionMatch) {
      section = normalizeTomlKey(sectionMatch[1]);
      return;
    }
    const equals = raw.indexOf('=');
    if (equals < 0) return;
    const key = normalizeTomlKey(raw.slice(0, equals));
    if (!key) return;
    const path = section ? `${section}.${key}` : key;
    entries.push({
      path,
      line: index + 1,
      endLine: index + 1,
      key: key.split('.').pop() || key,
      depth: countDepth(path)
    });
  });
  computeRangedEndLines(entries, lines.length);
  return entries;
}

function parseYamlOutline(text: string): ProviderConfigOutlineEntry[] {
  const entries: ProviderConfigOutlineEntry[] = [];
  const lines = text.split('\n');
  const stack: Array<{ indent: number; path: string }> = [];
  lines.forEach((raw, index) => {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed === '---' || trimmed === '...') return;
    const indent = (raw.match(/^[ \t]*/)?.[0] || '').replace(/\t/g, '  ').length;
    const listMatch = trimmed.match(/^-\s+(.*)$/);
    const content = listMatch ? listMatch[1] : trimmed;
    const keyMatch = content.match(/^("([^"]+)"|'([^']+)'|[^:#][^:]*?):(?:\s|$)/);
    if (!keyMatch) return;
    const key = String(keyMatch[2] || keyMatch[3] || keyMatch[1] || '').trim();
    if (!key) return;
    const actualIndent = indent + (listMatch ? 2 : 0);
    while (stack.length && stack[stack.length - 1].indent >= actualIndent) stack.pop();
    const parent = stack[stack.length - 1];
    const path = parent ? `${parent.path}.${key}` : key;
    entries.push({
      path,
      line: index + 1,
      endLine: index + 1,
      key,
      depth: countDepth(path)
    });
    stack.push({ indent: actualIndent, path });
  });
  computeRangedEndLines(entries, lines.length);
  return entries;
}

export function buildProviderConfigOutline(
  content: string,
  format: ConfigFormat
): ProviderConfigOutlineEntry[] {
  const text = String(content || '');
  if (!text.trim()) return [];
  if (format === 'json' || format === 'jsonc') return parseJsonOutline(text);
  if (format === 'toml') return parseTomlOutline(text);
  if (format === 'yaml') return parseYamlOutline(text);
  return [];
}

/** 光标/悬停行 → 最深的包含该行的键路径。 */
export function resolveProviderConfigOutlineEntry(
  entries: ProviderConfigOutlineEntry[],
  line: number
): ProviderConfigOutlineEntry | null {
  if (!entries.length || !line) return null;
  const exact = entries.filter((entry) => entry.line === line);
  if (exact.length) return exact[exact.length - 1];
  let best: ProviderConfigOutlineEntry | null = null;
  for (const entry of entries) {
    if (entry.line <= line && line <= entry.endLine) {
      if (!best || entry.depth >= best.depth) best = entry;
    }
  }
  return best;
}

function normalizeSchemaPath(path: string): string {
  return String(path || '')
    .trim()
    .replace(/^\[+|\]+$/g, '')
    .replace(/^\.+|\.+$/g, '')
    .replace(/\[\]/g, '')
    .replace(/\.\*/g, '')
    .replace(/\*/g, '')
    .replace(/\.\./g, '.');
}

/** 与后端 matchConfigSchemaField 同语义：精确匹配，然后逐级回退父路径。 */
export function findProviderConfigSchemaField(
  fields: ProviderConfigSchemaField[] | undefined,
  keyPath: string
): ProviderConfigSchemaField | null {
  if (!fields || !fields.length || !keyPath) return null;
  const index = new Map<string, ProviderConfigSchemaField>();
  fields.forEach((field) => {
    const normalized = normalizeSchemaPath(field.path);
    if (normalized && !index.has(normalized)) index.set(normalized, field);
  });
  let current = normalizeSchemaPath(keyPath);
  while (current) {
    const found = index.get(current);
    if (found) return found;
    const dot = current.lastIndexOf('.');
    current = dot > 0 ? current.slice(0, dot) : '';
  }
  return null;
}

export function describeFieldCompatibility(
  field: ProviderConfigSchemaField | null,
  cliVersion: string
): ProviderConfigSchemaFieldCompatibility {
  const compatibility = field?.compatibility;
  if (compatibility && compatibility.state !== 'ok') return compatibility;
  if (!field || !cliVersion) return { state: 'ok', messages: [] };
  const installed = String(cliVersion).match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  const removed = field.removedIn ? String(field.removedIn).match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/) : null;
  const since = field.since ? String(field.since).match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/) : null;
  const toParts = (match: RegExpMatchArray) => [
    Number(match[1] || 0),
    Number(match[2] || 0),
    Number(match[3] || 0)
  ];
  const compare = (left: number[], right: number[]) => {
    for (let index = 0; index < 3; index += 1) {
      if (left[index] !== right[index]) return left[index] > right[index] ? 1 : -1;
    }
    return 0;
  };
  if (installed && removed && compare(toParts(installed), toParts(removed)) >= 0) {
    return {
      state: 'unsupported',
      messages: [`当前 CLI ${cliVersion} 已移除该配置（removedIn ${field.removedIn}）。`]
    };
  }
  if (installed && since && compare(toParts(installed), toParts(since)) < 0) {
    return {
      state: 'unsupported',
      messages: [`该配置从 CLI ${field.since} 起才支持，当前为 ${cliVersion}。`]
    };
  }
  if (field.deprecated) {
    return { state: 'deprecated', messages: ['该配置已被标记为弃用，新版本可能不再生效。'] };
  }
  return { state: 'ok', messages: [] };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function formatOptionValue(option: string | number | boolean, format: ConfigFormat): string {
  if (typeof option === 'number' || typeof option === 'boolean') {
    if (format === 'toml' || format === 'yaml') return String(option);
    return JSON.stringify(option);
  }
  if (format === 'toml' || format === 'yaml') {
    return /^[A-Za-z0-9_.:/-]+$/.test(option) ? option : JSON.stringify(option);
  }
  return JSON.stringify(option);
}

/**
 * 把枚举选项写回该键所在行。只替换值片段，保留键名与行内注释；
 * 找不到可替换片段时返回 applied=false，由调用方提示用户手动修改。
 */
export function applyProviderConfigOption(
  content: string,
  entry: ProviderConfigOutlineEntry,
  option: string | number | boolean,
  format: ConfigFormat
): { content: string; applied: boolean } {
  const lines = String(content || '').split('\n');
  const index = entry.line - 1;
  if (index < 0 || index >= lines.length) return { content, applied: false };
  const line = lines[index];
  const key = escapeRegExp(entry.key.replace(/^["']|["']$/g, ''));
  const isJson = format === 'json' || format === 'jsonc';
  const value = formatOptionValue(option, format);
  const pattern = isJson
    ? new RegExp(`((?:"|')?${key}(?:"|')?\\s*:\\s*)("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|[^,}\\]]+)`)
    : new RegExp(`((?:^|\\s)(?:"|')?${key}(?:"|')?\\s*[:=]\\s*)([^#\\n]+)`);
  const match = line.match(pattern);
  if (!match || match.index === undefined) return { content, applied: false };
  const replacement = `${match[1]}${value}${isJson ? '' : ''}`;
  if (isJson) {
    // JSON 行 = 前缀 + 值 + 可选的逗号与行尾注释
    const rest = line.slice(match.index + match[0].length);
    const commentIndex = rest.indexOf('//');
    const tail = commentIndex >= 0 ? rest.slice(commentIndex) : '';
    const suffix = `${rest.slice(0, commentIndex >= 0 ? commentIndex : rest.length).replace(/\s+$/, '')}${commentIndex >= 0 ? ` ${tail}` : ''}`;
    lines[index] = `${line.slice(0, match.index)}${replacement}${suffix}`;
  } else {
    const rest = line.slice(match.index + match[0].length);
    const commentIndex = rest.indexOf('#');
    const comment = commentIndex >= 0 ? ` # ${rest.slice(commentIndex + 1).trim()}` : '';
    lines[index] = `${line.slice(0, match.index)}${replacement}${comment}`;
  }
  return { content: lines.join('\n'), applied: true };
}
