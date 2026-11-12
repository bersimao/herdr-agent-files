# Agent Files

A pane beside the terminal that lists every file the coding agent in that terminal read, edited, wrote or mentioned in its current session, and opens any of them in the desktop file manager: Explorer on Windows, Finder on macOS, the default file manager on Linux. Claude Code and Codex are supported; their own session files are read, so nothing is set up inside the agent.

![Agent Files](preview.png)

## What you see
A pane (split to the right of the focused pane) on the surface color:
1. Header, 42 px: "Agent Files" (semibold), a "Refresh" button and a "×" button.
2. A muted line: space name · terminal address, plus "· matched by folder" when the session was found by folder instead of by process.
3. When the space has more than one agent terminal, one small button per terminal ("claude t12", "codex t5") to switch.
4. A 30 px filter input ("Filter paths…").
5. The list, newest first. Each row is a raised card: folder icon (accent, 15 px), the file or folder name (semibold, "/" after folders), a "Reveal" (file) or "Open" (folder) button; under it the full path (muted, truncated, tooltip) and the origins ("Read · Edited", dim), with "· missing" when the path no longer exists.
6. Footer: a path input ("Or enter a file or folder path…"), "Open path" and "Project folder" buttons, and a notice line when there is something to say.

Empty states: "No Claude Code or Codex terminal in this space.", "Reading the session…", "No Claude Code session found for this terminal." (or Codex), "No paths yet…", "No matching paths.", "Gemini CLI sessions are not supported yet.", and errors in red.

## How it behaves
- The key (`mod.open:agent-files`) opens the mod as a 1x1 overlay. In that mode it closes every `agent-files` pane in the focused tab, or, if there is none, runs `pane.split {direction: "right", mod: "agent-files"}`; then it closes the overlay. On the pane's first tick it records its own pane id and hands focus back to the terminal it describes.
- The target terminal: the one picked with the buttons, else the last agent terminal that had focus (the launcher passes the one the key was pressed in as `props().terminal`; clicking the panel itself does not change it), else the first agent terminal in this tab, else in this space. Agent kind comes from the pane's `app`/`program` (codex, claude, gemini).
- Finding the session, Claude Code: on Linux, processes whose environment holds `HC_TERMINAL_ID=<terminal>` (`grep -lsxz` over `/proc/*/environ`) that have `~/.claude/sessions/<pid>.json`. Otherwise every live session file (pid still running) whose `cwd` is the terminal's folder, newest `statusUpdatedAt`. The transcript is `~/.claude/projects/<cwd with every non-alphanumeric replaced by "-">/<sessionId>.jsonl`, or found by name under `projects/`. `sessionId` changes after `/clear`, and the panel follows it.
- Finding the session, Codex: on Linux, the `~/.codex/sessions/**/rollout-*.jsonl` the matching process holds open (newest name). Otherwise the 30 newest rollouts from the last 7 days whose first line's `cwd` is the terminal's folder.
- Reading: incremental, from the last byte offset, at most 4 MiB per read and 6 reads per refresh. The byte cut is made where the file lives (sh or PowerShell); JS never counts bytes. A line longer than 4 MiB (a large base64 image) is skipped whole. A file that shrank is read from the start. The session is located again every 4th refresh, so a `/clear` is picked up within about 12 s.
- Paths, Claude Code: `tool_use` blocks Read (Read), Edit/MultiEdit/NotebookEdit (Edited), Write (Written) from `input.file_path` / `notebook_path`, kept even when missing (a Write is logged before it runs; missing entries are re-checked on every refresh); absolute paths and backticked relative paths in assistant text (Mentioned), kept only if they exist. Codex: `*** Add/Update/Delete File:` lines in tool calls (Edited), absolute paths in tool arguments (Tool; `function_call` arguments are JSON, so their string values are scanned), paths in assistant messages (Mentioned). Only regular files and folders count; devices such as `/dev/null` do not. At most 200 paths.
- Ticks every 750 ms while its tab is focused, reading at most every 3 s.
- Opening: Windows `explorer.exe <dir>` or `explorer.exe /select, <file>` (exit 1 is normal), using the `wslpath -w` form for a WSL machine; macOS `open <dir>` / `open -R <file>`; Linux `xdg-open` on the folder. Reveal is hidden when the desktop cannot reach the file (an SSH machine).

## Built from
- `mods/agent-files/main.js`: the `View` (launcher mode, pane mode, rendering, opening).
- `mods/agent-files/backend.js`: `Posix` (any Unix machine through `exec("sh", ["-c", SCRIPT, "sh", ...args], { on })`), `Windows` (this computer: `fs/promises` `readdir`/`readFile` under the home folder plus `agent-files.ps1`), and `Reader` (one per terminal: locate, read, parse, resolve).
- `mods/agent-files/agent-files.ps1`: actions `alive`, `codex`, `chunk`, `exists`. `PositionalBinding = $false`, paths in `ValueFromRemainingArguments`.
- `mods/agent-files/mod.json`: `{ "place": "none", "title": "Agent Files", "overlay": { "width": 1, "height": 1 } }`.
- `folder.svg`: the icon.
- Herdr API: `panes()`, `spaces()`, `focused()`, `props()`, `run()`, `exec()`, `closeOverlay()`, `window().platform`, `home()`, `appHome()`.
- `keys.json`: `ctrl-shift-m` -> `mod.open:agent-files`.

## Watch out
- Runs programs (`sh`, `powershell.exe`, `explorer.exe` / `open` / `xdg-open`) and reads the agents' session files under `~/.claude` and `~/.codex`. No network.
- A mod's `fs` reads only under the home folder: `fs.exists` on another drive or a `\\wsl.localhost` path is refused ("outside every granted read root"). Check paths through PowerShell instead.
- `tail -n 1` truncated a multi-megabyte last line on the tested Ubuntu; measure complete lines with `sed '$d'` instead.
- Herdr's JS stalls when indexing a multi-megabyte string character by character: keep byte arithmetic in the shell.
- A pane split by a key is not in `panes()` during `init`; it is on the next tick.
- A mod copy only starts once it is shown, so a pane in a space nobody is looking at does nothing yet.
- Pass paths to `sh -c` as positional arguments, never interpolated into the script. In JS template strings, escape `${` in shell code.
- The session formats are the agents' own, not APIs; an update can break a reader. macOS and Linux are untested on real machines.

## Done when
- `herdr-app check mods/agent-files` passes.
- `ctrl-shift-m` in a tab with Claude Code opens the pane with that session's files, keyboard still in the terminal; pressing it again closes it with no second pane.
- The same works for Codex, and in a WSL machine space on a Windows desktop (exact match, `\\wsl.localhost` paths).
- A native Windows Claude Code session lists its files, including `\\wsl.localhost` ones, and Reveal selects them in Explorer.
- After `/clear` the list follows the new session.
