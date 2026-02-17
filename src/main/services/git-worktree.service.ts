/**
 * Git Worktree Service - Manages git worktrees for parallel agent tasks
 *
 * Creates isolated working directories so multiple agents can implement
 * tasks concurrently on separate branches without conflicting.
 *
 * Uses execFile (not exec/execSync) to avoid shell injection vulnerabilities.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from './logger.service';

const execFileAsync = promisify(execFile);
const log = createLogger('GitWorktree');

export interface WorktreeInfo {
  path: string;
  branch: string;
  head: string;
  isMainWorktree: boolean;
}

export interface WorktreeResult {
  worktreePath: string;
  branchName: string;
}

export interface PullRequestResult {
  success: boolean;
  url?: string;
  prNumber?: number;
  error?: string;
}

/** Provider-agnostic PR creation interface for future GitLab/Azure DevOps support */
export interface PullRequestProvider {
  readonly name: string;
  matchesRemote(remoteUrl: string): boolean;
  isAuthenticated(cwd: string): Promise<boolean>;
  createPR(cwd: string, options: PRCreateOptions): Promise<PullRequestResult>;
  pushToExistingPR(cwd: string, prNumber: number): Promise<void>;
  getPRComments(cwd: string, prNumber: number): Promise<PRComment[]>;
}

export interface PRComment {
  id: string;
  author: string;
  body: string;
  path?: string;
  line?: number;
  createdAt: string;
}

export interface PRCreateOptions {
  title: string;
  body: string;
  baseBranch?: string;
  draft?: boolean;
}

/** GitHub provider using `gh` CLI */
class GitHubProvider implements PullRequestProvider {
  readonly name = 'github';
  private readonly log = createLogger('GitHubProvider');

  matchesRemote(remoteUrl: string): boolean {
    return /github\.com/i.test(remoteUrl);
  }

  async isAuthenticated(cwd: string): Promise<boolean> {
    try {
      const { stdout, stderr } = await execFileAsync('gh', ['auth', 'status'], { cwd });
      this.log.info('gh auth status OK', stdout.trim());
      return true;
    } catch (error: any) {
      this.log.warn('gh auth status FAILED', {
        message: error.message,
        stderr: error.stderr,
        code: error.code,
      });
      return false;
    }
  }

  async createPR(cwd: string, options: PRCreateOptions): Promise<PullRequestResult> {
    try {
      const args = ['pr', 'create', '--title', options.title, '--body', options.body];
      if (options.baseBranch) args.push('--base', options.baseBranch);
      if (options.draft) args.push('--draft');

      const { stdout } = await execFileAsync('gh', args, { cwd });
      const url = stdout.trim();
      const prNumber = parseInt(url.split('/').pop() || '0', 10);
      return { success: true, url, prNumber: prNumber || undefined };
    } catch (error: any) {
      return { success: false, error: error.stderr || error.message || String(error) };
    }
  }

  async pushToExistingPR(cwd: string, _prNumber: number): Promise<void> {
    // For GitHub, pushing to the branch auto-updates the PR
    const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
    await execFileAsync('git', ['push', 'origin', stdout.trim()], { cwd });
  }

  async getPRComments(cwd: string, prNumber: number): Promise<PRComment[]> {
    try {
      const { stdout } = await execFileAsync('gh', [
        'pr', 'view', String(prNumber),
        '--json', 'reviews',
        '--jq', '.reviews[] | .body'
      ], { cwd });

      // Parse review comments from gh CLI output
      const comments: PRComment[] = [];
      const lines = stdout.trim().split('\n').filter(Boolean);
      for (let i = 0; i < lines.length; i++) {
        comments.push({
          id: `review-${i}`,
          author: '',
          body: lines[i],
          createdAt: new Date().toISOString(),
        });
      }
      return comments;
    } catch {
      return [];
    }
  }
}

/** Safe git command executor — no shell, no injection */
async function gitExec(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout.trim();
}

/** Read-only git command — uses --no-optional-locks to avoid contention */
async function gitExecReadOnly(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['--no-optional-locks', ...args], { cwd });
  return stdout.trim();
}

function gitExecSync(args: string[], cwd: string): string {
  const { execFileSync } = require('child_process');
  return (execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }) as string).trim();
}

