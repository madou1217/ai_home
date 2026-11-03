const FILE_PATH_KEYS = new Set(['path', 'filePath', 'file_path']);

interface TimelineFileSource {
  readonly kind?: unknown;
  readonly detail?: unknown;
}

export function collectTimelineFileReferences(item: TimelineFileSource): readonly string[] {
  if (item.kind !== 'file_change' && item.kind !== 'tool') return [];
  const references: string[] = [];
  collectFilePathFields(item.detail, references, 0);
  return [...new Set(references)];
}

function collectFilePathFields(value: unknown, references: string[], depth: number): void {
  if (!value || typeof value !== 'object' || depth > 4) return;
  if (Array.isArray(value)) {
    value.forEach((entry) => collectFilePathFields(entry, references, depth + 1));
    return;
  }
  Object.entries(value as Record<string, unknown>).forEach(([key, entry]) => {
    if (FILE_PATH_KEYS.has(key) && isPreviewablePath(entry)) references.push(entry.trim());
    else if (typeof entry === 'object') collectFilePathFields(entry, references, depth + 1);
  });
}

function isPreviewablePath(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const path = value.trim();
  if (!path || /^(?:https?|data|file):/i.test(path)) return false;
  return /^(?:\.{0,2}[/\\]|~[/\\]|[/\\]|[a-z]:[/\\])/i.test(path);
}
