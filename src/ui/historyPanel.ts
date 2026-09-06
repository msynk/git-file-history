import * as path from 'path';
import * as vscode from 'vscode';
import { toHistoryUri } from '../git/contentProvider';
import { GitCancelledError, GitError } from '../git/gitExecutor';
import type { GitService, RepositoryContext } from '../git/gitService';
import type { CommitEntry, HistoryCursor, HistorySearch } from '../git/types';
import { buildCommitUrl } from '../util/remoteUrl';
import type { FileContext, FromWebview, LoadState, PreviewResult, ToWebview } from './protocol';

const VIEW_TYPE = 'gitFileHistory.view';

/**
 * Hard ceiling on the bytes read into a preview, independent of the line limit:
 * a minified bundle can be a single enormous line, and the whole blob has to
 * cross the webview boundary as a string.
 */
const PREVIEW_MAX_BYTES = 2_000_000;

/** How many previews are kept. A commit's content is immutable, so they never go stale. */
const PREVIEW_CACHE_LIMIT = 24;

interface Target {
  uri: vscode.Uri;
  repository: RepositoryContext;
  context: FileContext;
}

/**
 * The history view. A single panel is reused for every file so the user never
 * accumulates tabs; showing history for another file retargets it in place.
 */
export class HistoryPanel implements vscode.Disposable {
  private static instance: HistoryPanel | undefined;

