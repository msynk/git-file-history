import type { CommitDetail, CommitEntry, CommitFileChange, FileChangeStatus, RefInfo, RefKind } from './types';

/** Field separator inside a commit header. `git log` never emits it itself. */
const FIELD = '\x1f';
/** Marks the start of a commit record. */
const RECORD = '\x01';

/**
 * The `--format` string paired with {@link parseLog}. It must be combined with
 * `-z --raw --numstat`, which makes git emit, for each commit:
 *
 *   \x01 <header fields joined by \x1f> \x00 \n
 *   :<modes> <blobs> <STATUS> \x00 <path> \x00 [<newPath> \x00]   <- --raw
 *   <added> \t <deleted> \t <path> \x00                           <- --numstat
 *
 * and for a rename the numstat paths move into their own NUL-terminated
 * tokens: `<added>\t<deleted>\t\x00<old>\x00<new>\x00`.
 *
 * `--raw` supplies the exact status letter (A/M/D/R) that `--numstat` alone
 * cannot express, so one spawn produces everything a page needs.
 */
export const LOG_FORMAT = [
  `${RECORD}%H`,
  '%h',
  '%P',
  '%an',
  '%ae',
  '%at',
  '%cn',
  '%ce',
  '%ct',
  '%D',
  '%B'
].join(FIELD);

const HEADER_FIELD_COUNT = 11;

/**
 * Parses `git log` output produced with {@link LOG_FORMAT}.
 *
 * @param fallbackPath Path used for commits git reported without a diff
 * section, such as merge commits.
 */
export function parseLog(stdout: string, fallbackPath = ''): CommitEntry[] {
  const commits: CommitEntry[] = [];
  if (!stdout) {
    return commits;
  }

  // A record starts with RECORD either at the very start of the stream or
  // right after the NUL that closed the previous record. Anchoring on that
  // pair stops a stray RECORD byte inside a commit message from splitting a
  // record in half.
  let start = stdout.startsWith(RECORD) ? 0 : stdout.indexOf('\x00' + RECORD) + 1;
  if (start <= 0 && !stdout.startsWith(RECORD)) {
    return commits;
  }

  while (start < stdout.length) {
    const next = stdout.indexOf('\x00' + RECORD, start + 1);
    const end = next === -1 ? stdout.length : next + 1;
    const commit = parseRecord(stdout.slice(start + RECORD.length, end), fallbackPath);
    if (commit) {
      commits.push(commit);
    }
    if (next === -1) {
      break;
    }
    start = next + 1;
  }
  return commits;
}

function parseRecord(record: string, fallbackPath: string): CommitEntry | undefined {
  const headerEnd = record.indexOf('\x00');
  if (headerEnd === -1) {
    return undefined;
  }
  const header = parseHeader(record.slice(0, headerEnd));
  if (!header) {
    return undefined;
  }
  return { ...header, ...parseChange(record.slice(headerEnd + 1), fallbackPath) };
}

/** The commit metadata shared by a single-file log entry and a whole commit. */
type CommitHeader = Omit<CommitEntry, 'path' | 'previousPath' | 'status' | 'insertions' | 'deletions'>;

function parseHeader(header: string): CommitHeader | undefined {
  const fields = splitHeader(header);
  if (fields.length < HEADER_FIELD_COUNT) {
    return undefined;
  }

  const [
    hash,
    shortHash,
    parents,
    authorName,
    authorEmail,
    authorDate,
    committerName,
    committerEmail,
    commitDate,
    decorations,
    message
  ] = fields;

  const { subject, body } = splitMessage(message);

  return {
    hash,
    shortHash,
    parents: parents ? parents.split(' ').filter(Boolean) : [],
    authorName,
    authorEmail,
    authorDate: Number(authorDate) * 1000,
    committerName,
    committerEmail,
    commitDate: Number(commitDate) * 1000,
    subject,
    body,
    refs: parseRefs(decorations)
  };
}

