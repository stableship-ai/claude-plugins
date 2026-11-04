# Stableship instructions for coding agents

Copy the section below into `AGENTS.md` (Codex and other agents that read it), your Cursor or
Windsurf rules file, or any agent's project instructions. It is the same workflow as the Claude
Code plugin's `stableship` skill, for agents that connect to the Stableship MCP server
(`https://api.stableship.ai/mcp`) without the plugin. Stableship's `get_repo_files` returns a
shorter section with the project's own rules, ready for `AGENTS.md`, `.cursor/rules/stableship.mdc`,
`GEMINI.md`, `.github/copilot-instructions.md` and `.windsurf/rules/stableship.md`.

---

## Stableship

Stableship tests this app before each release, signing in as each kind of user, and holds the
release when a rule breaks. The rules say who may see, create, change and delete what. Its tools
come from the `stableship` MCP server. Pass `repo` as `owner/name` from `git remote get-url origin`.

**Before changing auth, data access, payments or migrations**, call `get_rules` (or `get_context`,
which adds the kinds of user, the founder's product notes and what the test copy could not test).
Without the tools, read `.gate/rules.md` and `.gate/context.md`. Keep every rule in the query, the
API route and the row level security policy.

**Supabase.** Every new table gets row level security enabled and policies that match the rules,
in the same migration. Never use the service-role key in client code (anything bundled for the
browser, including `NEXT_PUBLIC_*` and `VITE_*` variables). Check ownership with `auth.uid()`.

**Changing access.** Never change who can see or do what beyond the rules: ask the person first and say why.
Never loosen a policy or check to make something work. Call `propose_rule` with `resource`, `action`, `allowed` (role keys
from `get_context`, or `owner`, `signed_in`, `public`) and a `reason`. Until the founder accepts
it, keep the current rules in code.

**Product facts.** Save lasting facts future sessions need with `add_context_note`: one fact,
plain words, no secrets or personal data.

**Pushing a risky change.** Push it after the user agrees. Don't call `run_check` to re-test a push or confirm a fix: pushes are checked on their own.
Call `run_check` with the pushed commit and branch only for a check the push does not give you:
a wider `scope`, or one narrowed with `flow`, `role` or `endpoint`; the project's path rules set
a minimum you cannot go below. Wait with `get_run_status` and `wait_seconds`, not a fixed polling timer.
`block` means the release would be held; `explain_finding` says why. Runs that end
`failed_infra`, `timed_out` or `cancelled` never block; `rerun_gate` repeats one.

**Before editing a file** that concerns sign-in, data access, payments or the database, call
`get_rules` with `path` set to that file for just the rules that apply to it.

**Fixing findings.** Work through `get_fix_plan` in order (or `get_findings` with
`blocking_only=true`, then `get_fix_brief` per finding). Skip anything `get_known_issues` lists as an accepted
risk unless the user asks. Find each cause, group the tasks one fix closes, and fix one cause at a
time with the smallest change that meets every acceptance criterion. Stableship tests the code on GitHub, so push before you verify.
Verify once per push, with every finding id it closes: `verify_fix` with `finding_ids`, or `stableship verify <id> <id>…`.
Wait for the result before the next cause. Never
weaken tests, RLS policies, auth checks or validation to make a finding go away, and never read
`.env` files.
