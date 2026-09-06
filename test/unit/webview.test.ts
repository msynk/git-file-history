import * as assert from 'assert';
import * as fs from 'fs';
import { JSDOM } from 'jsdom';
import * as path from 'path';
import type { CommitEntry } from '../../src/git/types';
import type { FileContext, FromWebview, ToWebview } from '../../src/ui/protocol';

/**
 * Runs the real webview script in jsdom. These tests cover the parts of the UI
 * that are easy to break and impossible to notice from the extension side:
 * rendering, filtering, keyboard navigation and the message protocol.
 */

const SCRIPT = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'media', 'main.js'), 'utf8');

interface Harness {
  window: JSDOM['window'];
  document: Document;
  /** Messages the webview has sent to the extension. */
  sent: FromWebview[];
  /** Delivers a message as the extension host would. */
  receive(message: ToWebview): void;
  rows(): HTMLElement[];
  text(selector: string): string;
}

function commit(overrides: Partial<CommitEntry> = {}): CommitEntry {
  const hash = overrides.hash ?? 'a'.repeat(40);
  return {
    hash,
    shortHash: hash.slice(0, 7),
    parents: ['b'.repeat(40)],
    authorName: 'Ada Lovelace',
    authorEmail: 'ada@example.com',
    authorDate: Date.now() - 86400000,
    committerName: 'Ada Lovelace',
    committerEmail: 'ada@example.com',
    commitDate: Date.now() - 86400000,
    subject: 'Fix the tokenizer',
    body: '',
    refs: [],
    path: 'src/parser.ts',
    status: 'modified',
    insertions: 4,
    deletions: 2,
    ...overrides
  };
}

const FILE: FileContext = {
  uri: 'file:///repo/src/parser.ts',
  fileName: 'parser.ts',
  relativePath: 'src/parser.ts',
  repositoryName: 'repo',
  branch: 'main',
  hasRemote: true
};

function createHarness(options: { openDiffOnSelect?: boolean } = {}): Harness {
  const dom = new JSDOM(
    `<body data-gravatars="false" data-open-diff-on-select="${Boolean(options.openDiffOnSelect)}"><div id="app"></div></body>`,
    { runScripts: 'outside-only', pretendToBeVisual: true }
  );
  const sent: FromWebview[] = [];
  const window = dom.window as unknown as Window & typeof globalThis & Record<string, unknown>;

  window.acquireVsCodeApi = () => ({
    postMessage: (message: FromWebview) => sent.push(message),
    setState: () => undefined,
    getState: () => undefined
  });
  // jsdom has no IntersectionObserver; the view only uses it to prefetch.
  window.IntersectionObserver = class {
    observe(): void {}
    disconnect(): void {}
  } as unknown as typeof IntersectionObserver;
  window.Element.prototype.scrollIntoView = function scrollIntoView(): void {};

  dom.window.eval(SCRIPT);

  const document = dom.window.document;
  return {
    window: dom.window,
    document,
    sent,
    receive(message: ToWebview) {
      const event = new dom.window.MessageEvent('message', { data: message });
      dom.window.dispatchEvent(event);
    },
    rows: () => Array.from(document.querySelectorAll('.commit')) as HTMLElement[],
    text: (selector: string) => document.querySelector(selector)?.textContent ?? ''
  };
}

/** Loads a context plus commits, which is the normal startup sequence. */
function seed(harness: Harness, commits: CommitEntry[], hasMore = false): void {
  harness.receive({ type: 'context', file: FILE, followRenames: true });
  harness.receive({ type: 'commits', commits, hasMore, append: false, token: 1 });
  harness.receive({ type: 'state', state: 'ready' });
}

