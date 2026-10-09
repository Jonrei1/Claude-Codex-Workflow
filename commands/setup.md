---
description: Install the tools (Claude Code, Codex CLI, Playwright, graphify) and set up the Claude + Codex workflow in this project, local only (no tracked file changes). Impeccable design skills are optional and asked about first.
argument-hint: "[--yes] [--dry-run] [--tools-only|--project-only] [--impeccable|--skip-impeccable] [--graphify-scope=user|global] [--skip-playwright] [--playwright-codex] [--shared]"
allowed-tools: Bash(node:*), Bash(git status:*), Read, Write, Edit, AskUserQuestion
---

Set up the Claude + Codex workflow in the current project.

1. **Ask about Impeccable first.** Impeccable adds design skills and UI hooks, and it is
   optional.
   - If `$ARGUMENTS` has neither `--impeccable` nor `--skip-impeccable` (and isn't
     `--tools-only`), ask the user with AskUserQuestion whether to install it.
   - Say it is mainly useful for UI work, and that its own installer writes shared project
     files.
   - `--yes` does not answer this question.
   - Add `--impeccable` to the installer arguments for yes, `--skip-impeccable` for no. If the
     Impeccable plugin is already enabled in Claude Code, also add
     `--impeccable-providers=codex` for yes, so the skill isn't loaded twice.

   Also check whether graphify is installed (`graphify --version`).
   - If it isn't, and `$ARGUMENTS` has no `--graphify-scope`, ask with AskUserQuestion where to
     install it:
     - for the current user only (recommended: no admin rights, uv/pipx/pip --user);
     - globally for every user (system-wide pip, usually needs admin rights).
   - Add `--graphify-scope=user` or `--graphify-scope=global`. `--yes` does not answer this.
2. From the project root, run:

   ```
   node "${CLAUDE_PLUGIN_ROOT}/skills/claude-codex-workflow/scripts/install.js" $ARGUMENTS <the Impeccable and graphify-scope flags from step 1>
   ```

   The installer can't prompt from here. If it reports tools as missing and the user
   didn't pass `--yes`, list the install commands it printed and ask whether to re-run
   with `--yes`.
3. Show the summary: what was created, merged or skipped, and the steps that need
   attention. Run `git status` and confirm no workflow file shows up.
   - Explain that everything is local: plans, verify logs, task summaries, `CLAUDE.local.md`
     and `.codex/workflow/CODEX.md` are hidden through `.git/info/exclude`.
   - Explain that a step reported as "tracked by git, left unchanged" is expected.
   - If it points out old workflow sections in tracked `CLAUDE.md`, `AGENTS.md` or
     `.gitignore`, suggest removing them in a normal team commit.
4. Read the detected checks it printed. If they're wrong or empty, propose a
   `.codex/verify.json`. Also propose:
   - `alignment.riskPaths` for the project's schema, migration and auth paths;
   - for apps with a UI, a `ui` block (`startCommand`, `url`, `viewports`, `paths`) so
     Claude can audit UI phases with Playwright.

   See the claude-codex-workflow skill, "Checks".
5. List the "Left for you" steps, and the new- or existing-project steps from the skill's
   Setup section (`/graphify .`, and `/impeccable init` and `/impeccable document` only if
   Impeccable was installed). Stress that the user must:
   - restart Claude Code, which loads `CLAUDE.local.md` and the plan hook;
   - keep a Codex session open in the repo, because Claude posts plans into it with
     `codex queue`.
6. Explain that Playwright setup installs a global MCP server and matching Chromium, and
   registers it for Claude, which does the UI audits.
   - `--playwright-codex` also registers it for Codex.
   - Existing registrations are kept. Restart Claude and check `/mcp`.
   - `--project-only` skips Playwright setup; `--skip-playwright` opts out explicitly.

Don't commit anything.
