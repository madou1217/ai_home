export type FilePreviewKind = 'image' | 'markdown' | 'html' | 'source';
export type FilePreviewMode = 'source' | 'rendered' | 'image';

export interface FilePreviewDescriptor {
  kind: FilePreviewKind;
  extension: string;
  language: string;
  languageLabel: string;
  typeLabel: string;
}

interface MarkdownImageSourceOptions {
  baseDirectory?: string;
  projectPath?: string;
  source?: string;
}

const MARKDOWN_CAROUSEL_SLIDE_SEPARATOR = /<!--\s*slide\s*-->/i;

const IMAGE_EXTENSIONS = new Set(['avif', 'bmp', 'gif', 'jpeg', 'jpg', 'png', 'svg', 'webp']);
const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown', 'mdown', 'mdx', 'mkd']);
const HTML_EXTENSIONS = new Set(['htm', 'html', 'xhtml']);

const TYPE_LABEL_BY_PREVIEW_KIND: Record<FilePreviewKind, string> = {
  image: '图片',
  markdown: '文档',
  html: '网页',
  source: '源码'
};

const HTML_PREVIEW_VIEWPORT_META = '<meta name="viewport" content="width=device-width, initial-scale=1">';

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
  htm: 'html',
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
  xhtml: 'html',
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
  htm: 'HTML',
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
  xhtml: 'HTML',
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
  if (HTML_EXTENSIONS.has(extension)) return 'html';
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

  return {
    kind,
    extension,
    language,
    languageLabel,
    typeLabel: TYPE_LABEL_BY_PREVIEW_KIND[kind]
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
  if (kind === 'html') {
    return [
      { label: '预览', value: 'rendered' },
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
  if (kind === 'markdown' || kind === 'html') return 'rendered';
  return 'source';
}

export function normalizeHtmlPreviewDocument(content: string) {
  const html = String(content || '');
  if (/<meta(?:\s[^>]*)?name=["']viewport["'][^>]*>/i.test(html)) return html;

  const headPattern = /<head(?:\s[^>]*)?>/i;

  if (headPattern.test(html)) {
    return html.replace(headPattern, (head) => `${head}${HTML_PREVIEW_VIEWPORT_META}`);
  }

  const htmlPattern = /<html(?:\s[^>]*)?>/i;
  if (htmlPattern.test(html)) {
    return html.replace(htmlPattern, (htmlTag) => (
      `${htmlTag}<head>${HTML_PREVIEW_VIEWPORT_META}</head>`
    ));
  }

  const doctypeMatch = html.match(/^\s*<!doctype[^>]*>/i);
  const doctype = doctypeMatch?.[0].trim() || '<!doctype html>';
  const fragment = doctypeMatch ? html.slice(doctypeMatch[0].length) : html;
  return `${doctype}<html><head>${HTML_PREVIEW_VIEWPORT_META}</head><body>${fragment}</body></html>`;
}

export function buildFileMediaUrl(filePath: string, projectPath?: string, source?: string) {
  // 使用 URLSearchParams 保证路径里的空格、#、中文不会破坏预览请求。
  const params = new URLSearchParams();
  params.set('path', filePath);
  if (projectPath) params.set('projectPath', projectPath);
  if (source) params.set('source', source);
  return `/v0/webui/fs/media?${params.toString()}`;
}

function isWindowsAbsolutePath(value: string) {
  return /^[a-z]:[\\/]/i.test(value) || /^\\\\/.test(value);
}

function decodeFileUrl(value: string) {
  try {
    const url = new URL(value);
    const pathname = decodeURIComponent(url.pathname);
    if (url.hostname && url.hostname !== 'localhost') {
      return `//${url.hostname}${pathname}`;
    }
    // Windows 的 file:///C:/... 会多一个 URL 根斜杠，交给远端 Windows server 前先还原盘符路径。
    return /^\/[a-z]:\//i.test(pathname) ? pathname.slice(1) : pathname;
  } catch (_error) {
    return '';
  }
}

function decodeMarkdownLocalPath(value: string) {
  try {
    return decodeURIComponent(value);
  } catch (_error) {
    return value;
  }
}

function joinLocalPath(baseDirectory: string, relativePath: string) {
  const base = String(baseDirectory || '').trim().replace(/[\\/]+$/, '');
  const child = String(relativePath || '').trim().replace(/^(?:\.[\\/])+/, '');
  if (!base || !child) return '';
  return `${base}/${child}`;
}

export function getFileParentPath(filePath: string) {
  const value = String(filePath || '').trim().replace(/[\\/]+$/, '');
  const separatorIndex = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'));
  return separatorIndex > 0 ? value.slice(0, separatorIndex) : '';
}

export function parseMarkdownCarouselSlides(language: string, content: string) {
  if (String(language || '').trim().toLowerCase() !== 'carousel') return [];
  return String(content || '')
    .split(MARKDOWN_CAROUSEL_SLIDE_SEPARATOR)
    .map((slide) => slide.trim())
    .filter(Boolean);
}

export function buildMarkdownImageSource(
  imageSource: string,
  options: MarkdownImageSourceOptions = {}
) {
  const value = String(imageSource || '').trim();
  if (!value) return '';

  if (
    /^(?:data:image\/|blob:|https?:\/\/|\/\/)/i.test(value)
    || value.startsWith('/v0/')
    || value.startsWith('/ui/')
    || value.startsWith('/api/')
  ) {
    return value;
  }

  let localPath = '';
  if (/^file:\/\//i.test(value)) {
    localPath = decodeFileUrl(value);
  } else if (value.startsWith('/') || value.startsWith('~') || isWindowsAbsolutePath(value)) {
    localPath = decodeMarkdownLocalPath(value);
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
    // 未知协议交给浏览器处理，不能误包装成本地文件读取请求。
    return value;
  } else {
    localPath = joinLocalPath(options.baseDirectory || '', decodeMarkdownLocalPath(value));
    if (!localPath) return value;
  }

  if (!localPath) return '';
  return buildFileMediaUrl(localPath, options.projectPath, options.source);
}

export function buildFileBackedImageUrl(filePath: string, projectPath?: string, source?: string) {
  const value = String(filePath || '').trim();
  if (!value) return '';
  if (/^(data:image\/|blob:|https?:\/\/)/i.test(value)) return value;
  if (value.startsWith('/v0/webui/fs/media')) return value;
  if (value.startsWith('/v0/webui/chat/attachments')) return value;

  // 文件型图片统一走 fs/media，和右侧文件抽屉共享授权与读取逻辑。
  if (value.startsWith('file://')) {
    const localPath = decodeFileUrl(value);
    return localPath ? buildFileMediaUrl(localPath, projectPath, source) : '';
  }
  return buildFileMediaUrl(value, projectPath, source);
}
