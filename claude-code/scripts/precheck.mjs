#!/usr/bin/env node
/**
 * Stableship PreToolUse hook (Bash): before Claude's first `git push` of a commit, the self-check. It lists the files
 * the push sends, asks Stableship which rules they concern and which questions to answer about the change (the
 * questions only: how Stableship matches them stays on its side and runs on the pushed commit), and declines that one
 * push with the list as the reason, so Claude reads its own diff against it first and then pushes again. A second push
 * of the same commit goes through. Pushes from the user's own terminal never pass through here. With nothing to check
 * (ordinary UI files, no login, no repo, offline, a slow API or any error) it says nothing and the push goes ahead.
 */
import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { apiBase, apiToken, clean, getJson, gitRemote, parseGitRemote, parseJson, readState, readStdin, writeState } from './lib.mjs';

export const MAX_PATHS = 100;
export const MAX_RULES = 12;
export const MAX_CHECKS = 10;

/** Pure: whether a shell command pushes with git (`git push`, `git -C x push --force`, inside `a && git push`). */
export function isGitPush(command) {
  if (typeof command !== 'string') return false;
  // git's own options that take the next word as their value.
  const takesValue = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path']);
  return command.split(/&&|\|\||;|\||\n/).some((part) => {
    const words = part.trim().split(/\s+/);
    let i = 0;
    while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i++;
    if (!/(^|\/)git$/.test(words[i] ?? '')) return false;
    i++;
    while (i < words.length && words[i].startsWith('-')) i += takesValue.has(words[i]) ? 2 : 1;
    return words[i] === 'push';
  });
}

/** Pure: the checklist URL; paths as repeated `path=` parameters. */
export function checklistUrl(apiUrl, repo, paths) {
  const q = [`repo=${encodeURIComponent(repo)}`, ...paths.map((p) => `path=${encodeURIComponent(p)}`)].join('&');
  return `${apiBase(apiUrl)}/api/v1/checklist?${q}`;
}

/** Pure: the self-check text, or '' when the answer has nothing to check. */
export function checklistText(body, pushed) {
  const rules = Array.isArray(body?.rules) ? body.rules : [];
  const checks = Array.isArray(body?.checks) ? body.checks : [];
  if (rules.length === 0 && checks.length === 0) return '';
  const filesFor = new Map();
  for (const p of Array.isArray(body?.paths) ? body.paths : []) {
    for (const k of Array.isArray(p?.checks) ? p.checks : []) filesFor.set(k, [...(filesFor.get(k) ?? []), p.path]);
  }
  const n = pushed;
  const lines = [`Stableship self-check before this push (${n} changed file${n === 1 ? '' : 's'}; asked once per commit). Read your diff against it first.`];
  if (rules.length) {
    lines.push('Rules these files concern; the change must keep each one true in the query, the API route and the row level security policy:');
    for (const r of rules.slice(0, MAX_RULES)) lines.push(`- ${clean(r.sentence, 220)}`);
    if (rules.length > MAX_RULES) lines.push(`- …and ${rules.length - MAX_RULES} more (get_rules lists them).`);
  }
  if (checks.length) {
    lines.push('Questions to answer about the change; fix what fails:');
    for (const c of checks.slice(0, MAX_CHECKS)) {
      const files = (filesFor.get(c.key) ?? []).slice(0, 3).map((f) => clean(f, 80));
      lines.push(`- ${clean(c.question, 220)}${files.length ? ` (${files.join(', ')})` : ''}`);
    }
  }
  lines.push('When you have checked (and fixed what failed, in a new commit if needed), run the push again; this commit is not asked twice. Your own reading is not a result: Stableship still checks the pushed commit. To change who may do what, call propose_rule instead of changing access in code.');
  return lines.join('\n');
}

/** Pure: the hook output that declines this one push with the self-check as the reason. */
export function declineOnce(text) {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: text } });
}

function git(cwd, args) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: 1500, maxBuffer: 1 << 20 }, (err, stdout) => resolve(err ? null : String(stdout)));
  });
}

/** The files this push sends: since the upstream branch, else since the default branch, else the last commit. */
async function pushedPaths(cwd) {
  for (const range of ['@{upstream}...HEAD', 'origin/HEAD...HEAD', 'HEAD~1..HEAD']) {
    const out = await git(cwd, ['diff', '--name-only', range]);
    if (out !== null) return [...new Set(out.split('\n').map((s) => s.trim()).filter(Boolean))];
  }
  return [];
}

async function main() {
  const input = parseJson(await readStdin(1000));
  if (input.tool_name && input.tool_name !== 'Bash') return '';
  if (!isGitPush(input.tool_input?.command)) return '';
  const token = apiToken();
  if (!token) return '';
  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
  const head = (await git(cwd, ['rev-parse', 'HEAD']))?.trim();
  if (!head) return '';
  const sessionId = input.session_id ?? 'default';
  const state = readState(sessionId);
  const asked = state.prechecked && typeof state.prechecked === 'object' ? state.prechecked : {};
  if (asked[head]) return '';
  const remote = await gitRemote(cwd);
  const repo = (typeof state.repo === 'string' && state.repo) || (remote ? parseGitRemote(remote) : null);
  if (!repo) return '';
  const paths = await pushedPaths(cwd);
  if (paths.length === 0) return '';
  const body = await getJson(checklistUrl(process.env.STABLESHIP_API_URL, repo, paths.slice(0, MAX_PATHS)), token, 2500);
  const text = body ? checklistText(body, paths.length) : '';
  if (!text) return '';
  // Asked once per commit: the next push of this commit goes through. Keep the last 20.
  const kept = Object.entries(asked).sort((a, b) => Number(b[1]) - Number(a[1])).slice(0, 19);
  writeState(sessionId, { ...readState(sessionId), prechecked: Object.fromEntries([...kept, [head, Date.now()]]) });
  return declineOnce(text);
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
