# Stableship plugin for Claude Code

Stableship is a QA and security gate for AI-built apps. This plugin brings it into Claude Code:

- **MCP server.** Connects Claude to the Stableship MCP server (`https://api.stableship.ai/mcp`)
  with your API token. Tools: `list_projects`, `get_findings`, `get_fix_brief`, `explain_finding`,
  `run_check`, `run_audit`, `rerun_gate`, `get_run_status`, `verify_fix`, `get_rules`,
  `get_scope_policy`, `get_known_issues`, `get_fix_plan`, `get_report`, `get_context`,
  `propose_rule`, `add_context_note`, `get_setup`, `get_launch_report`.
- **`stableship` skill** (`skills/stableship/SKILL.md`). Claude loads it on its own before it
  changes auth, data access, payments or migrations: read the rules, give every new Supabase table
  row level security, never put the service-role key in client code, propose rule changes instead
  of making them, run a check before pushing risky changes, and fix findings in order. You can
  also run it as `/stableship:stableship`.
- **`/stableship:gate` command.** `status`, `check`, `fix`, `why`, `skip` and `test` (see below).
- **Hooks.** At session start Claude hears about open blocking findings and the rules. Before it
  edits a file that concerns sign-in, data access, payments or the database, it gets the rules
  for that file. Verdicts of checks it started, and new blocking findings from any push, land in
  the session as they arrive. See "Hooks" below.

For agents other than Claude Code, `AGENTS-snippet.md` is the same workflow as plain project
instructions for `AGENTS.md` or a rules file. The `get_setup` tool returns a shorter block for
`CLAUDE.md` that points every session at the skill, the rules and the fix plan.

Only **reproduced** findings block a release. **Suspected** findings are shown but never block.
If Stableship itself fails (`failed_infra`, `timed_out`, `cancelled`), the release is not blocked.

## Sign in

The plugin's MCP server signs in with OAuth: no token to copy.

1. After installing, start a session and run `/mcp`, pick `plugin:stableship:stableship` and choose
   **Authenticate**. Your browser opens app.stableship.ai: sign in (or sign up), pick the workspace and
   approve. Disconnect it any time in Stableship under **Settings → Connected apps**.
2. The hooks (rules before edits, run tracking) use a token: `STABLESHIP_TOKEN` if you export one, otherwise
   the one `npx @stableship/cli login` saved. `/stableship:gate setup` does that sign-in for you.

Optional: `STABLESHIP_API_URL` points the MCP server and the hook at another API (default
`https://api.stableship.ai`), e.g. a staging server.

## Install

**From the marketplace.** In a Claude Code session:

```sh
/plugin marketplace add stableship-ai/claude-plugins
/plugin install stableship@stableship
```

From a terminal, the same steps are `claude plugin marketplace add stableship-ai/claude-plugins`
and `claude plugin install stableship@stableship`. Updates arrive when the plugin's version
changes; `/plugin marketplace update stableship` fetches them.

**From a local copy.** In a clone of this repository, the repository root is the marketplace
(`.claude-plugin/marketplace.json`) and the plugin is `claude-code/`:

```sh
claude plugin marketplace add ./          # run from the clone's root
claude plugin install stableship@stableship
claude --plugin-dir ./claude-code         # or: for one session, without installing
```

**Check it loaded:** run `/mcp` in a session and look for the `stableship` server (its tools are
named `mcp__plugin_stableship_stableship__<tool>`). `claude plugin validate ./claude-code` checks
the manifest.

## Commands

Plugin commands are namespaced by the plugin name, so `/gate` is invoked as `/stableship:gate`.

| Command | What it does | Token scope |
| --- | --- | --- |
| `/stableship:gate status` | Latest release verdict and blocking findings for this repo's project. | `read` |
| `/stableship:gate check [quick\|security\|qa\|full] [--as <role>] [--flow <key>] [--endpoint <path>]` | Starts a check on your current branch (or HEAD, if it is pushed), waits for the verdict and lists blocking findings. Without a scope the change decides; asking for less than the project's minimum runs at the minimum. The options narrow the check. | `run` |
| `/stableship:gate fix [findingId]` | For each blocking finding (or just the one named): reads the fix brief, fixes the code to meet its acceptance criteria, asks before committing and pushing, then calls `verify_fix` and reports Fixed / Still blocking. | `run` |
| `/stableship:gate why <findingId\|runId>` | Why it blocks: confidence, the policy reason, the rule, repro, the verifier's notes, how often it was seen, evidence links. | `read` |
| `/stableship:gate skip "<reason>"` | Records that the pushed commit needs no check. A change to sign-in, data or money gets its minimum check anyway. | `run` |
| `/stableship:gate test <feature>` | Writes tests in your repository's own framework from the rules and the findings fixed so far, and runs them. | `read` |

