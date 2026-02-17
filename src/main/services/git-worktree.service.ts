/**
 * Git Worktree Service - Manages git worktrees for parallel agent tasks
 *
 * Creates isolated working directories so multiple agents can implement
 * tasks concurrently on separate branches without conflicting.
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

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
  error?: string;
}

export class GitWorktreeService {
  private static readonly WORKTREE_DIR = '.castle-worktrees';

  /**
   * Check if a directory is inside a git repository.
   */
  isGitRepo(repoPath: string): boolean {
    try {
      execSync('git rev-parse --is-inside-work-tree', {
        cwd: repoPath,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get the root of the git repository.
   */
  getRepoRoot(repoPath: string): string {
    return execSync('git rev-parse --show-toplevel', {
      cwd: repoPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  }

  /**
   * Get the current branch name.
   */
  getCurrentBranch(repoPath: string): string {
    return execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: repoPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  }

  /**
   * Create a slugified branch name from a task title.
   */
  slugifyBranch(title: string): string {
    return 'castle/' + title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .substring(0, 60);
  }

  /**
   * Create a new git worktree for a task.
   * Creates a branch and a worktree directory under .castle-worktrees/<taskId>/
   */
  createWorktree(repoPath: string, taskTitle: string, taskId: string): WorktreeResult {
    if (!this.isGitRepo(repoPath)) {
      throw new Error('Not a git repository');
    }

    const repoRoot = this.getRepoRoot(repoPath);
    const branchName = this.slugifyBranch(taskTitle);
    const worktreeBase = path.join(repoRoot, GitWorktreeService.WORKTREE_DIR);
    const worktreePath = path.join(worktreeBase, taskId);

    // Ensure the worktree base directory exists
    if (!fs.existsSync(worktreeBase)) {
      fs.mkdirSync(worktreeBase, { recursive: true });
    }

    // Add .castle-worktrees to .gitignore if not already there
    this.ensureGitignore(repoRoot);

    // If worktree already exists, return it
    if (fs.existsSync(worktreePath)) {
      console.log(`[GitWorktree] Worktree already exists: ${worktreePath}`);
      return { worktreePath, branchName };
    }

    // Check if branch already exists
    let branchExists = false;
    try {
      execSync(`git rev-parse --verify ${branchName}`, {
        cwd: repoRoot,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      branchExists = true;
    } catch {
      branchExists = false;
    }

    if (branchExists) {
      // Create worktree using existing branch
      execSync(`git worktree add "${worktreePath}" ${branchName}`, {
        cwd: repoRoot,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } else {
      // Create worktree with new branch from current HEAD
      execSync(`git worktree add -b ${branchName} "${worktreePath}"`, {
        cwd: repoRoot,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    }

    console.log(`[GitWorktree] Created worktree: ${worktreePath} on branch ${branchName}`);
    return { worktreePath, branchName };
  }

  /**
   * Remove a git worktree and optionally delete the branch.
   */
  removeWorktree(worktreePath: string, deleteBranch = false): void {
    if (!fs.existsSync(worktreePath)) {
      console.log(`[GitWorktree] Worktree does not exist: ${worktreePath}`);
      return;
    }

    // Find the repo root by going up from the worktree path
    let repoRoot: string;
    try {
      repoRoot = this.getRepoRoot(worktreePath);
    } catch {
      console.warn(`[GitWorktree] Cannot find repo root for: ${worktreePath}`);
      return;
    }

    // Get branch name before removing
    let branchName: string | null = null;
    if (deleteBranch) {
      try {
        branchName = this.getCurrentBranch(worktreePath);
      } catch {
        // ignore
      }
    }

    // Remove worktree
    try {
      execSync(`git worktree remove "${worktreePath}" --force`, {
        cwd: repoRoot,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      console.log(`[GitWorktree] Removed worktree: ${worktreePath}`);
    } catch (error) {
      console.warn(`[GitWorktree] Error removing worktree:`, error);
      // Try force cleanup
      if (fs.existsSync(worktreePath)) {
        fs.rmSync(worktreePath, { recursive: true, force: true });
      }
      try {
        execSync('git worktree prune', {
          cwd: repoRoot,
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch { /* ignore */ }
    }

    // Delete the branch if requested
    if (deleteBranch && branchName && branchName !== 'HEAD') {
      try {
        execSync(`git branch -D ${branchName}`, {
          cwd: repoRoot,
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        console.log(`[GitWorktree] Deleted branch: ${branchName}`);
      } catch {
        console.warn(`[GitWorktree] Could not delete branch: ${branchName}`);
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
    const output = execSync('git worktree list --porcelain', {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

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
          isMainWorktree: wPath === repoRoot || path.normalize(wPath) === path.normalize(repoRoot),
        });
      }
    }

    return worktrees;
  }

  /**
   * Get the status of a specific worktree.
   */
  getWorktreeStatus(worktreePath: string): { exists: boolean; branch?: string; hasChanges?: boolean } {
    if (!fs.existsSync(worktreePath)) {
      return { exists: false };
    }

    try {
      const branch = this.getCurrentBranch(worktreePath);
      const status = execSync('git status --porcelain', {
        cwd: worktreePath,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      return {
        exists: true,
        branch,
        hasChanges: status.trim().length > 0,
      };
    } catch {
      return { exists: false };
    }
  }

  /**
   * Create a pull request from a worktree branch using the `gh` CLI.
   */
  createPullRequest(worktreePath: string, title: string, body: string): PullRequestResult {
    // Verify gh CLI is available
    try {
      execSync('gh --version', {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      return {
        success: false,
        error: 'GitHub CLI (gh) is not installed. Install it from https://cli.github.com/',
      };
    }

    try {
      // Push the branch first
      const branch = this.getCurrentBranch(worktreePath);
      execSync(`git push -u origin ${branch}`, {
        cwd: worktreePath,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      // Create the PR
      const result = execSync(
        `gh pr create --title "${title.replace(/"/g, '\\"')}" --body "${body.replace(/"/g, '\\"')}"`,
        {
          cwd: worktreePath,
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
        }
      );

      const url = result.trim();
      console.log(`[GitWorktree] Created PR: ${url}`);
      return { success: true, url };
    } catch (error: any) {
      return {
        success: false,
        error: error.message || String(error),
      };
    }
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
