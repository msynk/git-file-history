import * as vscode from 'vscode';
import type { GitService } from './gitService';

/** Scheme for read-only documents backed by `git show`. */
export const HISTORY_SCHEME = 'git-file-history';

interface HistoryUriPayload {
  /** Repository root. */
  root: string;
  /** Commit-ish to read from. */
  ref: string;
  /** Repository-relative path at that ref. */
  path: string;
}

/**
 * Builds a URI whose contents are the file as it existed at `ref`.
 *
 * The repository-relative path is kept in the URI path so VS Code can pick the
 * right language mode and show a meaningful name; the payload rides along in
 * the query.
 */
export function toHistoryUri(payload: HistoryUriPayload): vscode.Uri {
  return vscode.Uri.from({
    scheme: HISTORY_SCHEME,
    path: `/${payload.path.replace(/^\/+/, '')}`,
    query: JSON.stringify(payload)
  });
}

/**
 * Serves historical file contents. Results are cached per URI: a commit's
 * content is immutable, so the same diff never re-runs `git show`.
 */
export class HistoryContentProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  /** Bounded so browsing a long history cannot grow memory without limit. */
  private static readonly CACHE_LIMIT = 64;

  private readonly cache = new Map<string, string>();
  private readonly registration: vscode.Disposable;

  /**
   * @param git Resolved on first use, so registering the provider at activation
   * does not pull in the git binary before anything needs it.
   */
  constructor(private readonly git: () => Promise<GitService>) {
    this.registration = vscode.workspace.registerTextDocumentContentProvider(HISTORY_SCHEME, this);
  }

  dispose(): void {
    this.registration.dispose();
    this.cache.clear();
  }

  async provideTextDocumentContent(uri: vscode.Uri, token: vscode.CancellationToken): Promise<string> {
    const key = uri.toString();
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      return cached;
    }

    let payload: HistoryUriPayload;
    try {
      payload = JSON.parse(uri.query) as HistoryUriPayload;
    } catch {
      return '';
    }

    // An empty ref means "the file does not exist on this side of the diff",
    // which is how an addition or a deletion is rendered.
    if (!payload.ref) {
      return '';
    }

    const git = await this.git();
    const buffer = await git.getFileAtCommit(payload.root, payload.ref, payload.path, token);
    const content = buffer.toString('utf8');

    if (this.cache.size >= HistoryContentProvider.CACHE_LIMIT) {
      // Simple FIFO eviction: history browsing is sequential, so the oldest
      // entry is the least likely to be revisited.
      const oldest = this.cache.keys().next();
      if (!oldest.done) {
        this.cache.delete(oldest.value);
      }
    }
    this.cache.set(key, content);
    return content;
  }
}
