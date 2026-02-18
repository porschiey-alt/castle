/**
 * GitHub Issue Service - Wraps `gh` CLI for issue CRUD operations
 *
 * Uses execFile (not exec) to avoid shell injection vulnerabilities.
 * All commands auto-detect the repo from the git remote — no need to parse owner/repo.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { createLogger } from './logger.service';

const execFileAsync = promisify(execFile);
const log = createLogger('GitHubIssue');

export interface GitHubIssue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  url: string;
  createdAt: string;
  updatedAt: string;
}

export class GitHubIssueService {
  /** Check if current directory is a GitHub repo with gh auth */
  async isAvailable(cwd: string): Promise<boolean> {
    try {
      // Check gh CLI is installed and authenticated
      await execFileAsync('gh', ['auth', 'status'], { cwd });
      // Check the remote is GitHub
      const { stdout } = await execFileAsync('git', ['remote', 'get-url', 'origin'], { cwd });
      return /github\.com/i.test(stdout.trim());
    } catch {
      return false;
    }
  }

  /** Get owner/repo string from git remote */
  async getRepoSlug(cwd: string): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], { cwd });
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }

  /** List issues */
  async listIssues(cwd: string, state: 'open' | 'closed' | 'all' = 'open'): Promise<GitHubIssue[]> {
    try {
      const args = ['issue', 'list', '--json', 'number,title,body,state,labels,url,createdAt,updatedAt', '--limit', '100'];
      if (state !== 'all') {
        args.push('--state', state);
      }
      const { stdout } = await execFileAsync('gh', args, { cwd });
      const raw = JSON.parse(stdout);
      return raw.map((issue: any) => ({
        number: issue.number,
        title: issue.title,
        body: issue.body || '',
        state: issue.state?.toLowerCase() === 'closed' ? 'closed' : 'open',
        labels: (issue.labels || []).map((l: any) => typeof l === 'string' ? l : l.name),
        url: issue.url || '',
        createdAt: issue.createdAt || '',
        updatedAt: issue.updatedAt || '',
      }));
    } catch (error: any) {
      log.error('Failed to list issues', error.message);
      return [];
    }
  }

  /** Get single issue by number */
  async getIssue(cwd: string, issueNumber: number): Promise<GitHubIssue | null> {
    try {
      const { stdout } = await execFileAsync('gh', [
        'issue', 'view', String(issueNumber),
        '--json', 'number,title,body,state,labels,url,createdAt,updatedAt'
      ], { cwd });
      const issue = JSON.parse(stdout);
      return {
        number: issue.number,
        title: issue.title,
        body: issue.body || '',
        state: issue.state?.toLowerCase() === 'closed' ? 'closed' : 'open',
        labels: (issue.labels || []).map((l: any) => typeof l === 'string' ? l : l.name),
        url: issue.url || '',
        createdAt: issue.createdAt || '',
        updatedAt: issue.updatedAt || '',
      };
    } catch (error: any) {
      log.error(`Failed to get issue #${issueNumber}`, error.message);
      return null;
    }
  }

  /** Create a new issue, returns the created issue */
  async createIssue(cwd: string, title: string, body: string, labels?: string[]): Promise<GitHubIssue> {
    const args = ['issue', 'create', '--title', title, '--body', body || ''];
    if (labels?.length) {
      args.push('--label', labels.join(','));
    }
    const { stdout } = await execFileAsync('gh', args, { cwd });
    const url = stdout.trim();
    // Extract issue number from URL
    const number = parseInt(url.split('/').pop() || '0', 10);
    log.info(`Created issue #${number}: ${url}`);
    // Fetch full issue data
    const issue = await this.getIssue(cwd, number);
    if (!issue) {
      return { number, title, body, state: 'open', labels: labels || [], url, createdAt: '', updatedAt: '' };
    }
    return issue;
  }

  /** Update an existing issue */
  async updateIssue(cwd: string, issueNumber: number, updates: { title?: string; body?: string }): Promise<void> {
    const args = ['issue', 'edit', String(issueNumber)];
    if (updates.title) args.push('--title', updates.title);
    if (updates.body !== undefined) args.push('--body', updates.body);
    if (args.length > 3) {
      await execFileAsync('gh', args, { cwd });
      log.info(`Updated issue #${issueNumber}`);
    }
  }

  /** Close an issue */
  async closeIssue(cwd: string, issueNumber: number): Promise<void> {
    await execFileAsync('gh', ['issue', 'close', String(issueNumber)], { cwd });
    log.info(`Closed issue #${issueNumber}`);
  }

  /** Reopen an issue */
  async reopenIssue(cwd: string, issueNumber: number): Promise<void> {
    await execFileAsync('gh', ['issue', 'reopen', String(issueNumber)], { cwd });
    log.info(`Reopened issue #${issueNumber}`);
  }

  /** Add labels to an issue */
  async addLabels(cwd: string, issueNumber: number, labels: string[]): Promise<void> {
    if (!labels.length) return;
    await execFileAsync('gh', ['issue', 'edit', String(issueNumber), '--add-label', labels.join(',')], { cwd });
  }

  /** Remove labels from an issue */
  async removeLabels(cwd: string, issueNumber: number, labels: string[]): Promise<void> {
    if (!labels.length) return;
    await execFileAsync('gh', ['issue', 'edit', String(issueNumber), '--remove-label', labels.join(',')], { cwd });
  }
}
