// Finds the agent session behind a terminal and reads the paths it touched.
// Everything runs on the machine that holds the session: POSIX sh there (Linux, macOS, WSL, SSH),
// or PowerShell + fs here when the app and the session are both on Windows.
import { exec, home, appHome } from "herdr";
import * as fs from "fs/promises";

export const MAX_PATHS = 200;
const CHUNK = 4 << 20; // bytes per read; exec output is capped at 8 MiB
const CHUNKS_PER_POLL = 6;

// ---------- POSIX scripts (run with `sh -c SCRIPT sh args...`) ----------

// $1 = terminal id, $2 = "claude" or "codex". Exact match: processes whose environment carries HC_TERMINAL_ID=$1 (Linux /proc).
// Lines: "C\t<session json>" Claude, "X\t<file>" Codex.
const EXACT_SH = String.raw`
T="$1"; K="$2"; S="$HOME/.claude/sessions"; X="$HOME/.codex/sessions"
[ -d /proc ] && [ -n "$T" ] || exit 0
for e in $(grep -lsxz "HC_TERMINAL_ID=$T" /proc/[0-9]*/environ 2>/dev/null); do
  p=\${e%/environ}; pid=\${p#/proc/}
  if [ "$K" = claude ]; then [ -f "$S/$pid.json" ] && { printf 'C\t'; tr -d '\n' < "$S/$pid.json"; echo; }; continue; fi
  for fd in "$p"/fd/*; do
    t=$(readlink "$fd" 2>/dev/null) || continue
    case "$t" in "$X"/*.jsonl) printf 'X\t%s\n' "$t";; esac
  done
done`.replace(/\\\$/g, "$");

// Folder fallback (macOS, or no process carries the id). $1 = "claude" or "codex".
// Lines: "c\t<session json>" live Claude, "x\t<file>\t<cwd>" one of the 30 newest Codex rollouts.
const LIVE_SH = String.raw`
S="$HOME/.claude/sessions"; X="$HOME/.codex/sessions"
if [ "$1" = claude ]; then
  for f in "$S"/*.json; do
    [ -f "$f" ] || continue
    pid=\${f##*/}; pid=\${pid%.json}
    if [ -d /proc ]; then [ -d "/proc/$pid" ] || continue; else kill -0 "$pid" 2>/dev/null || continue; fi
    printf 'c\t'; tr -d '\n' < "$f"; echo
  done
elif [ -d "$X" ]; then
  find "$X" -name 'rollout-*.jsonl' -mtime -7 2>/dev/null | sort -r | head -n 30 | while IFS= read -r f; do
    c=$(head -n 1 "$f" | grep -o '"cwd":"[^"]*"' | head -n 1 | cut -d'"' -f4)
    printf 'x\t%s\t%s\n' "$f" "$c"
  done
fi`.replace(/\\\$/g, "$");

// $1 = file, $2 = byte offset, $3 = max bytes. Prints the file size, the offset after the last
// complete line read, then those bytes. A line longer than $3 (a large base64 image) is skipped
// whole: the window is consumed and its pieces fail JSON.parse. The byte cut is made here: herdr's JS stalls when indexing
// a multi-megabyte string char by char (measured 2026-11-11), so JS never measures bytes.
const CHUNK_SH = String.raw`
s=$(wc -c < "$1" 2>/dev/null | tr -d ' ') || exit 5; [ -n "$s" ] || exit 5
if [ "$2" -ge "$s" ]; then printf '%s\n%s\n' "$s" "$2"; exit 0; fi
t=$(mktemp) || exit 6; trap 'rm -f "$t"' EXIT
tail -c +"$(($2 + 1))" "$1" | head -c "$3" > "$t"
n=$(wc -c < "$t" | tr -d ' ')
if [ "$n" -gt 0 ] && [ "$(tail -c 1 "$t" | od -An -c | tr -d ' ')" != '\n' ]; then
  r=$(sed '$d' "$t" | wc -c | tr -d ' ') # bytes of the complete lines ("tail -n 1" truncates huge lines)
  { [ "$r" -gt 0 ] || [ "$n" -lt "$3" ]; } && n=$r
fi
printf '%s\n%s\n' "$s" "$(($2 + n))"; head -c "$n" "$t"`;

