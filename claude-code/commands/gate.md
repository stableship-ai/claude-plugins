---
description: Stableship release gate. status shows verdicts; check [quick|security|qa|full] [--as role] [--flow key] [--endpoint path] runs a check; fix fixes and verifies blocking findings; why explains a finding or a run; skip "reason" records that nothing needs checking; test <feature> writes tests from the rules and fixed findings.
argument-hint: status | check [scope] [--as <role>] [--flow <key>] [--endpoint <path>] | fix [findingId] | why <findingId|runId> | skip "<reason>" | test <feature>
allowed-tools: mcp__plugin_stableship_stableship__list_projects, mcp__plugin_stableship_stableship__get_findings, mcp__plugin_stableship_stableship__get_fix_brief, mcp__plugin_stableship_stableship__get_run_status, mcp__plugin_stableship_stableship__get_rules, mcp__plugin_stableship_stableship__get_context, mcp__plugin_stableship_stableship__run_check, mcp__plugin_stableship_stableship__verify_fix, mcp__plugin_stableship_stableship__get_fix_plan, mcp__plugin_stableship_stableship__get_report, mcp__plugin_stableship_stableship__explain_finding, mcp__plugin_stableship_stableship__get_scope_policy, mcp__plugin_stableship_stableship__get_known_issues, mcp__plugin_stableship_stableship__rerun_gate, mcp__plugin_stableship_stableship__propose_rule, mcp__plugin_stableship_stableship__add_context_note, mcp__plugin_stableship_stableship__get_setup, mcp__plugin_stableship_stableship__run_audit, mcp__plugin_stableship_stableship__get_launch_report, Bash(git remote get-url origin), Bash(git rev-parse HEAD), Bash(git rev-parse --abbrev-ref HEAD), Bash(git status --porcelain=v2 --branch), Bash(git log -1 --format=%H), Bash(git diff --name-only *), Bash(sleep *)
---

You are running the Stableship release gate for the repository in the current directory.
The user typed: `/stableship:gate $ARGUMENTS`

Stableship is a QA and security gate. A check produces a release with a verdict
(`pass`, `warn`, `block`, `skipped`, `fail_open`, `ship_anyway`) and findings. Each finding is
**Reproduced** (`confidence` is `reproduced`: Stableship replayed it twice), **Confirmed**
(`confirmed`: a fact the tools saw, such as a vulnerable dependency or a missing header) or
**Suspected** (not proven; never blocks). `blocks: true` is the only thing that holds a release.
If a run ends as `failed_infra`, `timed_out` or `cancelled`, Stableship itself had a problem: say
so plainly and say the release is **not** blocked, because Stableship never blocks on its own
failures. `cancelled` usually means a newer check of the same branch superseded it.

Checks have **scopes**: `quick` (build, review, saved flows replayed), `security` (access rules,
API as each kind of user, security probes), `qa` (every critical flow as each kind of user) and
`full` (both). `auto` lets the change decide. The project's path rules set a **minimum** for some
changes (migrations, billing, auth); asking for less runs at the minimum and the result says so.
A check can be **narrowed** to one flow, one kind of user or one endpoint; it still counts as one
check.

The Stableship tools come from this plugin's `stableship` MCP server: `list_projects`,
`get_findings`, `get_fix_brief`, `run_check`, `get_run_status`, `verify_fix`, `rerun_gate`,
`explain_finding` (why a finding blocks, or why a run came out as it did), `get_rules` (pass
`path` for the rules that concern one file), `get_scope_policy`, `get_known_issues`,
`get_fix_plan` (every open finding as ordered tasks), `get_report` (an audit in plain English),
`get_context`, `propose_rule`, `add_context_note`, `get_setup`, `run_audit` and
`get_launch_report`. Before a fix that touches access, data, payments or migrations, read
`get_rules`; if the fix needs a rule to change, call `propose_rule` instead of changing access on
your own.
If a tool call fails with an authentication error, tell the user to set `STABLESHIP_TOKEN`
(create a token in Stableship under Settings → API tokens) and restart Claude Code. If it fails
because the token lacks the `run` scope, say that `check`, `fix`, `skip` and `test` need a token
with `run`.

## Find this repo's project (every subcommand)

