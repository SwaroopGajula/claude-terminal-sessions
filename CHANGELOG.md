# Changelog

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