// $1 = folder for relative paths ("" = none), then paths. One line per path:
// "d|f\t<path>\t<windows path or empty>" for an existing file or folder (not devices like /dev/null),
// an empty line otherwise.
const EXISTS_SH = String.raw`
cwd="$1"; shift; W=; command -v wslpath >/dev/null 2>&1 && W=1
for p in "$@"; do
  case "$p" in "~"|"~/"*) p="$HOME$(printf '%s' "$p" | cut -c2-)";; esac
  case "$p" in [A-Za-z]:[\\/]*|\\\\*) if [ -n "$W" ]; then p=$(wslpath -u "$p" 2>/dev/null) || { echo; continue; }; else echo; continue; fi;; esac
  case "$p" in /*) ;; *) [ -n "$cwd" ] || { echo; continue; }; p="$cwd/$p";; esac
  if [ ! -e "$p" ]; then q=$(printf '%s' "$p" | sed 's/:[0-9][0-9]*\(:[0-9][0-9]*\)\{0,1\}$//'); [ -e "$q" ] && p=$q; fi
  if [ -f "$p" ] || [ -d "$p" ]; then
    k=f; [ -d "$p" ] && k=d; w=; [ -n "$W" ] && w=$(wslpath -w "$p" 2>/dev/null)
    printf '%s\t%s\t%s\n' "$k" "$p" "$w"
  else echo; fi
done`;

const sh = (script, args, on) => exec("sh", ["-c", script, "sh", ...args], { on: on ?? undefined, timeout: 15000 });
const ps = (action, args) => exec("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
  appHome() + "/mods/agent-files/agent-files.ps1", "-Action", action, ...args], { timeout: 15000 });

// ---------- paths ----------