1. Run `git remote get-url origin` and read `owner/name` from it (GitHub https or ssh URL).
2. Call `list_projects` and pick the project whose `repos[].fullName` matches, ignoring case.
3. If none matches, say this repo is not connected to Stableship, list the projects you can see,
   and stop. If there is no git remote and exactly one project, use that project.

## Pick the subcommand

Read the first word of the arguments above.

- `status`, or no arguments: do **status**.
- `check`: do **check**. The rest of the arguments may hold a scope word (`quick`, `security`,
  `qa`, `full`, `auto`) and the options `--as <role>`, `--flow <key>`, `--endpoint <path>`.
- `fix`: do **fix**. A second argument, if any, is a finding id to fix.
- `why`: do **why**. The second argument is a finding id or a run id.
- `skip`: do **skip**. The rest of the arguments is the reason (quotes optional).
- `test`: do **test**. The rest of the arguments names a feature, a flow or a file.
- Anything else: show the six subcommands with one line each and stop.

### status

Report for this repo's project, briefly:
- The latest release: verdict in plain words, scope, commit (first 7 characters) and branch, when
  it finished, and its `url`.
- Open and blocking finding counts. If anything blocks, call `get_findings` with
  `blocking_only: true` and list each one: severity, title, `where`, and its id.
- If nothing blocks, say the release is clear to ship.

### check

1. Run `git rev-parse --abbrev-ref HEAD`, `git rev-parse HEAD` and
   `git status --porcelain=v2 --branch`.
2. Stableship checks what is on GitHub, not local files. If the branch has an upstream and is
   not ahead of it (`# branch.ab +0 ...`), pass both `branch` and `commit_sha` = HEAD. Otherwise
   pass `branch` only, and tell the user that unpushed commits and uncommitted changes are not
   part of this check. Do not commit or push to make a check possible unless the user asks.
3. Call `run_check` with the project id, the ref, `scope` (the scope word, or omit it for auto),
   and `role` (from `--as`; a role key from `get_rules`, or `signed_out`), `flow` (from
   `--flow`; a flow key or title from `get_rules`) and `endpoint` (from `--endpoint`) when
   given. If `run_check` answers 400 with "no flow" or "no role", call `get_rules`, show the
   user the keys it lists and stop.
4. Read the result. Tell the user what runs from `message`. If `lowered` is set, say the scope
   they asked for was below the project's minimum for this change and the check runs at
   `scope` instead. If `degraded` is `no_checks_left`, say the check replays saved flows only
   because the month's model-backed checks are used. If `status` is `skipped`, say nothing
   needed checking and stop.
5. Call `get_run_status` with the returned run id. While `done` is false, run `sleep 15` and
   call it again. Stop after about 15 minutes and give the user the run `url` to follow.
6. Report the verdict in plain words, then each blocking finding (severity, title, `where`, id),
   then non-blocking findings as a one-line count. End with the run `url`. If something blocks,
   say that `/stableship:gate fix` can fix it and `/stableship:gate why <id>` explains it. If the
   run ended in `failed_infra` or `timed_out`, offer `rerun_gate`.

### fix

1. Call `get_findings` for the project with `blocking_only: true`. If the user named a finding id,
   work only on that one (it may be non-blocking; that is fine if they asked for it). If nothing
   blocks and no id was named, say there is nothing to fix and stop. If the user asked to fix
   everything (or the repo has `STABLESHIP_FIXES.md`), call `get_fix_plan` instead and work
   through its tasks in order, blocking ones first. Call `get_known_issues` once: a finding a
   person accepted as a known issue needs no fix unless the user asks; say so and skip it.
2. For each finding, one at a time:
   1. Call `get_fix_brief`. Read `plainEnglish`, `ruleBroken`, `whereToLook`, `repro` and
      `acceptanceCriteria`. If the brief is unclear about why it blocks, call `explain_finding`.
   2. Find the cause in the code, starting from `whereToLook`. Make the smallest change that
      meets every acceptance criterion. Add or update a test that would have caught it when the
      project has tests.
   3. Tell the user what you changed and why, in two or three sentences.
3. `verify_fix` re-checks code on GitHub, so the fix must be committed and pushed first. Ask the
   user before committing or pushing unless they already told you to. Commit on the current
   branch with a clear message; never force-push and never push straight to the default branch
   without the user's say-so.
