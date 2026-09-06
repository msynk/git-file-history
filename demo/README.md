# Demo workspace

`setup.js` builds `demo/sample-repo`, a throwaway repository whose history is
designed to exercise every part of the view.

```bash
node demo/setup.js                 # ~47 commits
node demo/setup.js --commits 400   # a long history, for paging and scrolling
```

The repository is recreated from scratch each run and is ignored by git.

## What it contains

| File | Why it is there |
| --- | --- |
| `src/parser.ts` | The main subject. Renamed from `src/lexer.ts`, so `--follow` has something to follow. |
| `src/lexer.ts` | Only exists in early history - open `src/parser.ts` to see it. |
| `assets/logo.bin` | A binary file: the view should say `binary` instead of line counts. |
| `src/legacy.ts` | Added and then deleted, so both statuses appear. |
| `README.md` | A file with a very short history. |

Commits are spread across four authors and back-dated over roughly a year, so
relative dates ("3 months ago") and avatar colours look realistic. Tags
`v0.3.0` and `v1.0.0` exercise the ref badges, and an `origin` remote pointing
at github.com enables the **Open on remote** action.

## Manual test checklist

Press <kbd>F5</kbd> in the extension workspace; the Extension Development Host
opens this folder.

**Reaching the view**

- [ ] Open `src/parser.ts` and click the history icon in the editor title bar.
- [ ] Right-click `src/parser.ts` in the Explorer → **Git History**.
- [ ] Right-click inside the editor → **Git History**.
- [ ] Command Palette → **Git History: Show File History**.
- [ ] <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>H</kbd> with the editor focused.
- [ ] Right-click a changed file in the Source Control view → **Git History**.

**Reading it**

- [ ] Newest commit first; author, relative date, short SHA and stats all shown.
- [ ] Hovering a date shows the exact timestamp.
- [ ] `v1.0.0` and `v0.3.0` appear as tag badges.
- [ ] The rename commit is tagged **Renamed** and its details show
      "Renamed from src/lexer.ts".
- [ ] History continues past the rename into `src/lexer.ts`.
- [ ] `assets/logo.bin` shows `binary` rather than line counts.
- [ ] `src/legacy.ts` (via the commit that removed it) shows **Deleted**.

**Interacting**

- [ ] <kbd>↑</kbd>/<kbd>↓</kbd> move the selection; the list scrolls with it.
- [ ] <kbd>Enter</kbd> opens a diff of just that commit's change.
- [ ] The diff of the very first commit shows an empty left side.
- [ ] <kbd>Space</kbd> expands and collapses the details.
- [ ] **Open file at this commit** opens a read-only editor with old contents.
- [ ] **Compare with working tree** diffs against the file on disk.
- [ ] **Copy SHA** and **Copy message** put the right text on the clipboard.
- [ ] **Open on remote** opens a github.com URL in the browser.
- [ ] Typing `tokenizer` filters instantly; the chip shows "N of M".
- [ ] Pressing <kbd>Enter</kbd> searches the whole history.
- [ ] Switching to **Content** and searching `classify` finds the commits that
      changed that text.
- [ ] Scrolling to the bottom loads older commits without a visible stall.

**Edge cases**

- [ ] Create a new untracked file → the view says it is not tracked yet.
- [ ] Open a file outside any repository → the view says so.
- [ ] Commit something while the view is open → the "repository changed" banner
      appears; **Refresh** clears it.
- [ ] Switch colour themes (light, dark, high contrast) → the view follows.
- [ ] Reload the window with the view open → it comes back on the same file.