/**
 * Parses the single record produced by `git log -1` with {@link LOG_FORMAT},
 * keeping every file the commit touched instead of only the one being followed.
 *
 * @param limit Most files to keep. A larger commit is reported as truncated
 * rather than silently shortened, so the view can say what it left out.
 */
export function parseCommitDetail(stdout: string, limit = Number.POSITIVE_INFINITY): CommitDetail | undefined {
  const start = stdout.indexOf(RECORD);
  if (start === -1) {
    return undefined;
  }
  // `-m` can emit one record per parent; only the first-parent diff is wanted.
  const next = stdout.indexOf('\x00' + RECORD, start + 1);
  const record = stdout.slice(start + RECORD.length, next === -1 ? undefined : next + 1);

  const headerEnd = record.indexOf('\x00');
  if (headerEnd === -1) {
    return undefined;
  }
  const header = parseHeader(record.slice(0, headerEnd));
  if (!header) {
    return undefined;
  }

  const files = parseChanges(record.slice(headerEnd + 1));
  return {
    ...header,
    fileCount: files.length,
    files: files.length > limit ? files.slice(0, limit) : files,
    truncated: files.length > limit || undefined
  };
}

/**
 * Reads the `--raw` and `--numstat` sections of a commit that was not narrowed
 * to one path, so every file it touched comes back.
 *
 * git emits the whole raw section first and the whole numstat section after it,
 * so the statuses are collected on the first pass and the line counts matched
 * onto them by path on the second.
 */
function parseChanges(section: string): CommitFileChange[] {
  const tokens = section.replace(/^\n/, '').split('\x00');
  const changes: CommitFileChange[] = [];
  const byPath = new Map<string, CommitFileChange>();

  let index = 0;
  while (index < tokens.length && tokens[index].startsWith(':')) {
    const entry = tokens[index];
    const status = statusFromLetter(entry.slice(entry.lastIndexOf(' ') + 1));
    let path = tokens[index + 1] ?? '';
    let previousPath: string | undefined;
    index += 2;
    if (status === 'renamed') {
      previousPath = path;
      path = tokens[index] ?? path;
      index += 1;
    }
    if (!path) {
      continue;
    }
    const change: CommitFileChange = { path, previousPath, status };
    changes.push(change);
    byPath.set(path, change);
  }

  for (; index < tokens.length; index++) {
    const parts = tokens[index].split('\t');
    if (parts.length < 3) {
      continue;
    }
    // A dash means git treated the blob as binary and counted no lines.
    const insertions = parts[0] === '-' ? undefined : Number(parts[0]);
    const deletions = parts[1] === '-' ? undefined : Number(parts[1]);
    let path = parts.slice(2).join('\t');
    let previousPath: string | undefined;
    if (path === '') {
      // A rename moves both paths into their own NUL-terminated tokens.
      previousPath = tokens[index + 1] ?? '';
      path = tokens[index + 2] ?? '';
      index += 2;
    }
    if (!path) {
      continue;
    }
    const existing = byPath.get(path);
    if (existing) {
      existing.insertions = insertions;
      existing.deletions = deletions;
      continue;
    }
    // No raw entry for this path: fall back to what numstat alone can tell us.
    changes.push({
      path,
      previousPath: previousPath || undefined,
      status: previousPath ? 'renamed' : 'modified',
      insertions,
      deletions
    });
    byPath.set(path, changes[changes.length - 1]);
  }

  return changes;
}

/**
 * Splits the header into exactly {@link HEADER_FIELD_COUNT} fields. The last
 * one is the raw commit message, which may itself contain the separator, so it
 * absorbs everything that remains.
 */
function splitHeader(header: string): string[] {
  const fields: string[] = [];
  let start = 0;
  for (let i = 0; i < HEADER_FIELD_COUNT - 1; i++) {
    const at = header.indexOf(FIELD, start);
    if (at === -1) {
      return [];
    }
    fields.push(header.slice(start, at));
    start = at + FIELD.length;
  }
  fields.push(header.slice(start));
  return fields;
}

