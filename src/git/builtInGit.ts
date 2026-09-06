import * as vscode from 'vscode';

/**
 * The slice of the built-in `vscode.git` extension API we rely on. Using it
 * lets us honour the user's `git.path` setting and resolve repository roots
 * that VS Code has already discovered, without spawning anything ourselves.
 */
export interface BuiltInGitApi {
  readonly git: { readonly path: string };
  readonly repositories: ReadonlyArray<{ readonly rootUri: vscode.Uri }>;
  readonly onDidOpenRepository: vscode.Event<unknown>;
  readonly onDidCloseRepository: vscode.Event<unknown>;
}

interface GitExtensionExports {
  readonly enabled: boolean;
  readonly onDidChangeEnablement: vscode.Event<boolean>;
  getAPI(version: 1): BuiltInGitApi;
}

/**
 * Resolves the built-in git API, activating the extension if needed. Returns
 * `undefined` when git support is disabled or the extension is unavailable
 * (for example in a stripped-down remote), in which case callers fall back to
 * plain `git` on the PATH.
 */
export async function getBuiltInGitApi(): Promise<BuiltInGitApi | undefined> {
  try {
    const extension = vscode.extensions.getExtension<GitExtensionExports>('vscode.git');
    if (!extension) {
      return undefined;
    }
    const exports = extension.isActive ? extension.exports : await extension.activate();
    if (!exports?.enabled) {
      return undefined;
    }
    return exports.getAPI(1);
  } catch {
    return undefined;
  }
}