  private readonly disposables: vscode.Disposable[] = [];
  private target: Target | undefined;
  private commits: CommitEntry[] = [];
  private cursor: HistoryCursor | undefined;
  private hasMore = false;
  private search: HistorySearch | undefined;
  private loading: vscode.CancellationTokenSource | undefined;
  /** In-flight preview read, cancelled when the selection moves on. */
  private previewLoading: vscode.CancellationTokenSource | undefined;
  /** Guards against a slow preview landing after a newer one. */
  private previewToken = 0;
  private readonly previewCache = new Map<string, PreviewResult>();
  private headWatcher: vscode.FileSystemWatcher | undefined;
  /** Guards against a stale response overwriting a newer one. */
  private loadToken = 0;
  /**
   * Last context and state posted. A hidden webview is torn down by VS Code, so
   * its script restarts on reveal and asks for everything again via `ready`;
   * keeping the last values means the replay is exact.
   */
  private lastContext: FileContext | undefined;
  private lastState: { state: LoadState; message?: string } = { state: 'loading' };

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly git: GitService,
    private readonly extensionUri: vscode.Uri
  ) {
    this.panel.webview.html = this.renderHtml();
    this.panel.iconPath = {
      light: vscode.Uri.joinPath(extensionUri, 'media', 'history-light.svg'),
      dark: vscode.Uri.joinPath(extensionUri, 'media', 'history-dark.svg')
    };

    this.disposables.push(
      this.panel.webview.onDidReceiveMessage((message: FromWebview) => void this.handleMessage(message)),
      this.panel.onDidDispose(() => this.dispose())
    );
  }

  /** Opens or retargets the shared panel. */
  static async show(git: GitService, extensionUri: vscode.Uri, uri: vscode.Uri): Promise<void> {
    if (!HistoryPanel.instance) {
      const panel = vscode.window.createWebviewPanel(
        VIEW_TYPE,
        'Git History',
        { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
        {
          enableScripts: true,
          retainContextWhenHidden: false,
          localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
        }
      );
      HistoryPanel.instance = new HistoryPanel(panel, git, extensionUri);
    } else {
      HistoryPanel.instance.panel.reveal(HistoryPanel.instance.panel.viewColumn, false);
    }
    await HistoryPanel.instance.setTarget(uri);
  }

  /** Restores a panel that VS Code persisted across a window reload. */
  static restore(panel: vscode.WebviewPanel, git: GitService, extensionUri: vscode.Uri, uri: vscode.Uri | undefined): void {
    HistoryPanel.instance?.dispose();
    // A deserialised panel comes back without its options, so re-grant script
    // access and the media root before the HTML is set.
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
    };
    HistoryPanel.instance = new HistoryPanel(panel, git, extensionUri);
    if (uri) {
      void HistoryPanel.instance.setTarget(uri);
    }
  }

  static refreshCurrent(): void {
    void HistoryPanel.instance?.reload();
  }

  dispose(): void {
    if (HistoryPanel.instance === this) {
      HistoryPanel.instance = undefined;
    }
    this.loading?.cancel();
    this.loading?.dispose();
    this.previewLoading?.cancel();
    this.previewLoading?.dispose();
    this.headWatcher?.dispose();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
    this.panel.dispose();
  }

  private async setTarget(uri: vscode.Uri): Promise<void> {
    if (this.target && this.target.uri.toString() === uri.toString()) {
      // Same file: keep what is already loaded rather than refetching.
      this.panel.reveal(this.panel.viewColumn, false);
      return;
    }

    this.panel.title = `History: ${path.basename(uri.fsPath)}`;
    this.resetState();
    this.post({ type: 'reset' });
    this.setState('loading');

    const repository = await this.git.resolveRepository(uri);
    if (!repository) {
      this.target = undefined;
      this.setContext({
        uri: uri.toString(),
        fileName: path.basename(uri.fsPath),
        relativePath: uri.fsPath,
        repositoryName: '',
        hasRemote: false
      });
      this.setState('no-repository');
      return;
    }

    const [branch, remote] = await Promise.all([
      this.git.getCurrentBranch(repository.root),
      this.git.getRemoteUrl(repository.root)
    ]);

    this.target = {
      uri,
      repository,
      context: {
        uri: uri.toString(),
        fileName: path.basename(repository.relativePath) || path.basename(uri.fsPath),
        relativePath: repository.relativePath,
        repositoryName: path.basename(repository.root),
        branch,
        hasRemote: Boolean(remote && buildCommitUrl(remote, 'x'))
      }
    };

    this.watchHead(repository.root);
    this.setContext(this.target.context);
    await this.loadPage(false);
  }

  private resetState(): void {
    this.loading?.cancel();
    this.loading?.dispose();
    this.loading = undefined;
    this.cancelPreview();
    this.previewCache.clear();
    this.commits = [];
    this.cursor = undefined;
    this.hasMore = false;
    this.search = undefined;
    this.loadToken++;
  }

  private async reload(): Promise<void> {
    if (!this.target) {
      return;
    }
    const search = this.search;
    this.loading?.cancel();
    this.loading?.dispose();
    this.loading = undefined;
    this.cancelPreview();
    this.previewCache.clear();
    this.commits = [];
    this.cursor = undefined;
    this.hasMore = false;
    this.search = search;
    this.loadToken++;
    this.post({ type: 'reset' });
    this.post({ type: 'stale', stale: false });
    this.setState('loading');
    await this.loadPage(false);
  }

  private async loadPage(append: boolean): Promise<void> {
    const target = this.target;
    if (!target) {
      return;
    }
    if (append && !this.hasMore) {
      return;
    }

    this.loading?.cancel();
    this.loading?.dispose();
    const source = new vscode.CancellationTokenSource();
    this.loading = source;
    const token = ++this.loadToken;

    try {
      const page = await this.git.getHistory(
        {
          repoRoot: target.repository.root,
          path: target.repository.relativePath,
          limit: this.pageSize(),
          follow: this.followRenames(),
          cursor: append ? this.cursor : undefined,
          search: this.search
        },
        source.token
      );

      if (token !== this.loadToken) {
        return;
      }

      this.commits = append ? [...this.commits, ...page.commits] : page.commits;
      this.cursor = page.cursor;
      this.hasMore = page.hasMore;

      this.post({ type: 'commits', commits: page.commits, hasMore: page.hasMore, append, token });

      if (this.commits.length === 0) {
        if (this.search?.text) {
          this.setState('empty');
        } else {
          const tracked = await this.git.isTracked(target.repository.root, target.repository.relativePath, source.token);
          this.setState(tracked ? 'empty' : 'untracked');
        }
      } else {
        this.setState('ready');
      }
    } catch (error) {
      if (error instanceof GitCancelledError || token !== this.loadToken) {
        return;
      }
      const message = error instanceof GitError ? error.message : String(error);
      this.setState('error', message);
    } finally {
      if (this.loading === source) {
        this.loading = undefined;
      }
      source.dispose();
    }
  }

  /**
   * Flags the view when the repository moves under it, so the user can refresh
   * deliberately instead of having the list shift while they read it.
   */
  private watchHead(root: string): void {
    this.headWatcher?.dispose();
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(root), '.git/HEAD')
    );
    const markStale = () => this.post({ type: 'stale', stale: true });
    watcher.onDidChange(markStale);
    watcher.onDidCreate(markStale);
    this.headWatcher = watcher;
  }

  private async handleMessage(message: FromWebview): Promise<void> {
    switch (message.type) {
      case 'ready':
        this.replayState();
        return;
      case 'loadMore':
        await this.loadPage(true);
        return;
      case 'refresh':
        await this.reload();
        return;
      case 'search':
        this.search = message.text ? { text: message.text, mode: message.mode } : undefined;
        await this.reload();
        return;
      case 'preview':
        await this.sendPreview(message.hash);
        return;
      case 'openDiff':
        await this.openDiff(message.hash);
        return;
      case 'openFile':
        await this.openFileAtCommit(message.hash);
        return;
      case 'compareWithWorkingTree':
        await this.compareWithWorkingTree(message.hash);
        return;
      case 'copySha':
        await this.copy(message.hash, 'Commit SHA copied.');
        return;
      case 'copyMessage': {
        const commit = this.find(message.hash);
        if (commit) {
          const text = commit.body ? `${commit.subject}\n\n${commit.body}` : commit.subject;
          await this.copy(text, 'Commit message copied.');
        }
        return;
      }
      case 'openRemote':
        await this.openRemote(message.hash);
        return;
      case 'openCurrentFile':
        if (this.target) {
          await vscode.window.showTextDocument(this.target.uri, { preview: false });
        }
        return;
    }
  }

  /** Re-sends everything after the webview script restarts. */
  /**
   * Sends the current state in full. Called whenever the webview script starts:
   * on first load, and again after VS Code tears the hidden webview down and
   * rebuilds it on reveal.
   */
  private replayState(): void {
    if (this.lastContext) {
      this.post({ type: 'context', file: this.lastContext, followRenames: this.followRenames() });
    }
    if (this.commits.length) {
      this.post({ type: 'commits', commits: this.commits, hasMore: this.hasMore, append: false, token: this.loadToken });
    }
    this.post({ type: 'state', ...this.lastState });
  }

  private setState(state: LoadState, message?: string): void {
    this.lastState = { state, message };
    this.post({ type: 'state', state, message });
  }

  private setContext(file: FileContext): void {
    this.lastContext = file;
    this.post({ type: 'context', file, followRenames: this.followRenames() });
  }

  /**
   * Reads the file as it stood at a commit and sends it to the view.
   *
   * A commit that deleted the file has nothing to show, so the preview falls
   * back to its parent - the last state the file had - and says so.
   */
  private async sendPreview(hash: string): Promise<void> {
    const commit = this.find(hash);
    const target = this.target;
    if (!commit || !target) {
      return;
    }

    const cached = this.previewCache.get(hash);
    if (cached) {
      this.post({ type: 'preview', preview: cached });
      return;
    }

    this.cancelPreview();
    const source = new vscode.CancellationTokenSource();
    this.previewLoading = source;
    const token = ++this.previewToken;

    const fromParent = commit.status === 'deleted';
    const ref = fromParent ? commit.parents[0] : commit.hash;
    const previewPath = fromParent ? (commit.previousPath ?? commit.path) : commit.path;

    try {
      let preview: PreviewResult;
      if (!ref) {
        preview = {
          hash,
          path: previewPath,
          status: commit.status,
          kind: 'missing',
          message: 'The file was deleted in this commit, which has no parent to read it from.'
        };
      } else {
        const buffer = await this.git.getFileAtCommit(target.repository.root, ref, previewPath, source.token, {
          missingAsEmpty: false
        });
        if (token !== this.previewToken) {
          return;
        }
        preview = buildPreview(commit, previewPath, buffer, this.previewMaxLines(), fromParent);
      }
      this.rememberPreview(preview);
      this.post({ type: 'preview', preview });
    } catch (error) {
      if (error instanceof GitCancelledError || token !== this.previewToken) {
        return;
      }
      const preview: PreviewResult = {
        hash,
        path: previewPath,
        status: commit.status,
        kind: error instanceof GitError ? 'missing' : 'error',
        message: error instanceof GitError ? `This file does not exist at ${commit.shortHash}.` : String(error)
      };
      this.rememberPreview(preview);
      this.post({ type: 'preview', preview });
    } finally {
      if (this.previewLoading === source) {
        this.previewLoading = undefined;
      }
      source.dispose();
    }
  }

  private cancelPreview(): void {
    this.previewLoading?.cancel();
    this.previewLoading?.dispose();
    this.previewLoading = undefined;
    this.previewToken++;
  }

  private rememberPreview(preview: PreviewResult): void {
    if (this.previewCache.size >= PREVIEW_CACHE_LIMIT) {
      // FIFO: the view walks history in order, so the oldest entry is the
      // least likely to be asked for again.
      const oldest = this.previewCache.keys().next();
      if (!oldest.done) {
        this.previewCache.delete(oldest.value);
      }
    }
    this.previewCache.set(preview.hash, preview);
  }

  private async openDiff(hash: string): Promise<void> {
    const commit = this.find(hash);
    const target = this.target;
    if (!commit || !target) {
      return;
    }
    const root = target.repository.root;
    const parent = commit.parents[0];
    const previousPath = commit.previousPath ?? commit.path;

    const left =
      parent && commit.status !== 'added'
        ? toHistoryUri({ root, ref: parent, path: previousPath })
        : toHistoryUri({ root, ref: '', path: previousPath });
    const right =
      commit.status === 'deleted'
        ? toHistoryUri({ root, ref: '', path: commit.path })
        : toHistoryUri({ root, ref: commit.hash, path: commit.path });

    const name = path.posix.basename(commit.path);
    const title =
      commit.status === 'added'
        ? `${name} (added in ${commit.shortHash})`
        : commit.status === 'deleted'
          ? `${name} (deleted in ${commit.shortHash})`
          : `${name} (${commit.shortHash} ↔ parent)`;

    await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: true });
  }

  private async openFileAtCommit(hash: string): Promise<void> {
    const commit = this.find(hash);
    if (!commit || !this.target) {
      return;
    }
    const uri = toHistoryUri({ root: this.target.repository.root, ref: commit.hash, path: commit.path });
    await vscode.window.showTextDocument(uri, { preview: true });
  }

  private async compareWithWorkingTree(hash: string): Promise<void> {
    const commit = this.find(hash);
    const target = this.target;
    if (!commit || !target) {
      return;
    }
    const left = toHistoryUri({ root: target.repository.root, ref: commit.hash, path: commit.path });
    const name = path.basename(target.uri.fsPath);
    await vscode.commands.executeCommand(
      'vscode.diff',
      left,
      target.uri,
      `${name} (${commit.shortHash} ↔ working tree)`,
      { preview: true }
    );
  }

  private async openRemote(hash: string): Promise<void> {
    if (!this.target) {
      return;
    }
    const remote = await this.git.getRemoteUrl(this.target.repository.root);
    const url = remote ? buildCommitUrl(remote, hash) : undefined;
    if (!url) {
      void vscode.window.showInformationMessage('This repository has no remote that can be opened in a browser.');
      return;
    }
    await vscode.env.openExternal(vscode.Uri.parse(url));
  }

  private async copy(text: string, confirmation: string): Promise<void> {
    await vscode.env.clipboard.writeText(text);
    void vscode.window.setStatusBarMessage(`$(check) ${confirmation}`, 2000);
  }

  private find(hash: string): CommitEntry | undefined {
    return this.commits.find((commit) => commit.hash === hash);
  }

  private post(message: ToWebview): void {
    void this.panel.webview.postMessage(message);
  }

  private pageSize(): number {
    return vscode.workspace.getConfiguration('gitFileHistory').get<number>('pageSize', 50);
  }

  private followRenames(): boolean {
    return vscode.workspace.getConfiguration('gitFileHistory').get<boolean>('followRenames', true);
  }

  private previewMaxLines(): number {
    return vscode.workspace.getConfiguration('gitFileHistory').get<number>('previewMaxLines', 2000);
  }

  private renderHtml(): string {
    const webview = this.panel.webview;
    const media = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', file));
    const nonce = createNonce();
    const gravatars = vscode.workspace.getConfiguration('gitFileHistory').get<boolean>('showGravatars', false);
    const openDiffOnSelect = vscode.workspace
      .getConfiguration('gitFileHistory')
      .get<boolean>('openDiffOnSelect', false);
    const showPreview = vscode.workspace.getConfiguration('gitFileHistory').get<boolean>('showPreview', true);
    const imageSources = gravatars ? `${webview.cspSource} https://www.gravatar.com data:` : `${webview.cspSource} data:`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${imageSources}; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${media('main.css')}" rel="stylesheet">
<title>Git History</title>
</head>
<body data-gravatars="${gravatars}" data-open-diff-on-select="${openDiffOnSelect}" data-show-preview="${showPreview}">
<div id="app"></div>
<script nonce="${nonce}" src="${media('main.js')}"></script>
</body>
</html>`;
  }
}

/**
 * Turns a blob into something the view can render: text, or an explanation of
 * why there is none. Truncation happens here rather than in the webview so a
 * huge file never has to cross the message boundary in full.
 */
function buildPreview(
  commit: CommitEntry,
  filePath: string,
  buffer: Buffer,
  maxLines: number,
  fromParent: boolean
): PreviewResult {
  const base = {
    hash: commit.hash,
    path: filePath,
    status: commit.status,
    bytes: buffer.length,
    fromParent: fromParent || undefined
  };

  if (isBinary(buffer)) {
    return { ...base, kind: 'binary', message: 'Binary file - there is nothing to show as text.' };
  }

  const head = buffer.length > PREVIEW_MAX_BYTES ? buffer.subarray(0, PREVIEW_MAX_BYTES) : buffer;
  let truncated = head.length < buffer.length;
  let text = head.toString('utf8');
  // A byte-level cut can land mid-character or mid-line; drop the remainder.
  if (truncated) {
    const lastBreak = text.lastIndexOf('\n');
    text = lastBreak > 0 ? text.slice(0, lastBreak) : text;
  }
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }

  const lines = text.length ? text.split(/\r?\n/) : [];
  // A trailing newline leaves an empty last element that is not a real line.
  if (lines.length && lines[lines.length - 1] === '') {
    lines.pop();
  }
  if (lines.length > maxLines) {
    lines.length = maxLines;
    truncated = true;
  }

  return {
    ...base,
    kind: 'text',
    content: lines.join('\n'),
    lines: lines.length,
    truncated: truncated || undefined
  };
}

/** Same heuristic git uses: a NUL byte early in the file means binary. */
function isBinary(buffer: Buffer): boolean {
  const limit = Math.min(buffer.length, 8000);
  for (let i = 0; i < limit; i++) {
    if (buffer[i] === 0) {
      return true;
    }
  }
  return false;
}

function createNonce(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let i = 0; i < 32; i++) {
    nonce += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return nonce;
}
