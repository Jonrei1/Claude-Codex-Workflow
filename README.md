# Claude + Codex workflow

A Claude Code plugin and standalone installer that gives Claude and Codex a shared way to plan, implement, verify and document work in a Git project. One setup command installs missing tools, including **Playwright MCP and Chromium**, and adds project instructions and execution helpers.

## What this setup is for

The purpose is to make an AI coding task concrete and reviewable: agree on what should change, divide it into phases with executable checks, implement each phase, and compare the result against the approved plan. Shared files carry the requirements between Claude and Codex, so you can hand off a task with one pasted line instead of repeatedly explaining it.

Claude can implement a task directly, or act as planner while Codex implements. In the orchestrated workflow, separate headless Claude runs check each phase's code and alignment with the plan. This adds a second review pass and a record of findings. It also adds model usage and time; choose direct implementation when that overhead is unnecessary.

The workflow supports new or existing repositories and detects checks for several stacks. Browser tooling has its own platform requirements. You control the final changes: agents do not commit, stage, stash or push your work. You review and commit it yourself.

## How the tools help

| Tool | Role in this setup | Benefit |
|---|---|---|
| Claude Code | Interactive planner or implementer; headless checker, reviewer and summary writer | Turns a request into acceptance criteria and phases, then checks whether the implementation satisfies them. |
| Codex CLI | Implements approved phases, runs gates and fixes findings | Carries a task through every phase from one handoff; optional plan review checks assumptions before implementation. |
| Playwright MCP + Chromium | Browser tools available to both agents | Enables requested inspection of a running app: navigation, clicks, forms, browser errors, screenshots and different viewport sizes. |
| graphify | Shared codebase knowledge graph and search/read hooks | Helps find affected modules and dependents before editing, so plans include relevant files and checks. |
| Impeccable (optional) | Design skills and UI feedback hooks | Uses `PRODUCT.md` and `DESIGN.md` to guide UI work and flag design issues during implementation. |
| caveman | Optional terse replies | Reduces prose output; file reads, reasoning, tool results and reviews still consume usage. No fixed percentage saving is guaranteed. |
| Autopilot helper and verification hook | Local Node scripts under `.codex/` | Track snapshots, run gates, launch reviews, record verdicts and close tasks. The scripts coordinate agents; they are not another model. |

For example, for a checkout-page change, Claude can identify dependencies with graphify and, if you installed the optional Impeccable, specify the design with it. Codex implements the phases and uses Playwright to check requested interactions in the running app. Gates run executable assertions, and Claude reviews the diff against the plan.

## Install once, configure each project

### Prerequisites

- Node.js and npm, with `npx` available. The installer requires Node 18+, but **use a current supported Node LTS for browser tooling**; current Playwright Test documentation lists Node 22/24/26.
- Git and a repository for project setup. Scaffold a new app and run `git init` yourself before setup.
- Claude and Codex accounts or supported API authentication. Installing the CLIs does not sign you in or include model usage.
- `uv`, `pipx`, or Python if graphify needs installing. For a global (all users) graphify install, Python's `pip` and administrator/root rights.

