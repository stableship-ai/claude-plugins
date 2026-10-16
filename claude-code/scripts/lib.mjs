/**
 * Shared helpers for the Stableship plugin's hook scripts. No dependencies, Node 22+. Every function here is written
 * so a hook can never get in the way: network calls time out fast, state lives in a per-session file under the user's
 * state directory, and anything unreadable means "do nothing".
 */
import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_API_URL = 'https://api.stableship.ai';
export const FETCH_TIMEOUT_MS = 2000;
/** The rules for one area are shown once per this many minutes per session. */
export const RULES_TTL_MS = 10 * 60_000;
/** The inbox polls Stableship at most this often, except on Stop. */
export const INBOX_INTERVAL_MS = 45_000;

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;

/** `owner/name` from a GitHub remote URL (https, scp-style ssh, ssh://, git://), else null. Kept in step with packages/cli/src/git.ts. */
export function parseGitRemote(remote) {
  const url = String(remote ?? '').trim();
  if (!url) return null;
  let host;
  let path;
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(url);
  if (/^[a-z+]+:\/\//i.test(url)) {
    try {
      const parsed = new URL(url);
      host = parsed.hostname;
      path = parsed.pathname;
    } catch {
      return null;
    }
  } else if (scp) {
    host = scp[1] ?? '';
    path = scp[2] ?? '';
  } else {
    return null;
  }
  if (!/^(?:www\.)?github\.com(?:-[\w.-]+)?$/i.test(host)) return null;
  const parts = path.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '').split('/');
  if (parts.length !== 2) return null;
  const [owner, name] = parts;
  return owner && name && OWNER.test(owner) && NAME.test(name) ? `${owner}/${name}` : null;
}

export function apiBase(apiUrl) {
  return (apiUrl && apiUrl.trim() ? apiUrl.trim() : DEFAULT_API_URL).replace(/\/+$/, '');
}

/** GET JSON with the token, within the timeout; null on any failure. */
export async function getJson(url, token, timeoutMs = FETCH_TIMEOUT_MS) {
  try {
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json', 'user-agent': 'stableship-claude-code-plugin' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/** The hook's JSON input from stdin; {} when unreadable. */
export function readStdin(timeoutMs = 1000) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    const timer = setTimeout(() => resolve(data), timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => { clearTimeout(timer); resolve(data); });
    process.stdin.on('error', () => { clearTimeout(timer); resolve(data); });
  });
}

export function parseJson(text) {
  try { const v = JSON.parse(text); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
}

export function gitRemote(cwd) {
  return new Promise((resolve) => {
    execFile('git', ['remote', 'get-url', 'origin'], { cwd, timeout: 1500 }, (err, stdout) => {
      resolve(err ? null : String(stdout).trim() || null);
    });
  });
}

/** `$XDG_STATE_HOME/stableship/sessions`, else `~/.local/state/stableship/sessions`. */
export function stateDir(env = process.env, home = homedir()) {
  const xdg = env.XDG_STATE_HOME && env.XDG_STATE_HOME.trim();
  return join(xdg ? xdg : join(home, '.local', 'state'), 'stableship', 'sessions');
}

function safeName(sessionId) {
  const s = String(sessionId ?? 'default').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
  return s || 'default';
}

/** Per-session state: `{ repo, startedAt, runs: [{ id, deliveredAt }], lastPollAt, deliveredFindingIds, rulesShown: { area: at } }`. */
export function readState(sessionId, dir = stateDir()) {
  try {
    const v = JSON.parse(readFileSync(join(dir, `${safeName(sessionId)}.json`), 'utf8'));
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

export function writeState(sessionId, state, dir = stateDir()) {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, `${safeName(sessionId)}.json`);
    writeFileSync(path, JSON.stringify(state), { mode: 0o600 });
    chmodSync(path, 0o600);
  } catch {
    // State is a convenience; a hook never fails for it.
  }
}

/** Pure: whether the inbox may poll now. */
export function mayPoll(state, now, interval = INBOX_INTERVAL_MS) {
  if (state.lastPollAt === undefined || state.lastPollAt === null) return true;
  const last = Number(state.lastPollAt);
  return !Number.isFinite(last) || now - last >= interval;
}

/** Pure: whether an area's rules were shown recently in this session. */
export function rulesRecentlyShown(state, area, now, ttl = RULES_TTL_MS) {
  const raw = state.rulesShown?.[area];
  if (raw === undefined || raw === null) return false;
  const at = Number(raw);
  return Number.isFinite(at) && now - at < ttl;
}

/** Hook JSON output that adds context without blocking. */
export function additionalContext(hookEventName, text) {
  return JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: text } });
}

/** One line, bounded, so a title cannot spill into extra context lines. */
export function clean(value, max) {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
