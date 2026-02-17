/**
 * Permission grant matching utility.
 *
 * When a permission request arrives the system loads all grants for the
 * current project + tool kind and scores each one against the request
 * context.  The most-specific matching grant wins.
 */

import { PermissionGrant } from '../types/settings.types';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Find the best matching grant for an incoming permission request.
 * Returns `null` when no grant matches.
 */
export function findMatchingGrant(
  grants: PermissionGrant[],
  toolKind: string,
  locations: Array<{ path: string; line?: number | null }> | null | undefined,
  rawInput: unknown,
  projectPath: string,
): PermissionGrant | null {
  const candidates = grants.filter(g => g.toolKind === toolKind);

  // For chained commands, check that every sub-command is covered by some grant
  if (toolKind === 'execute') {
    const cmd = normalizeCommand(rawInput);
    if (cmd) {
      const subCmds = splitChainedCommands(cmd);
      if (subCmds.length > 1) {
        return findMatchingGrantForChain(candidates, subCmds, projectPath);
      }
    }
  }

  const scored = candidates
    .map(grant => ({ grant, score: matchScore(grant, locations, rawInput, projectPath) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score);

  return scored.length > 0 ? scored[0].grant : null;
}

/**
 * For chained commands (e.g. "cd dir && git log"), every sub-command must be
 * covered by at least one grant. Returns the lowest-specificity grant if all
 * sub-commands match, or null if any sub-command is uncovered.
 */
function findMatchingGrantForChain(
  grants: PermissionGrant[],
  subCmds: string[],
  projectPath: string,
): PermissionGrant | null {
  let weakestGrant: PermissionGrant | null = null;
  let weakestScore = Infinity;

  // `cd` is pure navigation — implicitly allowed in chains
  const IMPLICIT_CMDS = ['cd'];

  for (const sub of subCmds) {
    const binary = sub.trim().split(/\s+/)[0].toLowerCase();
    if (IMPLICIT_CMDS.includes(binary)) continue;

    const subInput = { command: sub };
    let bestScore = 0;
    let bestGrant: PermissionGrant | null = null;
    for (const grant of grants) {
      const score = matchScore(grant, null, subInput, projectPath);
      if (score > bestScore) {
        bestScore = score;
        bestGrant = grant;
      }
    }
    if (!bestGrant || bestScore === 0) return null; // Uncovered sub-command
    if (bestScore < weakestScore) {
      weakestScore = bestScore;
      weakestGrant = bestGrant;
    }
  }

  return weakestGrant;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function matchScore(
  grant: PermissionGrant,
  locations: Array<{ path: string; line?: number | null }> | null | undefined,
  rawInput: unknown,
  projectPath: string,
): number {
  switch (grant.scopeType) {
    case 'command':
      return normalizeCommand(rawInput) === grant.scopeValue ? 100 : 0;

    case 'command_prefix': {
      const cmd = normalizeCommand(rawInput);
      if (!cmd) return 0;
      // For chained commands (&&, ||, ;), check that EVERY sub-command
      // matches the prefix. e.g. "cd dir && git log" matches prefix "git"
      // only if "cd" is also allowed — but here we check a single prefix,
      // so for chains, each sub-command's first word must equal the grant prefix.
      const subCmds = splitChainedCommands(cmd);
      if (subCmds.length > 1) {
        // Every sub-command's binary must match the grant prefix
        const allMatch = subCmds.every(sub => {
          const bin = sub.split(/\s+/)[0];
          return bin === grant.scopeValue;
        });
        return allMatch ? 75 : 0;
      }
      // Single command: match on word boundary
      if (cmd === grant.scopeValue) return 80;
      if (cmd.startsWith(grant.scopeValue + ' ')) return 80;
      return 0;
    }

    case 'path':
      return locations?.some(l => normalizePath(l.path, projectPath) === grant.scopeValue) ? 100 : 0;

    case 'path_prefix':
      return locations?.length &&
        locations.every(l => normalizePath(l.path, projectPath).startsWith(grant.scopeValue))
        ? 70
        : 0;

    case 'glob':
      return locations?.length &&
        locations.every(l => simpleGlobMatch(normalizePath(l.path, projectPath), grant.scopeValue))
        ? 60
        : 0;

    case 'domain':
      return extractDomain(rawInput) === grant.scopeValue ? 90 : 0;

    case 'url_prefix': {
      const url = extractUrl(rawInput);
      return url && url.startsWith(grant.scopeValue) ? 85 : 0;
    }

    case 'any':
      return 10;

    default:
      return 0;
  }
}

// ---------------------------------------------------------------------------
// Normalisation helpers
// ---------------------------------------------------------------------------

function normalizeCommand(rawInput: unknown): string | null {
  if (!rawInput) return null;
  if (typeof rawInput === 'string') return rawInput.trim();
  if (typeof rawInput === 'object') {
    const obj = rawInput as Record<string, unknown>;
    if (typeof obj['command'] === 'string') return (obj['command'] as string).trim();
    if (typeof obj['cmd'] === 'string') return (obj['cmd'] as string).trim();
  }
  return null;
}

/** Split a chained command string into individual commands (by &&, ||, ;) */
function splitChainedCommands(cmd: string): string[] {
  return cmd.split(/\s*(?:&&|\|\||;)\s*/).map(s => s.trim()).filter(Boolean);
}

function normalizePath(filePath: string, _projectPath: string): string {
  // Normalize to forward slashes and collapse redundant segments
  return filePath.replace(/\\/g, '/').replace(/\/+/g, '/');
}

function extractDomain(rawInput: unknown): string | null {
  const url = extractUrl(rawInput);
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function extractUrl(rawInput: unknown): string | null {
  if (!rawInput) return null;
  if (typeof rawInput === 'string') {
    try { new URL(rawInput); return rawInput; } catch { return null; }
  }
  if (typeof rawInput === 'object') {
    const obj = rawInput as Record<string, unknown>;
    if (typeof obj['url'] === 'string') return obj['url'];
    if (typeof obj['uri'] === 'string') return obj['uri'];
  }
  return null;
}

/**
 * Simple glob matching that supports `*` (single segment) and `**` (any depth).
 * Good enough for path_prefix / extension patterns without pulling in minimatch.
 */
function simpleGlobMatch(filePath: string, pattern: string): boolean {
  // Convert glob to regex
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape special regex chars (not * and ?)
    .replace(/\*\*/g, '{{GLOBSTAR}}')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\{\{GLOBSTAR\}\}/g, '.*');

  return new RegExp(`^${regexStr}$`).test(filePath);
}

// ---------------------------------------------------------------------------
// Scope option derivation (used by the permission dialog)
// ---------------------------------------------------------------------------

export interface ScopeOption {
  scopeType: PermissionGrant['scopeType'];
  scopeValue: string;
  label: string;
}

export function deriveScopeOptions(
  toolKind: string,
  locations: Array<{ path: string; line?: number | null }> | null | undefined,
  rawInput: unknown,
): ScopeOption[] {
  const options: ScopeOption[] = [];

  if (toolKind === 'execute' && rawInput) {
    const cmd = normalizeCommand(rawInput);
    if (cmd) {
      const subCmds = splitChainedCommands(cmd);
      // For chained commands, offer per-binary prefixes for each unique binary
      if (subCmds.length > 1) {
        const binaries = [...new Set(subCmds.map(s => s.split(/\s+/)[0].toLowerCase()))].filter(b => b !== 'cd');
        for (const bin of binaries) {
          options.push({ scopeType: 'command_prefix', scopeValue: bin, label: `All \`${bin}\` commands` });
        }
      } else {
        options.push({ scopeType: 'command', scopeValue: cmd, label: `This exact command` });
        const prefix = cmd.split(/\s+/)[0];
        if (prefix !== cmd) {
          options.push({ scopeType: 'command_prefix', scopeValue: prefix, label: `All \`${prefix}\` commands` });
        }
      }
    }
  }

  if (['read', 'edit', 'delete', 'move'].includes(toolKind) && locations?.length) {
    const filePath = locations[0].path;
    options.push({ scopeType: 'path', scopeValue: filePath, label: `This file only` });

    const dir = filePath.substring(0, filePath.lastIndexOf('/') + 1);
    if (dir) {
      options.push({ scopeType: 'path_prefix', scopeValue: dir, label: `Files in \`${dir}\`` });
    }
    options.push({ scopeType: 'path_prefix', scopeValue: '', label: `Files in project directory` });
  }

  if (toolKind === 'fetch' && rawInput) {
    const domain = extractDomain(rawInput);
    if (domain) {
      options.push({ scopeType: 'domain', scopeValue: domain, label: `Requests to \`${domain}\`` });
    }
  }

  // Always offer the blanket option last
  options.push({ scopeType: 'any', scopeValue: '', label: `All ${toolKind} operations` });

  return options;
}