Use a supported operating system for browser tooling. See the official [Playwright installation requirements](https://playwright.dev/docs/intro#system-requirements) for the current platform list.

### Through the Claude Code plugin

In Claude Code:

```text
/plugin marketplace add Jonrei1/Claude-Codex-Workflow
/plugin install claude-codex-workflow@claude-codex-workflow
```

Open the target project and run:

```text
/claude-codex-workflow:setup --yes
```

Before running the installer, Claude asks you two questions, because the installer itself cannot prompt from inside Claude:

| Question | Asked when | Your choices |
|---|---|---|
| Install **Impeccable** (design skills and UI hooks)? | Always, unless you passed `--impeccable` or `--skip-impeccable` | Yes adds `--impeccable`; no adds `--skip-impeccable`. Optional, mainly useful for UI work. |
| Install **graphify** for your user only, or globally? | Only when graphify isn't installed and you didn't pass `--graphify-scope` | **User** (recommended): into your home directory with `uv tool`, `pipx` or `pip --user`, no admin rights. **Global**: system-wide `pip`, shared by every user, usually needs admin/root rights. |

`--yes` approves missing global tool installations (Claude Code and Codex CLI through npm), the Chromium download and missing Playwright MCP registrations. It does not answer the two questions above. The terminal installer asks them itself, with Impeccable defaulting to no and graphify defaulting to user. With `--yes`, `--dry-run` or no terminal, it skips Impeccable and uses the user scope for graphify. A headless Claude command cannot prompt and reports incomplete steps for you to address.

### Without the plugin

From the target Git project root:

```sh
npx github:Jonrei1/Claude-Codex-Workflow --yes
```

To inspect intended changes without installing or writing anything:

```sh
npx github:Jonrei1/Claude-Codex-Workflow --dry-run
```

The machine tools are shared across projects. Run full setup once on each development machine, then run setup in every repository that should use the workflow. Once the tools and browser registrations are ready, use `--project-only` in additional projects to skip machine setup.

### What the installer does

| Step | Action | Location |
|---|---|---|
| Prerequisites | Checks Node and Git; reports missing prerequisites rather than installing them | Your machine |
| Agent CLIs | Installs missing `@anthropic-ai/claude-code` and `@openai/codex` through npm | Global npm packages |
| Playwright | Installs missing `@playwright/mcp`, locates its bundled Playwright dependency, and downloads matching Chromium if absent | Global npm package and user browser cache |
| Browser connections | Adds missing `playwright` MCP registrations for Claude in user scope and Codex in user config | `~/.claude.json` and `~/.codex/config.toml`, shared across projects |
| graphify | If missing, asks for scope. **User** (default): `uv tool`, then `pipx`, then `pip --user`. **Global**: system-wide `pip install`, usually needing admin/root | Your user directory, or system-wide for global |
| Helpers | Copies or updates workflow-owned Node scripts | `.codex/autopilot.js` and `.codex/hooks/` |
| Instructions and hooks | Merges workflow sections and hook groups, retaining existing entries | `CLAUDE.md`, `AGENTS.md`, `.codex/hooks.json` |
| Templates and skills | Creates missing plan template, task directory and caveman skills | `plans/`, `docs/tasks/`, `.claude/skills/`, `.agents/skills/` |
| Project integrations | Runs graphify's agent installers. Only if you opt in, also runs `npx -y impeccable install --project --providers=claude,codex` | Project instructions; with Impeccable, design skills and hooks |
| Ignores and checks | Adds workflow-state ignores and prints detected verification commands | `.gitignore` and installer output |

Re-running updates workflow-owned `.codex/` scripts, replaces the `## Workflow` and `## Codex execution` sections with the bundled versions (the old text is saved in `.codex/backup/`; pass `--keep-sections` to keep yours), and removes scripts an earlier version installed that the current one no longer ships (tracked in `.codex/workflow-manifest.json`). Plan and caveman templates are refreshed only while you haven't edited them.

**Updating the plugin:** after `/plugin update claude-codex-workflow`, the plugin's SessionStart hook runs `install.js --sync` in any project that already uses the workflow. It upgrades the scripts, sections and hooks silently, removes stale files, and says so in the session. It does nothing in other projects, never downgrades a project a teammate already upgraded, and needs no re-run of setup. Restart Codex afterwards so it reloads `AGENTS.md` and the scripts. Existing Playwright registrations are preserved and matching Chromium is reused. Keeping an existing registration does not prove it connects successfully; check `/mcp`.

### Flags

| Flag | Effect |
|---|---|
| `--yes` | Approve missing machine tools and Playwright setup without installer prompts. Doesn't install Impeccable, and graphify uses the user scope. |
| `--dry-run` | Print intended actions without installing or writing files/configuration. |
| `--tools-only` | Set up machine tools, Chromium and Playwright registrations; skip project files and integrations. |
| `--project-only` | Configure the project using existing tools; skip machine installations, Chromium download and MCP registration. |
| `--skip-playwright` | Skip Playwright package, browser download and both registrations. |
| `--graphify-scope=user` or `global` | Choose where a missing graphify is installed without being asked. Default `user`; `global` is system-wide `pip` and usually needs admin/root rights. |
| `--skip-graphify` | Skip graphify's project integrations; the tools stage still checks/installs graphify. |
| `--impeccable` | Install Impeccable. Without it, a terminal installer asks; `--yes`, `--dry-run` and a non-interactive run skip it. |
| `--skip-impeccable` | Don't install Impeccable and don't ask. |
| `--impeccable-providers=codex` | Implies `--impeccable`; installs design skills only for Codex when Claude already uses the Impeccable plugin. |
| `--keep-sections` | Leave existing workflow sections in `CLAUDE.md` and `AGENTS.md` alone. By default they are replaced with the bundled versions (the old text is saved under `.codex/backup/`). `--update-sections` is accepted and is the default. |
| `--sync` | Quiet, files-only upgrade of a project that already uses the workflow. Run by the plugin's SessionStart hook; no tools, prompts, graphify or Impeccable. |
| `--root <dir>` | Configure the Git repository containing that directory. |

### Finish initial setup

1. Open `claude` and follow its sign-in flow; run `codex login` if needed.
2. Restart both clients. Check `/mcp` for Playwright, and inspect registrations with `claude mcp get playwright` and `codex mcp get playwright`.
3. Review and trust `.codex/hooks.json` in Codex using `/hooks` when needed. Later hook changes require trusting them again.
4. Allow the helper's `verify`, `triage` and `close` commands network access and a long timeout when Codex requests approval: they start headless Claude sessions.
5. Once the project has code, build the initial graph with `/graphify .` in Claude Code. If you chose a user-scope graphify and `graphify` isn't found, add `~/.local/bin` (or the Python user scripts folder) to `PATH`.
6. If you installed Impeccable, run `/impeccable init` for `PRODUCT.md`; for an existing UI, follow with `/impeccable document` for `DESIGN.md`. Use `/impeccable doctor` for an older design setup.
7. Review detected checks and add `.codex/verify.json` if they are missing or unsuitable.
8. Optional: run `node .codex/autopilot.js usage` after a task to see headless Claude token usage and cost.

## Playwright browser tools

Playwright is included in default **machine setup**. The browser download uses the Playwright version inside the installed MCP package, avoiding a browser mismatch with a separately fetched version.

New registrations use absolute Node, server and Chromium paths, with `--headless` and `--isolated`. Browser sessions have separate state and no visible window, so the agents do not share a persistent profile. Existing registrations retain their settings. See the official [Playwright MCP guide](https://github.com/microsoft/playwright-mcp) for server capabilities and options.

Start your app normally, then give either agent the actual URL and expected behavior:

```text
Use Playwright to inspect http://localhost:3000/settings. Check that Save is disabled
until a field changes, saving shows confirmation, and the page fits desktop and
mobile viewport sizes. Report console errors and capture relevant screenshots.
```

For an orchestrated task, put the startup command, URL, browser steps and expected results in the plan. MCP provides interactive browser tools; it does not create a test suite or automatically launch your application. The headless Step A/B reviewers do not have MCP browser tools in their allowed tool lists. Step A can run an existing browser test command if configured as a check.

For repeatable browser gates, install `@playwright/test` in the application's own development dependencies using its package manager, write specs and configure the test server. A gate can then run `npx playwright test tests/settings.spec.ts`. That project test runner and lockfile are separate from global MCP and may require their own matching browser download.

Minimal Linux systems may need OS libraries for Chromium. With administrator approval, run the installed MCP package's bundled Playwright CLI with `install-deps chromium`. Locate global packages with `npm root -g`; setup does not automatically install system packages. See [Playwright browser dependencies and caches](https://playwright.dev/docs/browsers).

## Daily use: what happens during a task

1. **Describe the task to Claude.** For app-code changes, choose direct implementation or orchestration. Direct implementation uses Claude's session and project checks without the phased Codex handoff.
2. **Review the plan.** Claude writes `plans/<task>.md` with scope, acceptance criteria, risk and runnable gates. It validates the plan. High-risk work enables Codex plan review.
3. **Paste the handoff into Codex:**

   ```text
   Execute plans/<task>.md
   ```

4. **Preflight and optional plan review.** The helper validates phases and snapshots the working tree. Existing uncommitted work becomes the starting baseline. When enabled, Codex appends plan findings and headless Claude triages them before implementation.
5. **Implement each phase.** Codex edits scoped files; the helper runs the gate. Gate failures return to Codex for fixes. After the gate passes, the verify script runs the checks (no model call) and then one headless Claude review:

   | Step | Default model / effort | Behavior | Report |
   |---|---|---|---|
   | A: checks | None when checks pass; Sonnet / low only to fix a failure | The verify script runs detected or configured checks itself. If one fails, Claude fixes lint, formatting and type errors and reports other failures; the script then re-runs the checks. | `.codex/verify/last.log` |
   | B: alignment | Sonnet / medium; Opus for high risk or configured risk paths | Reads the plan and diff, reports completeness, scope, gates and risks, then returns `PASS` or `NEEDS REWORK`. Editing tools are denied. | `.codex/verify/alignment.md` |

   On `NEEDS REWORK`, Codex fixes findings and verifies again. After two reworks, another failed review stops the run as `stuck`. Each repeated review adds Claude usage. The verified snapshot advances only on `PASS`.
6. **Close the task.** The helper runs `graphify update .` and a Sonnet / low Claude call writes `docs/tasks/<date>-<task>.md`. Codex reports completion. You review the changes and commit them.

Snapshots use a temporary Git index and tree objects; they do not change your real staging index or create branch commits. During helper-driven execution, the Stop hook stays quiet to avoid overlapping verification. In manual phase mode, the Stop hook launches review after Codex ends its turn; wait for `Finished` in the log before another edit turn.

Say **manual** to Claude to hand off one phase at a time. The [workflow skill](skills/claude-codex-workflow/SKILL.md) also covers unattended `autopilot.js run` and `--resume` commands.

## Configure verification

Checks are detected from root-level Node, Rust, Go and Python markers. Node checks use the detected npm/pnpm/yarn/bun commands and available typecheck, lint, build and non-watch test scripts. Monorepos, custom checks and browser suites often need an override:

```json
{
  "checks": [
    "npm run typecheck",
    "npm run lint",
    "npm test",
    "npx playwright test tests/settings.spec.ts"
  ],
  "alignment": {
    "model": "sonnet",
    "effort": "medium",
    "riskModel": "opus",
    "riskPaths": ["src/auth/**", "migrations/**"]
  }
}
```

Save this as `.codex/verify.json`, retaining only commands your project supports. `checks` replaces auto-detection; an empty list runs no executable checks. An `alignment`-only configuration retains auto-detection. Gates live in the plan and may be narrower than the full check list.

Inspect the resolved setup:

```sh
node .codex/hooks/claude-verify.js --print-checks
node .codex/autopilot.js check plans/<task>.md
```

## Token usage for Claude and Codex

**There is no fixed token count for installation or a task.** Running the installer directly executes local commands without calling Claude or Codex models. Package and browser downloads are not model tokens. Setup through Claude uses tokens for the conversation, command output and follow-up analysis. Graph building, design interviews and subsequent coding/review sessions are separate work and may use models.

Claude and Codex have **separate usage accounting**. A Claude subprocess launched by Codex uses Claude's authenticated account or API credentials; it does not become Codex usage. This plugin neither supplies credits nor combines billing.

| Activity | Claude usage | Codex usage |
|---|---|---|
| Direct shell installation | No Claude model calls from the installer | No Codex model calls from the installer |
| Setup invoked in Claude | Setup conversation and analysis of output | No Codex model calls from the installer |
| Direct implementation in Claude | Reads, reasoning, edits and checks in that session | None unless Codex is separately requested |
| Orchestrated planning | Plan creation and revisions | Optional plan review |
| Phase implementation | Headless verification after passing gates | Implementation, gate fixes and review rework |
| Verification | Step B per review attempt, plus a Step A fix call when a check fails | Reading findings and fixing them |
| Optional plan triage | One Sonnet / medium headless call | Plan review and reading the revised plan |
| Task close | One Sonnet / low headless summary call | Closing coordination in the active session |
| Browser inspection | Usage belongs to Claude when it drives Playwright | Usage belongs to Codex when it drives Playwright |

For `P` phases and `R` additional verification attempts that reach Claude review, a successful orchestrated run normally starts **`(P + R) + 1 + T` headless Claude calls** when checks pass, where `T = 1` if plan triage runs, otherwise `0`. Each attempt whose checks fail adds one more call, for the fix step. Three phases with no rework, failing checks or triage mean four headless Claude calls (three reviews and the close summary), plus interactive planning and Codex implementation. Gate failures occur before Claude review, so fixing one does not itself add Claude calls. Interrupted calls can change these counts. Calls are not tokens: a call can contain multiple model turns and tool interactions.

Every headless call starts with only the built-in tools it needs (`--tools`) and no MCP servers (`--strict-mcp-config`). On a trivial prompt this cut a call's fixed input from about 37k to 14k tokens in a test run; your figure depends on your CLAUDE.md, skills, plugins and hooks. To also skip user-level settings, plugins and hooks, add `"headless": { "settingSources": "project,local" }` to `.codex/verify.json`. This is off by default because user settings can hold authentication or proxy environment.

### See your actual usage

| Agent | Where to look | Meaning |
|---|---|---|
| Claude Code | `/usage`; older versions may expose `/cost`; `/context` for context occupancy | Current-session usage/model breakdown where supported, plus subscription information depending on account and version. |
| Claude API billing | Claude Console usage reporting | Authoritative account billing; planner-session totals alone do not include separate headless sessions. |
| Codex CLI | `/status`, `/usage` where available, `/statusline` token fields | Session usage/configuration and available account token activity. |
| OpenAI API billing | OpenAI Platform usage reporting | API-key usage; subscription limits and dollar billing are distinct from raw token counts. |

See the official [Claude usage and cost guide](https://code.claude.com/docs/en/costs) and [Codex CLI command reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli). Availability varies by client version and authentication. Context occupancy is not cumulative consumption; an API-equivalent dollar estimate is not a subscription invoice.

**Headless Claude calls are logged; Codex and interactive sessions are not.** Each headless call appends its model, effort, input, cache and output tokens, turns and list-price cost to `.codex/verify/usage.jsonl`. Sum it with:

```sh
node .codex/autopilot.js usage                  # all tasks
node .codex/autopilot.js usage plans/<task>.md  # one task
```

Input counts fresh, cache-written and cache-read tokens together, summed over each call's turns. The dollar figure is the API list price, not a subscription invoice. Codex usage and your interactive planner session are not in this log, so compare them through each client's own usage view. To establish a baseline, run a representative task and keep the usage summary alongside those figures. Concurrent work can affect account-level differences, and avoid counting a session twice.

### What increases usage, and what helps

Large file reads, conversation history, repeated tool output, screenshots, extra phases and rework all add context or output. Reasoning usage is model-dependent; cached input is accounted for separately where reported. Two agents reviewing the same work intentionally repeat some context. Scoped diffs and clear acceptance criteria help keep that repetition useful.

Use graphify to narrow discovery, request focused Playwright interactions and screenshots, and keep checks deterministic. Reserve high-risk review settings for work that needs them. Use `/caveman` in Claude or request caveman mode in Codex for shorter replies. These practices can reduce unnecessary usage; this repository has no benchmark proving a fixed saving.

## Reports, recovery and troubleshooting

| Artifact | Contents |
|---|---|
| `plans/<task>.md` | Approved requirements, phases, gates and plan findings; ignored by default except the template. |
| `.codex/autopilot/status.json` | State (`running`, `done`, `stuck`, `failed`), phase, step and reason. |
| `.codex/autopilot/<task>.log` | Helper progress log. |
| `.codex/verify/phase.diff` | Changes presented to the verifier. |
| `.codex/verify/last.log` | Latest checks report and completion information. |
| `.codex/verify/alignment.md` | Latest alignment report and verdict. |
| `docs/tasks/<date>-<task>.md` | Final task summary for review and commit. |

Verification reports are overwritten on the next run. Verification/helper state, graph output and individual plans are ignored by Git; task summaries can be committed with the code.

- **Failed setup steps:** fix the reported prerequisite, network or installation issue and re-run. Missing tools in a noninteractive run require `--yes`; successful partial steps remain.
- **Playwright missing from `/mcp`:** restart clients, inspect `mcp get playwright`, and re-run full setup rather than `--project-only`. Existing entries are kept; repair stale custom entries yourself. Moving Node/global packages can invalidate absolute registration paths.
- **Chromium cannot launch:** check current platform support and Linux system dependencies. Download success alone does not verify launchability.
- **No browser tests ran:** MCP tools are used when requested. Add actual project specs and their command to gates/checks for repeatable assertions.
- **`stuck` run:** read alignment findings, resolve the code or plan decision, and tell Codex to continue the stopped step.
- **`failed` run:** read the reason/logs, fix authentication, permissions, network or command failure, then continue. Helper-launched agent calls have a 30-minute timeout each.
- **Wrong or missing checks:** inspect `--print-checks` and configure `.codex/verify.json`, especially for monorepos.
- **Stale Impeccable context:** run `/impeccable doctor`. Remove its `impeccable-live-start`/`impeccable-live-end` block before committing a production app.

## Repository layout

```text
.claude-plugin/                     # plugin and marketplace manifests
commands/setup.md                   # Claude Code setup command
hooks/hooks.json                    # SessionStart hook that syncs projects after a plugin update
package.json                        # npx installer entry point
skills/claude-codex-workflow/
  SKILL.md                          # workflow guide and advanced operation
  scripts/install.js                # machine and project installer
  scripts/playwright.js              # browser package, Chromium and MCP setup
  templates/
    CLAUDE.workflow.md               # merged Claude instructions
    AGENTS.codex.md                  # merged Codex instructions
    codex/hooks.json                 # merged project hooks
    codex/hooks/claude-verify.js      # two-step headless review
    codex/hooks/workflow-lib.js       # plan parsing and Git snapshots
    codex/autopilot.js               # phase helper
    plans/_template.md               # phased plan template
    skills/caveman/SKILL.md          # optional terse-response skill
tests/                              # installer regression tests
```

Run `npm test` to check the Playwright setup flow without downloading browsers, invoking models or changing user MCP configuration.
