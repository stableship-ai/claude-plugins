#!/usr/bin/env node
/**
 * Stableship SessionStart hook. Prints a short plain-text note about open blocking findings for the repo in the
 * session's directory, then one line on how many rules the project has and where to read them; Claude Code adds
 * SessionStart stdout to Claude's context. It also starts the session's state file (the repository and the start
 * time), which the prevention and inbox hooks read. It must never get in the way: no GitHub remote, offline, a slow
 * API or any error all mean "print nothing and exit 0". With no saved login it says so, at most once a week (the hooks
 * can't do anything without one). No dependencies, Node 22+ only.
 */
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { apiBase, clean, getJson, gitRemote, parseGitRemote, readState, readStdin, writeState, apiToken } from './lib.mjs';

export { DEFAULT_API_URL, parseGitRemote } from './lib.mjs';
export const FETCH_TIMEOUT_MS = 2500;
export const MAX_LISTED = 8;

/**
 * @param {string | undefined} apiUrl
 * @param {string} repo
 */
export function findingsUrl(apiUrl, repo) {
  return `${apiBase(apiUrl)}/api/v1/findings?repo=${encodeURIComponent(repo)}&blocking=true&status=open`;
}

/**
 * @param {string | undefined} apiUrl
 * @param {string} repo
 */
export function rulesUrl(apiUrl, repo) {
  return `${apiBase(apiUrl)}/api/v1/rules?repo=${encodeURIComponent(repo)}`;
}

/**
 * The hook input is JSON on stdin with the session `cwd` and `session_id`; anything unreadable means "use our own cwd".
 * @param {string} text
 * @returns {{ cwd?: string, sessionId?: string }}
 */
export function parseHookInput(text) {
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object') return {};
    return {
      ...(typeof parsed.cwd === 'string' && parsed.cwd ? { cwd: parsed.cwd } : {}),
      ...(typeof parsed.session_id === 'string' && parsed.session_id ? { sessionId: parsed.session_id } : {}),
    };
  } catch {
    return {};
  }
}

/**
 * Context text for Claude, or '' when nothing blocks. Written as facts, not instructions.
 * @param {string} repo
 * @param {Array<{ id: string, title: string, severity: string, where?: string | null, blocks?: boolean }>} findings
 */
export function summarize(repo, findings) {
  const blocking = (Array.isArray(findings) ? findings : []).filter((f) => f && f.blocks === true);
  if (blocking.length === 0) return '';
  const n = blocking.length;
  const lines = [
    `Stableship: ${n} reproduced finding${n === 1 ? '' : 's'} currently block${n === 1 ? 's' : ''} releases of ${repo}.`,
  ];
  for (const f of blocking.slice(0, MAX_LISTED)) {
    const where = f.where ? ` (${clean(f.where, 120)})` : '';
    lines.push(`- [${clean(f.severity, 10)}] ${clean(f.title, 160)}${where}. Finding id: ${clean(f.id, 40)}`);
  }
  if (n > MAX_LISTED) lines.push(`- …and ${n - MAX_LISTED} more.`);
  lines.push(
    'The /stableship:gate fix command fixes and verifies them; the get_fix_brief tool returns the fix brief for one finding, and explain_finding says why one blocks.',
  );
  return `${lines.join('\n')}\n`;
}

/**
 * One line on the project's rules, or '' when it has none (or the answer is unreadable).
 * @param {string} repo
 * @param {{ rules?: unknown[] } | null | undefined} body
 */
export function rulesLine(repo, body) {
  const n = Array.isArray(body?.rules) ? body.rules.length : 0;
  if (n === 0) return '';
  return `Stableship: ${n} rule${n === 1 ? '' : 's'} say${n === 1 ? 's' : ''} who may see and change what in ${repo}. The get_rules tool lists them (a copy lives in .gate/rules.md once the rules pull request is merged); the stableship skill covers changing auth, data access, payments or migrations.\n`;
}

export const LOGIN_HINT_EVERY_MS = 7 * 24 * 3600_000;
/**
 * Without a saved login the hooks can't read anything (the plugin's tools sign in through Claude Code, the hooks
 * can't). Rather than stay silent for good, say so at most once a week, in a repository. Pure.
 * @param {number} now
 * @param {unknown} lastShown  ISO time it was last said, if ever
 */
export function loginHint(now, lastShown) {
  const last = typeof lastShown === 'string' ? Date.parse(lastShown) : NaN;
  if (Number.isFinite(last) && now - last < LOGIN_HINT_EVERY_MS) return '';
  return 'Stableship: the plugin\'s hooks are off on this machine because nothing is signed in for them, so blocking findings and check results will not show up in sessions. The Stableship tools still work. Mention once that running `npx --yes @stableship/cli@latest login` (it opens the browser to approve) turns the hooks on.\n';
}

/** @returns {Promise<string>} the context text, or '' to stay silent */
async function main() {
  const token = apiToken();
  const input = parseHookInput(await readStdin(1000));
  const remote = await gitRemote(input.cwd ?? process.cwd());
  const repo = remote ? parseGitRemote(remote) : null;
  if (!repo) return '';
  if (!token) {
    const seen = readState('login-hint');
    const hint = loginHint(Date.now(), seen.shownAt);
    if (hint) writeState('login-hint', { shownAt: new Date().toISOString() });
    return hint;
  }
  // The session's state file: the inbox reports findings recorded from now on, and the rules cache starts empty.
  const sessionId = input.sessionId ?? 'default';
  const state = readState(sessionId);
  writeState(sessionId, { ...state, repo, startedAt: typeof state.startedAt === 'string' && state.repo === repo ? state.startedAt : new Date().toISOString(), rulesShown: {} });
  // Both at once, so the hook still finishes within one timeout.
  const [findings, rules] = await Promise.all([
    getJson(findingsUrl(process.env.STABLESHIP_API_URL, repo), token, FETCH_TIMEOUT_MS),
    getJson(rulesUrl(process.env.STABLESHIP_API_URL, repo), token, FETCH_TIMEOUT_MS),
  ]);
  return summarize(repo, findings?.findings) + rulesLine(repo, rules);
}

function isEntryPoint() {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  // Exit explicitly (stdin may still be open) but only after stdout has flushed.
  main().then(
    (text) => (text ? process.stdout.write(text, () => process.exit(0)) : process.exit(0)),
    () => process.exit(0),
  );
}
