/**
 * Turns a git remote URL into a browsable commit URL.
 *
 * Only the hosts whose commit URL layout we actually know are handled; anything
 * else returns `undefined` so the UI can hide the action rather than open a
 * link that 404s.
 */
export function buildCommitUrl(remote: string, hash: string): string | undefined {
  const web = toWebUrl(remote);
  if (!web) {
    return undefined;
  }
  const { host, pathname } = web;

  if (host === 'dev.azure.com' || host.endsWith('.visualstudio.com')) {
    return `https://${host}${pathname}/commit/${hash}`;
  }
  if (host === 'bitbucket.org') {
    return `https://${host}${pathname}/commits/${hash}`;
  }
  if (host === 'gitlab.com' || host.startsWith('gitlab.')) {
    return `https://${host}${pathname}/-/commit/${hash}`;
  }
  if (host === 'github.com' || host.endsWith('.githubusercontent.com') || host.startsWith('github.')) {
    return `https://${host}${pathname}/commit/${hash}`;
  }
  return undefined;
}

/** Normalises SCP-style and URL-style remotes to a host plus a clean path. */
export function toWebUrl(remote: string): { host: string; pathname: string } | undefined {
  const trimmed = remote.trim();
  if (!trimmed) {
    return undefined;
  }

  // scp-like syntax: git@host:owner/repo.git
  const scp = /^(?:([^@/]+)@)?([^:/]+):(?!\/)(.+)$/.exec(trimmed);
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    return { host: scp[2], pathname: normalisePath(scp[3]) };
  }

  try {
    const url = new URL(trimmed);
    if (url.protocol === 'file:') {
      return undefined;
    }
    return { host: url.host.replace(/^.*@/, ''), pathname: normalisePath(url.pathname) };
  } catch {
    return undefined;
  }
}

function normalisePath(pathname: string): string {
  const cleaned = pathname.replace(/^\/+/, '').replace(/\.git\/?$/, '').replace(/\/+$/, '');
  return cleaned ? `/${cleaned}` : '';
}
