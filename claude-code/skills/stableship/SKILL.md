---
name: stableship
description: Keep an app inside its Stableship rules while changing it. Use before changing auth, sign-in, who can see or change data, row level security, Supabase tables or migrations, payments, or API routes; before pushing a risky change; when a Stableship finding blocks a release; and when fixing Stableship findings. Covers reading the rules for the file you are editing, proposing rule changes, running scoped checks, explaining why something blocks, and fixing findings in order.
when_to_use: The repo is connected to Stableship (the stableship MCP tools answer for it, or it has a .gate/rules.md). Triggers include "add a table", "change permissions", "add an admin page", "fix the Stableship findings", "why does this block", "is this safe to ship".
allowed-tools: mcp__plugin_stableship_stableship__list_projects mcp__plugin_stableship_stableship__get_rules mcp__plugin_stableship_stableship__get_context mcp__plugin_stableship_stableship__get_findings mcp__plugin_stableship_stableship__get_fix_brief mcp__plugin_stableship_stableship__get_run_status mcp__plugin_stableship_stableship__explain_finding mcp__plugin_stableship_stableship__get_scope_policy mcp__plugin_stableship_stableship__get_known_issues mcp__plugin_stableship_stableship__get_fix_plan mcp__plugin_stableship_stableship__run_check mcp__plugin_stableship_stableship__verify_fix mcp__plugin_stableship_stableship__rerun_gate mcp__plugin_stableship_stableship__propose_rule mcp__plugin_stableship_stableship__add_context_note mcp__plugin_stableship_stableship__whoami mcp__plugin_stableship_stableship__get_next_steps mcp__plugin_stableship_stableship__get_activity mcp__plugin_stableship_stableship__get_app_map mcp__plugin_stableship_stableship__get_approval mcp__plugin_stableship_stableship__request_fix mcp__plugin_stableship_stableship__request_fixes_pr mcp__plugin_stableship_stableship__resume_held_audit mcp__plugin_stableship_stableship__reanalyze mcp__plugin_stableship_stableship__set_role mcp__plugin_stableship_stableship__set_role_reach mcp__plugin_stableship_stableship__create_app mcp__plugin_stableship_stableship__link_repo
---

# Working inside Stableship's rules

Stableship tests this app before each release, signing in as each kind of user, and holds the
release when a rule breaks. The rules say who may see, create, change and delete what. The tools
below come from the `stableship` MCP server (in Claude Code: `mcp__plugin_stableship_stableship__<tool>`).
Pass `repo` as `owner/name` from `git remote get-url origin` when a tool asks for the project.

Not set up yet (the tools are missing or say the token is missing or invalid)? Run
`npx --yes @stableship/cli@latest init`: it signs the person in from a link they approve, adds Stableship
to Claude Code, and says what the repository still needs, one step at a time. Setup, rules and these
tools are free; testing the app needs a plan.

## Before you change auth, data access, money or migrations

1. Call `get_rules` with `path` set to the file you are about to edit: it returns only the rules
   and flows that concern that file, and the areas it touches (empty means ordinary UI code).
   `get_context` adds the kinds of user, the founder's product notes and what the test copy
   could not test. Without the tools, read `.gate/rules.md` and `.gate/context.md`. The plugin's
   hook also shows these rules before an edit to such a file; they are facts, not permission.
2. Make the change keep every rule. If a rule says only the owner can open an invoice, the query,
   the API route and the row level security policy must all enforce that.

## Supabase

- Every new table gets `alter table … enable row level security` and policies that match the
  rules for that data, in the same migration. No table ships with RLS off or with a policy of
  `using (true)` unless a rule says anyone may see it.
- Never use the service-role key in client code (anything bundled for the browser, including
  `NEXT_PUBLIC_*` and `VITE_*` variables). It bypasses every policy. Server-only code may use it.
- Check ownership in policies with `auth.uid()`, not with values the client sends.
- Change the database through migrations, not the Supabase dashboard. If `get_context` lists
  differences under `testCopy.liveMatch` (changes that exist only in the live database), capture
  them first with `supabase db pull`, so your migrations describe what is really live before you
  change those tables or policies.

## When access needs to change