function key(harness: Harness, target: Element, init: KeyboardEventInit): void {
  target.dispatchEvent(new harness.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
}

describe('webview', () => {
  it('announces itself as ready on load', () => {
    const harness = createHarness();
    assert.deepStrictEqual(plain(harness.sent), [{ type: 'ready' }]);
  });

  it('renders the header from the file context', () => {
    const harness = createHarness();
    harness.receive({ type: 'context', file: FILE, followRenames: true });
    assert.strictEqual(harness.text('.file-name'), 'parser.ts');
    assert.strictEqual(harness.text('.file-dir'), 'src');
    assert.ok(harness.text('.meta-row').includes('main'));
    assert.ok(harness.text('.meta-row').includes('repo'));
  });

  it('renders one row per commit with its metadata', () => {
    const harness = createHarness();
    seed(harness, [commit({ hash: '1'.repeat(40) }), commit({ hash: '2'.repeat(40), subject: 'Second' })]);

    const rows = harness.rows();
    assert.strictEqual(rows.length, 2);
    assert.strictEqual(rows[0].querySelector('.commit-subject')?.textContent, 'Fix the tokenizer');
    assert.strictEqual(rows[0].querySelector('.sha')?.textContent, '1111111');
    assert.strictEqual(rows[0].querySelector('.stats')?.textContent, '+4−2');
    assert.strictEqual(rows[0].querySelector('.author')?.textContent, 'Ada Lovelace');
    assert.ok(rows[0].querySelector('time')?.getAttribute('title'));
  });

  it('shows status and rename information', () => {
    const harness = createHarness();
    seed(harness, [commit({ status: 'renamed', previousPath: 'src/lexer.ts' })]);
    const tag = harness.document.querySelector('.status-tag');
    assert.strictEqual(tag?.textContent, 'Renamed');
    assert.strictEqual(tag?.getAttribute('title'), 'Renamed from src/lexer.ts');
  });

  it('labels binary changes instead of showing line counts', () => {
    const harness = createHarness();
    seed(harness, [commit({ insertions: undefined, deletions: undefined })]);
    assert.strictEqual(harness.text('.stats'), 'binary');
  });

  it('renders refs as badges', () => {
    const harness = createHarness();
    seed(harness, [commit({ refs: [{ kind: 'tag', name: 'v1.0.0' }] })]);
    const ref = harness.document.querySelector('.ref');
    assert.strictEqual(ref?.textContent, 'v1.0.0');
    assert.strictEqual(ref?.getAttribute('data-kind'), 'tag');
  });

  it('filters the loaded commits as the user types', async () => {
    const harness = createHarness();
    seed(harness, [
      commit({ hash: '1'.repeat(40), subject: 'Fix the tokenizer' }),
      commit({ hash: '2'.repeat(40), subject: 'Add decimals', authorName: 'Grace Hopper' })
    ]);

    const input = harness.document.querySelector('.search-input') as HTMLInputElement;
    input.value = 'decimals';
    input.dispatchEvent(new harness.window.Event('input'));
    await delay(200);

    assert.strictEqual(harness.rows().length, 1);
    assert.strictEqual(harness.rows()[0].querySelector('.commit-subject')?.textContent, 'Add decimals');
    assert.ok(harness.text('.chip-row').includes('1 of 2'));
  });

  it('matches the author and the hash prefix as well as the subject', async () => {
    const harness = createHarness();
    seed(harness, [
      commit({ hash: 'abc' + 'a'.repeat(37), subject: 'One' }),
      commit({ hash: 'def' + 'b'.repeat(37), subject: 'Two', authorName: 'Grace Hopper' })
    ]);
    const input = harness.document.querySelector('.search-input') as HTMLInputElement;

    input.value = 'grace';
    input.dispatchEvent(new harness.window.Event('input'));
    await delay(200);
    assert.strictEqual(harness.rows().length, 1);

    input.value = 'abc';
    input.dispatchEvent(new harness.window.Event('input'));
    await delay(200);
    assert.strictEqual(harness.rows()[0].dataset.hash, 'abc' + 'a'.repeat(37));
  });

  it('sends a whole-history search when Enter is pressed', () => {
    const harness = createHarness();
    seed(harness, [commit()]);
    const input = harness.document.querySelector('.search-input') as HTMLInputElement;
    input.value = ' tokenizer ';
    key(harness, input, { key: 'Enter' });

    assert.deepStrictEqual(lastSent(harness), { type: 'search', text: 'tokenizer', mode: 'message' });
  });

  it('switches the search mode to the pickaxe', () => {
    const harness = createHarness();
    seed(harness, [commit()]);
    const contentButton = Array.from(harness.document.querySelectorAll('.segmented button')).find(
      (button) => button.textContent === 'Content'
    ) as HTMLElement;
    contentButton.click();

    const input = harness.document.querySelector('.search-input') as HTMLInputElement;
    input.value = 'classify';
    key(harness, input, { key: 'Enter' });
    assert.deepStrictEqual(lastSent(harness), { type: 'search', text: 'classify', mode: 'content' });
  });

  it('moves the selection with the arrow keys', () => {
    const harness = createHarness();
    seed(harness, [commit({ hash: '1'.repeat(40) }), commit({ hash: '2'.repeat(40) })]);
    const list = harness.document.querySelector('.list') as HTMLElement;

    key(harness, list, { key: 'ArrowDown' });
    assert.strictEqual(harness.rows()[0].getAttribute('aria-selected'), 'true');

    key(harness, list, { key: 'ArrowDown' });
    assert.strictEqual(harness.rows()[1].getAttribute('aria-selected'), 'true');
    assert.strictEqual(harness.rows()[0].getAttribute('aria-selected'), 'false');

    key(harness, list, { key: 'ArrowUp' });
    assert.strictEqual(harness.rows()[0].getAttribute('aria-selected'), 'true');
  });

  it('opens the diff on Enter', () => {
    const harness = createHarness();
    seed(harness, [commit({ hash: '1'.repeat(40) })]);
    const list = harness.document.querySelector('.list') as HTMLElement;
    key(harness, list, { key: 'ArrowDown' });
    key(harness, list, { key: 'Enter' });
    assert.deepStrictEqual(lastSent(harness), { type: 'openDiff', hash: '1'.repeat(40) });
  });

  it('toggles the detail pane with Space', () => {
    const harness = createHarness();
    seed(harness, [commit({ hash: '1'.repeat(40), body: 'Long explanation.' })]);
    const list = harness.document.querySelector('.list') as HTMLElement;

    key(harness, list, { key: 'ArrowDown' });
    key(harness, list, { key: ' ' });
    assert.ok(harness.document.querySelector('.detail'));
    assert.strictEqual(harness.text('.detail-body'), 'Long explanation.');

    key(harness, list, { key: ' ' });
    assert.strictEqual(harness.document.querySelector('.detail'), null);
  });

  it('exposes commit actions in the detail pane', () => {
    const harness = createHarness();
    seed(harness, [commit({ hash: '1'.repeat(40) })]);
    harness.rows()[0].dispatchEvent(new harness.window.MouseEvent('click', { bubbles: true }));

    const labels = Array.from(harness.document.querySelectorAll('.detail .action')).map((node) => node.textContent);
    assert.deepStrictEqual(labels, [
      'Open diff',
      'Open file at this commit',
      'Compare with working tree',
      'Copy SHA',
      'Copy message',
      'Open on remote'
    ]);
  });

  it('hides the remote action when the repository has no usable remote', () => {
    const harness = createHarness();
    harness.receive({ type: 'context', file: { ...FILE, hasRemote: false }, followRenames: true });
    harness.receive({ type: 'commits', commits: [commit()], hasMore: false, append: false, token: 1 });
    harness.rows()[0].dispatchEvent(new harness.window.MouseEvent('click', { bubbles: true }));

    const labels = Array.from(harness.document.querySelectorAll('.detail .action')).map((node) => node.textContent);
    assert.ok(!labels.includes('Open on remote'));
  });

  it('sends the copy actions with the right hash', () => {
    const harness = createHarness();
    seed(harness, [commit({ hash: '1'.repeat(40) })]);
    harness.rows()[0].dispatchEvent(new harness.window.MouseEvent('click', { bubbles: true }));

    const copySha = Array.from(harness.document.querySelectorAll('.detail .action')).find(
      (node) => node.textContent === 'Copy SHA'
    ) as HTMLElement;
    copySha.click();
    assert.deepStrictEqual(lastSent(harness), { type: 'copySha', hash: '1'.repeat(40) });
  });

  it('appends a page instead of re-rendering the list', () => {
    const harness = createHarness();
    seed(harness, [commit({ hash: '1'.repeat(40) })], true);
    const firstRow = harness.rows()[0];

    harness.receive({
      type: 'commits',
      commits: [commit({ hash: '2'.repeat(40), subject: 'Older' })],
      hasMore: false,
      append: true,
      token: 2
    });

    assert.strictEqual(harness.rows().length, 2);
    assert.strictEqual(harness.rows()[0], firstRow, 'the existing row should be reused');
    assert.strictEqual(harness.rows()[1].querySelector('.commit-subject')?.textContent, 'Older');
  });

  it('requests more history when the load button is used', () => {
    const harness = createHarness();
    seed(harness, [commit()], true);
    const loadMore = Array.from(harness.document.querySelectorAll('.action')).find((node) =>
      node.textContent?.includes('Load older commits')
    ) as HTMLElement;
    assert.ok(loadMore, 'expected a load-more control');
    loadMore.click();
    assert.deepStrictEqual(lastSent(harness), { type: 'loadMore' });
  });

  it('shows a skeleton while the first page is loading', () => {
    const harness = createHarness();
    harness.receive({ type: 'state', state: 'loading' });
    assert.ok(harness.document.querySelector('.skeleton'));
  });

  it('explains an untracked file', () => {
    const harness = createHarness();
    harness.receive({ type: 'context', file: FILE, followRenames: true });
    harness.receive({ type: 'state', state: 'untracked' });
    assert.ok(harness.text('.state h2').includes('Not tracked'));
  });

  it('explains a file outside any repository', () => {
    const harness = createHarness();
    harness.receive({ type: 'state', state: 'no-repository' });
    assert.ok(harness.text('.state h2').includes('Not inside a Git repository'));
  });

  it('surfaces the git error message and offers a retry', () => {
    const harness = createHarness();
    harness.receive({ type: 'state', state: 'error', message: 'fatal: bad revision' });
    assert.ok(harness.text('.state p').includes('fatal: bad revision'));

    const retry = harness.document.querySelector('.state .action') as HTMLElement;
    retry.click();
    assert.deepStrictEqual(lastSent(harness), { type: 'refresh' });
  });

  it('shows and clears the stale-repository banner', () => {
    const harness = createHarness();
    seed(harness, [commit()]);
    const banner = harness.document.querySelector('.banner') as HTMLElement;
    assert.ok(banner.classList.contains('hidden'));

    harness.receive({ type: 'stale', stale: true });
    assert.ok(!banner.classList.contains('hidden'));

    (banner.querySelector('button') as HTMLElement).click();
    assert.deepStrictEqual(lastSent(harness), { type: 'refresh' });
  });

  it('clears the list on reset', () => {
    const harness = createHarness();
    seed(harness, [commit()]);
    harness.receive({ type: 'reset' });
    assert.strictEqual(harness.rows().length, 0);
  });

  it('opens the diff on select when configured to', () => {
    const harness = createHarness({ openDiffOnSelect: true });
    seed(harness, [commit({ hash: '1'.repeat(40) })]);
    harness.rows()[0].dispatchEvent(new harness.window.MouseEvent('click', { bubbles: true }));
    assert.deepStrictEqual(lastSent(harness), { type: 'openDiff', hash: '1'.repeat(40) });
  });

  it('opens the file when the title is activated', () => {
    const harness = createHarness();
    seed(harness, [commit()]);
    (harness.document.querySelector('.file-name') as HTMLElement).click();
    assert.deepStrictEqual(lastSent(harness), { type: 'openCurrentFile' });
  });

  it('gives every icon an explicit size', () => {
    // An SVG with only a viewBox has no intrinsic size and stretches to fill
    // its container, which once blew the header up to the whole panel.
    const harness = createHarness();
    seed(harness, [commit({ refs: [{ kind: 'tag', name: 'v1.0.0' }] })], true);
    harness.rows()[0].dispatchEvent(new harness.window.MouseEvent('click', { bubbles: true }));
    const input = harness.document.querySelector('.search-input') as HTMLInputElement;
    input.value = 'anything';
    key(harness, input, { key: 'Enter' });

    const icons = Array.from(harness.document.querySelectorAll('svg'));
    assert.ok(icons.length > 5, 'expected the view to render several icons');
    for (const svg of icons) {
      assert.ok(
        Number(svg.getAttribute('width')) > 0 && Number(svg.getAttribute('height')) > 0,
        `icon without an explicit size: ${svg.outerHTML.slice(0, 80)}`
      );
    }
  });

  it('sizes the header file icon with its own class', () => {
    const harness = createHarness();
    harness.receive({ type: 'context', file: FILE, followRenames: true });
    const headerIcon = harness.document.querySelector('.title-row svg');
    assert.ok(headerIcon, 'the header should render a file icon');
    assert.ok(headerIcon!.classList.contains('file-icon'));
  });

  it('escapes untrusted commit text rather than interpreting it as markup', () => {
    const harness = createHarness();
    seed(harness, [commit({ subject: '<img src=x onerror="alert(1)">' })]);
    assert.strictEqual(harness.document.querySelectorAll('.commit-subject img').length, 0);
    assert.strictEqual(harness.text('.commit-subject'), '<img src=x onerror="alert(1)">');
  });
});

/**
 * jsdom objects come from another realm, so their prototype is not the one
 * `deepStrictEqual` expects. Round-tripping through JSON compares the values.
 */
function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value ?? null));
}

function lastSent(harness: Harness): unknown {
  return plain(harness.sent.at(-1) ?? null);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
