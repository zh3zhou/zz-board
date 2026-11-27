import path from 'node:path';

/** Compare the complete saved directory, preserving POSIX case and workspace boundaries. */
export function matchingProjectDirectory(saved: string, actual: unknown): boolean {
  if (saved === actual) return true;
  if (typeof actual !== 'string') return false;
  const windowsPath = (value: string) => {
    const plain = value.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '');
    if (!/^(?:[a-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/i.test(plain)) return null;
    return path.win32.normalize(plain).replace(/\\+$/, '').toLowerCase();
  };
  const normalized = windowsPath(saved);
  return normalized !== null && normalized === windowsPath(actual);
}