Stableship checks the code on GitHub, not your local files. `check` tells you when you have
unpushed work, and `fix` must push the fix before it can verify it. It asks first.

`fix` never weakens tests, RLS policies or auth checks to make a finding go away, and never reads
`.env` files. Those rules are in the command's instructions. Add the deny rule below so the
`.env` rule is also enforced by Claude Code itself.

## Hooks

Every hook needs Node 22+ on your `PATH`, has no dependencies, never blocks a tool call and exits
0. No token, no GitHub remote, offline, a slow API or any error all mean no output. Each keeps a
small state file per session under `$XDG_STATE_HOME/stableship/sessions/` (or
`~/.local/state/stableship/sessions/`), readable only by you; it holds the repository, the run
ids this session started and what was already said, never the token.

| Hook | Script | What it does |
| --- | --- | --- |
| `SessionStart` (startup, resume, clear, compact) | `session-start.mjs` | Lists open blocking findings for the repo and says how many rules it has (2.5 second timeout). Starts the session's state file. |
| `PreToolUse` on `Edit`, `Write`, `MultiEdit`, `NotebookEdit` | `prevention.mjs` | When the file looks like sign-in, sessions, Supabase, migrations, SQL, policies, payments, webhooks, API routes or schemas, asks `GET /api/v1/rules?repo=&path=` (2 second timeout) and adds those rules to Claude's context. Ordinary UI files never reach the network. The same area is shown once per 10 minutes. |
| `PostToolUse` on `run_check`, `verify_fix`, `rerun_gate` | `track-run.mjs` | Remembers the run id. |
| `PostToolUse` on `Edit`, `Write`, `MultiEdit`, `Bash` | `inbox.mjs` | At most every 45 seconds: reports runs this session started once they finish, and blocking findings recorded for the repo since the session began (a push check, a click in the app). |
| `Stop` | `inbox.mjs --final` | The same, at once. If something new blocks, Claude is asked once to carry on and deal with it (`stop_hook_active` keeps it from looping). Stableship's own failures are reported as "not blocking". |

To see a hook's output, run it yourself from your app's repository, e.g.
`echo '{"cwd":"'"$PWD"'"}' | node <path to the plugin>/scripts/session-start.mjs`. Run
`claude --debug` to see hook logs.

## Keep Claude out of `.env` files

A plugin can't ship permission rules: a plugin's `settings.json` only applies the `agent` and
`subagentStatusLine` keys. Add this to your project's `.claude/settings.json` (or
`~/.claude/settings.json` for every project):

```json
{
  "permissions": {
    "deny": [
      "Read(.env)",
      "Read(.env.*)",
      "Edit(.env)",
      "Edit(.env.*)"
    ]
  }
}
```

A bare file name matches at any depth under the project, so `Read(.env)` also covers
`apps/web/.env`. These rules apply to Claude's file tools. They do not stop a shell command such as
`cat .env`, so keep Bash prompts on, or also deny those commands, e.g. `"Bash(cat .env*)"`.

## Troubleshooting

- **`/stableship:gate` is missing.** Run `/plugin` and check that `stableship` is installed and
  enabled. Run `/reload-plugins` after editing plugin files.
- **Tools fail with 401 / unauthorized.** Run `/mcp`, pick the Stableship server and choose
  **Authenticate** (or **Re-authenticate** if it was disconnected in Settings → Connected apps).
- **"lacks the run scope" (403).** Create a token with `run` for `check` and `fix`.
- **"Not connected" for your repo.** The repo's GitHub `origin` must match a repo connected to a
  Stableship project. Check with `git remote get-url origin` and `/stableship:gate status`.
- **No session note.** That is expected when nothing blocks. See "Hooks" for how to run a hook
  by hand.
- **Check says your changes aren't included.** Push the branch, then run `/stableship:gate check`
  again.

## License

MIT. See `LICENSE`.
