/** Shared data shapes used by the git layer and the webview. */

/** How a file changed in a single commit. */
export type FileChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed';

/** One commit that touched the file being inspected. */
export interface CommitEntry {
  /** Full 40-character commit hash. */
  hash: string;
  /** Abbreviated hash as produced by git (respects `core.abbrev`). */
  shortHash: string;
  /** Parent hashes, oldest-first as reported by git. Empty for a root commit. */
  parents: string[];
  authorName: string;
  authorEmail: string;
  /** Author time, milliseconds since epoch. */
  authorDate: number;
  committerName: string;
  committerEmail: string;
  /** Commit time, milliseconds since epoch. */
  commitDate: number;
  /** First line of the commit message. */
  subject: string;
  /** Remaining lines of the commit message, trimmed. May be empty. */
  body: string;
  /** Decorations such as `HEAD -> main`, `tag: v1.0`, `origin/main`. */
  refs: RefInfo[];
  /** Path of the file as of this commit, relative to the repository root. */
  path: string;
  /** Previous path when this commit renamed the file, otherwise `undefined`. */
  previousPath?: string;
  status: FileChangeStatus;
  /** Added lines, or `undefined` for binary files. */
  insertions?: number;
  /** Removed lines, or `undefined` for binary files. */
  deletions?: number;
}

export type RefKind = 'head' | 'branch' | 'remote' | 'tag';

export interface RefInfo {
  kind: RefKind;
  name: string;
}

/**
 * Where to resume a walk. We resume from a concrete commit rather than using
 * `--skip`, so paging stays proportional to the page size instead of
 * re-walking from HEAD every time.
 */
export interface HistoryCursor {
  /** Commit to start the next walk from. */
  fromRef: string;
  /** Path the file had at `fromRef`. Renames make this differ from the original. */
  path: string;
}

/** A page of history plus the cursor needed to fetch the next page. */
export interface HistoryPage {
  commits: CommitEntry[];
  /** True when more commits are known to exist beyond this page. */
  hasMore: boolean;
  /** Opaque cursor for the next request. `undefined` when history is exhausted. */
  cursor?: HistoryCursor;
}

/** How the search box is applied when git runs it across the whole history. */
export interface HistorySearch {
  text: string;
  /** `message` maps to `--grep`, `content` to the `-S` pickaxe. */
  mode: 'message' | 'content';
}

export interface HistoryQuery {
  /** Repository root, absolute. */
  repoRoot: string;
  /** File path relative to `repoRoot`, using forward slashes. */
  path: string;
  /** Maximum commits to return. */
  limit: number;
  /** Follow the file across renames. */
  follow: boolean;
  /** Resume point produced by a previous page. */
  cursor?: HistoryCursor;
  /** Server-side search executed by git across the whole history. */
  search?: HistorySearch;
}
