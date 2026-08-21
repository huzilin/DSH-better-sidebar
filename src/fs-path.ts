/**
 * Separator-tolerant path helpers shared by the host fs-watch hub and the
 * client fs-events feed. Every path here is absolute (host-produced), but the
 * separator style varies by platform (POSIX '/' vs Windows '\\'); all
 * comparisons normalize to '/' first so a Windows path never mis-compares.
 */
export function normalizeFsPath(path: string): string {
  return path.replace(/[\\/]+/g, '/').replace(/\/+$/, '')
}

/** The containing directory of an absolute path (normalized; '/' at root). */
export function parentDirOf(path: string): string {
  const norm = normalizeFsPath(path)
  const at = norm.lastIndexOf('/')
  return at <= 0 ? '/' : norm.slice(0, at)
}