import * as assert from 'assert';
import { buildCommitUrl, toWebUrl } from '../../src/util/remoteUrl';

const SHA = '0123456789abcdef0123456789abcdef01234567';

describe('toWebUrl', () => {
  it('normalises scp-style remotes', () => {
    assert.deepStrictEqual(toWebUrl('git@github.com:owner/repo.git'), {
      host: 'github.com',
      pathname: '/owner/repo'
    });
  });

  it('normalises https remotes and strips credentials', () => {
    assert.deepStrictEqual(toWebUrl('https://token@github.com/owner/repo.git'), {
      host: 'github.com',
      pathname: '/owner/repo'
    });
  });

  it('normalises ssh:// remotes', () => {
    assert.deepStrictEqual(toWebUrl('ssh://git@gitlab.com/group/sub/repo.git'), {
      host: 'gitlab.com',
      pathname: '/group/sub/repo'
    });
  });

  it('ignores local paths', () => {
    assert.strictEqual(toWebUrl('file:///srv/git/repo.git'), undefined);
    assert.strictEqual(toWebUrl(''), undefined);
  });
});

describe('buildCommitUrl', () => {
  it('builds GitHub commit links', () => {
    assert.strictEqual(
      buildCommitUrl('git@github.com:owner/repo.git', SHA),
      `https://github.com/owner/repo/commit/${SHA}`
    );
  });

  it('builds GitLab commit links', () => {
    assert.strictEqual(
      buildCommitUrl('https://gitlab.com/group/repo.git', SHA),
      `https://gitlab.com/group/repo/-/commit/${SHA}`
    );
  });

  it('builds Bitbucket commit links', () => {
    assert.strictEqual(
      buildCommitUrl('git@bitbucket.org:team/repo.git', SHA),
      `https://bitbucket.org/team/repo/commits/${SHA}`
    );
  });

  it('builds Azure DevOps commit links', () => {
    assert.strictEqual(
      buildCommitUrl('https://dev.azure.com/org/project/_git/repo', SHA),
      `https://dev.azure.com/org/project/_git/repo/commit/${SHA}`
    );
  });

  it('returns nothing for hosts whose URL layout is unknown', () => {
    assert.strictEqual(buildCommitUrl('git@git.internal.example:team/repo.git', SHA), undefined);
    assert.strictEqual(buildCommitUrl('/srv/git/repo.git', SHA), undefined);
  });
});
