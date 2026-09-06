import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GitCancelledError, GitError, GitExecutor } from '../../src/git/gitExecutor';
import {
  findRepositoryRoot,
  isTracked,
  loadHistoryPage,
  pickRemote,
  readCurrentBranch,
  readFileAtCommit,
  readRemoteUrl
} from '../../src/git/history';
import type { HistoryCursor } from '../../src/git/types';

/**
 * These tests drive the real `git` binary against a scratch repository. They
 * are the ones that would catch a change in git's output format, which no
 * amount of fixture-based testing can.
 */

const executor = new GitExecutor('git');
let repo: string;

/**
 * The module used throughout. It is deliberately several lines long: git only
 * reports a rename when the two blobs are similar enough, so a one-line file
 * would make the `--follow` tests depend on the rename score.
 */
function moduleSource(answer: number, extraLine = ''): string {
  return [
    `export const answer = ${answer};`,
    'export const label = "demo";',
    'export function describeAnswer() {',
    '  return `${label}: ${answer}`;',
    '}',
    'export const extra = [1, 2, 3];',
    'export const flag = true;',
    'export default describeAnswer;',
    extraLine
  ]
    .filter((line, index, all) => line !== '' || index < all.length - 1)
    .join('\n')
    .concat('\n');
}

const INITIAL_LINE_COUNT = 8;

function git(...args: string[]): void {
  execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
}

