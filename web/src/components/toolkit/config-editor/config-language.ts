export type ConfigLanguage =
  | 'json'
  | 'jsonc'
  | 'yaml'
  | 'toml'
  | 'dotenv'
  | 'ini'
  | 'shellscript'
  | 'plaintext';

export interface ConfigLanguageOption {
  value: ConfigLanguage;
  label: string;
  extensions: string[];
  formattable: boolean;
}

export const CONFIG_LANGUAGE_OPTIONS: ConfigLanguageOption[] = [
  { value: 'json', label: 'JSON', extensions: ['json'], formattable: true },
  { value: 'jsonc', label: 'JSON（允许注释）', extensions: ['jsonc'], formattable: true },
  { value: 'yaml', label: 'YAML', extensions: ['yaml', 'yml'], formattable: true },
  { value: 'toml', label: 'TOML', extensions: ['toml'], formattable: true },
  { value: 'dotenv', label: '.env', extensions: ['env'], formattable: false },
  { value: 'ini', label: 'INI', extensions: ['ini', 'properties'], formattable: false },
  { value: 'shellscript', label: 'Shell', extensions: ['sh', 'bash', 'zsh'], formattable: false },
  { value: 'plaintext', label: '纯文本', extensions: ['txt', 'conf'], formattable: false }
];

const LANGUAGE_BY_FORMAT = new Map<string, ConfigLanguage>([
  ['json', 'json'],
  ['jsonc', 'jsonc'],
  ['yaml', 'yaml'],
  ['yml', 'yaml'],
  ['toml', 'toml'],
  ['dotenv', 'dotenv'],
  ['env', 'dotenv'],
  ['ini', 'ini'],
  ['properties', 'ini'],
  ['shell', 'shellscript'],
  ['shellscript', 'shellscript'],
  ['sh', 'shellscript'],
  ['bash', 'shellscript'],
  ['zsh', 'shellscript'],
  ['text', 'plaintext'],
  ['txt', 'plaintext'],
  ['plaintext', 'plaintext']
]);

function normalizeToken(value?: string) {
  return String(value || '').trim().toLowerCase().replace(/^\./, '');
}

function languageFromFileName(fileName?: string): ConfigLanguage | null {
  const normalized = String(fileName || '').trim().toLowerCase();
  if (!normalized) return null;
  const baseName = normalized.split(/[\\/]/).pop() || '';
  if (baseName === '.env' || baseName.startsWith('.env.')) return 'dotenv';
  const extension = baseName.includes('.') ? baseName.split('.').pop() : '';
  return LANGUAGE_BY_FORMAT.get(normalizeToken(extension)) || null;
}

export function detectConfigLanguage(content?: string): ConfigLanguage {
  const source = String(content || '').trim();
  if (!source) return 'plaintext';

  if (source.startsWith('{') || source.startsWith('[')) {
    try {
      JSON.parse(source);
      return 'json';
    } catch {
      if (source.startsWith('{')) return 'jsonc';
    }
  }

  const meaningfulLines = source.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  if (meaningfulLines.length > 0 && meaningfulLines.every((line) => (
    /^(?:export\s+)?[A-Z_][A-Z0-9_]*\s*=/.test(line)
  ))) {
    return 'dotenv';
  }

  if (/^\s*\[[^\]\r\n]+]\s*$/m.test(source) || /^\s*[A-Za-z0-9_.-]+\s*=\s*.+$/m.test(source)) {
    return 'toml';
  }

  const hasYamlMapping = /^\s*[A-Za-z0-9_.-]+\s*:\s*(?!\/\/).*$/m.test(source);
  const hasYamlSequence = /^\s*-\s+(?:[A-Za-z0-9_.-]+\s*:|\{)/m.test(source);
  if (hasYamlMapping || hasYamlSequence || /^\s*---\s*$/m.test(source)) return 'yaml';

  if (/^\s*(?:#!.*\b(?:sh|bash|zsh)\b|(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*=)/m.test(source)) {
    return 'shellscript';
  }

  return 'plaintext';
}

interface ResolveConfigLanguageInput {
  format?: string;
  fileName?: string;
  content?: string;
  detectContent?: boolean;
}

export function resolveConfigLanguage({
  format,
  fileName,
  content,
  detectContent = false
}: ResolveConfigLanguageInput): ConfigLanguage {
  const normalizedFormat = normalizeToken(format);
  const explicit = normalizedFormat && normalizedFormat !== 'auto'
    ? LANGUAGE_BY_FORMAT.get(normalizedFormat)
    : null;

  if (explicit && explicit !== 'plaintext') return explicit;

  const fromName = languageFromFileName(fileName);
  if (fromName && fromName !== 'plaintext') return fromName;

  if (detectContent || normalizedFormat === 'auto' || explicit === 'plaintext') {
    const detected = detectConfigLanguage(content);
    if (detected !== 'plaintext') return detected;
  }

  return explicit || fromName || 'plaintext';
}

export function getConfigLanguageLabel(language: ConfigLanguage) {
  return CONFIG_LANGUAGE_OPTIONS.find((option) => option.value === language)?.label || '纯文本';
}

export function canFormatConfigLanguage(language: ConfigLanguage) {
  return CONFIG_LANGUAGE_OPTIONS.some((option) => option.value === language && option.formattable);
}

export function getVirtualConfigExtension(language: ConfigLanguage) {
  return CONFIG_LANGUAGE_OPTIONS.find((option) => option.value === language)?.extensions[0] || 'txt';
}