const isWin = p => /^[A-Za-z]:[\\/]|^\\\\/.test(p);
export function normalize(p) {
  const win = isWin(p), sep = win ? "\\" : "/";
  const unc = win && p.startsWith("\\\\");
  const parts = p.split(/[\\/]+/), out = [];
  const head = win ? (unc ? "\\\\" + parts.splice(0, 3).filter(Boolean).join("\\") : parts.shift().toUpperCase()) : (parts.shift(), "");
  for (const s of parts) { if (!s || s === ".") continue; if (s === "..") out.pop(); else out.push(s); }
  return win ? head + sep + out.join(sep) : "/" + out.join("/");
}
export function absolute(raw, base) {
  let p = String(raw).trim().replace(/^[`"']+|[`"'.,;:)\]]+$/g, "");
  if (!p || /[\0\n\t]/.test(p)) return null;
  if (p.startsWith("~")) return p; // the machine expands it
  if (isWin(p) || p.startsWith("/")) return normalize(p);
  if (!base) return null;
  return normalize(base + (isWin(base) ? "\\" : "/") + p);
}
const keyOf = p => isWin(p) ? p.toLowerCase() : p;

// ---------- transcript parsers ----------

const ABS = /(?:^|[\s"'`(\[{<=])(~?\/(?:[\w.@+-]+\/)+[\w.@+-]+\/?|[A-Za-z]:\\(?:[^\s"'`<>|*?\\]+\\)*[^\s"'`<>|*?\\]+)/g;
const TICKED = /`([^`\s]+\.[A-Za-z0-9]{1,8})`/g;
const PATCH = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm;
function* mentions(text) {
  if (typeof text !== "string") return;
  for (const m of text.matchAll(ABS)) yield m[1];
  for (const m of text.matchAll(TICKED)) if (!m[1].includes("://")) yield m[1];
}
// function_call arguments are a JSON string: scan its string values, so escaped newlines and
// doubled backslashes (C:\\x) read as written.
function toolText(raw) {
  if (typeof raw !== "string") return "";
  let v; try { v = JSON.parse(raw); } catch { return raw; }
  const out = [], walk = x => { if (typeof x === "string") out.push(x); else if (x && typeof x === "object") Object.values(x).forEach(walk); };
  walk(v);
  return out.join("\n");
}
const CLAUDE_ORIGIN = { Read: "Read", Edit: "Edited", MultiEdit: "Edited", NotebookEdit: "Edited", Write: "Written" };

// Each yields [raw path, base folder, origin, mustExist].
function* claudeRecord(rec, state) {
  if (rec.cwd) state.base = rec.cwd;
  if (rec.type !== "assistant") return;
  for (const c of rec.message?.content ?? []) {
    if (c?.type === "tool_use" && CLAUDE_ORIGIN[c.name]) {
      const p = c.input?.file_path ?? c.input?.notebook_path;
      if (typeof p === "string") yield [p, state.base, CLAUDE_ORIGIN[c.name], false];
    } else if (c?.type === "text") for (const p of mentions(c.text)) yield [p, state.base, "Mentioned", true];
  }
}
function* codexRecord(rec, state) {
  const p = rec.payload ?? {};
  if (rec.type === "session_meta" && p.cwd) state.base = p.cwd;
  if (rec.type !== "response_item") return;
  if (p.type === "custom_tool_call" || p.type === "function_call") {
    const text = toolText(p.type === "custom_tool_call" ? p.input : p.arguments);
    for (const m of text.matchAll(PATCH)) yield [m[1].trim(), state.base, "Edited", false];
    for (const m of text.matchAll(ABS)) yield [m[1], state.base, "Tool", true];
  } else if (p.type === "message" && p.role === "assistant") {
    for (const c of p.content ?? []) for (const m of mentions(c?.text)) yield [m, state.base, "Mentioned", true];
  }
}

// ---------- the machine a session lives on ----------

class Posix {
  constructor(on) { this.on = on; }
  async find(terminal, kind) {
    const out = { exact: { claude: [], codex: [] }, live: { claude: [], codex: [] } };
    const parse = text => { for (const line of text.split("\n")) {
      const [k, a, b] = line.split("\t");
      if (k === "C" || k === "c") { try { (k === "C" ? out.exact : out.live).claude.push(JSON.parse(a)); } catch {} }
      else if (k === "X") out.exact.codex.push({ file: a });
      else if (k === "x" && a) out.live.codex.push({ file: a, cwd: b });
    } };
    parse((await sh(EXACT_SH, [terminal ?? "", kind], this.on)).stdout);
    if (!out.exact[kind].length) parse((await sh(LIVE_SH, [kind], this.on)).stdout);
    return out;
  }
  async claudeTranscript(s) {
    const slug = s.cwd.replace(/[^A-Za-z0-9]/g, "-");
    const r = await sh(String.raw`f="$HOME/.claude/projects/$1/$2.jsonl"; [ -f "$f" ] || f=$(find "$HOME/.claude/projects" -maxdepth 2 -name "$2.jsonl" 2>/dev/null | head -n 1); printf '%s' "$f"`, [slug, s.sessionId], this.on);
    return r.stdout.trim() || null;
  }
  async chunk(file, offset) {
    const r = await sh(CHUNK_SH, [file, String(offset), String(CHUNK)], this.on);
    if (r.code !== 0) throw new Error("Cannot read the session file.");
    const a = r.stdout.indexOf("\n"), b = r.stdout.indexOf("\n", a + 1);
    return { size: Number(r.stdout.slice(0, a)), next: Number(r.stdout.slice(a + 1, b)), text: r.stdout.slice(b + 1) };
  }
  async exists(paths, cwd) {
    const out = new Map();
    for (let i = 0; i < paths.length; i += 200) {
      const batch = paths.slice(i, i + 200);
      const r = await sh(EXISTS_SH, [cwd ?? "", ...batch], this.on);
      const lines = r.stdout.split("\n");
      batch.forEach((p, j) => {
        const [k, path, win] = (lines[j] ?? "").split("\t");
        if (k === "d" || k === "f") out.set(p, { path, isDir: k === "d", windows: win || null });
      });
    }
    return out;
  }
}

class Windows {
  get base() { return home().replace(/[\\/]+$/, ""); }
  async find(_terminal, kind) {
    const out = { exact: { claude: [], codex: [] }, live: { claude: [], codex: [] } };
    const dir = this.base + "\\.claude\\sessions";
    const sessions = [];
    if (kind === "claude") try {
      for (const f of await fs.readdir(dir)) if (/^\d+\.json$/.test(f)) {
        try { sessions.push(JSON.parse(await fs.readFile(dir + "\\" + f, "utf8"))); } catch {}
      }
    } catch {}
    if (kind === "claude" && sessions.length) {
      const r = await ps("alive", ["-Pids", sessions.map(s => s.pid).join(",")]);
      const alive = new Set(r.stdout.split(/\r?\n/).map(Number));
      out.live.claude = sessions.filter(s => alive.has(Number(s.pid)));
    }
    if (kind !== "codex") return out;
    const r = await ps("codex", []);
    for (const line of r.stdout.split(/\r?\n/)) { const [file, cwd] = line.split("\t"); if (file) out.live.codex.push({ file, cwd }); }
    return out;
  }
  async claudeTranscript(s) {
    const root = this.base + "\\.claude\\projects";
    const direct = `${root}\\${s.cwd.replace(/[^A-Za-z0-9]/g, "-")}\\${s.sessionId}.jsonl`;
    if (await fs.exists(direct)) return direct;
    try { for (const d of await fs.readdir(root)) { const f = `${root}\\${d}\\${s.sessionId}.jsonl`; if (await fs.exists(f)) return f; } } catch {}
    return null;
  }
  async chunk(file, offset) {
    const r = await ps("chunk", ["-File", file, "-Offset", String(offset), "-Max", String(CHUNK)]);
    if (r.code !== 0) throw new Error("Cannot read the session file.");
    const [size, next] = r.stdout.split("\n", 2).map(Number);
    const text = r.stdout.split("\n").slice(2).join("\n");
    return { size, next, text };
  }
  // Through PowerShell: mods may only read under the home folder, so fs.exists rejects other drives
  // and \\wsl.localhost paths ("outside every granted read root", seen 2026-11-11).
  async exists(paths, cwd) {
    const out = new Map();
    const ok = paths.filter(p => p && !p.startsWith("-")); // a leading "-" would read as a parameter
    for (let i = 0; i < ok.length; i += 40) {
      const batch = ok.slice(i, i + 40);
      const r = await ps("exists", ["-Cwd", cwd ?? "", ...batch]);
      const lines = r.stdout.split(/\r?\n/);
      batch.forEach((p, j) => {
        const [k, path] = (lines[j] ?? "").split("\t");
        if (k === "d" || k === "f") out.set(p, { path, isDir: k === "d", windows: path });
      });
    }
    return out;
  }
}

export function machineFor(space, platform) {
  if (!space?.machine && platform === "windows") return new Windows();
  return new Posix(space?.machine ?? null);
}

// ---------- one reader per terminal ----------

const sameDir = (a, b) => a && b && keyOf(normalize(a)) === keyOf(normalize(b));
function newest(list, date) { return list.slice().sort((a, b) => date(b) - date(a))[0]; }

export class Reader {
  constructor(machine, kind, terminal, cwd) {
    Object.assign(this, { machine, kind, terminal, cwd });
    this.file = null; this.offset = 0; this.seq = 0; this.paths = new Map(); this.state = { base: cwd }; this.exact = false;
    this.polls = 0; this.where = null;
  }
  async locate() {
    const found = await this.machine.find(this.terminal, this.kind);
    if (this.kind === "claude") {
      const date = x => x.statusUpdatedAt ?? x.updatedAt ?? x.startedAt ?? 0;
      let s = newest(found.exact.claude, date), exact = Boolean(s);
      if (!s) s = newest(found.live.claude.filter(x => sameDir(x.cwd, this.cwd)), date);
      if (!s) return null;
      const file = await this.machine.claudeTranscript(s);
      return file && { file, exact };
    }
    if (found.exact.codex.length) return { file: found.exact.codex.map(x => x.file).sort().pop(), exact: true };
    const c = found.live.codex.filter(x => sameDir(x.cwd, this.cwd)).sort((a, b) => a.file < b.file ? 1 : -1)[0];
    return c && { file: c.file, exact: false };
  }
  async refresh() {
    // Finding the session costs a process scan; redo it every 4th refresh (a /clear starts a new one).
    const where = this.where && this.polls++ % 4 ? this.where : (this.where = await this.locate());
    if (!where) return { state: "empty", message: this.kind === "claude" ? "No Claude Code session found for this terminal." : "No Codex session found for this terminal." };
    if (where.file !== this.file) { this.file = where.file; this.offset = 0; this.paths = new Map(); this.state = { base: this.cwd }; }
    this.exact = where.exact;
    for (let i = 0; i < CHUNKS_PER_POLL; i++) {
      const c = await this.machine.chunk(this.file, this.offset);
      if (c.size < this.offset) { this.offset = 0; this.paths = new Map(); continue; } // rewritten
      if (!c.text) break;
      await this.ingest(c.text);
      this.offset = c.next;
      if (this.offset >= c.size) break;
    }
    await this.recheck();
    const items = [...this.paths.values()].sort((a, b) => b.seq - a.seq);
    return { state: "ready", exact: this.exact, file: this.file, paths: items };
  }
  // A Write is logged before it runs, and files get deleted: re-check entries marked missing.
  async recheck() {
    const missing = [...this.paths.values()].filter(p => !p.exists).slice(0, 40);
    if (!missing.length) return;
    const hits = await this.machine.exists(missing.map(p => p.raw), this.cwd);
    for (const p of missing) { const h = hits.get(p.raw); if (h) Object.assign(p, { exists: true, isDir: h.isDir, windows: h.windows }); }
  }
  async ingest(text) {
    const parse = this.kind === "claude" ? claudeRecord : codexRecord;
    const found = []; // [raw, base, origin, mustExist, seq]
    for (const line of text.split("\n")) {
      if (!line) continue;
      let rec; try { rec = JSON.parse(line); } catch { continue; }
      for (const [raw, base, origin, mustExist] of parse(rec, this.state)) found.push([raw, base, origin, mustExist, ++this.seq]);
    }
    // Group by base folder so each machine call resolves relative paths against the right one.
    const byBase = new Map();
    for (const f of found) {
      const p = absolute(f[0], f[1]);
      if (!p) continue;
      f[0] = p;
      if (!byBase.has(f[1] ?? "")) byBase.set(f[1] ?? "", new Set());
      byBase.get(f[1] ?? "").add(p);
    }
    const resolved = new Map();
    for (const [base, set] of byBase) for (const [k, v] of await this.machine.exists([...set], base)) resolved.set(base + "\0" + k, v);
    for (const [p, base, origin, mustExist, seq] of found) {
      const hit = resolved.get((base ?? "") + "\0" + p);
      if (!hit && mustExist) continue;
      const path = hit?.path ?? p, key = keyOf(path);
      const prev = this.paths.get(key);
      const origins = new Set(prev?.origins ?? []); origins.add(origin);
      this.paths.set(key, { raw: path, windows: hit?.windows ?? prev?.windows ?? null, isDir: hit?.isDir ?? prev?.isDir ?? false, exists: Boolean(hit), origins: [...origins].sort(), seq });
    }
    if (this.paths.size > MAX_PATHS) {
      const keep = [...this.paths.entries()].sort((a, b) => b[1].seq - a[1].seq).slice(0, MAX_PATHS);
      this.paths = new Map(keep);
    }
  }
}
