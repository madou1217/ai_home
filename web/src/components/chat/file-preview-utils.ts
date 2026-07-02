import { withWebUiAccessToken } from '@/services/api';
export type FilePreviewKind = 'image' | 'markdown' | 'source';
export type FilePreviewMode = 'source' | 'rendered' | 'image';

export interface FilePreviewDescriptor {
  kind: FilePreviewKind;
  extension: string;
  language: string;
  languageLabel: string;
  typeLabel: string;
}

const IMAGE_EXTENSIONS = new Set(['avif', 'bmp', 'gif', 'jpeg', 'jpg', 'png', 'svg', 'webp']);
const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown', 'mdown', 'mdx', 'mkd']);

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  bash: 'bash',
  c: 'c',
  cc: 'cpp',
  conf: 'ini',
  cpp: 'cpp',
  css: 'css',
  csv: 'csv',
  env: 'ini',
  go: 'go',
  h: 'c',
  hpp: 'cpp',
  html: 'html',
  ini: 'ini',
  java: 'java',
  js: 'javascript',
  json: 'json',
  jsx: 'jsx',
  md: 'markdown',
  mdx: 'markdown',
  mjs: 'javascript',
  mts: 'typescript',
  php: 'php',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  sh: 'bash',
  sql: 'sql',
  ts: 'typescript',
  tsx: 'tsx',
  toml: 'toml',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
  zsh: 'bash'
};

const LANGUAGE_LABEL_BY_EXTENSION: Record<string, string> = {
  bash: 'Bash',
  c: 'C',
  cc: 'C++',
  conf: 'Config',
  cpp: 'C++',
  css: 'CSS',
  csv: 'CSV',
  env: 'ENV',
  go: 'Go',
  h: 'C Header',
  hpp: 'C++ Header',
  html: 'HTML',
  ini: 'INI',
  java: 'Java',
  js: 'JavaScript',
  json: 'JSON',
  jsx: 'React JSX',
  md: 'Markdown',
  mdx: 'MDX',
  mjs: 'JavaScript',
  mts: 'TypeScript',
  php: 'PHP',
  py: 'Python',
  rb: 'Ruby',
  rs: 'Rust',
  sh: 'Shell',
  sql: 'SQL',
  ts: 'TypeScript',
  tsx: 'React TSX',
  toml: 'TOML',
  xml: 'XML',
  yaml: 'YAML',
  yml: 'YAML',
  zsh: 'Zsh'
};

const SPECIAL_FILE_LABEL_BY_NAME: Record<string, string> = {
  dockerfile: 'Dockerfile',
  makefile: 'Makefile'
};

function getFileName(filePath: string) {
  const withoutQuery = String(filePath || '').replace(/[?#].*$/, '');
  // 记忆引用和 Markdown 链接常带 :12 或 :12-18 行号，类型识别必须回到真实文件名。
  const withoutLineSuffix = withoutQuery.replace(/:([0-9]+)(-[0-9]+)?$/, '');
  return withoutLineSuffix.split(/[\\/]/).pop()?.toLowerCase() || '';
}

export function getFileExtension(filePath: string) {
  const fileName = getFileName(filePath);
  const match = fileName.toLowerCase().match(/\.([a-z0-9_-]+)$/);
  return match?.[1] || '';
}

export function getFilePreviewKind(filePath: string): FilePreviewKind {
  const extension = getFileExtension(filePath);
  if (IMAGE_EXTENSIONS.has(extension)) return 'image';
  if (MARKDOWN_EXTENSIONS.has(extension)) return 'markdown';
  return 'source';
}

export function getPreviewLanguage(filePath: string) {
  const fileName = getFileName(filePath);
  if (fileName === 'dockerfile') return 'dockerfile';
  if (fileName === 'makefile') return 'makefile';
  if (fileName.startsWith('.env')) return 'ini';
  return LANGUAGE_BY_EXTENSION[getFileExtension(filePath)] || 'text';
}

export function getPreviewLanguageLabel(filePath: string) {
  const fileName = getFileName(filePath);
  if (SPECIAL_FILE_LABEL_BY_NAME[fileName]) return SPECIAL_FILE_LABEL_BY_NAME[fileName];
  if (fileName.startsWith('.env')) return 'ENV';
  return LANGUAGE_LABEL_BY_EXTENSION[getFileExtension(filePath)] || 'Text';
}

export function getFilePreviewDescriptor(filePath: string): FilePreviewDescriptor {
  const kind = getFilePreviewKind(filePath);
  const extension = getFileExtension(filePath);
  const language = getPreviewLanguage(filePath);
  const languageLabel = kind === 'image'
    ? (extension ? extension.toUpperCase() : 'Image')
    : getPreviewLanguageLabel(filePath);
  const typeLabel = kind === 'image' ? '图片' : (kind === 'markdown' ? '文档' : '源码');

  return {
    kind,
    extension,
    language,
    languageLabel,
    typeLabel
  };
}

export function getPreviewModeOptions(kind: FilePreviewKind): Array<{ label: string; value: FilePreviewMode }> {
  if (kind === 'image') {
    return [
      { label: '预览', value: 'image' },
      { label: '打开', value: 'source' }
    ];
  }
  if (kind === 'markdown') {
    return [
      { label: '渲染', value: 'rendered' },
      { label: '原文', value: 'source' }
    ];
  }
  return [
    { label: '原文', value: 'source' }
  ];
}

export function getDefaultPreviewMode(kind: FilePreviewKind): FilePreviewMode {
  // 不同文件类型有不同首屏预览偏好，统一放这里避免各组件各自判断。
  if (kind === 'image') return 'image';
  if (kind === 'markdown') return 'rendered';
  return 'source';
}

export function buildFileMediaUrl(filePath: string, projectPath?: string, source?: string) {
  // 使用 URLSearchParams 保证路径里的空格、#、中文不会破坏预览请求。
  const params = new URLSearchParams();
  params.set('path', filePath);
  if (projectPath) params.set('projectPath', projectPath);
  if (source) params.set('source', source);
  return withWebUiAccessToken(`/v0/webui/fs/media?${params.toString()}`);
}

export function buildFileBackedImageUrl(filePath: string, projectPath?: string, source?: string) {
  const value = String(filePath || '').trim();
  if (!value) return '';
  if (/^(data:image\/|blob:|https?:\/\/)/i.test(value)) return value;
  if (value.startsWith('/v0/webui/fs/media')) return value;
  if (value.startsWith('/v0/webui/chat/attachments')) return value;

  // 文件型图片统一走 fs/media，和右侧文件抽屉共享授权与读取逻辑。
  if (value.startsWith('file://')) {
    try {
      return buildFileMediaUrl(decodeURIComponent(new URL(value).pathname), projectPath, source);
    } catch (_error) {
      return '';
    }
  }
  return buildFileMediaUrl(value, projectPath, source);
}
