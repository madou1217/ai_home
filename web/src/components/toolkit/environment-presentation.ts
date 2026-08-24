const ENVIRONMENT_CATEGORY_LABELS: Readonly<Record<string, string>> = Object.freeze({
  'version-manager': '版本管理器',
  'package-manager': '包管理器',
  'environment-manager': '环境管理器',
  'virtual-environment': '虚拟环境',
  runtime: '运行时'
});

export function getEnvironmentCategoryLabel(category: string) {
  const normalized = String(category || '').trim();
  return ENVIRONMENT_CATEGORY_LABELS[normalized] || normalized || '未分类';
}
