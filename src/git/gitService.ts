import * as path from 'path';
import * as vscode from 'vscode';
import { getBuiltInGitApi, type BuiltInGitApi } from './builtInGit';
import { GitExecutor } from './gitExecutor';
import {
  findRepositoryRoot,
  isTracked,
  loadHistoryPage,
  readCurrentBranch,
  readFileAtCommit,
  readRemoteUrl
} from './history';
import type { HistoryPage, HistoryQuery } from './types';
import { comparablePath, isSameOrInside, toRelativePosixPath } from '../util/paths';

/** Bounds the memory the directory-to-root cache can use. */
const REPO_CACHE_LIMIT = 512;

export interface RepositoryContext {
  /** Absolute repository root with platform separators. */
  root: string;
  /** File path relative to {@link root}, using forward slashes. */
  relativePath: string;
}

/**
 * The extension's single entry point to git.
 *
 * Its job on top of {@link ./history} is caching: repository discovery and
 * remote lookups are memoised so opening history repeatedly - the common case -
 * spawns git only for the log itself.
 */
export class GitService implements vscode.Disposable {
  private readonly rootByDirectory = new Map<string, string | null>();
  private readonly remoteByRoot = new Map<string, string | null>();
  private readonly disposables: vscode.Disposable[] = [];

  private constructor(
    private readonly executor: GitExecutor,
    private readonly builtIn: BuiltInGitApi | undefined
  ) {
    if (builtIn) {
      // Opening or closing a repository can change which root a file belongs to
      // (submodules, freshly cloned folders), so drop the memoised answers.
      this.disposables.push(
        builtIn.onDidOpenRepository(() => this.clearCaches()),
        builtIn.onDidCloseRepository(() => this.clearCaches())
      );
    }
  }

  static async create(): Promise<GitService> {
    const builtIn = await getBuiltInGitApi();
    // Honour the user's `git.path` setting by reusing the binary VS Code found.
    return new GitService(new GitExecutor(builtIn?.git.path || 'git'), builtIn);
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
    this.clearCaches();
  }

  clearCaches(): void {
    this.rootByDirectory.clear();
    this.remoteByRoot.clear();
  }

  /**
   * Finds the repository a file belongs to. Answers from the built-in git
   * extension when it already knows the root, so the common case costs no
   * process at all.
   */
  async resolveRepository(
    uri: vscode.Uri,
    token?: vscode.CancellationToken
  ): Promise<RepositoryContext | undefined> {
    if (uri.scheme !== 'file') {
      return undefined;
    }
    const filePath = path.normalize(uri.fsPath);
    const directory = path.dirname(filePath);

    const known = this.findKnownRoot(directory);
    if (known !== undefined) {
      return known === null ? undefined : toContext(known, filePath);
    }

    const root = (await findRepositoryRoot(this.executor, directory, token)) ?? null;
    this.rememberRoot(directory, root);
    return root === null ? undefined : toContext(root, filePath);
  }

  /** Loads one page of history for a file. */
  getHistory(query: HistoryQuery, token?: vscode.CancellationToken): Promise<HistoryPage> {
    return loadHistoryPage(this.executor, query, token);
  }

  /**
   * Reads a file's contents at a commit. Empty when it does not exist there,
   * unless `missingAsEmpty: false` asks for the git error instead.
   */
  getFileAtCommit(
    root: string,
    ref: string,
    relativePath: string,
    token?: vscode.CancellationToken,
    options?: { missingAsEmpty?: boolean }
  ): Promise<Buffer> {
    return readFileAtCommit(this.executor, root, ref, relativePath, token, options);
  }

  isTracked(root: string, relativePath: string, token?: vscode.CancellationToken): Promise<boolean> {
    return isTracked(this.executor, root, relativePath, token);
  }

  getCurrentBranch(root: string, token?: vscode.CancellationToken): Promise<string | undefined> {
    return readCurrentBranch(this.executor, root, token);
  }

  /** The repository's remote URL. Cached: it effectively never changes. */
  async getRemoteUrl(root: string, token?: vscode.CancellationToken): Promise<string | undefined> {
    const cached = this.remoteByRoot.get(root);
    if (cached !== undefined) {
      return cached ?? undefined;
    }
    const url = (await readRemoteUrl(this.executor, root, token)) ?? null;
    this.remoteByRoot.set(root, url);
    return url ?? undefined;
  }

  /**
   * Looks for a root we already know, walking up from `directory`.
   *
   * Returns `undefined` when nothing is known yet, `null` when we have already
   * established the directory is not in a repository.
   */
  private findKnownRoot(directory: string): string | null | undefined {
    // Longest match wins so a file inside a submodule resolves to the submodule
    // rather than to the outer repository.
    let best: string | undefined;
    for (const repository of this.builtIn?.repositories ?? []) {
      const root = path.normalize(repository.rootUri.fsPath);
      if (isSameOrInside(root, directory) && (!best || root.length > best.length)) {
        best = root;
      }
    }
    if (best) {
      return best;
    }
    // Only exact directories are memoised: an ancestor's root is not reliably
    // the answer for a nested directory, which may sit in a submodule.
    return this.rootByDirectory.get(comparablePath(directory));
  }

  private rememberRoot(directory: string, root: string | null): void {
    if (this.rootByDirectory.size >= REPO_CACHE_LIMIT) {
      this.rootByDirectory.clear();
    }
    this.rootByDirectory.set(comparablePath(directory), root);
  }
}

function toContext(root: string, filePath: string): RepositoryContext {
  return { root, relativePath: toRelativePosixPath(root, filePath) };
}
