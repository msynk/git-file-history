// @ts-check
/**
 * Git File History - webview controller.
 *
 * Plain DOM, no framework: the view has to stay responsive with thousands of
 * rows, and every dependency here is bytes the user pays for on every open.
 */
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();

  /** @typedef {{hash:string,shortHash:string,parents:string[],authorName:string,authorEmail:string,authorDate:number,committerName:string,committerEmail:string,commitDate:number,subject:string,body:string,refs:{kind:string,name:string}[],path:string,previousPath?:string,status:string,insertions?:number,deletions?:number}} Commit */

  const state = {
    /** @type {{uri:string,fileName:string,relativePath:string,repositoryName:string,branch?:string,hasRemote:boolean}|null} */
    file: null,
    followRenames: true,
    /** @type {Commit[]} */
    commits: [],
    hasMore: false,
    /** @type {'loading'|'ready'|'empty'|'untracked'|'no-repository'|'error'} */
    loadState: 'loading',
    errorMessage: '',
    /** Client-side filter over the commits already loaded. */
    filter: '',
    /** The term currently being searched by git across the whole history. */
    deepSearch: '',
    /** @type {'message'|'content'} */
    searchMode: 'message',
    /** @type {string|null} */
    selected: null,
    /** @type {string|null} */
    expanded: null,
    stale: false,
    loadingMore: false
  };

  const useGravatars = document.body.dataset.gravatars === 'true';
  const openDiffOnSelect = document.body.dataset.openDiffOnSelect === 'true';

  // --------------------------------------------------------------- icons --

  const ICONS = {
    search: 'M10.5 10.5 14 14M6.5 11a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9Z',
    refresh: 'M13.5 8a5.5 5.5 0 1 1-1.7-3.97M13.5 2v3h-3',
    branch: 'M5 3.5v9M5 3.5a1.5 1.5 0 1 0 0-.001ZM5 12.5a1.5 1.5 0 1 0 0-.001ZM11 5.5a1.5 1.5 0 1 0 0-.001ZM11 7v.5A2.5 2.5 0 0 1 8.5 10H7',
    file: 'M9 1.5H4.5A1.5 1.5 0 0 0 3 3v10A1.5 1.5 0 0 0 4.5 14.5h7A1.5 1.5 0 0 0 13 13V5.5L9 1.5ZM9 1.5V5.5H13',
    diff: 'M4.5 2v11M2.5 4h4M2.5 11h4M11.5 3v10M9.5 6h4',
    copy: 'M5.5 5.5h7a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1ZM10.5 3.5v-1a1 1 0 0 0-1-1h-7a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h1',
    external: 'M9 2.5h4.5V7M13.5 2.5 7 9M11.5 9.5V13a.5.5 0 0 1-.5.5H3a.5.5 0 0 1-.5-.5V5.5A.5.5 0 0 1 3 5h3.5',
    open: 'M2 12.5V4a1 1 0 0 1 1-1h3l1.5 2H13a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1Z',
    close: 'M4 4l8 8M12 4l-8 8',
    history: 'M8 4.5V8l2.5 1.5M2.5 8a5.5 5.5 0 1 0 1.6-3.9M2.5 3v3h3',
    warn: 'M8 2.5 15 14H1L8 2.5ZM8 6.5v4M8 12.2v.6',
    empty: 'M3 4.5h10M3 8h10M3 11.5h6'
  };

  /**
   * @param {keyof typeof ICONS} name
   * @param {number} [size] Rendered size in pixels. Always set: an SVG with only
   * a viewBox has no intrinsic size and stretches to fill its container.
   * @param {string} [className]
   */
  function icon(name, size, className) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.3');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('width', String(size || 16));
    svg.setAttribute('height', String(size || 16));
    if (className) {
      svg.setAttribute('class', className);
    }
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', ICONS[name]);
    svg.appendChild(path);
    return svg;
  }

  // ------------------------------------------------------------ dom utils --

  /**
   * @param {string} tag
   * @param {Record<string, any>} [props]
   * @param {(Node|string|null|undefined)[]} [children]
   */
  function el(tag, props, children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value === undefined || value === null || value === false) {
        continue;
      }
      if (key === 'class') {
        node.className = value;
      } else if (key === 'text') {
        node.textContent = String(value);
      } else if (key === 'dataset') {
        Object.assign(node.dataset, value);
      } else if (key.startsWith('on') && typeof value === 'function') {
        node.addEventListener(key.slice(2).toLowerCase(), value);
      } else {
        node.setAttribute(key, value === true ? '' : String(value));
      }
    }
    for (const child of children || []) {
      if (child === null || child === undefined) {
        continue;
      }
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    }
    return node;
  }

  // ---------------------------------------------------------- formatting --

  const relativeFormatter =
    typeof Intl !== 'undefined' && Intl.RelativeTimeFormat
      ? new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
      : null;

  const UNITS = /** @type {[Intl.RelativeTimeFormatUnit, number][]} */ ([
    ['year', 31557600000],
    ['month', 2629800000],
    ['week', 604800000],
    ['day', 86400000],
    ['hour', 3600000],
    ['minute', 60000]
  ]);

  /** Human-friendly age, e.g. "3 days ago". */
  function formatRelative(timestamp) {
    const delta = timestamp - Date.now();
    const magnitude = Math.abs(delta);
    if (magnitude < 45000) {
      return 'just now';
    }
    for (const [unit, ms] of UNITS) {
      if (magnitude >= ms) {
        const value = Math.round(delta / ms);
        return relativeFormatter ? relativeFormatter.format(value, unit) : `${Math.abs(value)} ${unit}s ago`;
      }
    }
    return 'just now';
  }

  function formatExact(timestamp) {
    const date = new Date(timestamp);
    return date.toLocaleString(undefined, {
      weekday: 'short',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  const STATUS_LABEL = { added: 'Added', deleted: 'Deleted', renamed: 'Renamed', modified: 'Modified' };

  function initials(name) {
    const parts = String(name || '?')
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (parts.length === 0) {
      return '?';
    }
    if (parts.length === 1) {
      return parts[0].slice(0, 2);
    }
    return parts[0][0] + parts[parts.length - 1][0];
  }

  /** Stable colour per author so the same person always looks the same. */
  function avatarColor(email) {
    let hash = 0;
    const key = String(email || '').toLowerCase();
    for (let i = 0; i < key.length; i++) {
      hash = (hash * 31 + key.charCodeAt(i)) | 0;
    }
    return `hsl(${Math.abs(hash) % 360}, 52%, 42%)`;
  }

  /** Gravatar keys avatars by the SHA-256 of the lowercased e-mail address. */
  async function gravatarUrl(email) {
    if (!crypto || !crypto.subtle) {
      return null;
    }
    const data = new TextEncoder().encode(String(email || '').trim().toLowerCase());
    const digest = await crypto.subtle.digest('SHA-256', data);
    const hex = Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
    return `https://www.gravatar.com/avatar/${hex}?s=36&d=404`;
  }

  // ---------------------------------------------------------------- shell --

  const app = /** @type {HTMLElement} */ (document.getElementById('app'));

  const fileNameEl = el('h1', { class: 'file-name', title: 'Open this file', tabindex: '0', role: 'button' });
  const fileDirEl = el('span', { class: 'file-dir' });
  const metaRow = el('div', { class: 'meta-row' });
  const chipRow = el('div', { class: 'chip-row' });

  const searchInput = /** @type {HTMLInputElement} */ (
    el('input', {
      class: 'search-input',
      type: 'search',
      spellcheck: 'false',
      placeholder: 'Filter loaded commits - press Enter to search the whole history',
      'aria-label': 'Filter or search commits'
    })
  );

  const modeButtons = ['message', 'content'].map((mode) =>
    el('button', {
      type: 'button',
      text: mode === 'message' ? 'Message' : 'Content',
      title:
        mode === 'message'
          ? 'Search commit messages (git log --grep)'
          : 'Search commits that changed this text in the file (git log -S)',
      'aria-pressed': String(mode === state.searchMode),
      dataset: { mode },
      onclick: () => setSearchMode(/** @type {'message'|'content'} */ (mode))
    })
  );

  const refreshButton = el(
    'button',
    { class: 'icon-button', type: 'button', title: 'Refresh history', 'aria-label': 'Refresh history', onclick: refresh },
    [icon('refresh')]
  );

  const banner = el('div', { class: 'banner hidden' }, [
    el('span', { text: 'The repository changed since this history was loaded.' }),
    el('button', { type: 'button', text: 'Refresh', onclick: refresh })
  ]);

  const header = el('header', { class: 'header' }, [
    el('div', { class: 'title-row' }, [icon('file', 16, 'file-icon'), fileNameEl, fileDirEl, refreshButton]),
    metaRow,
    el('div', { class: 'search-row' }, [
      el('div', { class: 'search-box' }, [icon('search'), searchInput]),
      el('div', { class: 'segmented', role: 'group', 'aria-label': 'Search mode' }, modeButtons)
    ]),
    chipRow,
    banner
  ]);

  const list = el('div', {
    class: 'list',
    role: 'listbox',
    tabindex: '0',
    'aria-label': 'File history'
  });

  const footer = el('footer', { class: 'footer' });
  const liveRegion = el('div', { class: 'visually-hidden', role: 'status', 'aria-live': 'polite' });

  app.append(header, list, footer, liveRegion);

  // -------------------------------------------------------------- filters --

  /** @returns {Commit[]} */
  function visibleCommits() {
    const needle = state.filter.trim().toLowerCase();
    if (!needle) {
      return state.commits;
    }
    return state.commits.filter((commit) => {
      return (
        commit.subject.toLowerCase().includes(needle) ||
        commit.body.toLowerCase().includes(needle) ||
        commit.authorName.toLowerCase().includes(needle) ||
        commit.authorEmail.toLowerCase().includes(needle) ||
        commit.hash.toLowerCase().startsWith(needle) ||
        commit.path.toLowerCase().includes(needle)
      );
    });
  }

  // ----------------------------------------------------------- rendering --

  /** @type {Map<string, HTMLElement>} */
  const rowsByHash = new Map();
  /** @type {IntersectionObserver|null} */
  let sentinelObserver = null;

  function renderHeader() {
    const file = state.file;
    fileNameEl.textContent = file ? file.fileName : '';
    const directory = file ? file.relativePath.slice(0, file.relativePath.length - file.fileName.length) : '';
    fileDirEl.textContent = directory ? directory.replace(/\/$/, '') : '';

    metaRow.textContent = '';
    if (!file) {
      return;
    }
    const pieces = [];
    if (file.repositoryName) {
      pieces.push(el('span', { text: file.repositoryName }));
    }
    if (file.branch) {
      pieces.push(el('span', { class: 'sep' }));
      pieces.push(el('span', { class: 'branch' }, [icon('branch', 13), el('span', { text: file.branch })]));
    }
    if (state.commits.length) {
      pieces.push(el('span', { class: 'sep' }));
      const count = state.commits.length + (state.hasMore ? '+' : '');
      pieces.push(el('span', { text: `${count} commit${state.commits.length === 1 ? '' : 's'}` }));
    }
    if (state.followRenames) {
      pieces.push(el('span', { class: 'sep' }));
      pieces.push(el('span', { text: 'following renames', title: 'History follows the file across renames (git log --follow)' }));
    }
    for (const piece of pieces) {
      metaRow.appendChild(piece);
    }
  }

  function renderChips() {
    chipRow.textContent = '';
    if (state.deepSearch) {
      chipRow.appendChild(
        el('span', { class: 'chip' }, [
          el('span', {
            text: `${state.searchMode === 'content' ? 'Content' : 'Message'}: ${state.deepSearch}`
          }),
          el(
            'button',
            { type: 'button', title: 'Clear search', 'aria-label': 'Clear search', onclick: clearSearch },
            [icon('close', 11)]
          )
        ])
      );
    }
    const visible = visibleCommits().length;
    if (state.filter && visible !== state.commits.length) {
      chipRow.appendChild(el('span', { text: `${visible} of ${state.commits.length} loaded commits match` }));
    }
  }

  /**
   * @param {Commit} commit
   */
  function renderRow(commit) {
    const row = el('div', {
      class: 'commit',
      role: 'option',
      tabindex: '-1',
      id: `commit-${commit.hash}`,
      'aria-selected': String(state.selected === commit.hash),
      'aria-expanded': String(state.expanded === commit.hash),
      dataset: { hash: commit.hash, status: commit.status }
    });

    const refs = commit.refs.length
      ? el(
          'span',
          { class: 'refs' },
          commit.refs.slice(0, 3).map((ref) =>
            el('span', {
              class: 'ref',
              text: ref.name,
              title: `${ref.kind}: ${ref.name}`,
              dataset: { kind: ref.kind }
            })
          )
        )
      : null;

    const stats = renderStats(commit);

    const subjectRow = el('div', { class: 'commit-subject-row' }, [
      el('span', { class: 'commit-subject', text: commit.subject || '(no commit message)', title: commit.subject }),
      refs,
      stats
    ]);

    const avatar = el('span', {
      class: 'avatar',
      style: `background:${avatarColor(commit.authorEmail)}`,
      text: initials(commit.authorName),
      'aria-hidden': 'true'
    });
    if (useGravatars) {
      void applyGravatar(avatar, commit.authorEmail);
    }

    const meta = el('div', { class: 'commit-meta' }, [
      avatar,
      el('span', { class: 'author', text: commit.authorName, title: commit.authorEmail }),
      el('span', { class: 'sep' }),
      el('time', {
        text: formatRelative(commit.authorDate),
        datetime: new Date(commit.authorDate).toISOString(),
        title: formatExact(commit.authorDate)
      }),
      el('span', { class: 'sep' }),
      el('span', { class: 'sha', text: commit.shortHash, title: commit.hash }),
      commit.status !== 'modified'
        ? el('span', {
            class: 'status-tag',
            text: STATUS_LABEL[commit.status] || commit.status,
            dataset: { status: commit.status },
            title:
              commit.status === 'renamed' && commit.previousPath
                ? `Renamed from ${commit.previousPath}`
                : STATUS_LABEL[commit.status]
          })
        : null
    ]);

    row.append(
      el('div', { class: 'rail' }, [el('span', { class: 'dot' })]),
      el('div', { class: 'commit-body' }, [subjectRow, meta])
    );

    if (state.expanded === commit.hash) {
      row.appendChild(renderDetail(commit));
    }

    rowsByHash.set(commit.hash, row);
    return row;
  }

  /** @param {Commit} commit */
  function renderStats(commit) {
    if (commit.insertions === undefined && commit.deletions === undefined) {
      return el('span', { class: 'stats', text: 'binary', title: 'Binary file' });
    }
    const parts = [];
    if (commit.insertions) {
      parts.push(el('span', { class: 'add', text: `+${commit.insertions}` }));
    }
    if (commit.deletions) {
      parts.push(el('span', { class: 'del', text: `−${commit.deletions}` }));
    }
    if (!parts.length) {
      return null;
    }
    return el('span', { class: 'stats', title: `${commit.insertions || 0} added, ${commit.deletions || 0} removed` }, parts);
  }

  /** @param {Commit} commit */
  function renderDetail(commit) {
    const definitions = [];
    definitions.push(el('dt', { text: 'Commit' }), el('dd', {}, [el('span', { class: 'sha', text: commit.hash })]));
    definitions.push(
      el('dt', { text: 'Author' }),
      el('dd', { text: `${commit.authorName} <${commit.authorEmail}> · ${formatExact(commit.authorDate)}` })
    );
    if (commit.committerEmail !== commit.authorEmail || Math.abs(commit.commitDate - commit.authorDate) > 60000) {
      definitions.push(
        el('dt', { text: 'Committer' }),
        el('dd', { text: `${commit.committerName} <${commit.committerEmail}> · ${formatExact(commit.commitDate)}` })
      );
    }
    definitions.push(el('dt', { text: 'File' }), el('dd', { text: commit.path }));
    if (commit.previousPath && commit.previousPath !== commit.path) {
      definitions.push(el('dt', { text: 'Renamed from' }), el('dd', { text: commit.previousPath }));
    }
    if (commit.parents.length > 1) {
      definitions.push(el('dt', { text: 'Merge' }), el('dd', { text: `${commit.parents.length} parents` }));
    }

    const actions = [
      action('Open diff', 'diff', () => send({ type: 'openDiff', hash: commit.hash }), true),
      action('Open file at this commit', 'open', () => send({ type: 'openFile', hash: commit.hash })),
      action('Compare with working tree', 'file', () => send({ type: 'compareWithWorkingTree', hash: commit.hash })),
      action('Copy SHA', 'copy', () => send({ type: 'copySha', hash: commit.hash })),
      action('Copy message', 'copy', () => send({ type: 'copyMessage', hash: commit.hash }))
    ];
    if (state.file && state.file.hasRemote) {
      actions.push(action('Open on remote', 'external', () => send({ type: 'openRemote', hash: commit.hash })));
    }

    return el('div', { class: 'detail', onclick: (/** @type {Event} */ event) => event.stopPropagation() }, [
      el('dl', {}, definitions),
      commit.body ? el('div', { class: 'detail-body', text: commit.body }) : null,
      el('div', { class: 'actions' }, actions)
    ]);
  }

  function action(label, iconName, handler, primary) {
    return el(
      'button',
      {
        class: primary ? 'action primary' : 'action',
        type: 'button',
        onclick: (/** @type {Event} */ event) => {
          event.stopPropagation();
          handler();
        }
      },
      [icon(iconName), el('span', { text: label })]
    );
  }

  /** Rebuilds the whole list. Used on filter changes and fresh loads. */
  function renderList() {
    rowsByHash.clear();
    detachSentinel();
    list.textContent = '';

    if (state.loadState === 'loading' && state.commits.length === 0) {
      list.appendChild(renderSkeleton());
      renderFooter();
      return;
    }

    const commits = visibleCommits();
    if (commits.length === 0) {
      list.appendChild(renderEmptyState());
      renderFooter();
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const commit of commits) {
      fragment.appendChild(renderRow(commit));
    }
    list.appendChild(fragment);
    markLastRow();
    appendSentinel();
    renderFooter();
  }

  /** Appends only the new page, which keeps paging cheap for long histories. */
  function appendCommits(commits) {
    if (state.filter) {
      renderList();
      return;
    }
    detachSentinel();
    const fragment = document.createDocumentFragment();
    for (const commit of commits) {
      fragment.appendChild(renderRow(commit));
    }
    list.appendChild(fragment);
    markLastRow();
    appendSentinel();
    renderFooter();
  }

  function markLastRow() {
    const rows = list.querySelectorAll('.commit');
    rows.forEach((row) => row.classList.remove('is-last'));
    if (!state.hasMore && rows.length) {
      rows[rows.length - 1].classList.add('is-last');
    }
  }

  function renderSkeleton() {
    const fragment = document.createDocumentFragment();
    for (let i = 0; i < 8; i++) {
      fragment.appendChild(
        el('div', { class: 'skeleton', 'aria-hidden': 'true' }, [
          el('div', {}, [el('span', { class: 'dot' })]),
          el('div', {}, [
            el('div', { class: 'bar', style: `width:${45 + ((i * 13) % 40)}%` }),
            el('div', { class: 'bar', style: `width:${25 + ((i * 7) % 20)}%` })
          ])
        ])
      );
    }
    return fragment;
  }

  function renderEmptyState() {
    if (state.loadState === 'error') {
      return el('div', { class: 'state' }, [
        icon('warn', 34),
        el('h2', { text: 'Could not read the history' }),
        el('p', { text: state.errorMessage || 'git reported an error.' }),
        action('Try again', 'refresh', refresh, true)
      ]);
    }
    if (state.loadState === 'no-repository') {
      return el('div', { class: 'state' }, [
        icon('warn', 34),
        el('h2', { text: 'Not inside a Git repository' }),
        el('p', { text: 'This file is not part of a repository, so there is no history to show.' })
      ]);
    }
    if (state.loadState === 'untracked') {
      return el('div', { class: 'state' }, [
        icon('history', 34),
        el('h2', { text: 'Not tracked by Git yet' }),
        el('p', { text: 'Commit this file and its history will appear here.' })
      ]);
    }
    if (state.deepSearch || state.filter) {
      return el('div', { class: 'state' }, [
        icon('empty', 34),
        el('h2', { text: 'No matching commits' }),
        el('p', {
          text: state.deepSearch
            ? `Nothing in this file's history matches "${state.deepSearch}".`
            : 'Try a different term, or press Enter to search the whole history.'
        }),
        action('Clear search', 'close', clearSearch, true)
      ]);
    }
    if (state.loadState === 'loading') {
      return renderSkeleton();
    }
    return el('div', { class: 'state' }, [
      icon('history', 34),
      el('h2', { text: 'No history for this file' }),
      el('p', { text: 'The file has no commits yet on the current branch.' })
    ]);
  }

  function renderFooter() {
    footer.textContent = '';
    if (state.loadState === 'no-repository' || state.loadState === 'untracked') {
      return;
    }
    const loaded = state.commits.length;
    const summary = loaded
      ? `${loaded} commit${loaded === 1 ? '' : 's'} loaded${state.hasMore ? ' · more available' : ''}`
      : '';
    footer.append(
      el('span', { text: summary }),
      el('span', { class: 'hint' }, [
        el('kbd', { text: '↑' }),
        el('kbd', { text: '↓' }),
        el('span', { text: ' navigate · ' }),
        el('kbd', { text: 'Enter' }),
        el('span', { text: ' diff · ' }),
        el('kbd', { text: 'Space' }),
        el('span', { text: ' details · ' }),
        el('kbd', { text: '/' }),
        el('span', { text: ' search' })
      ])
    );
  }

  // ------------------------------------------------------- lazy paging --

  /** @type {HTMLElement|null} */
  let sentinel = null;

  function appendSentinel() {
    if (!state.hasMore || state.filter) {
      return;
    }
    sentinel = el('div', { class: 'state', style: 'margin:16px auto' }, [
      el('span', { text: state.loadingMore ? 'Loading older commits…' : '' }),
      state.loadingMore ? null : action('Load older commits', 'history', loadMore, false)
    ]);
    list.appendChild(sentinel);

    // Prefetch just before the sentinel scrolls into view so paging feels
    // instant, while the button keeps it reachable without a mouse wheel.
    sentinelObserver = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          loadMore();
        }
      },
      { root: list, rootMargin: '400px' }
    );
    sentinelObserver.observe(sentinel);
  }

  function detachSentinel() {
    if (sentinelObserver) {
      sentinelObserver.disconnect();
      sentinelObserver = null;
    }
    if (sentinel && sentinel.parentNode) {
      sentinel.remove();
    }
    sentinel = null;
  }

  function loadMore() {
    if (!state.hasMore || state.loadingMore) {
      return;
    }
    state.loadingMore = true;
    detachSentinel();
    sentinel = el('div', { class: 'state', style: 'margin:16px auto' }, [el('span', { text: 'Loading older commits…' })]);
    list.appendChild(sentinel);
    send({ type: 'loadMore' });
  }

  // ------------------------------------------------------------ selection --

  function select(hash, options) {
    const previous = state.selected;
    state.selected = hash;
    if (previous && previous !== hash) {
      const row = rowsByHash.get(previous);
      if (row) {
        row.setAttribute('aria-selected', 'false');
      }
    }
    const row = rowsByHash.get(hash);
    if (!row) {
      return;
    }
    row.setAttribute('aria-selected', 'true');
    if (!options || options.scroll !== false) {
      row.scrollIntoView({ block: 'nearest' });
    }
    list.setAttribute('aria-activedescendant', row.id);
    const commit = state.commits.find((item) => item.hash === hash);
    if (commit) {
      liveRegion.textContent = `${commit.subject}, ${commit.authorName}, ${formatRelative(commit.authorDate)}`;
    }
  }

  function toggleDetail(hash) {
    state.expanded = state.expanded === hash ? null : hash;
    for (const [key, row] of rowsByHash) {
      const detail = row.querySelector('.detail');
      if (key === state.expanded) {
        if (!detail) {
          const commit = state.commits.find((item) => item.hash === key);
          if (commit) {
            row.appendChild(renderDetail(commit));
          }
        }
        row.setAttribute('aria-expanded', 'true');
      } else {
        if (detail) {
          detail.remove();
        }
        row.setAttribute('aria-expanded', 'false');
      }
    }
    const row = rowsByHash.get(hash);
    if (row && state.expanded === hash) {
      row.scrollIntoView({ block: 'nearest' });
    }
  }

  function move(delta) {
    const commits = visibleCommits();
    if (!commits.length) {
      return;
    }
    const currentIndex = commits.findIndex((commit) => commit.hash === state.selected);
    let next = currentIndex + delta;
    if (currentIndex === -1) {
      next = delta > 0 ? 0 : commits.length - 1;
    }
    next = Math.max(0, Math.min(commits.length - 1, next));
    select(commits[next].hash);
    // Keep the detail pane following the selection once the user has opened it.
    if (state.expanded && state.expanded !== commits[next].hash) {
      toggleDetail(commits[next].hash);
    }
    // Reaching the end of what is loaded should pull the next page in.
    if (next >= commits.length - 3) {
      loadMore();
    }
  }

  // ------------------------------------------------------------- actions --

  function refresh() {
    send({ type: 'refresh' });
  }

  function clearSearch() {
    searchInput.value = '';
    state.filter = '';
    if (state.deepSearch) {
      state.deepSearch = '';
      send({ type: 'search', text: '', mode: state.searchMode });
    } else {
      renderChips();
      renderList();
    }
    searchInput.focus();
  }

  /** @param {'message'|'content'} mode */
  function setSearchMode(mode) {
    state.searchMode = mode;
    for (const button of modeButtons) {
      button.setAttribute('aria-pressed', String(button.dataset.mode === mode));
    }
    searchInput.placeholder =
      mode === 'content'
        ? 'Press Enter to find commits that changed this text'
        : 'Filter loaded commits - press Enter to search the whole history';
    if (state.deepSearch) {
      send({ type: 'search', text: state.deepSearch, mode });
    }
  }

  function send(message) {
    vscode.postMessage(message);
  }

  async function applyGravatar(node, email) {
    try {
      const url = await gravatarUrl(email);
      if (!url) {
        return;
      }
      const image = new Image();
      image.alt = '';
      image.onload = () => {
        node.textContent = '';
        node.appendChild(image);
      };
      image.src = url;
    } catch {
      // Keep the initials avatar; a missing Gravatar is not worth reporting.
    }
  }

  // -------------------------------------------------------------- events --

  let filterTimer = 0;
  searchInput.addEventListener('input', () => {
    clearTimeout(filterTimer);
    filterTimer = setTimeout(() => {
      state.filter = searchInput.value;
      renderChips();
      renderList();
    }, 120);
  });

  searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      const text = searchInput.value.trim();
      state.deepSearch = text;
      state.filter = '';
      send({ type: 'search', text, mode: state.searchMode });
    } else if (event.key === 'Escape') {
      event.preventDefault();
      clearSearch();
      list.focus();
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      list.focus();
      move(1);
    }
  });

  list.addEventListener('click', (event) => {
    const row = /** @type {HTMLElement|null} */ (/** @type {HTMLElement} */ (event.target).closest('.commit'));
    if (!row || !row.dataset.hash) {
      return;
    }
    const hash = row.dataset.hash;
    select(hash, { scroll: false });
    if (state.expanded !== hash) {
      toggleDetail(hash);
    }
    if (openDiffOnSelect) {
      send({ type: 'openDiff', hash });
    }
  });

  list.addEventListener('dblclick', (event) => {
    const row = /** @type {HTMLElement|null} */ (/** @type {HTMLElement} */ (event.target).closest('.commit'));
    if (row && row.dataset.hash && !(/** @type {HTMLElement} */ (event.target).closest('.detail'))) {
      send({ type: 'openDiff', hash: row.dataset.hash });
    }
  });

  list.addEventListener('keydown', (event) => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        move(1);
        return;
      case 'ArrowUp':
        event.preventDefault();
        move(-1);
        return;
      case 'PageDown':
        event.preventDefault();
        move(10);
        return;
      case 'PageUp':
        event.preventDefault();
        move(-10);
        return;
      case 'Home':
        event.preventDefault();
        move(-1e9);
        return;
      case 'End':
        event.preventDefault();
        move(1e9);
        return;
      case 'Enter':
        if (state.selected) {
          event.preventDefault();
          send({ type: 'openDiff', hash: state.selected });
        }
        return;
      case ' ':
      case 'Spacebar':
        if (state.selected) {
          event.preventDefault();
          toggleDetail(state.selected);
        }
        return;
      default:
        return;
    }
  });

  document.addEventListener('keydown', (event) => {
    const target = /** @type {HTMLElement} */ (event.target);
    const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA');
    if (!typing && (event.key === '/' || ((event.ctrlKey || event.metaKey) && event.key === 'f'))) {
      event.preventDefault();
      searchInput.focus();
      searchInput.select();
    } else if (!typing && event.key === 'F5') {
      event.preventDefault();
      refresh();
    }
  });

  fileNameEl.addEventListener('click', () => send({ type: 'openCurrentFile' }));
  fileNameEl.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      send({ type: 'openCurrentFile' });
    }
  });

  window.addEventListener('message', (event) => {
    const message = event.data;
    switch (message.type) {
      case 'context':
        state.file = message.file;
        state.followRenames = message.followRenames;
        vscode.setState({ uri: message.file.uri });
        renderHeader();
        return;
      case 'reset':
        state.commits = [];
        state.hasMore = false;
        state.selected = null;
        state.expanded = null;
        state.loadingMore = false;
        rowsByHash.clear();
        renderList();
        return;
      case 'commits': {
        state.loadingMore = false;
        state.hasMore = message.hasMore;
        if (message.append) {
          state.commits = state.commits.concat(message.commits);
          appendCommits(message.commits);
        } else {
          state.commits = message.commits;
          renderList();
        }
        renderHeader();
        renderChips();
        return;
      }
      case 'state':
        state.loadState = message.state;
        state.errorMessage = message.message || '';
        if (state.commits.length === 0) {
          renderList();
        }
        renderFooter();
        return;
      case 'stale':
        state.stale = message.stale;
        banner.classList.toggle('hidden', !message.stale);
        return;
      default:
        return;
    }
  });

  renderHeader();
  renderList();
  send({ type: 'ready' });
})();
