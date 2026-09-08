import * as assert from 'assert';
import { LOG_FORMAT, parseCommitDetail, parseLog, parseRefs } from '../../src/git/parseLog';

/** Builds a record the way `git log -z --raw --numstat` would emit it. */
function record(options: {
  hash?: string;
  short?: string;
  parents?: string;
  author?: string;
  email?: string;
  at?: number;
  decorations?: string;
  message: string;
  diff?: string;
}): string {
  const fields = [
    options.hash ?? 'a'.repeat(40),
    options.short ?? 'aaaaaaa',
    options.parents ?? 'b'.repeat(40),
    options.author ?? 'Ada Lovelace',
    options.email ?? 'ada@example.com',
    String(options.at ?? 1700000000),
    options.author ?? 'Ada Lovelace',
    options.email ?? 'ada@example.com',
    String(options.at ?? 1700000000),
    options.decorations ?? '',
    options.message
  ];
  return `\x01${fields.join('\x1f')}\x00${options.diff ?? ''}`;
}

describe('LOG_FORMAT', () => {
  it('asks git for every field the parser reads', () => {
    assert.strictEqual(LOG_FORMAT.split('\x1f').length, 11);
    assert.ok(LOG_FORMAT.startsWith('\x01%H'));
    assert.ok(LOG_FORMAT.endsWith('%B'));
  });
});

describe('parseLog', () => {
  it('returns nothing for empty output', () => {
    assert.deepStrictEqual(parseLog(''), []);
    assert.deepStrictEqual(parseLog('\n'), []);
  });

  it('parses a plain modification', () => {
    const commits = parseLog(
      record({
        message: 'Fix the thing',
        diff: '\n:100644 100644 aaa bbb M\x00src/a.ts\x005\t2\tsrc/a.ts\x00'
      })
    );

    assert.strictEqual(commits.length, 1);
    const [commit] = commits;
    assert.strictEqual(commit.subject, 'Fix the thing');
    assert.strictEqual(commit.body, '');
    assert.strictEqual(commit.status, 'modified');
    assert.strictEqual(commit.path, 'src/a.ts');
    assert.strictEqual(commit.insertions, 5);
    assert.strictEqual(commit.deletions, 2);
    assert.strictEqual(commit.authorDate, 1700000000000);
    assert.deepStrictEqual(commit.parents, ['b'.repeat(40)]);
  });

  it('splits subject from body and trims trailing whitespace', () => {
    const [commit] = parseLog(
      record({
        message: 'Add feature\n\nWhy this matters.\nSecond line.\n\n',
        diff: '\n:000000 100644 000 ccc A\x00src/a.ts\x0010\t0\tsrc/a.ts\x00'
      })
    );
    assert.strictEqual(commit.subject, 'Add feature');
    assert.strictEqual(commit.body, 'Why this matters.\nSecond line.');
    assert.strictEqual(commit.status, 'added');
  });

  it('reads a rename, including the previous path', () => {
    const [commit] = parseLog(
      record({
        message: 'Move it',
        diff: '\n:100644 100644 aaa bbb R095\x00old/a.ts\x00new/a.ts\x003\t1\t\x00old/a.ts\x00new/a.ts\x00'
      })
    );
    assert.strictEqual(commit.status, 'renamed');
    assert.strictEqual(commit.previousPath, 'old/a.ts');
    assert.strictEqual(commit.path, 'new/a.ts');
    assert.strictEqual(commit.insertions, 3);
    assert.strictEqual(commit.deletions, 1);
  });

  it('reads a deletion', () => {
    const [commit] = parseLog(
      record({ message: 'Remove it', diff: '\n:100644 000000 aaa 000 D\x00src/a.ts\x000\t9\tsrc/a.ts\x00' })
    );
    assert.strictEqual(commit.status, 'deleted');
    assert.strictEqual(commit.deletions, 9);
  });

  it('marks binary files as having no line counts', () => {
    const [commit] = parseLog(
      record({ message: 'Add logo', diff: '\n:000000 100644 000 ccc A\x00logo.png\x00-\t-\tlogo.png\x00' })
    );
    assert.strictEqual(commit.insertions, undefined);
    assert.strictEqual(commit.deletions, undefined);
    assert.strictEqual(commit.path, 'logo.png');
  });

  it('falls back to the requested path when a commit has no diff section', () => {
    const [commit] = parseLog(record({ message: 'Merge branch', parents: `${'b'.repeat(40)} ${'c'.repeat(40)}` }), 'src/a.ts');
    assert.strictEqual(commit.path, 'src/a.ts');
    assert.strictEqual(commit.parents.length, 2);
    assert.strictEqual(commit.insertions, undefined);
  });

  it('handles a root commit with no parents', () => {
    const [commit] = parseLog(
      record({ parents: '', message: 'Initial', diff: '\n:000000 100644 000 ccc A\x00a.ts\x001\t0\ta.ts\x00' })
    );
    assert.deepStrictEqual(commit.parents, []);
  });

  it('parses several commits in one stream', () => {
    const stream =
      record({ hash: 'a'.repeat(40), message: 'One', diff: '\n:100644 100644 a b M\x00a.ts\x001\t1\ta.ts\x00' }) +
      record({ hash: 'c'.repeat(40), message: 'Two', diff: '\n:100644 100644 a b M\x00a.ts\x002\t2\ta.ts\x00' });
    const commits = parseLog(stream);
    assert.deepStrictEqual(
      commits.map((commit) => commit.subject),
      ['One', 'Two']
    );
  });

  it('does not split a record on a control byte inside a commit message', () => {
    const commits = parseLog(
      record({
        message: 'Weird \x01 subject\n\nBody with \x1f separator',
        diff: '\n:100644 100644 a b M\x00a.ts\x001\t1\ta.ts\x00'
      })
    );
    assert.strictEqual(commits.length, 1);
    assert.strictEqual(commits[0].subject, 'Weird \x01 subject');
    assert.strictEqual(commits[0].body, 'Body with \x1f separator');
  });

  it('keeps tabs that belong to a path', () => {
    const [commit] = parseLog(
      record({ message: 'Odd name', diff: '\n:100644 100644 a b M\x00od\td.ts\x001\t1\tod\td.ts\x00' })
    );
    assert.strictEqual(commit.path, 'od\td.ts');
  });
});