4. Once pushed, call `verify_fix` with the finding id and the pushed commit sha, then poll
   `get_run_status` as in **check** until `done`.
5. Report per finding: **Fixed** (it no longer reproduces), **Still blocking** (it still
   reproduces; explain what the run found and try again only if you have a new idea), or
   **Not verified** (Stableship had an infrastructure problem; not blocking; offer `rerun_gate`).

Hard rules for fix, with no exceptions:
- Never weaken, skip, delete or loosen tests, assertions, RLS policies, auth checks, input
  validation, CSP, rate limits or rules to make a finding go away. Fix the real cause.
- Never read, print or edit `.env`, `.env.*` or other secret files, and never put secrets in code,
  commits or messages. If a fix needs a new secret, tell the user which variable to set.
- Never disable Stableship, its checks or its GitHub integration.
- If the brief asks for something you can't do safely, stop and explain instead of guessing.

### why

1. If the argument is a finding id (it appears in `get_findings`, or `explain_finding` with
   `finding_id` answers), call `explain_finding` with `finding_id`. Otherwise call it with
   `run_id`.
2. For a finding, tell the user in plain words: what it is, whether it is reproduced, confirmed
   or suspected (`confidence`), whether it blocks and the exact reason (`why`), the rule it
   breaks (`rule.sentence`), how to reproduce it (`repro`), what proves it (`verification`,
   `evidence` links), how often it was seen (`sightings`), and whether a person already accepted
   it (`knownIssue`). End with `url`.
3. For a run, tell them: the scope it ran at and whether it was raised from what they asked
   (`lowered`), what was narrowed (`target`), the verdict and `why`, each blocker with its own
   reason, and what was not covered (`coverage.incomplete`, `coverage.notCovered`).
4. Never argue a verdict away. If the user disagrees with a finding, say that the founder can
   accept it as a known issue or mark it a false positive in Stableship, and that nothing here
   changes the verdict.

### skip

Skip records that nothing in the pushed commit needs checking (docs, comments, copy). It is not
a way around a block.

1. Take the reason from the arguments. If it is empty, ask for one sentence and stop.
2. Find the ref as in **check** (pushed HEAD, else the branch).
3. Call `run_check` with `scope: "skip"` and the `reason`.
4. If the result's `status` is `skipped`, say the commit is recorded as checked and skipped, with
   the run `url`. If instead `lowered` is set, the change touches sign-in, data or money and
   Stableship runs the minimum check anyway: say so, say which scope runs and why
   (`message`), then poll as in **check** and report.

### test

Write tests for one feature from the rules Stableship enforces and the findings it has found,
in the repository's own test framework. Nothing here runs on Stableship; it is work in this
repository.

1. Resolve the feature. Call `get_rules` with `path` set to the feature's main file (if the user
   named a file) or without `path`, and pick the rules and flows whose words match the feature
   (a table name, a flow title, a route). Call `get_context` for the role keys. If nothing
   matches, list the rules and flows and ask which to test.
2. Collect what has gone wrong before: `get_findings` with `status: "fixed"` and `status: "open"`
   for the project; keep the findings whose `where` or title concerns this feature. For each,
   `get_fix_brief` gives `repro` and `acceptanceCriteria`: each fixed finding becomes a
   regression test, each open one a failing test the user can keep red until it is fixed (tell
   them which). `get_known_issues` says which ones a person accepted; mark those tests as
   skipped with the reason, never delete them.
3. Look at how this repository tests: the test runner, where tests live, how it signs in as a
   user and how it reaches the database or the API in tests. Match it exactly; do not add a
   framework.
4. Write the tests. For each rule: one test per allowed audience that the action works, and one
   test per other audience (including signed out) that it is refused with "not found" or
   "forbidden", on the API route and on the database policy where the project tests policies.
   For each flow: the happy path as the roles it lists. For each finding: its repro, asserting
   the acceptance criteria.
5. Run the new tests with the repository's test command. Fix tests that fail for reasons in the
   tests, not in the app. A test that fails because the app really breaks a rule is a finding:
   leave it red, say so, and point at `/stableship:gate check security` to have Stableship
   reproduce it.
6. Show the user the files you added, offer to commit (never push without being asked), and say
   that a `quick` check runs the repository's test suite on each push once that is enabled for
   the project.
