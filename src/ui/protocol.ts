import type { CommitEntry } from '../git/types';

/** Everything the webview needs to render its header. */
export interface FileContext {
  /** Serialised URI of the file on disk, used to restore the panel. */
  uri: string;
  /** File name shown as the title. */
  fileName: string;
  /** Repository-relative path. */
  relativePath: string;
  /** Repository folder name. */
  repositoryName: string;
  /** Current branch, when HEAD is attached. */
  branch?: string;
  /** Whether "Open on remote" can work for this repository. */
  hasRemote: boolean;
}

export type LoadState = 'loading' | 'ready' | 'empty' | 'untracked' | 'no-repository' | 'error';

/** Messages sent from the extension to the webview. */
export type ToWebview =
  | { type: 'context'; file: FileContext; followRenames: boolean }
  | { type: 'state'; state: LoadState; message?: string }
  | { type: 'commits'; commits: CommitEntry[]; hasMore: boolean; append: boolean; token: number }
  | { type: 'stale'; stale: boolean }
  | { type: 'reset' };

/** Messages sent from the webview to the extension. */
export type FromWebview =
  | { type: 'ready' }
  | { type: 'loadMore' }
  | { type: 'refresh' }
  | { type: 'search'; text: string; mode: 'message' | 'content' }
  | { type: 'openDiff'; hash: string }
  | { type: 'openFile'; hash: string }
  | { type: 'compareWithWorkingTree'; hash: string }
  | { type: 'copySha'; hash: string }
  | { type: 'copyMessage'; hash: string }
  | { type: 'openRemote'; hash: string }
  | { type: 'openCurrentFile' };
