import * as vscode from 'vscode';
import { HistoryContentProvider } from './git/contentProvider';
import { GitService } from './git/gitService';
import { HistoryPanel } from './ui/historyPanel';
import { resolveTargetUri } from './ui/resolveTarget';

/**
 * Activation is deliberately thin: it registers commands and two providers and
 * nothing else. Git itself is not touched - no binary is resolved and no
 * process is spawned - until the user actually asks for a history.
 */
export function activate(context: vscode.ExtensionContext): void {
  let gitServicePromise: Promise<GitService> | undefined;

  const getGit = (): Promise<GitService> => {
    if (!gitServicePromise) {
      gitServicePromise = GitService.create().then((service) => {
        context.subscriptions.push(service);
        return service;
      });
    }
    return gitServicePromise;
  };

  const show = async (arg?: unknown): Promise<void> => {
    const uri = resolveTargetUri(arg);
    if (!uri) {
      void vscode.window.showInformationMessage('Open a file to see its Git history.');
      return;
    }
    if (uri.scheme !== 'file') {
      void vscode.window.showInformationMessage('Git history is only available for files stored on disk.');
      return;
    }
    await HistoryPanel.show(await getGit(), context.extensionUri, uri);
  };

  context.subscriptions.push(
    // Registered up front so diff tabs restored from a previous session resolve
    // their contents without waiting for a command.
    new HistoryContentProvider(getGit),
    vscode.commands.registerCommand('gitFileHistory.show', show),
    vscode.commands.registerCommand('gitFileHistory.showForActiveEditor', () => show()),
    vscode.commands.registerCommand('gitFileHistory.refresh', () => HistoryPanel.refreshCurrent()),
    vscode.window.registerWebviewPanelSerializer('gitFileHistory.view', {
      // Restores the view after a window reload, on the file it was showing.
      async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: unknown) {
        const stored = (state as { uri?: string } | undefined)?.uri;
        HistoryPanel.restore(panel, await getGit(), context.extensionUri, stored ? vscode.Uri.parse(stored) : undefined);
      }
    })
  );
}

export function deactivate(): void {
  // Everything is owned by the extension context's subscriptions.
}
