#!/usr/bin/env node
/**
 * Stableship PostToolUse hook for run_check, verify_fix and rerun_gate: remember the run ids this session started, so
 * the inbox hook can report their verdicts without being asked. Never blocks, never exits non-zero.
 */
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseJson, readState, readStdin, writeState } from './lib.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Pure: the run id in an MCP tool result (JSON text in content[0].text, or an object). */
export function runIdFrom(toolResponse) {
  const candidates = [];
  if (toolResponse && typeof toolResponse === 'object') {
    candidates.push(toolResponse);
    const content = Array.isArray(toolResponse.content) ? toolResponse.content : [];
    for (const c of content) if (c && typeof c.text === 'string') { try { candidates.push(JSON.parse(c.text)); } catch { /* not json */ } }
  } else if (typeof toolResponse === 'string') {
    try { candidates.push(JSON.parse(toolResponse)); } catch { /* not json */ }
  }
  for (const c of candidates) {
    const id = c?.runId ?? c?.run_id ?? c?.run?.id;
    if (typeof id === 'string' && UUID.test(id)) return id.toLowerCase();
  }
  return null;
}

/** Pure: add a run to the state once. */
export function trackRun(state, runId, now) {
  const runs = Array.isArray(state.runs) ? state.runs : [];
  if (runs.some((r) => r && r.id === runId)) return state;
  return { ...state, runs: [...runs, { id: runId, startedAt: now, deliveredAt: null }].slice(-20) };
}

async function main() {
  const input = parseJson(await readStdin(1000));
  const runId = runIdFrom(input.tool_response);
  if (!runId) return;
  const sessionId = input.session_id ?? 'default';
  writeState(sessionId, trackRun(readState(sessionId), runId, Date.now()));
}

function isEntryPoint() {
  try { return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
}

if (isEntryPoint()) main().then(() => process.exit(0), () => process.exit(0));