export class GitWorktreeService {
  private static readonly WORKTREE_DIR = '.castle-worktrees';
  private static readonly MAX_CONCURRENT_DEFAULT = 5;

  private providers: PullRequestProvider[] = [new GitHubProvider()];
  private maxConcurrent = GitWorktreeService.MAX_CONCURRENT_DEFAULT;

  setMaxConcurrent(max: number): void {
    this.maxConcurrent = Math.max(1, max);
  }

  /**
   * Check if a directory is inside a git repository.
   */
  isGitRepo(repoPath: string): boolean {
    try {
      gitExecSync(['rev-parse', '--is-inside-work-tree'], repoPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get the root of the git repository.
   */
  getRepoRoot(repoPath: string): string {
    return gitExecSync(['rev-parse', '--show-toplevel'], repoPath);
  }

  /**
   * Get the current branch name.
   */
  getCurrentBranch(repoPath: string): string {
    return gitExecSync(['rev-parse', '--abbrev-ref', 'HEAD'], repoPath);
  }

  /**
   * Check for uncommitted changes in the working directory.
   */
  async hasUncommittedChanges(repoPath: string): Promise<boolean> {
    const output = await gitExecReadOnly(['status', '--porcelain'], repoPath);
    return output.length > 0;
  }

  /**
   * Create a slugified branch name from a task title.
   */
  slugifyBranch(title: string, kind?: string): string {
    const prefix = kind === 'bug' ? 'bugfix' : kind === 'chore' ? 'chore' : 'feature';
    const slug = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .substring(0, 50);
    return `castle/${prefix}/${slug}`;
  }

  /**
   * Create a new git worktree for a task.
   */
  async createWorktree(repoPath: string, taskTitle: string, taskId: string, kind?: string, baseBranch?: string): Promise<WorktreeResult> {
    if (!this.isGitRepo(repoPath)) {
      throw new Error('Not a git repository');
    }

    const repoRoot = this.getRepoRoot(repoPath);
    const branchName = this.slugifyBranch(taskTitle, kind);
    const worktreeBase = path.join(repoRoot, GitWorktreeService.WORKTREE_DIR);
    const worktreePath = path.join(worktreeBase, taskId);

    // Enforce concurrent worktree limit
    const active = await this.listCastleWorktrees(repoPath);
    if (active.length >= this.maxConcurrent) {
      throw new Error(`Maximum concurrent worktrees (${this.maxConcurrent}) reached. Clean up completed tasks first.`);
    }

    // Ensure the worktree base directory exists
    if (!fs.existsSync(worktreeBase)) {
      fs.mkdirSync(worktreeBase, { recursive: true });
    }

    this.ensureGitignore(repoRoot);

    // If worktree already exists, return it
    if (fs.existsSync(worktreePath)) {
      log.info(`Worktree already exists: ${worktreePath}`);
      return { worktreePath, branchName };
    }

    // Determine the start point for the new branch, validating the ref exists
    let startPoint = 'HEAD';
    if (baseBranch) {
      try {
        await gitExec(['rev-parse', '--verify', baseBranch], repoRoot);
        startPoint = baseBranch;
      } catch {
        log.warn(`Base branch '${baseBranch}' not found, falling back to HEAD`);
      }
    }

    // Check if branch already exists
    let branchExists = false;
    try {
      await gitExec(['rev-parse', '--verify', branchName], repoRoot);
      branchExists = true;
    } catch {
      branchExists = false;
    }

    if (branchExists) {
      await gitExec(['worktree', 'add', worktreePath, branchName], repoRoot);
    } else {
      await gitExec(['worktree', 'add', '-b', branchName, worktreePath, startPoint], repoRoot);
    }

    // Enable long paths on Windows
    if (process.platform === 'win32') {
      try {
        await gitExec(['config', 'core.longpaths', 'true'], worktreePath);
      } catch { /* non-fatal */ }
    }

    log.info(`Created worktree: ${worktreePath} on branch ${branchName}`);
    return { worktreePath, branchName };
  }

  /**
   * Install dependencies in a worktree (detects package manager).
   */
  async installDependencies(worktreeDir: string): Promise<void> {
    if (fs.existsSync(path.join(worktreeDir, 'package-lock.json'))) {
      log.info('Installing dependencies with npm...');
      await execFileAsync('npm', ['ci', '--prefer-offline'], { cwd: worktreeDir, timeout: 300_000, shell: true });
    } else if (fs.existsSync(path.join(worktreeDir, 'yarn.lock'))) {
      log.info('Installing dependencies with yarn...');
      await execFileAsync('yarn', ['install', '--frozen-lockfile'], { cwd: worktreeDir, timeout: 300_000, shell: true });
    } else if (fs.existsSync(path.join(worktreeDir, 'pnpm-lock.yaml'))) {
      log.info('Installing dependencies with pnpm...');
      await execFileAsync('pnpm', ['install', '--frozen-lockfile'], { cwd: worktreeDir, timeout: 300_000, shell: true });
    } else {
      log.info('No lock file found, skipping dependency install');
    }
  }

  /**
   * Check if a worktree needs dependency installation (has lock file but no node_modules).
   */
  needsDependencyInstall(worktreeDir: string): boolean {
    const hasLockFile = fs.existsSync(path.join(worktreeDir, 'package-lock.json'))
      || fs.existsSync(path.join(worktreeDir, 'yarn.lock'))
      || fs.existsSync(path.join(worktreeDir, 'pnpm-lock.yaml'));
    const hasNodeModules = fs.existsSync(path.join(worktreeDir, 'node_modules'));
    return hasLockFile && !hasNodeModules;
  }

  /**
   * Stage and commit all changes in a worktree.
   */
  async commitChanges(worktreePath: string, message: string): Promise<boolean> {
    // Check if there are changes to commit
    const status = await gitExec(['status', '--porcelain'], worktreePath);
    if (!status) {
      log.info('No changes to commit');
      return false;
    }

    await gitExec(['add', '-A'], worktreePath);
    await gitExec(['commit', '-m', message], worktreePath);
    log.info(`Committed changes: ${message}`);
    return true;
  }

  /**
   * Check if the worktree branch has commits ahead of the base branch (main/master).
   */
  async hasCommitsAhead(worktreePath: string): Promise<boolean> {
    try {
      const branch = await gitExecReadOnly(['rev-parse', '--abbrev-ref', 'HEAD'], worktreePath);
      let baseBranch = 'main';
      try {
        await gitExecReadOnly(['rev-parse', '--verify', 'main'], worktreePath);
      } catch {
        baseBranch = 'master';
      }
      const count = await gitExecReadOnly(
        ['rev-list', '--count', `${baseBranch}..${branch}`], worktreePath
      );
      return parseInt(count, 10) > 0;
    } catch {
      return false;
    }
  }

  /**
   * Push branch to remote.
   */
  async pushBranch(worktreePath: string): Promise<void> {
    const branch = await gitExec(['rev-parse', '--abbrev-ref', 'HEAD'], worktreePath);
    await gitExec(['push', '--set-upstream', 'origin', branch], worktreePath);
    log.info(`Pushed branch: ${branch}`);
  }

  /**
   * Get a diff summary for a worktree (for preview).
   */
  async getDiffSummary(worktreePath: string): Promise<string> {
    try {
      const branch = await gitExecReadOnly(['rev-parse', '--abbrev-ref', 'HEAD'], worktreePath);
      let baseBranch = 'main';
      try {
        await gitExecReadOnly(['rev-parse', '--verify', 'main'], worktreePath);
      } catch {
        baseBranch = 'master';
      }
      try {
        const mergeBase = await gitExecReadOnly(['merge-base', baseBranch, branch], worktreePath);
        return await gitExecReadOnly(['diff', '--stat', mergeBase, 'HEAD'], worktreePath);
      } catch {
        return await gitExecReadOnly(['diff', '--stat', 'HEAD~1'], worktreePath);
      }
    } catch {
      return '(unable to generate diff summary)';
    }
  }

  /**
   * Get the full diff for a worktree.
   */
  async getDiff(worktreePath: string): Promise<string> {
    try {
      const branch = await gitExecReadOnly(['rev-parse', '--abbrev-ref', 'HEAD'], worktreePath);
      let baseBranch = 'main';
      try {
        await gitExecReadOnly(['rev-parse', '--verify', 'main'], worktreePath);
      } catch {
        baseBranch = 'master';
      }
      try {
        const mergeBase = await gitExecReadOnly(['merge-base', baseBranch, branch], worktreePath);
        return await gitExecReadOnly(['diff', mergeBase, 'HEAD'], worktreePath);
      } catch {
        return await gitExecReadOnly(['diff', 'HEAD~1'], worktreePath);
      }
    } catch {
      return '';
    }
  }

  /**
   * Remove a git worktree and optionally delete the branch.
   */
  async removeWorktree(worktreePath: string, deleteBranch = false): Promise<void> {
    if (!fs.existsSync(worktreePath)) {
      log.info(`Worktree does not exist: ${worktreePath}`);
      return;
    }

    let repoRoot: string;
    try {
      repoRoot = this.getRepoRoot(worktreePath);
    } catch {
      log.warn(`Cannot find repo root for: ${worktreePath}`);
      return;
    }

    // Get branch name before removing
    let branchName: string | null = null;
    if (deleteBranch) {
      try {
        branchName = this.getCurrentBranch(worktreePath);
      } catch { /* ignore */ }
    }

    try {
      await gitExec(['worktree', 'remove', worktreePath, '--force'], repoRoot);
      log.info(`Removed worktree: ${worktreePath}`);
    } catch (error) {
      log.warn('Error removing worktree', error);
      if (fs.existsSync(worktreePath)) {
        fs.rmSync(worktreePath, { recursive: true, force: true });
      }
      try {
        await gitExec(['worktree', 'prune'], repoRoot);
      } catch { /* ignore */ }
    }

    if (deleteBranch && branchName && branchName !== 'HEAD') {
      try {
        await gitExec(['branch', '-D', branchName], repoRoot);
        log.info(`Deleted branch: ${branchName}`);
      } catch {
        log.warn(`Could not delete branch: ${branchName}`);
      }
    }
  }

  /**
   * List all worktrees for a repository.
   */
  listWorktrees(repoPath: string): WorktreeInfo[] {
    if (!this.isGitRepo(repoPath)) {
      return [];
    }

    const repoRoot = this.getRepoRoot(repoPath);
    const output = gitExecSync(['worktree', 'list', '--porcelain'], repoRoot);

    const worktrees: WorktreeInfo[] = [];
    const entries = output.split('\n\n').filter(Boolean);

    for (const entry of entries) {
      const lines = entry.trim().split('\n');
      let wPath = '';
      let head = '';
      let branch = '';
      let isBare = false;

      for (const line of lines) {
        if (line.startsWith('worktree ')) wPath = line.substring(9);
        if (line.startsWith('HEAD ')) head = line.substring(5);
        if (line.startsWith('branch ')) branch = line.substring(7).replace('refs/heads/', '');
        if (line === 'bare') isBare = true;
      }

      if (wPath && !isBare) {
        worktrees.push({
          path: wPath,
          branch,
          head,
          isMainWorktree: path.normalize(wPath) === path.normalize(repoRoot),
        });
      }
    }

    return worktrees;
  }

  /**
   * List only Castle-managed worktrees (those under .castle-worktrees).
   */
  async listCastleWorktrees(repoPath: string): Promise<WorktreeInfo[]> {
    const all = this.listWorktrees(repoPath);
    const repoRoot = this.getRepoRoot(repoPath);
    const worktreeBase = path.join(repoRoot, GitWorktreeService.WORKTREE_DIR);
    return all.filter(w => path.normalize(w.path).startsWith(path.normalize(worktreeBase)));
  }

  /**
   * Get worktrees sorted by last modified time (oldest first) for LRU cleanup.
   * Returns worktrees that can be cleaned up to free slots.
   */
  async getLruWorktrees(repoPath: string, count: number): Promise<Array<WorktreeInfo & { lastModified: Date }>> {
    const worktrees = await this.listCastleWorktrees(repoPath);
    const withMtime = worktrees.map(w => {
      let mtime = new Date(0);
      try {
        mtime = fs.statSync(w.path).mtime;
      } catch { /* directory may be gone */ }
      return { ...w, lastModified: mtime };
    });
    // Sort oldest first (LRU)
    withMtime.sort((a, b) => a.lastModified.getTime() - b.lastModified.getTime());
    return withMtime.slice(0, count);
  }

  /**
   * Clean up the given worktrees (remove worktree + delete branch).
   */
  async cleanupWorktrees(worktrees: WorktreeInfo[]): Promise<void> {
    for (const wt of worktrees) {
      log.info(`LRU cleanup: removing ${wt.path} (branch: ${wt.branch})`);
      await this.removeWorktree(wt.path, true);
    }
  }

  /**
   * Get the status of a specific worktree.
   */
  async getWorktreeStatus(worktreePath: string): Promise<{ exists: boolean; branch?: string; hasChanges?: boolean }> {
    if (!fs.existsSync(worktreePath)) {
      return { exists: false };
    }

    try {
      const branch = await gitExecReadOnly(['rev-parse', '--abbrev-ref', 'HEAD'], worktreePath);
      const status = await gitExecReadOnly(['status', '--porcelain'], worktreePath);
      return { exists: true, branch, hasChanges: status.length > 0 };
    } catch {
      return { exists: false };
    }
  }

  /**
   * Detect the remote URL and find a matching PR provider.
   */
  async getProvider(cwd: string): Promise<PullRequestProvider | null> {
    try {
      const remoteUrl = await gitExec(['remote', 'get-url', 'origin'], cwd);
      for (const provider of this.providers) {
        if (provider.matchesRemote(remoteUrl)) return provider;
      }
    } catch { /* no remote */ }
    return null;
  }

  /**
   * Check if the PR provider CLI is authenticated.
   */
  async isProviderAuthenticated(cwd: string): Promise<{ authenticated: boolean; provider?: string }> {
    const provider = await this.getProvider(cwd);
    if (!provider) return { authenticated: false };
    const authenticated = await provider.isAuthenticated(cwd);
    return { authenticated, provider: provider.name };
  }

  /**
   * Push branch and create a pull request via the detected provider.
   */
  async pushAndCreatePR(worktreePath: string, options: PRCreateOptions): Promise<PullRequestResult> {
    const provider = await this.getProvider(worktreePath);
    if (!provider) {
      return { success: false, error: 'No supported Git hosting provider detected for this repository.' };
    }

    log.info(`pushAndCreatePR: provider=${provider.name}, cwd=${worktreePath}`);
    const authenticated = await provider.isAuthenticated(worktreePath);
    log.info(`pushAndCreatePR: authenticated=${authenticated}`);
    if (!authenticated) {
      return { success: false, error: `Not authenticated with ${provider.name}. Run the appropriate login command.` };
    }

    // Push first
    try {
      await this.pushBranch(worktreePath);
    } catch (error: any) {
      return { success: false, error: `Failed to push: ${error.message || error}` };
    }

    return provider.createPR(worktreePath, options);
  }

  /**
   * Clean up orphaned Castle worktrees (those on disk that don't map to active tasks).
   * Called on app startup.
   */
  async cleanupOrphans(repoPath: string, activeTaskIds: Set<string>): Promise<void> {
    if (!this.isGitRepo(repoPath)) return;

    const repoRoot = this.getRepoRoot(repoPath);
    const worktreeBase = path.join(repoRoot, GitWorktreeService.WORKTREE_DIR);

    if (!fs.existsSync(worktreeBase)) return;

    const dirs = fs.readdirSync(worktreeBase, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);

    for (const taskId of dirs) {
      if (!activeTaskIds.has(taskId)) {
        const orphanPath = path.join(worktreeBase, taskId);
        log.info(`Cleaning up orphan worktree: ${orphanPath}`);
        await this.removeWorktree(orphanPath, true);
      }
    }

    // Prune any stale worktree references
    try {
      await gitExec(['worktree', 'prune'], repoRoot);
    } catch { /* ignore */ }
  }

  /**
   * Ensure .castle-worktrees is in .gitignore.
   */
  private ensureGitignore(repoRoot: string): void {
    const gitignorePath = path.join(repoRoot, '.gitignore');
    const entry = GitWorktreeService.WORKTREE_DIR;

    if (fs.existsSync(gitignorePath)) {
      const content = fs.readFileSync(gitignorePath, 'utf-8');
      if (content.includes(entry)) return;
      fs.appendFileSync(gitignorePath, `\n# Castle agent worktrees\n${entry}/\n`);
    } else {
      fs.writeFileSync(gitignorePath, `# Castle agent worktrees\n${entry}/\n`);
    }
  }
}
