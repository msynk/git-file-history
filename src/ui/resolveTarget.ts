import * as vscode from 'vscode';

/**
 * Schemes that wrap a real file on disk and can be unwrapped by swapping the
 * scheme back to `file` (the built-in git extension and diff editors use these).
 */
const WRAPPER_SCHEMES = new Set(['git', 'gitlens', 'git-file-history', 'vscode-local-history']);

/**
 * Works out which file the user meant.
 *
 * The command is reachable from the editor title bar, the editor and explorer
 * context menus, the SCM view, a keybinding and the Command Palette, so the
 * argument shape varies: a `Uri`, an SCM resource state, or nothing at all.
 */
export function resolveTargetUri(arg?: unknown): vscode.Uri | undefined {
  return unwrap(fromArgument(arg) ?? fromActiveEditor() ?? fromActiveTab());
}

function fromArgument(arg?: unknown): vscode.Uri | undefined {
  if (arg instanceof vscode.Uri) {
    return arg;
  }
  if (arg && typeof arg === 'object') {
    const resource = (arg as { resourceUri?: unknown }).resourceUri;
    if (resource instanceof vscode.Uri) {
      return resource;
    }
    // Some menus hand over `{ uri }` wrappers.
    const uri = (arg as { uri?: unknown }).uri;
    if (uri instanceof vscode.Uri) {
      return uri;
    }
  }
  return undefined;
}

function fromActiveEditor(): vscode.Uri | undefined {
  return vscode.window.activeTextEditor?.document.uri;
}

/**
 * Falls back to the active tab, which covers editors that are not text editors
 * (images, notebooks, custom editors) and diff views.
 */
function fromActiveTab(): vscode.Uri | undefined {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  if (input instanceof vscode.TabInputText) {
    return input.uri;
  }
  if (input instanceof vscode.TabInputTextDiff) {
    return input.modified;
  }
  if (input instanceof vscode.TabInputCustom || input instanceof vscode.TabInputNotebook) {
    return input.uri;
  }
  return undefined;
}

function unwrap(uri: vscode.Uri | undefined): vscode.Uri | undefined {
  if (!uri) {
    return undefined;
  }
  if (uri.scheme === 'file') {
    return uri;
  }
  if (WRAPPER_SCHEMES.has(uri.scheme)) {
    return uri.with({ scheme: 'file', query: '', fragment: '' });
  }
  return uri;
}
