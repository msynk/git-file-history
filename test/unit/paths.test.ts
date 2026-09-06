import * as assert from 'assert';
import * as path from 'path';
import { comparablePath, isSameOrInside, toRelativePosixPath } from '../../src/util/paths';

describe('toRelativePosixPath', () => {
  it('produces forward-slashed repository-relative paths', () => {
    const root = path.join(path.sep === '\\' ? 'C:\\' : '/', 'repo');
    const file = path.join(root, 'src', 'nested', 'file.ts');
    assert.strictEqual(toRelativePosixPath(root, file), 'src/nested/file.ts');
  });

  it('handles a file directly in the root', () => {
    const root = path.join(path.sep === '\\' ? 'C:\\' : '/', 'repo');
    assert.strictEqual(toRelativePosixPath(root, path.join(root, 'README.md')), 'README.md');
  });
});

describe('isSameOrInside', () => {
  const root = path.join(path.sep === '\\' ? 'C:\\' : '/', 'repo');

  it('accepts the root itself', () => {
    assert.strictEqual(isSameOrInside(root, root), true);
  });

  it('accepts a nested directory', () => {
    assert.strictEqual(isSameOrInside(root, path.join(root, 'src', 'deep')), true);
  });

  it('rejects a sibling whose name starts the same', () => {
    assert.strictEqual(isSameOrInside(root, `${root}-other`), false);
  });

  it('rejects an unrelated directory', () => {
    assert.strictEqual(isSameOrInside(root, path.join(path.sep === '\\' ? 'C:\\' : '/', 'elsewhere')), false);
  });
});

describe('comparablePath', () => {
  it('matches the case sensitivity of the host file system', () => {
    const value = comparablePath('/Repo/SRC');
    assert.strictEqual(value, process.platform === 'linux' ? '/Repo/SRC' : '/repo/src');
  });
});
