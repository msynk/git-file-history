#!/usr/bin/env node
/**
 * Builds demo/sample-repo: a small repository with the kind of history that is
 * worth looking at - several authors, a rename, tags, a binary file, a deletion
 * and enough commits to exercise paging.
 *
 * Usage:
 *   node demo/setup.js            # create (or recreate) demo/sample-repo
 *   node demo/setup.js --commits 400
 *
 * Then open demo/sample-repo in the Extension Development Host (F5) and run
 * "Git History: Show File History" on src/parser.ts.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, 'sample-repo');

const AUTHORS = [
  { name: 'Ada Lovelace', email: 'ada@example.com' },
  { name: 'Grace Hopper', email: 'grace@example.com' },
  { name: 'Alan Turing', email: 'alan@example.com' },
  { name: 'Katherine Johnson', email: 'katherine@example.com' }
];

const extraCommits = readCount();

function readCount() {
  const index = process.argv.indexOf('--commits');
  if (index === -1) {
    return 40;
  }
  const value = Number(process.argv[index + 1]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 40;
}

function git(args, options = {}) {
  execFileSync('git', args, { cwd: REPO, stdio: 'pipe', ...options });
}

function write(relativePath, contents) {
  const target = path.join(REPO, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}

/**
 * Commits with a fixed author and a back-dated timestamp, so the view shows a
 * believable spread of relative dates instead of "just now" everywhere.
 */
function commit(message, author, daysAgo) {
  const when = new Date(Date.now() - daysAgo * 86400000).toISOString();
  git(['add', '-A']);
  git(['commit', '-q', '-m', message], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: author.name,
      GIT_AUTHOR_EMAIL: author.email,
      GIT_AUTHOR_DATE: when,
      GIT_COMMITTER_NAME: author.name,
      GIT_COMMITTER_EMAIL: author.email,
      GIT_COMMITTER_DATE: when
    }
  });
}

function parserSource(version, notes) {
  return [
    '/** A toy expression parser used to demo the Git File History view. */',
    `export const VERSION = '${version}';`,
    '',
    'export interface Token {',
    '  kind: "number" | "operator" | "paren";',
    '  value: string;',
    '}',
    '',
    'export function tokenize(input: string): Token[] {',
    '  const tokens: Token[] = [];',
    '  for (const match of input.matchAll(/\\d+(?:\\.\\d+)?|[-+*/]|[()]/g)) {',
    '    const value = match[0];',
    '    tokens.push({ kind: classify(value), value });',
    '  }',
    '  return tokens;',
    '}',
    '',
    'function classify(value: string): Token["kind"] {',
    '  if (value === "(" || value === ")") {',
    '    return "paren";',
    '  }',
    '  return /\\d/.test(value) ? "number" : "operator";',
    '}',
    ...notes.map((note) => `// ${note}`),
    ''
  ].join('\n');
}

function main() {
  if (fs.existsSync(REPO)) {
    fs.rmSync(REPO, { recursive: true, force: true });
  }
  fs.mkdirSync(REPO, { recursive: true });

  git(['init', '-q', '-b', 'main', '.']);
  git(['config', 'user.name', 'Demo']);
  git(['config', 'user.email', 'demo@example.com']);
  git(['config', 'commit.gpgsign', 'false']);
  git(['config', 'core.autocrlf', 'false']);
  // A plausible remote so "Open on remote" is enabled in the view.
  git(['remote', 'add', 'origin', 'https://github.com/example/git-file-history-demo.git']);

  let day = 420;

  write('README.md', '# Sample repository\n\nA scratch repository for trying out Git File History.\n');
  write('src/lexer.ts', parserSource('0.1.0', []));
  commit('Initial commit', AUTHORS[0], day--);

  write('src/lexer.ts', parserSource('0.2.0', ['handles parentheses']));
  commit('Recognise parentheses\n\nThe tokenizer previously dropped them, which broke nesting.', AUTHORS[1], day--);

  write('src/lexer.ts', parserSource('0.3.0', ['handles parentheses', 'supports decimals']));
  commit('Support decimal numbers', AUTHORS[2], day--);
  git(['tag', 'v0.3.0']);

  git(['mv', 'src/lexer.ts', 'src/parser.ts']);
  write('src/parser.ts', parserSource('0.4.0', ['handles parentheses', 'supports decimals', 'renamed from lexer.ts']));
  commit('Rename lexer.ts to parser.ts\n\nThe module does more than lexing now.', AUTHORS[0], day--);

  write('assets/logo.bin', Buffer.from(Array.from({ length: 512 }, (_, i) => i % 251)));
  commit('Add a binary asset', AUTHORS[3], day--);

  write('src/legacy.ts', 'export const deprecated = true;\n');
  commit('Add a module that will be removed', AUTHORS[1], day--);
  fs.rmSync(path.join(REPO, 'src', 'legacy.ts'));
  commit('Remove the deprecated module', AUTHORS[1], day--);

  // A long tail of commits so "load older commits" and the keyboard paging have
  // something real to work with.
  const notes = ['handles parentheses', 'supports decimals', 'renamed from lexer.ts'];
  for (let i = 0; i < extraCommits; i++) {
    const author = AUTHORS[i % AUTHORS.length];
    notes.push(`tuned rule ${i}`);
    write('src/parser.ts', parserSource(`0.5.${i}`, notes.slice(-6)));
    commit(`Tune tokenizer rule ${i}`, author, Math.max(1, day - i));
  }

  git(['tag', 'v1.0.0']);

  console.log(`Sample repository ready at ${REPO}`);
  console.log('Open it in the Extension Development Host and run "Git History: Show File History" on src/parser.ts.');
}

main();