Never change who can access what on your own, and never loosen a policy or check to make
something work. Call `propose_rule` with `resource`, `action`, `allowed` (role keys from
`get_context`, or `owner`, `signed_in`, `public`) and a `reason` the founder will read. A rule
that only adds a check may apply at once; anything that lets more people in waits for the founder.
Until it is accepted, keep the current rules in code and tell the user it is waiting.

## Product facts

When you learn something lasting that future sessions need ("invoices belong to the company, not
the user who made them"), save it with `add_context_note`: one fact, plain words, no secrets or
personal data.

## Before pushing a risky change

Risky means auth, data access, payments, migrations or anything a rule mentions. Commit and push
(after the user agrees), then call `run_check` with the pushed commit and branch. Leave `scope`
out (auto) unless you know better: `security` after access, auth or payment changes, `qa` after
flow or route changes, `full` for both. The project's path rules set a minimum for some changes;
asking for less runs at the minimum and the result's `message` says so. Narrow with `flow`,
`role` or `endpoint` when you changed only that; a narrow check still counts as one check.
`get_scope_policy` with the changed paths tells you beforehand what would run. Poll
`get_run_status` every 20-30 seconds until `done`. Report the verdict. `block` means the release
would be held: fix it before moving on. Runs that end `failed_infra`, `timed_out` or `cancelled`
are Stableship's own problem and never block; `rerun_gate` repeats one.

## When something blocks and the user asks why

Call `explain_finding` with the finding id (or with the run id for the whole verdict). It gives
the confidence in words, whether it blocks and the exact policy reason, the rule broken, the
repro, the verifier's notes, evidence links, how often it was seen and whether a person accepted
it as a known issue. Report that plainly. Never argue a verdict away in code: the founder can
accept a risk or mark a false positive in Stableship; `get_known_issues` lists those decisions.

## Fixing findings

1. Call `get_fix_plan` and work through it in order. If it is not available, call `get_findings`
   with `blocking_only=true`, then `get_fix_brief` for each finding. Skip findings listed by
   `get_known_issues` as accepted unless the user asks.
2. For each one: make the smallest change that meets every acceptance criterion in its brief, push
   it, call `verify_fix`, and poll `get_run_status` until done before starting the next.
3. Never weaken, skip or delete tests, RLS policies, auth checks or validation to make a finding
   go away. Never read or print `.env` files or secrets.

## Running Stableship for the user

The user can run Stableship entirely from here; the app is optional. At the start of a session,
`whoami` says which projects this token sees and whether it has the manage scope.

1. **What now?** After an audit, `get_next_steps` gives how it went, what was covered, and what to
   fix first, grouped by cause. Tell the user in two or three sentences, then offer to start on
   the first group. `get_app_map` shows the pages each kind of user reached and how each went.
2. **Fix** as in "Fixing findings" above. `request_fix` asks Stableship's own fix agent instead,
   and `request_fixes_pr` opens a pull request with the whole plan.
3. **Held audit:** when the copy could not be built, fix the build, push, then `resume_held_audit`.
4. **Rules and kinds of user:** `set_role` adds or changes one; `set_role_reach` says whether it
   reaches every customer's records or only linked ones; `reanalyze` reads the app again.
5. **An app in several repositories** (a web app, an API, a worker, an MCP server): `create_app`
   with every repository, the one holding the app's pages first, or `link_repo` to add one to an
   existing app. Stableship decides from the code which ones belong; `get_app_map` shows each
   repository's verdict and every service it found, with how its last start went. `set_service`
   corrects a service (kind, start command, port) and always asks the user first; prefer
   declaring services in `.gate/build.yaml` when the repository is the user's to change. A
   repository Stableship cannot see needs the Stableship GitHub App given access to it on GitHub:
   tell the user, never work around it.
6. **Decisions that lower protection** ask the user every time, never you alone: marking a finding
   a false positive or an accepted risk (triage_finding), approving a fix (decide_fix), shipping
   anyway, accepting a change to who may see what (decide_rule_suggestion), loosening a policy
   (set_policy), more autonomy (set_autonomy), removing a kind of user (remove_role), leaving a
   service out of testing (set_service) and sharing a report (share_report). Explain what it does
   and why before calling one. When the answer is `pending_approval`, a person decides in
   Stableship: tell the user, and check `get_approval` later. Never retry to get around a refusal.
7. `get_activity` says what changed recently and who did it.
