import * as path from 'path';
import { GitError, type CancellationLike, type GitExecutor } from './gitExecutor';
import { LOG_FORMAT, parseCommitDetail, parseLog } from './parseLog';
import type { CommitDetail, HistoryPage, HistoryQuery } from './types';

/**
 * The git commands behind the view. Deliberately free of any `vscode` import so
 * this layer can be tested directly against a real repository.
 */

/**
 * Loads one page of a file's history.
 *
 * Paging resumes from a concrete commit instead of using `--skip`, which would
 * make git re-walk the history from HEAD for every page. One extra commit is
 * requested so we learn whether more exists - and get the next cursor - without
 * a second round trip.
 */
export async function loadHistoryPage(
  executor: GitExecutor,
  query: HistoryQuery,
  token?: CancellationLike
): Promise<HistoryPage> {
  const walkPath = query.cursor?.path ?? query.path;
  const args = ['log', `--format=${LOG_FORMAT}`, '-z', '--raw', '--numstat', `-n${query.limit + 1}`];

  if (query.follow) {
    args.push('--follow');
  }
  if (query.search?.text) {
    if (query.search.mode === 'content') {
      // Literal pickaxe: the search box holds a plain string, not a regex, so
      // characters like `(` never turn into a git error.
      args.push(`-S${query.search.text}`);
    } else {
      args.push('--regexp-ignore-case', `--grep=${query.search.text}`);
    }
  }
  if (query.cursor) {
    args.push(query.cursor.fromRef);
  }
  args.push('--', walkPath);

  const stdout = await executor.run(args, { cwd: query.repoRoot, token });
  const commits = parseLog(stdout, walkPath);

  if (commits.length <= query.limit) {
    return { commits, hasMore: false };
  }

  const next = commits[query.limit];
  return {
    commits: commits.slice(0, query.limit),
    hasMore: true,
    // The next walk starts at `next` itself, using the name the file had at
    // that point, so a rename inside this page does not break the cursor.
    cursor: { fromRef: next.hash, path: next.path || walkPath }
  };
}

/**
 * Loads one commit in full: its metadata and every file it touched, not just
 * the file whose history is on screen.
 *
 * `-m --first-parent` makes a merge report the changes it brought in relative
 * to its first parent; without it `git log` shows a merge as touching nothing.
 */
export async function readCommitDetail(
  executor: GitExecutor,
  root: string,
  hash: string,
  limit: number,
  token?: CancellationLike
): Promise<CommitDetail | undefined> {
  const stdout = await executor.run(
    ['log', '-1', `--format=${LOG_FORMAT}`, '-z', '--raw', '--numstat', '-m', '--first-parent', hash, '--'],
    { cwd: root, token }
  );
  return parseCommitDetail(stdout, limit);
}

/**
 * Reads a file's contents at a revision.
 *
 * A path that is absent at that revision - the commit that added the file, or
 * one that deleted it - reads as empty by default, which is how a diff renders
 * the missing side. Callers that need to tell "absent" from "empty" pass
 * `missingAsEmpty: false` and handle the {@link GitError}.
 */
export async function readFileAtCommit(
  executor: GitExecutor,
  root: string,
  ref: string,
  relativePath: string,
  token?: CancellationLike,
  options?: { missingAsEmpty?: boolean }
): Promise<Buffer> {
  try {
    return await executor.runRaw(['show', `${ref}:${relativePath}`], { cwd: root, token });
  } catch (error) {
    if (error instanceof GitError && options?.missingAsEmpty !== false) {
      return Buffer.alloc(0);
    }
    throw error;
  }
}

/** Finds the repository root containing `directory`, or `undefined`. */
export async function findRepositoryRoot(
  executor: GitExecutor,
  directory: string,
  token?: CancellationLike
): Promise<string | undefined> {
  try {
    const output = await executor.run(['rev-parse', '--show-toplevel'], { cwd: directory, token });
    const trimmed = output.trim();
    return trimmed ? path.normalize(trimmed) : undefined;
  } catch (error) {
    if (error instanceof GitError) {
      return undefined;
    }
    throw error;
  }
}

/** True when git tracks the path at HEAD. */
export async function isTracked(
  executor: GitExecutor,
  root: string,
  relativePath: string,
  token?: CancellationLike
): Promise<boolean> {
  try {
    const output = await executor.run(['ls-files', '--error-unmatch', '--', relativePath], { cwd: root, token });
    return output.trim().length > 0;
  } catch {
    return false;
  }
}

/** The URL of `origin`, or of the first remote when there is no origin. */
export async function readRemoteUrl(
  executor: GitExecutor,
  root: string,
  token?: CancellationLike
): Promise<string | undefined> {
  try {
    return pickRemote(await executor.run(['remote', '-v'], { cwd: root, token }));
  } catch {
    return undefined;
  }
}

/** The current branch name, or `undefined` on a detached HEAD. */
export async function readCurrentBranch(
  executor: GitExecutor,
  root: string,
  token?: CancellationLike
): Promise<string | undefined> {
  try {
    const output = await executor.run(['symbolic-ref', '--short', '-q', 'HEAD'], { cwd: root, token });
    return output.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Picks `origin` from `git remote -v` output, else the first remote listed. */
export function pickRemote(output: string): string | undefined {
  let fallback: string | undefined;
  for (const line of output.split('\n')) {
    const match = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(line.trim());
    if (!match) {
      continue;
    }
    const [, name, url] = match;
    if (name === 'origin') {
      return url;
    }
    fallback ??= url;
  }
  return fallback;
}
