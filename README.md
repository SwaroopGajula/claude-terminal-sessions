<p align="center">
  <img src="media/icon.png" width="128" alt="Claude Terminal Sessions icon">
</p>

<h1 align="center">Claude Terminal Sessions</h1>

<p align="center">
  Every Claude Code session you have run in the terminal, from every project folder, in one VS Code sidebar.<br>
  See what each session was about, what it changed, and jump back in with one click.
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=SwaroopGajula.claude-terminal-sessions"><img src="https://img.shields.io/visual-studio-marketplace/v/SwaroopGajula.claude-terminal-sessions?label=VS%20Code%20Marketplace&color=B24E2C" alt="VS Code Marketplace version"></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=SwaroopGajula.claude-terminal-sessions"><img src="https://img.shields.io/visual-studio-marketplace/i/SwaroopGajula.claude-terminal-sessions?color=B24E2C" alt="Installs"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-B24E2C" alt="MIT license"></a>
</p>

---

## Why

When you use Claude Code across many repos, sessions pile up in different folders and it is hard to remember
*which* session handled *which* task. `claude --resume` only lists sessions for the current folder.

**Claude Terminal Sessions** reads the session history Claude Code already keeps on your machine
(`~/.claude/projects`) and shows all of it, across all folders, grouped by day.

## Features

### All sessions, everywhere
- Sessions from **every folder**, newest first
- Grouped by **Today / Yesterday / Earlier this week / Earlier this month / Older**, or by **folder** (toggle in the toolbar)
- Each row shows the **session name**, **folder**, and **when it was last used**
- **Name** is taken from your `/rename` title, then Claude's automatic title, then your first prompt
- Hover for details: description (first and last prompt), full folder path, git branch, start and last-active dates, prompt count, session ID

### Expand a session to see its context
```
▾ dark-mode-toggle                        my-web-app · 2h ago
  ▶ Resume session                        claude --resume 7c3e9a12…
  📖 Open conversation                    readable transcript
  📁 Folder                               ~/projects/my-web-app
  🌿 Branch                               feature/dark-mode
  🔑 Session ID                           7c3e9a12-4f8b-4d21-…
  ▾ 💬 Prompts                            4
      👤 Add a dark mode toggle to the…   Nov 5, 10:12 AM
      👤 Remember the choice in local…    Nov 5, 10:31 AM
      👤 Write tests for the toggle       Nov 5, 10:48 AM
      👤 Fix the failing snapshot test    Nov 5, 11:02 AM
  ▾ 📄 Files changed                      3
      ThemeToggle.tsx                     src/components · 3× Edit
      theme.css                           src/styles · 2× Edit
      ThemeToggle.test.tsx                src/components · 1× Write
  ▸ 💻 Commands run                       6
      Run the theme tests                 npm test -- ThemeToggle
      Start the dev server                npm run dev
```

| Item | Click | Right-click |
|---|---|---|
| **Resume session** | Opens a terminal in the session's folder and runs `claude --resume <id>` | |
| **Open conversation** | Opens a readable Markdown copy of the session: prompts, Claude's replies, every tool step | |
| **Folder** | Opens the folder in a new VS Code window | |
| **Session ID** | Copies the ID | |
| **Prompt** | Opens the conversation at that prompt | |
| **Changed file** | Opens the file | |
| **Command run** | Shows it in the conversation | Copy, or paste into a terminal (not run until you press Enter) |

### Share a session with someone else
Right-click a session → **Share**:

| Option | What the other person gets | Needs Claude Code? |
|---|---|---|
| **Export for Reading (.md)** | A readable Markdown file: prompts, Claude's replies, files changed and commands run (no command output) | No |
| **Export to Continue on Another Computer** | A `.claude-session.json` file they can import and **resume with full context** | Yes |

#### Export (the person sharing)
1. Open the **Claude Terminal Sessions** sidebar and find the session.
2. Right-click it and choose **Share: Export for Reading (.md)** or **Share: Export to Continue on Another Computer**.
3. Read the warning. It shows how many likely secrets were removed automatically. Click **Save…**.
4. Choose where to save the file (defaults to your `Downloads` folder).
5. Click **Open** to check the file, then send it (Slack, email, shared drive…).