function splitMessage(message: string): { subject: string; body: string } {
  const trimmed = message.replace(/\s+$/, '');
  const breakAt = trimmed.indexOf('\n');
  if (breakAt === -1) {
    return { subject: trimmed, body: '' };
  }
  return {
    subject: trimmed.slice(0, breakAt),
    body: trimmed.slice(breakAt + 1).replace(/^\n+/, '')
  };
}

interface ChangeInfo {
  path: string;
  previousPath?: string;
  status: FileChangeStatus;
  insertions?: number;
  deletions?: number;
}

/**
 * Reads the `--raw` and `--numstat` sections. History is always requested for a
 * single path, so a commit contributes at most one change and only the first
 * entry of each section is relevant.
 */
function parseChange(section: string, fallbackPath: string): ChangeInfo {
  const tokens = section.replace(/^\n/, '').split('\x00');
  if (!tokens[0]) {
    // No diff section: a merge commit that git kept during simplification.
    return { path: fallbackPath, status: 'modified' };
  }

  let index = 0;
  let status: FileChangeStatus = 'modified';
  let path = fallbackPath;
  let previousPath: string | undefined;

  if (tokens[0].startsWith(':')) {
    const letter = tokens[0].slice(tokens[0].lastIndexOf(' ') + 1);
    status = statusFromLetter(letter);
    path = tokens[1] ?? fallbackPath;
    index = 2;
    if (status === 'renamed') {
      previousPath = path;
      path = tokens[2] ?? path;
      index = 3;
    }
  }

  const stats = parseNumstatToken(tokens, index);
  if (stats.path) {
    path = stats.path;
    if (stats.previousPath) {
      previousPath = stats.previousPath;
      status = 'renamed';
    }
  }

  return { path, previousPath, status, insertions: stats.insertions, deletions: stats.deletions };
}

function parseNumstatToken(
  tokens: string[],
  index: number
): { path?: string; previousPath?: string; insertions?: number; deletions?: number } {
  const token = tokens[index];
  if (token === undefined || token === '') {
    return {};
  }
  const parts = token.split('\t');
  if (parts.length < 3) {
    return {};
  }
  // A dash means git treated the blob as binary and counted no lines.
  const insertions = parts[0] === '-' ? undefined : Number(parts[0]);
  const deletions = parts[1] === '-' ? undefined : Number(parts[1]);
  const inlinePath = parts.slice(2).join('\t');

  if (inlinePath === '') {
    return {
      previousPath: tokens[index + 1] ?? '',
      path: tokens[index + 2] ?? '',
      insertions,
      deletions
    };
  }
  return { path: inlinePath, insertions, deletions };
}

function statusFromLetter(letter: string): FileChangeStatus {
  switch (letter.charAt(0)) {
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    // C (copy), M (modify), T (type change) and U (unmerged) all read as an
    // edit from the point of view of a single file's history.
    default:
      return 'modified';
  }
}

/** Parses the `%D` decoration field into structured refs. */
export function parseRefs(decorations: string): RefInfo[] {
  if (!decorations) {
    return [];
  }
  const refs: RefInfo[] = [];
  for (const raw of decorations.split(', ')) {
    const entry = raw.trim();
    if (!entry) {
      continue;
    }
    if (entry.startsWith('tag: ')) {
      refs.push({ kind: 'tag', name: entry.slice('tag: '.length) });
      continue;
    }
    // `HEAD -> main` means HEAD is attached to that local branch.
    const arrow = entry.indexOf(' -> ');
    if (arrow !== -1) {
      refs.push({ kind: 'head', name: entry.slice(arrow + 4) });
      continue;
    }
    if (entry === 'HEAD') {
      refs.push({ kind: 'head', name: 'HEAD' });
      continue;
    }
    const kind: RefKind = entry.includes('/') ? 'remote' : 'branch';
    refs.push({ kind, name: entry });
  }
  return refs;
}