function write(relativePath: string, contents: string): void {
  const target = path.join(repo, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}

function commit(message: string): void {
  git('add', '-A');
  git('commit', '-q', '-m', message);
}

before(function () {
  this.timeout(60000);
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gfh-test-'));
  git('init', '-q', '-b', 'main', '.');
  git('config', 'user.name', 'Ada Lovelace');
  git('config', 'user.email', 'ada@example.com');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.autocrlf', 'false');
  git('remote', 'add', 'origin', 'git@github.com:example/demo.git');

  write('src/old-name.ts', moduleSource(41));
  write('README.md', '# Demo\n');
  commit('Initial commit');

  write('src/old-name.ts', moduleSource(42));
  commit('Correct the answer\n\nIt was off by one.');

  git('mv', 'src/old-name.ts', 'src/new-name.ts');
  write('src/new-name.ts', moduleSource(42, '// moved into place'));
  commit('Rename module and add a note');
  git('tag', 'v1.0.0');

  for (let i = 0; i < 6; i++) {
    write('src/new-name.ts', moduleSource(42, `// note ${i}`));
    commit(`Adjust note ${i}`);
  }
});

after(() => {
  if (repo) {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

describe('findRepositoryRoot', () => {
  it('finds the root from a nested directory', async () => {
    const root = await findRepositoryRoot(executor, path.join(repo, 'src'));
    assert.ok(root);
    assert.strictEqual(fs.realpathSync(root!), fs.realpathSync(repo));
  });

  it('returns nothing outside a repository', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'gfh-plain-'));
    try {
      assert.strictEqual(await findRepositoryRoot(executor, outside), undefined);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('loadHistoryPage', () => {
  const base = { follow: true, limit: 50 };

  it('returns the whole history newest first', async () => {
    const page = await loadHistoryPage(executor, { ...base, repoRoot: repo, path: 'src/new-name.ts' });
    assert.strictEqual(page.hasMore, false);
    assert.strictEqual(page.commits.length, 9);
    assert.strictEqual(page.commits[0].subject, 'Adjust note 5');
    assert.strictEqual(page.commits[8].subject, 'Initial commit');
  });

  it('follows the file across the rename', async () => {
    const page = await loadHistoryPage(executor, { ...base, repoRoot: repo, path: 'src/new-name.ts' });
    const rename = page.commits.find((entry) => entry.status === 'renamed');
    assert.ok(rename, 'expected a renamed commit');
    assert.strictEqual(rename!.previousPath, 'src/old-name.ts');
    assert.strictEqual(rename!.path, 'src/new-name.ts');
    // Commits from before the rename report the old path.
    assert.strictEqual(page.commits[page.commits.length - 1].path, 'src/old-name.ts');
  });

  it('stops at the rename when following is disabled', async () => {
    const page = await loadHistoryPage(executor, {
      ...base,
      follow: false,
      repoRoot: repo,
      path: 'src/new-name.ts'
    });
    assert.ok(page.commits.every((entry) => entry.path === 'src/new-name.ts'));
    assert.ok(page.commits.length < 9);
  });

  it('reports the first commit as an addition with line counts', async () => {
    const page = await loadHistoryPage(executor, { ...base, repoRoot: repo, path: 'src/new-name.ts' });
    const first = page.commits[page.commits.length - 1];
    assert.strictEqual(first.status, 'added');
    assert.strictEqual(first.insertions, INITIAL_LINE_COUNT);
    assert.strictEqual(first.deletions, 0);
    assert.deepStrictEqual(first.parents, []);
  });

  it('exposes decorations for tagged commits', async () => {
    const page = await loadHistoryPage(executor, { ...base, repoRoot: repo, path: 'src/new-name.ts' });
    const tagged = page.commits.find((entry) => entry.refs.some((ref) => ref.kind === 'tag'));
    assert.ok(tagged);
    assert.strictEqual(tagged!.refs.find((ref) => ref.kind === 'tag')!.name, 'v1.0.0');
  });

  it('pages through the history without repeating or losing commits', async () => {
    const collected: string[] = [];
    let cursor: HistoryCursor | undefined;
    let pages = 0;

    do {
      const page = await loadHistoryPage(executor, {
        ...base,
        limit: 2,
        repoRoot: repo,
        path: 'src/new-name.ts',
        cursor
      });
      collected.push(...page.commits.map((entry) => entry.hash));
      cursor = page.cursor;
      pages++;
      assert.ok(pages < 20, 'paging did not terminate');
    } while (cursor);

    const full = await loadHistoryPage(executor, { ...base, repoRoot: repo, path: 'src/new-name.ts' });
    assert.deepStrictEqual(collected, full.commits.map((entry) => entry.hash));
    assert.strictEqual(new Set(collected).size, collected.length);
  });

  it('keeps the cursor valid across the rename boundary', async () => {
    // A page size of 3 puts the rename commit at a page edge.
    let cursor: HistoryCursor | undefined;
    const paths: string[] = [];
    do {
      const page = await loadHistoryPage(executor, {
        ...base,
        limit: 3,
        repoRoot: repo,
        path: 'src/new-name.ts',
        cursor
      });
      paths.push(...page.commits.map((entry) => entry.path));
      cursor = page.cursor;
    } while (cursor);
    assert.ok(paths.includes('src/old-name.ts'), 'history before the rename was lost');
  });

  it('searches commit messages', async () => {
    const page = await loadHistoryPage(executor, {
      ...base,
      repoRoot: repo,
      path: 'src/new-name.ts',
      search: { text: 'RENAME', mode: 'message' }
    });
    assert.strictEqual(page.commits.length, 1);
    assert.strictEqual(page.commits[0].subject, 'Rename module and add a note');
  });

  it('searches changed content with the pickaxe', async () => {
    const page = await loadHistoryPage(executor, {
      ...base,
      repoRoot: repo,
      path: 'src/new-name.ts',
      search: { text: 'answer = 41', mode: 'content' }
    });
    assert.deepStrictEqual(
      page.commits.map((entry) => entry.subject),
      ['Correct the answer', 'Initial commit']
    );
  });

  it('treats a search with regex characters as literal text', async () => {
    const page = await loadHistoryPage(executor, {
      ...base,
      repoRoot: repo,
      path: 'src/new-name.ts',
      search: { text: 'answer = (41', mode: 'content' }
    });
    assert.strictEqual(page.commits.length, 0);
  });

  it('returns an empty page for a path with no history', async () => {
    const page = await loadHistoryPage(executor, { ...base, repoRoot: repo, path: 'src/does-not-exist.ts' });
    assert.deepStrictEqual(page.commits, []);
    assert.strictEqual(page.hasMore, false);
  });

  it('surfaces git failures as GitError', async () => {
    await assert.rejects(
      () => loadHistoryPage(executor, { ...base, repoRoot: repo, path: 'a.ts', cursor: { fromRef: 'nope', path: 'a.ts' } }),
      GitError
    );
  });

  it('rejects with GitCancelledError when cancelled up front', async () => {
    const token = { isCancellationRequested: true, onCancellationRequested: () => ({ dispose() {} }) };
    await assert.rejects(
      () => loadHistoryPage(executor, { ...base, repoRoot: repo, path: 'src/new-name.ts' }, token),
      GitCancelledError
    );
  });
});

describe('readFileAtCommit', () => {
  it('reads the contents at a revision', async () => {
    const page = await loadHistoryPage(executor, {
      follow: true,
      limit: 50,
      repoRoot: repo,
      path: 'src/new-name.ts'
    });
    const initial = page.commits[page.commits.length - 1];
    const contents = await readFileAtCommit(executor, repo, initial.hash, initial.path);
    assert.strictEqual(contents.toString('utf8'), moduleSource(41));
  });

  it('returns empty bytes when the path is absent at that revision', async () => {
    const contents = await readFileAtCommit(executor, repo, 'HEAD', 'src/never-existed.ts');
    assert.strictEqual(contents.length, 0);
  });
});

describe('repository metadata', () => {
  it('reports tracked and untracked paths', async () => {
    assert.strictEqual(await isTracked(executor, repo, 'src/new-name.ts'), true);
    assert.strictEqual(await isTracked(executor, repo, 'src/nope.ts'), false);
  });

  it('reads the current branch', async () => {
    assert.strictEqual(await readCurrentBranch(executor, repo), 'main');
  });

  it('reads the origin remote', async () => {
    assert.strictEqual(await readRemoteUrl(executor, repo), 'git@github.com:example/demo.git');
  });
});

describe('pickRemote', () => {
  it('prefers origin', () => {
    const output = [
      'upstream\thttps://example.com/up.git (fetch)',
      'upstream\thttps://example.com/up.git (push)',
      'origin\thttps://example.com/origin.git (fetch)',
      'origin\thttps://example.com/origin.git (push)'
    ].join('\n');
    assert.strictEqual(pickRemote(output), 'https://example.com/origin.git');
  });

  it('falls back to the first remote', () => {
    assert.strictEqual(pickRemote('fork\thttps://example.com/fork.git (fetch)'), 'https://example.com/fork.git');
  });

  it('returns nothing when there are no remotes', () => {
    assert.strictEqual(pickRemote(''), undefined);
  });
});

describe('GitExecutor', () => {
  it('reports a missing binary with actionable guidance', async () => {
    const missing = new GitExecutor(path.join(os.tmpdir(), 'definitely-not-git'));
    await assert.rejects(
      () => missing.run(['--version'], { cwd: os.tmpdir() }),
      (error: unknown) => error instanceof GitError && /Make sure git is installed/.test((error as Error).message)
    );
  });
});
