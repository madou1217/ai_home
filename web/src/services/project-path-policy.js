export function isAbsoluteProjectPath(projectPath) {
  const value = String(projectPath || '').trim();
  if (!value) return false;
  if (value.startsWith('/')) return true;
  if (/^[a-zA-Z]:[\\/]/.test(value)) return true;
  return /^\\\\[^\\]+\\[^\\]+/.test(value);
}
