import * as path from 'path';

/**
 * Path comparisons that match how the host file system behaves. Windows and
 * macOS are case-insensitive, Linux is not, and getting this wrong makes the
 * repository cache miss (or worse, match the wrong root).
 */
export function comparablePath(value: string): string {
  return process.platform === 'linux' ? value : value.toLowerCase();
}

/** True when `candidate` is `root` itself or lives inside it. */
export function isSameOrInside(root: string, candidate: string): boolean {
  const a = comparablePath(path.normalize(root));
  const b = comparablePath(path.normalize(candidate));
  return b === a || b.startsWith(a.endsWith(path.sep) ? a : a + path.sep);
}

/** Repository-relative path with forward slashes, which is what git expects. */
export function toRelativePosixPath(root: string, filePath: string): string {
  return path.relative(root, filePath).split(path.sep).join('/');
}
