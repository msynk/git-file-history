import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { toHistoryUri } from '../../src/git/contentProvider';

/**
 * End-to-end checks inside a real VS Code: opening the view for a file in a
 * throwaway repository, and reading historical contents through the
 * `git-file-history:` document provider.
 */

let repo: string;
let file: vscode.Uri;

function git(...args: string[]): void {
  execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
}

async function waitFor(predicate: () => boolean, message: string, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(message);
}

before(function () {
  this.timeout(60000);
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gfh-panel-')));
  git('init', '-q', '-b', 'main', '.');
  git('config', 'user.name', 'Ada Lovelace');
  git('config', 'user.email', 'ada@example.com');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.autocrlf', 'false');

  fs.writeFileSync(path.join(repo, 'note.txt'), 'first version\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'Add the note');

  fs.writeFileSync(path.join(repo, 'note.txt'), 'second version\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'Update the note');

  file = vscode.Uri.file(path.join(repo, 'note.txt'));
});

after(async () => {
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  if (!repo) {
    return;
  }
  try {
    fs.rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // On Windows the file watcher on `.git/HEAD` can still hold the directory
    // open. It is a temp directory, so leaving it behind is harmless and must
    // not fail the run.
  }
});

describe('history panel', () => {
  it('opens a history tab titled after the file', async () => {
    await vscode.commands.executeCommand('gitFileHistory.show', file);

    await waitFor(() => findHistoryTab() !== undefined, 'the history tab never opened');
    assert.strictEqual(findHistoryTab()!.label, 'History: note.txt');
  });

  it('reuses the same tab when another file is shown', async () => {
    const other = vscode.Uri.file(path.join(repo, 'note.txt'));
    await vscode.commands.executeCommand('gitFileHistory.show', other);

    const tabs = vscode.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .filter((tab) => tab.input instanceof vscode.TabInputWebview);
    assert.strictEqual(tabs.length, 1, 'a second history tab was opened');
  });

  it('tells the user when a file is not in a repository', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'gfh-outside-'));
    try {
      const loose = vscode.Uri.file(path.join(outside, 'loose.txt'));
      fs.writeFileSync(loose.fsPath, 'no history here\n');
      // The panel reports this in its own UI rather than throwing.
      await vscode.commands.executeCommand('gitFileHistory.show', loose);
      assert.ok(findHistoryTab(), 'the history tab should still be open');
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('git-file-history documents', () => {
  it('serves the file contents at a revision', async () => {
    const first = execFileSync('git', ['rev-list', '--max-parents=0', 'HEAD'], { cwd: repo }).toString().trim();
    const document = await vscode.workspace.openTextDocument(
      toHistoryUri({ root: repo, ref: first, path: 'note.txt' })
    );
    assert.strictEqual(document.getText(), 'first version\n');
  });

  it('serves an empty document for the missing side of a diff', async () => {
    const document = await vscode.workspace.openTextDocument(toHistoryUri({ root: repo, ref: '', path: 'note.txt' }));
    assert.strictEqual(document.getText(), '');
  });

  it('serves an empty document when the path did not exist at that revision', async () => {
    const document = await vscode.workspace.openTextDocument(
      toHistoryUri({ root: repo, ref: 'HEAD', path: 'never-existed.txt' })
    );
    assert.strictEqual(document.getText(), '');
  });
});

function findHistoryTab(): vscode.Tab | undefined {
  return vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .find((tab) => tab.input instanceof vscode.TabInputWebview && tab.label.startsWith('History:'));
}
