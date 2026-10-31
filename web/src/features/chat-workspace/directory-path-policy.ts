export type DirectoryBreadcrumb = {
  key: string;
  label: string;
  path: string;
  current: boolean;
};

function pathParts(path: string): string[] {
  return path.split(/[\\/]/).filter(Boolean);
}

function isWindowsPath(path: string, parts: string[]): boolean {
  return path.includes('\\') || Boolean(parts[0] && /^[a-zA-Z]:$/.test(parts[0]));
}

export function buildDirectoryBreadcrumbs(currentPath: string): DirectoryBreadcrumb[] {
  const parts = pathParts(currentPath);
  if (!currentPath) return [];
  const windows = isWindowsPath(currentPath, parts);
  let accumulated = '';
  const breadcrumbs: DirectoryBreadcrumb[] = [
    { key: 'root', label: '[Root]', path: '/', current: false },
  ];
  parts.forEach((part, index) => {
    if (index === 0 && /^[a-zA-Z]:$/.test(part)) accumulated = part;
    else accumulated += `${windows ? '\\' : '/'}${part}`;
    breadcrumbs.push({
      key: `${index}:${part}`,
      label: part,
      path: accumulated,
      current: index === parts.length - 1,
    });
  });
  return breadcrumbs;
}
