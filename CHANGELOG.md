# Changelog

All notable changes to Git File History View are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.2.0] - 2026-09-08

### Added

- Compare any two commits: mark one with <kbd>C</kbd>, <kbd>Alt</kbd>+click or
  **Select for compare**, then diff another against it with
  <kbd>Ctrl</kbd>+<kbd>Enter</kbd> or **Compare with `<sha>`**. The pair is
  ordered oldest-first and follows the file across renames.
- Whole-commit view: <kbd>F</kbd>, or the button at the end of every row, lists
  all the files that commit touched - not just the one being followed - with
  each file's status and line counts. Selecting a file opens its diff against
  the parent commit. Very large commits are capped at 500 files and say so.

### Changed

- The view keeps its state - selection, expanded commit, scroll position,
  search - while it is hidden behind another tab, instead of rebuilding itself
  from scratch on every reveal.

### Fixed

- Clicking a row and then changing its state (marking a compare base, opening
  the file list) no longer drops the focus, which greyed out the selection and
  left the keyboard shortcuts with nothing to act on.

## [1.1.0] - 2026-09-07

### Added

- File preview pane: selecting a commit shows the file as it was at that commit,
  with line numbers, optional soft wrapping and a draggable divider. Toggle it
  with <kbd>P</kbd> or the preview button; the state is remembered per window.
  A commit that deleted the file previews the version from its parent.
- `gitFileHistory.showPreview` and `gitFileHistory.previewMaxLines` settings.

## [1.0.0] - 2026-09-06

### Added

- History view for any file, reachable from the editor title bar, the editor and
  Explorer context menus, the SCM view, the Command Palette and
  `Ctrl+Alt+H` / `Cmd+Alt+H`.
- Timeline showing commit message, author avatar, relative and exact dates,
  short SHA, branch and tag badges, change type and lines added/removed.
- Rename following, including the previous path of a renamed file.
- Commit actions: open diff, open the file at a commit, compare with the working
  tree, copy SHA, copy message, open the commit on GitHub, GitLab, Bitbucket or
  Azure DevOps.
- Search: instant filtering of loaded commits, plus whole-history search by
  commit message (`--grep`) or by changed content (`-S`).
- Incremental paging with a cursor rather than `--skip`, so paging cost does not
  grow with the length of the history.
- Full keyboard navigation and screen-reader announcements.
- Clear empty, loading, untracked, no-repository and error states.
