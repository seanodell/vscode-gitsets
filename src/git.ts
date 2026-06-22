import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Minimal shape of the built-in Git extension's exported API — just enough to
// read the resolved git binary path. We avoid a hard dependency on its types.
interface BuiltinGitApi {
  git?: { path?: string };
}
interface BuiltinGitExports {
  getAPI(version: 1): BuiltinGitApi;
}

let cachedGitPath: string | undefined;

// Resolve the git binary by reusing the built-in Git extension's resolved path
// (which honors the `git.path` setting and VS Code's own discovery), falling
// back to `git` on PATH. This is the pattern GitLens uses.
export async function resolveGitPath(): Promise<string> {
  if (cachedGitPath) {
    return cachedGitPath;
  }
  let resolved = 'git';
  try {
    const ext = vscode.extensions.getExtension<BuiltinGitExports>('vscode.git');
    if (ext) {
      const exports = ext.isActive ? ext.exports : await ext.activate();
      const fromApi = exports.getAPI(1)?.git?.path;
      if (fromApi) {
        resolved = fromApi;
      }
    }
  } catch {
    // Built-in Git extension unavailable/disabled — fall back to PATH.
  }
  cachedGitPath = resolved;
  return resolved;
}

export class GitError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
    readonly code?: number,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

// Run a git command with an argument array (never a shell string), a timeout,
// and structured errors. Returns stdout.
export async function runGit(
  args: string[],
  opts: { cwd: string; timeoutMs?: number },
): Promise<string> {
  const git = await resolveGitPath();
  try {
    const { stdout } = await execFileAsync(git, args, {
      cwd: opts.cwd,
      timeout: opts.timeoutMs ?? 60_000,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
    return stdout;
  } catch (err) {
    const e = err as { stderr?: string; message?: string; code?: number };
    const stderr = typeof e.stderr === 'string' ? e.stderr : '';
    const detail = stderr.trim() || e.message || String(err);
    throw new GitError(`git ${args.join(' ')} failed: ${detail}`, stderr, e.code);
  }
}
