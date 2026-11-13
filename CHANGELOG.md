# Changelog

## 0.10.2
- Windows: finding the terminal of a running session no longer freezes VS Code while PowerShell starts (the lookup now runs in the background, allows up to 20 seconds and is remembered).

## 0.10.1
- Fix: agents interrupted by closing a session (or quitting VS Code) now show as *Stopped* after the session is resumed, instead of *Running*.

## 0.10.0
- **Alerts** when a session starts waiting for your input and when an agent of a running session finishes, with buttons to show the terminal or open the conversation. Skipped when you are already looking at that terminal, and shown in only one VS Code window. Settings: `claudeSessions.notifyNeedsInput`, `claudeSessions.notifyAgentDone`.
- **Context size** of running sessions on their row, and for every session on hover and in *Token usage*: tokens on the latest reply against the model's limit, compactions in the session, and the range at which Claude Code has compacted your sessions before. ⚠ marks sessions near that range.

## 0.9.0
- **Agents.** See the agents (Agent / Task tool) each session started: a count of running agents on the session row and in the *Running* group, and an *Agents* section with each agent's task, status (running, done or stopped), latest step, duration, model and cost. Hover for the task and the result it handed back; click to open the agent's own conversation. Updates live while agents work.

## 0.8.0
- **Rename sessions** from the right-click menu or with **F2**. The name is stored by the extension; Claude Code's own title is unchanged, shown on hover and still searchable.
- **Windows support:** *Copy Resume Command* uses your default shell's syntax (PowerShell, Command Prompt, Git Bash, bash/zsh, fish); finding the terminal of a running session works on Windows; deleted sessions go to the Recycle Bin; importing a session exported on another OS converts path separators.
- CI runs the tests on Linux, Windows and macOS.
- Fix: changed files are shown relative to the project folder whether their paths use `/` or `\`.

## 0.7.0
- **Token usage and cost.** Each session shows its estimated cost at Anthropic API list prices on its row, on hover and in a new *Token usage* section (output, input, cache reads and writes, per model). Each reply is counted once, cache tokens are priced per model, fast mode counts at 2×, and subagent transcripts are included.
- **Token Usage and Cost Report** toolbar button: totals by day, model, project and most expensive sessions for today, yesterday, this week, the last 7 or 30 days, or all time.
- The daily summary shows the estimated cost per session and for the period.
- New settings: `claudeSessions.showCost` and `claudeSessions.modelPricing` (override or add prices).

## 0.6.1
- Uses `CLAUDE_CONFIG_DIR` when it is set, like Claude Code does, instead of always reading `~/.claude`.
- `scripts/demo.js` creates invented demo sessions in a separate VS Code window for screenshots (not part of the extension).
- Clearer Marketplace description and keywords.
- Demo GIF in the README.
- Search results for files and commands show plain text instead of Markdown.

## 0.6.0
- **Search Inside Conversations** toolbar button: finds text in prompts, Claude's replies, commands and changed files across all sessions. Open a match at that line, or filter the sidebar to the matching sessions.
- **Pin to Top**, **notes** and **labels** (`#bug`, `#feature`…) for sessions. Filter by label from the ⋯ menu or by typing `#label` in the filter.
- **Archive** hides finished sessions (with Undo; resuming brings them back). **Show Archived Sessions** in the ⋯ menu. New setting `claudeSessions.autoArchiveDays`.
- **Delete Session** moves a session's files to the Trash after a confirmation.
- Select several sessions to pin, label, archive or delete them together.
- Fix: clicking a prompt, command or changed file now opens the conversation at the right line (it often landed too early in long sessions).

## 0.5.0
- **Running sessions.** A live *Running* group shows every open Claude Code session: working, needs input or open. The status bar shows sessions that need your input.
- Resuming a session that is already open warns you and offers to show its terminal or fork instead.
- **Fork Session** (`--fork-session`) from the right-click menu or inside an expanded session.
- **Follow-up reminders.** Set a reminder for tomorrow, in N days, next week or on a date, with a note. A *Follow-ups* group, a status-bar count and a reminder with Resume / Snooze / Done. Skipping the note keeps the follow-up, and a confirmation with a Change button is shown.
- **Daily Summary** toolbar button: a Markdown report of the prompts, commits, pull requests and files changed in a chosen period.

## 0.4.0
- **Share sessions.** Right-click a session → *Share: Export for Reading (.md)* or *Share: Export to Continue on Another Computer*.
- **Import Shared Session** toolbar button: pick a `.claude-session.json`, choose your local copy of the project, and resume it.
- Exports remove likely secrets automatically, leave out Claude Code's internal request logs, and warn before saving.
- Marketplace link and badges in the README.

## 0.3.0
- Renamed to **Claude Terminal Sessions**, with a new icon.
- First Marketplace release.

## 0.2.0
- Expand a session to see its prompts, files changed and commands run.
- Readable conversation view that opens at a chosen prompt or command.

## 0.1.0
- Sidebar listing all Claude Code sessions across folders, grouped by date or folder, with one-click resume.
