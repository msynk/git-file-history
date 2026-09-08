import type { CommitDetail, CommitEntry, FileChangeStatus } from '../git/types';

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

/** Why a preview has no text to show, or `text` when it does. */
export type PreviewKind = 'text' | 'binary' | 'missing' | 'error';

/** The file as it stood at one commit, ready to be rendered as-is. */
export interface PreviewResult {
  /** Commit the preview was requested for. */
  hash: string;
  /** Path the file had at that commit. */
  path: string;
  status: FileChangeStatus;
  kind: PreviewKind;
  /** File contents, present only when `kind` is `text`. */
  content?: string;
  /** Lines actually sent in `content`. */
  lines?: number;
  /** Byte size of the blob before any truncation. */
  bytes?: number;
  /** True when `content` stops short of the end of the file. */
  truncated?: boolean;
  /**
   * True when the commit deleted the file, so the contents come from its
   * parent - the last state the file had before disappearing.
   */
  fromParent?: boolean;
  /** Explanation shown for `binary`, `missing` and `error`. */
  message?: string;
}

/** Every file one commit touched, or why they could not be listed. */
export interface CommitDetailResult {
  hash: string;
  /** Absent when git could not report the commit. */
  detail?: CommitDetail;
  /** Explanation shown in place of the file list. */
  error?: string;
}

/** Messages sent from the extension to the webview. */
export type ToWebview =
  | { type: 'context'; file: FileContext; followRenames: boolean }
  | { type: 'state'; state: LoadState; message?: string }
  | { type: 'commits'; commits: CommitEntry[]; hasMore: boolean; append: boolean; token: number }
  | { type: 'stale'; stale: boolean }
  | { type: 'preview'; preview: PreviewResult }
  | { type: 'commitDetail'; result: CommitDetailResult }
  | { type: 'reset' };

/** Messages sent from the webview to the extension. */
export type FromWebview =
  | { type: 'ready' }
  | { type: 'loadMore' }
  | { type: 'refresh' }
  | { type: 'search'; text: string; mode: 'message' | 'content' }
  | { type: 'preview'; hash: string }
  | { type: 'openDiff'; hash: string }
  | { type: 'openFile'; hash: string }
  | { type: 'compareWithWorkingTree'; hash: string }
  /** Diff the file between two arbitrary commits from the list. */
  | { type: 'compareCommits'; base: string; target: string }
  /** List every file the commit touched, not just the one on screen. */
  | { type: 'commitDetail'; hash: string }
  /** Diff one of those files against the state it had in the parent commit. */
  | { type: 'openCommitFileDiff'; hash: string; path: string; previousPath?: string; status: FileChangeStatus }
  | { type: 'copySha'; hash: string }
  | { type: 'copyMessage'; hash: string }
  | { type: 'openRemote'; hash: string }
  | { type: 'openCurrentFile' };
