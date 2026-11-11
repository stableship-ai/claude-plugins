#!/usr/bin/env node
/**
 * Stableship SessionStart hook. Prints a short plain-text note about open blocking findings for the repo in the
 * session's directory, the rule changes waiting for a person's decision (so a founder who works in Claude Code can
 * decide them here, not only in the app), then one line on how many rules the project has; Claude Code adds
 * SessionStart stdout to Claude's context. It also starts the session's state file (the repository and the start
 * time), which the prevention and inbox hooks read. It must never get in the way: no GitHub remote, offline, a slow
 * API or any error all mean "print nothing and exit 0". With no saved login it says so, at most once a week (the hooks
 * can't do anything without one); with a login Stableship rejects (401: expired or revoked), at most once a day. No
 * dependencies, Node 22+ only.
 */
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { apiBase, clean, getJson, getJsonStatus, gitRemote, parseGitRemote, readState, readStdin, writeState, apiToken } from './lib.mjs';

export { DEFAULT_API_URL, parseGitRemote } from './lib.mjs';
export const FETCH_TIMEOUT_MS = 2500;
export const MAX_LISTED = 8;
export const MAX_SUGGESTIONS = 3;

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
 * The project's context: its rules and the rule suggestions waiting for a decision, in one request.
 * @param {string | undefined} apiUrl
 * @param {string} repo
 */
export function contextUrl(apiUrl, repo) {
  return `${apiBase(apiUrl)}/api/v1/context?repo=${encodeURIComponent(repo)}`;
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
    'When the user asks to fix them ("fix them", "fix the audit", "work through the findings"), call get_fix_plan and work through its tasks in order, then verify_fix each one.',
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
  return `Stableship: ${n} rule${n === 1 ? '' : 's'} say${n === 1 ? 's' : ''} who may see and change what in ${repo}. The get_rules tool lists them (get_repo_files gives .gate/rules.md to commit yourself); the stableship skill covers changing auth, data access, payments or migrations.\n`;
}

/**
 * The rule suggestions waiting for a person, or '' when there are none. Accepting one that lets more people in needs
 * the owner, so the agent asks and passes the answer on; it never decides one itself. Pure.
 * @param {string} repo
 * @param {{ pendingSuggestions?: number, suggestions?: Array<{ id: string, question?: string, change?: string[] }> } | null | undefined} body
 */
export function suggestionsLine(repo, body) {
  const list = (Array.isArray(body?.suggestions) ? body.suggestions : []).filter((s) => s && typeof s.id === 'string');
  const n = Math.max(Number(body?.pendingSuggestions) || 0, list.length);
  if (n === 0 || list.length === 0) return '';
  const lines = [`Stableship: ${n} suggested rule change${n === 1 ? '' : 's'} for ${repo} wait${n === 1 ? 's' : ''} for a person to decide. Until then the findings they would settle stay open.`];
  for (const s of list.slice(0, MAX_SUGGESTIONS)) {
    const change = Array.isArray(s.change) && typeof s.change[0] === 'string' ? ` Accepting it: ${clean(s.change[0], 200)}.` : '';
    lines.push(`- ${clean(s.question || 'Add this rule?', 200)}${change} Suggestion id: ${clean(s.id, 40)}`);
  }
  if (n > MAX_SUGGESTIONS) lines.push(`- …and ${n - MAX_SUGGESTIONS} more (get_context lists them).`);
  lines.push('Ask the user about each one, in plain words. When they answer, call decide_rule_suggestion with their choice (accept or dismiss); the user decides, never the agent.');
  return `${lines.join('\n')}\n`;
}

/**
 * Results that finished since the last session in this repository (audits, the day's deep checks, checks someone asked
 * for). The first session looks back a day and a half.
 * @param {string | undefined} apiUrl
 * @param {string} repo
 * @param {string} since ISO time
 */
export function finishedRunsUrl(apiUrl, repo, since) {
  return `${apiBase(apiUrl)}/api/v1/runs?repo=${encodeURIComponent(repo)}&since=${encodeURIComponent(since)}`;
}
export const FIRST_LOOK_BACK_MS = 36 * 3600_000;

/**
 * One line per finished result since the last session, or ''. Pure.
 * @param {{ runs?: Array<{ kind?: string, verdict?: string | null, blocking?: number, findings?: number, pushes?: number, url?: string }> } | null | undefined} body
 */
export function finishedLine(body) {
  const runs = (Array.isArray(body?.runs) ? body.runs : []).filter((r) => r && typeof r.url === 'string').slice(0, 3);
  if (runs.length === 0) return '';
  const lines = ['Stableship: since the last session here:'];
  for (const r of runs) {
    const what = r.kind === 'audit' ? 'An audit' : r.kind === 'deep_check' ? (r.pushes ? `The deep check of ${r.pushes} risky push${r.pushes === 1 ? '' : 'es'}` : 'A deep check') : 'A check someone asked for';
    const b = Number(r.blocking) || 0; const f = Number(r.findings) || 0;
    const found = b ? `${b} blocking problem${b === 1 ? '' : 's'} (${f} finding${f === 1 ? '' : 's'} in all)` : f ? `nothing blocking, ${f} finding${f === 1 ? '' : 's'} to look at` : 'nothing to fix';
    lines.push(`- ${what} finished: ${found}. ${clean(r.url, 200)}`);
  }
  lines.push('Tell the user in a sentence; get_findings and get_fix_plan have the details.');
  return `${lines.join('\n')}\n`;
}

