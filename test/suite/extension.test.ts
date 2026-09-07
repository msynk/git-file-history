import * as assert from 'assert';
import * as vscode from 'vscode';
import { resolveTargetUri } from '../../src/ui/resolveTarget';

/**
 * Integration tests that need a running VS Code. Run them with
 * `npm run test:integration`; the parser and git tests run without one.
 */
describe('Git File History extension', () => {
  before(async () => {
    // Activation is lazy - nothing is registered until a command runs or a
    // history panel is restored - so the tests ask for it explicitly.
    const extension = vscode.extensions.getExtension('msynk.git-file-history-view');
    assert.ok(extension, 'the extension should be installed in the test host');
    await extension!.activate();
  });

  it('registers its commands', async () => {
    const commands = await vscode.commands.getCommands(true);
    for (const command of ['gitFileHistory.show', 'gitFileHistory.showForActiveEditor', 'gitFileHistory.refresh']) {
      assert.ok(commands.includes(command), `${command} is not registered`);
    }
  });

  it('refresh is a no-op when no history view is open', async () => {
    await vscode.commands.executeCommand('gitFileHistory.refresh');
  });
});

describe('resolveTargetUri', () => {
  it('prefers an explicit URI argument', () => {
    const uri = vscode.Uri.file('/tmp/example.ts');
    assert.strictEqual(resolveTargetUri(uri)?.toString(), uri.toString());
  });

  it('accepts an SCM resource state', () => {
    const uri = vscode.Uri.file('/tmp/from-scm.ts');
    assert.strictEqual(resolveTargetUri({ resourceUri: uri })?.toString(), uri.toString());
  });

  it('unwraps URIs from the built-in git extension back to the file on disk', () => {
    const wrapped = vscode.Uri.file('/tmp/wrapped.ts').with({ scheme: 'git', query: '{"ref":"HEAD"}' });
    const resolved = resolveTargetUri(wrapped);
    assert.strictEqual(resolved?.scheme, 'file');
    assert.strictEqual(resolved?.query, '');
  });

  it('returns undefined when nothing is open and no argument is given', async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    assert.strictEqual(resolveTargetUri(undefined), undefined);
  });
});
