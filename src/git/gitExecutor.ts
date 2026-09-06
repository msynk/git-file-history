import { spawn } from 'child_process';

/**
 * The part of `vscode.CancellationToken` this layer needs. Declaring it here
 * keeps the whole git core free of the `vscode` module, so it can be exercised
 * by plain Node tests against a real repository.
 */
export interface CancellationLike {
  readonly isCancellationRequested: boolean;
  onCancellationRequested(listener: () => void): { dispose(): void };
}

/** Raised when git exits non-zero. Carries enough context to show a good message. */
export class GitError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly stderr: string,
    readonly args: readonly string[]
  ) {
    super(message);
    this.name = 'GitError';
  }
}

/** Raised when the caller cancelled the operation. Callers swallow this. */
export class GitCancelledError extends Error {
  constructor() {
    super('Git operation cancelled');
    this.name = 'GitCancelledError';
  }
}

export interface RunOptions {
  cwd: string;
  token?: CancellationLike;
}

/**
 * Options applied to every invocation.
 *
 * - `core.quotepath=false` keeps non-ASCII paths readable instead of
 *   backslash-escaped octal.
 * - `log.showSignature=false` stops signed repositories from injecting gpg
 *   output into the log stream.
 * - `GIT_OPTIONAL_LOCKS=0` avoids touching the index, so a background history
 *   read never fights a foreground git command for the lock.
 */
const GLOBAL_ARGS = ['-c', 'core.quotepath=false', '-c', 'log.showSignature=false'];

/** Spawns git and collects its output. The single choke point for all git access. */
export class GitExecutor {
  constructor(private readonly gitPath: string) {}

  get path(): string {
    return this.gitPath;
  }

  async run(args: string[], options: RunOptions): Promise<string> {
    const buffer = await this.runRaw(args, options);
    return buffer.toString('utf8');
  }

  /** Runs git and returns stdout as bytes. */
  runRaw(args: string[], options: RunOptions): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      if (options.token?.isCancellationRequested) {
        reject(new GitCancelledError());
        return;
      }

      const child = spawn(this.gitPath, [...GLOBAL_ARGS, ...args], {
        cwd: options.cwd,
        windowsHide: true,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' }
      });

      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let settled = false;

      const cancellation = options.token?.onCancellationRequested(() => {
        if (!settled) {
          settled = true;
          child.kill();
          cancellation?.dispose();
          reject(new GitCancelledError());
        }
      });

      const finish = (fn: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        cancellation?.dispose();
        fn();
      };

      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));

      child.on('error', (error: NodeJS.ErrnoException) => {
        finish(() => {
          const message =
            error.code === 'ENOENT'
              ? `Could not run git ("${this.gitPath}"). Make sure git is installed and on your PATH, or set "git.path".`
              : error.message;
          reject(new GitError(message, null, '', args));
        });
      });

      child.on('close', (code) => {
        finish(() => {
          if (code === 0) {
            resolve(Buffer.concat(stdout));
            return;
          }
          const errorText = Buffer.concat(stderr).toString('utf8').trim();
          reject(new GitError(errorText || `git exited with code ${code}`, code, errorText, args));
        });
      });
    });
  }
}
