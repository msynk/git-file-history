# Changelog

All notable changes to Git File History are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