#### Import (the person receiving)
*A `.md` export needs no import: just open it in any editor or Markdown viewer.*

For a `.claude-session.json` export:
1. Install **Claude Terminal Sessions** and [Claude Code](https://docs.claude.com/en/docs/claude-code).
2. Get the same project on your computer (clone the repo). Ideally check out the branch the session was on.
3. Open the **Claude Terminal Sessions** sidebar and click **Import Shared Session** (📥) in the toolbar.
4. Pick the `.claude-session.json` file.
5. Choose your local copy of the project. Folders with the same name are suggested first, or use **Browse…**.
6. If the session already exists on your computer, choose **Import as a copy** (it gets a new session ID).
7. Click **Resume now**. Claude Code opens in that folder with the full conversation, ready to continue.
   The session also appears in the sidebar, so you can resume it later.

**Before you share:** session files can contain anything that went through the session, including command output,
file contents, environment variables and internal URLs. The extension:
- removes likely secrets automatically (GitHub, GitLab, npm, Slack and Stripe tokens, AWS and Google keys, Anthropic and OpenAI keys, JWTs, private keys, passwords in URLs, and values of settings like `DB_PASSWORD` or `API_KEY`) and tells you how many it found
- leaves out Claude Code's internal request logs
- warns you before every export

Automatic detection is not perfect. **Read the file before sharing it**, and only share with people who may see that code and data.

### Toolbar
- 🔍 **Filter** by title, prompt text, folder, branch or session ID
- 🌲 **Group by** date or folder
- 📥 **Import Shared Session** from a `.claude-session.json` file
- 🔄 **Refresh** (the list also refreshes when sessions change)

### Session right-click menu
Resume in terminal · Open conversation · Copy session ID · Copy resume command
(`cd '<folder>' && claude --resume <id>`) · Open folder in new window · Open raw transcript (`.jsonl`) · Share: Export for Reading · Share: Export to Continue on Another Computer

## Requirements

- VS Code 1.90 or newer
- [Claude Code](https://docs.claude.com/en/docs/claude-code) installed and on your `PATH` (needed to resume sessions)

## Installation

**From the VS Code Marketplace (recommended)**

- [Install from the Marketplace](https://marketplace.visualstudio.com/items?itemName=SwaroopGajula.claude-terminal-sessions), or
- in VS Code open the **Extensions** panel and search **Claude Terminal Sessions**, or
- run:

  ```bash
  code --install-extension SwaroopGajula.claude-terminal-sessions
  ```

**From a `.vsix` file**

```bash
code --install-extension claude-terminal-sessions-0.4.0.vsix
```

or in VS Code: **Extensions** panel → `···` menu → **Install from VSIX…**

Then click the **Claude Terminal Sessions** icon in the activity bar.

## Settings

| Setting | Default | Description |
|---|---|---|
| `claudeSessions.claudeCommand` | `claude` | Command used to launch Claude Code (e.g. a full path or an alias) |
| `claudeSessions.groupBy` | `date` | Group sessions by `date` or `folder` |
| `claudeSessions.maxSessions` | `300` | Maximum number of sessions to show |

## Privacy

Everything stays on your machine. The extension only **reads** the session files in `~/.claude/projects`.
It never changes them and never sends anything over the network. Each user sees only their own sessions.
Exports are only written where you choose to save them, and importing only adds a new session file under `~/.claude/projects`.

## Building from source

```bash
git clone https://github.com/SwaroopGajula/claude-terminal-sessions.git
cd claude-terminal-sessions
npx @vscode/vsce package
code --install-extension claude-terminal-sessions-*.vsix
```

There is no build step: the extension is a single plain JavaScript file (`extension.js`) with no dependencies.

## Notes

This is an unofficial community tool and is not affiliated with or endorsed by Anthropic.
It relies on Claude Code's local session file format, which may change between Claude Code versions.

## License

[MIT](LICENSE)
