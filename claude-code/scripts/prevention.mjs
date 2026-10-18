#!/usr/bin/env node
/**
 * Stableship PreToolUse hook (Edit, Write, MultiEdit): when Claude is about to edit a file that concerns sign-in, data
 * access, payments or the database, hand it the matching rules first, as context. Never blocks, never exits non-zero.
 * Paths that look like ordinary UI code are skipped before any network call; each area's rules are shown once per
 * ten minutes per session; the request times out after two seconds.
 */
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { additionalContext, apiBase, clean, getJson, gitRemote, parseGitRemote, parseJson, readState, readStdin, rulesRecentlyShown, writeState, apiToken } from './lib.mjs';

/** Files worth a look: sign-in, sessions, Supabase, migrations, policies, money, routes, schemas. */
export const SENSITIVE = /(^|\/)(auth|login|signin|sign-in|signup|sign-up|session|password|oauth|supabase|migrations?|rls|polic(y|ies)|permission|guard|middleware|payments?|billing|stripe|checkout|invoice|subscription|webhook|api|routes?|server|schema|prisma|drizzle|admin|settings|team|members|invite)(\/|\.|-|_|$)|\.sql$/i;

/** Pure: the repository-relative file a tool call touches, or null. */
export function editedPath(toolInput, cwd) {
  const p = toolInput && typeof toolInput === 'object' ? toolInput.file_path ?? toolInput.path ?? toolInput.notebook_path : null;
  if (typeof p !== 'string' || !p) return null;
  const rel = cwd && p.startsWith(cwd) ? p.slice(cwd.length).replace(/^\/+/, '') : p;
  return rel.replace(/^\.\/+/, '');
}

export function isSensitive(path) {
  return SENSITIVE.test(path) && !/(\.test\.|\.spec\.|__tests__|\.stories\.|\.md$|\.css$|\.svg$|\.png$)/i.test(path);
}

export function rulesUrl(apiUrl, repo, path) {
  return `${apiBase(apiUrl)}/api/v1/rules?repo=${encodeURIComponent(repo)}&path=${encodeURIComponent(path)}`;
}

/** Pure: the context text for a rules answer, or '' when there is nothing to say. */
export function rulesContext(path, body) {
  const rules = Array.isArray(body?.rules) ? body.rules : [];
  if (rules.length === 0) return '';
  const areas = Array.isArray(body?.areas) && body.areas.length ? body.areas.join(', ') : 'this area';
  const lines = [`Stableship rules for ${areas} (you are editing ${clean(path, 120)}; ${rules.length} rule${rules.length === 1 ? '' : 's'}):`];
  for (const r of rules.slice(0, 12)) lines.push(`- ${clean(r.sentence ?? r.text, 220)}${r.enforcement === 'warn' ? ' (warns)' : ''}`);
  if (rules.length > 12) lines.push(`- …and ${rules.length - 12} more (get_rules lists them).`);
  const flows = Array.isArray(body?.flows) ? body.flows : [];
  if (flows.length) lines.push(`Flows Stableship tests here: ${flows.slice(0, 5).map((f) => clean(f.title ?? f.key, 60)).join(', ')}.`);
  lines.push('Keep every rule in the query, the API route and the row level security policy. To change who may do what, call propose_rule instead of changing access in code.');
  return lines.join('\n');
}

async function main() {
  const token = apiToken();
  if (!token) return '';
  const input = parseJson(await readStdin(1000));
  const path = editedPath(input.tool_input, input.cwd);
  if (!path || !isSensitive(path)) return '';
  const sessionId = input.session_id ?? 'default';
  const state = readState(sessionId);
  const remote = await gitRemote(input.cwd ?? process.cwd());
  const repo = (state.repo && typeof state.repo === 'string' ? state.repo : null) ?? (remote ? parseGitRemote(remote) : null);
  if (!repo) return '';
  const body = await getJson(rulesUrl(process.env.STABLESHIP_API_URL, repo, path), token);
  if (!body) return '';
  const areas = Array.isArray(body.areas) && body.areas.length ? body.areas : ['other'];
  const now = Date.now();
  if (areas.every((a) => rulesRecentlyShown(state, a, now))) return '';
  state.repo = repo;
  state.rulesShown = { ...(state.rulesShown ?? {}) };
  for (const a of areas) state.rulesShown[a] = now;
  writeState(sessionId, state);
  const text = rulesContext(path, body);
  return text ? additionalContext('PreToolUse', text) : '';
}

function isEntryPoint() {
  try { return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
}

if (isEntryPoint()) {
  main().then(
    (text) => (text ? process.stdout.write(`${text}\n`, () => process.exit(0)) : process.exit(0)),
    () => process.exit(0),
  );
}
