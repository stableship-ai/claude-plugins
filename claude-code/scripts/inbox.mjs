#!/usr/bin/env node
/**
 * Stableship inbox hook ("Send to my agent"): findings and verdicts land in the session without being asked. Runs on
 * PostToolUse (Edit, Write, Bash; at most one poll every 45 seconds) and on Stop (`--final`). It looks at runs this
 * session started (track-run.mjs) and at blocking findings recorded for the repository since the session began (a push
 * check, a web click). PostToolUse adds context; Stop with undelivered blocking results asks Claude to carry on once
 * (`decision: block` with the reason), guarded by stop_hook_active so it never loops. Infrastructure failures read as
 * "not blocking". Never exits non-zero.
 */
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { additionalContext, apiBase, clean, getJson, gitRemote, mayPoll, parseGitRemote, parseJson, readState, readStdin, writeState } from './lib.mjs';

const INFRA = new Set(['failed_infra', 'timed_out', 'cancelled']);
const VERDICT_WORDS = { pass: 'passed', warn: 'passed with warnings', block: 'is BLOCKED', skipped: 'was skipped (nothing risky changed)', fail_open: 'was released on a timeout', ship_anyway: 'was shipped anyway' };

export function runUrl(apiUrl, runId) { return `${apiBase(apiUrl)}/api/v1/runs/${encodeURIComponent(runId)}`; }
export function findingsUrl(apiUrl, repo, since) {
  return `${apiBase(apiUrl)}/api/v1/findings?repo=${encodeURIComponent(repo)}&blocking=true&status=open${since ? `&since=${encodeURIComponent(since)}` : ''}`;
}

/** Pure: one paragraph about a finished run, or '' while it is still going. */
export function runLine(body) {
  const run = body?.run;
  if (!run || !run.done) return '';
  if (INFRA.has(run.status)) return `Stableship run ${run.id} could not finish (${String(run.status).replace('_', ' ')}). Not blocking: Stableship never blocks a release on its own failure. ${run.url ?? ''}`.trim();
  const findings = Array.isArray(body.findings) ? body.findings : [];
  const blocking = findings.filter((f) => f && f.blocks);
  const head = `Stableship run ${run.id} ${VERDICT_WORDS[run.verdict] ?? run.verdict} (${run.scope} check${run.branch ? ` of ${run.branch}` : ''}).`;
  const lines = [head];
  for (const f of blocking.slice(0, 6)) lines.push(`- [${clean(f.severity, 10)}] ${clean(f.title, 160)}${f.where ? ` (${clean(f.where, 100)})` : ''}. Finding id: ${f.id}`);
  if (blocking.length > 6) lines.push(`- …and ${blocking.length - 6} more.`);
  if (blocking.length) lines.push('Use /stableship:gate fix to fix and verify them, or get_fix_brief for one.');
  if (run.url) lines.push(run.url);
  return lines.join('\n');
}

/** Pure: new blocking findings (not delivered before), as a paragraph, or ''. */
export function findingsLine(repo, body, delivered) {
  const findings = (Array.isArray(body?.findings) ? body.findings : []).filter((f) => f && f.blocks && !delivered.has(f.id));
  if (!findings.length) return '';
  const lines = [`Stableship: ${findings.length} new reproduced finding${findings.length === 1 ? '' : 's'} block${findings.length === 1 ? 's' : ''} releases of ${repo}:`];
  for (const f of findings.slice(0, 6)) lines.push(`- [${clean(f.severity, 10)}] ${clean(f.title, 160)}${f.where ? ` (${clean(f.where, 100)})` : ''}. Finding id: ${f.id}`);
  if (findings.length > 6) lines.push(`- …and ${findings.length - 6} more.`);
  lines.push('Use /stableship:gate fix to fix and verify them.');
  return lines.join('\n');
}

/** Pure: does a delivered batch contain something that blocks (worth a Stop prompt)? */
export function blocksAnything(runBodies, findingBodies) {
  return runBodies.some((b) => b?.run?.done && b.run.verdict === 'block') || findingBodies.some((b) => (b?.findings ?? []).some((f) => f && f.blocks));
}

async function main(final) {
  const token = process.env.STABLESHIP_TOKEN?.trim();
  if (!token) return '';
  const input = parseJson(await readStdin(1000));
  if (final && input.stop_hook_active) return '';
  const sessionId = input.session_id ?? 'default';
  const state = readState(sessionId);
  const now = Date.now();
  if (!final && !mayPoll(state, now)) return '';
  const remote = state.repo ? null : await gitRemote(input.cwd ?? process.cwd());
  const repo = (typeof state.repo === 'string' ? state.repo : null) ?? (remote ? parseGitRemote(remote) : null);
  if (!repo) return '';
  const apiUrl = process.env.STABLESHIP_API_URL;
  const pending = (Array.isArray(state.runs) ? state.runs : []).filter((r) => r && r.id && !r.deliveredAt);
  const delivered = new Set(Array.isArray(state.deliveredFindingIds) ? state.deliveredFindingIds : []);
  const since = typeof state.startedAt === 'string' ? state.startedAt : new Date(now - 6 * 3600_000).toISOString();
  const [runBodies, findingsBody] = await Promise.all([
    Promise.all(pending.slice(0, 5).map((r) => getJson(runUrl(apiUrl, r.id), token))),
    getJson(findingsUrl(apiUrl, repo, since), token),
  ]);
  const parts = [];
  const finishedIds = new Set();
  runBodies.forEach((b, i) => { const line = runLine(b); if (line) { parts.push(line); finishedIds.add(pending[i].id); } });
  const fl = findingsLine(repo, findingsBody, delivered);
  if (fl) parts.push(fl);
  // Remember what was delivered so nothing is said twice.
  const next = { ...state, repo, lastPollAt: now, startedAt: since,
    runs: (Array.isArray(state.runs) ? state.runs : []).map((r) => (r && finishedIds.has(r.id) ? { ...r, deliveredAt: now } : r)),
    deliveredFindingIds: [...delivered, ...((findingsBody?.findings ?? []).filter((f) => f && f.blocks).map((f) => f.id))].slice(-200) };
  writeState(sessionId, next);
  if (!parts.length) return '';
  const text = parts.join('\n\n');
  if (final && blocksAnything(runBodies, fl ? [findingsBody] : [])) return JSON.stringify({ decision: 'block', reason: `${text}\n\nThese block the release. Fix them now, or tell the user what blocks and why you are stopping.` });
  return additionalContext(final ? 'Stop' : 'PostToolUse', text);
}

function isEntryPoint() {
  try { return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
}

if (isEntryPoint()) {
  main(process.argv.includes('--final')).then(
    (text) => (text ? process.stdout.write(`${text}\n`, () => process.exit(0)) : process.exit(0)),
    () => process.exit(0),
  );
}