export const UNLINKED_HINT_EVERY_MS = 7 * 24 * 3600_000;
/**
 * A repository no Stableship app uses: said once a week, so the user knows why no findings or rules show up. Pure.
 * @param {string} repo
 * @param {number} now
 * @param {unknown} lastShown
 */
export function unlinkedLine(repo, now, lastShown) {
  const last = typeof lastShown === 'string' ? Date.parse(lastShown) : NaN;
  if (Number.isFinite(last) && now - last < UNLINKED_HINT_EVERY_MS) return '';
  return `Stableship: ${repo} isn't linked to a Stableship app in this workspace, so its findings and rules won't show up here. If it belongs to an app, link it in Stableship's Settings → Repositories; otherwise this is expected. Mention it once.\n`;
}

/** The hello every session sends (GET /api/v1/whoami). Pure. */
export function whoamiUrl(apiUrl) {
  return `${apiBase(apiUrl)}/api/v1/whoami`;
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
  return 'Stableship: the plugin\'s hooks are off on this machine because nothing is signed in for them, so blocking findings and check results will not show up in sessions. The Stableship tools still work. Mention once that the user can turn the hooks on by running `npx --yes @stableship/cli@latest login` in their own terminal (it opens the browser to approve); do not run it yourself.\n';
}

export const REJECTED_HINT_EVERY_MS = 24 * 3600_000;
/**
 * The login the hooks use was refused (401: expired, revoked, or the token was deleted), so they go quiet. Said at most
 * once a day, in a repository. Pure.
 * @param {number} now
 * @param {unknown} lastShown  ISO time it was last said, if ever
 * @param {boolean} fromEnv  the token came from STABLESHIP_TOKEN rather than the saved login
 */
export function rejectedLoginHint(now, lastShown, fromEnv = false) {
  const last = typeof lastShown === 'string' ? Date.parse(lastShown) : NaN;
  if (Number.isFinite(last) && now - last < REJECTED_HINT_EVERY_MS) return '';
  const which = fromEnv ? 'the token in STABLESHIP_TOKEN' : 'the saved Stableship login';
  const unset = fromEnv ? ' (STABLESHIP_TOKEN wins over the saved login, so they should also update or unset it)' : '';
  return `Stableship: the plugin's hooks are off on this machine because Stableship rejected ${which} (it expired or was revoked), so blocking findings and check results will not show up in sessions. Mention once that the user can sign in again by running \`npx --yes @stableship/cli@latest login\` in their own terminal (it opens the browser to approve)${unset}; do not run it yourself.\n`;
}

/** @returns {Promise<string>} the context text, or '' to stay silent */
async function main() {
  const token = apiToken();
  const input = parseHookInput(await readStdin(1000));
  // Every session says hello, in any folder: that is how Stableship knows Claude Code is connected (setup's coding-agent
  // step turns green on it). Silent, and it never holds up the session beyond the fetch timeout.
  // Its status also says whether the login still works (401: refused).
  const hello = token ? getJsonStatus(whoamiUrl(process.env.STABLESHIP_API_URL), token, FETCH_TIMEOUT_MS) : Promise.resolve(null);
  const remote = await gitRemote(input.cwd ?? process.cwd());
  const repo = remote ? parseGitRemote(remote) : null;
  if (!repo) { await hello; return ''; }
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
  // When the last session here started: results that finished since are news (the first looks back a day and a half).
  const seen = readState('seen-runs');
  const since = typeof seen[repo] === 'string' && Number.isFinite(Date.parse(seen[repo])) ? seen[repo] : new Date(Date.now() - FIRST_LOOK_BACK_MS).toISOString();
  const now = new Date().toISOString();
  const [found, context, finished, hi] = await Promise.all([
    getJsonStatus(findingsUrl(process.env.STABLESHIP_API_URL, repo), token, FETCH_TIMEOUT_MS),
    getJson(contextUrl(process.env.STABLESHIP_API_URL, repo), token, FETCH_TIMEOUT_MS),
    getJson(finishedRunsUrl(process.env.STABLESHIP_API_URL, repo, since), token, FETCH_TIMEOUT_MS),
    hello,
  ]);
  if (finished) writeState('seen-runs', { ...readState('seen-runs'), [repo]: now });
  if (found.status === 401 || hi?.status === 401) {
    const seen = readState('rejected-hint');
    const hint = rejectedLoginHint(Date.now(), seen.shownAt, Boolean(process.env.STABLESHIP_TOKEN && process.env.STABLESHIP_TOKEN.trim()));
    if (hint) writeState('rejected-hint', { shownAt: new Date().toISOString() });
    return hint;
  }
  if (found.status === 404) {
    // Not linked: the inbox stops polling this session, and the user hears why once a week.
    writeState(sessionId, { ...readState(sessionId), unlinked: true });
    const shown = readState('unlinked-hint');
    const line = unlinkedLine(repo, Date.now(), shown[repo]);
    if (line) writeState('unlinked-hint', { ...shown, [repo]: new Date().toISOString() });
    return line;
  }
  return finishedLine(finished) + summarize(repo, found.body?.findings) + suggestionsLine(repo, context) + rulesLine(repo, context);
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