describe('parseRefs', () => {
  it('returns nothing when there are no decorations', () => {
    assert.deepStrictEqual(parseRefs(''), []);
  });

  it('classifies heads, branches, remotes and tags', () => {
    assert.deepStrictEqual(parseRefs('HEAD -> main, origin/main, tag: v1.2.0, develop'), [
      { kind: 'head', name: 'main' },
      { kind: 'remote', name: 'origin/main' },
      { kind: 'tag', name: 'v1.2.0' },
      { kind: 'branch', name: 'develop' }
    ]);
  });

  it('handles a detached HEAD', () => {
    assert.deepStrictEqual(parseRefs('HEAD, tag: v2'), [
      { kind: 'head', name: 'HEAD' },
      { kind: 'tag', name: 'v2' }
    ]);
  });
});

describe('parseCommitDetail', () => {
  /** The raw and numstat sections git emits for a commit touching four files. */
  const DIFF =
    '\n' +
    ':000000 100644 000 aaa A\x00added.txt\x00' +
    ':100644 000000 bbb 000 D\x00blob.bin\x00' +
    ':100644 100644 ccc ccc R100\x00old.txt\x00dir/new name.txt\x00' +
    ':100644 100644 ddd eee M\x00keep.txt\x00' +
    '1\t0\tadded.txt\x00' +
    '-\t-\tblob.bin\x00' +
    '0\t0\t\x00old.txt\x00dir/new name.txt\x00' +
    '3\t1\tkeep.txt\x00';

  it('returns nothing for output git produced no record for', () => {
    assert.strictEqual(parseCommitDetail(''), undefined);
    assert.strictEqual(parseCommitDetail('not a record'), undefined);
  });

  it('keeps every file the commit touched, with its status and line counts', () => {
    const detail = parseCommitDetail(record({ message: 'Restructure', diff: DIFF }));

    assert.ok(detail);
    assert.strictEqual(detail!.subject, 'Restructure');
    assert.strictEqual(detail!.fileCount, 4);
    assert.deepStrictEqual(detail!.files, [
      { path: 'added.txt', previousPath: undefined, status: 'added', insertions: 1, deletions: 0 },
      { path: 'blob.bin', previousPath: undefined, status: 'deleted', insertions: undefined, deletions: undefined },
      { path: 'dir/new name.txt', previousPath: 'old.txt', status: 'renamed', insertions: 0, deletions: 0 },
      { path: 'keep.txt', previousPath: undefined, status: 'modified', insertions: 3, deletions: 1 }
    ]);
    assert.strictEqual(detail!.truncated, undefined);
  });

  it('caps a huge commit and says it did', () => {
    const detail = parseCommitDetail(record({ message: 'Restructure', diff: DIFF }), 2);

    assert.strictEqual(detail!.files.length, 2);
    assert.strictEqual(detail!.fileCount, 4);
    assert.strictEqual(detail!.truncated, true);
  });

  it('reports a commit that touched nothing', () => {
    const detail = parseCommitDetail(record({ message: 'Empty merge', diff: '' }));

    assert.deepStrictEqual(detail!.files, []);
    assert.strictEqual(detail!.fileCount, 0);
  });

  it('reads only the first-parent record when -m emitted one per parent', () => {
    const merged =
      record({ message: 'Merge', diff: '\n:100644 100644 aaa bbb M\x00first.ts\x001\t1\tfirst.ts\x00' }) +
      record({ message: 'Merge', diff: '\n:100644 100644 aaa bbb M\x00second.ts\x002\t2\tsecond.ts\x00' });

    const detail = parseCommitDetail(merged);
    assert.deepStrictEqual(
      detail!.files.map((file) => file.path),
      ['first.ts']
    );
  });
});
