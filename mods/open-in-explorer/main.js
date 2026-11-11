import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { spaces, panes, focused, props, exec, theme, appHome, closeOverlay } from "herdr";

// Each script prints "d" or "f", then the path. Exit 4 = bad path, 5 = missing.
// UNIX: a local macOS/Linux terminal. WSL: a WSL machine seen from a Windows desktop (path converted to a Windows one).
const UNIX = '[ -z "$1" ] || cd "$1" 2>/dev/null || exit 3; case "$2" in "~"*) set -- "$1" "$HOME${2#\\~}";; esac; case "$2" in /*) p="$2";; *) [ -n "$1" ] || exit 7; p="$1/$2";; esac; [ -e "$p" ] || exit 5; if [ -d "$p" ]; then echo d; else echo f; fi; printf "%s\\n" "$p"';
const WSL = '[ -z "$1" ] || cd "$1" 2>/dev/null || exit 3; case "$2" in [A-Za-z]:*) set -- "$1" "$(wslpath -u "$2")";; "~"*) set -- "$1" "$HOME${2#\\~}";; esac; ' +
  'case "$2" in /*) ;; *) [ -n "$1" ] || exit 7;; esac; p=$(realpath -m -- "$2") || exit 4; [ -e "$p" ] || exit 5; w=$(wslpath -w "$p") || exit 6; if [ -d "$p" ]; then echo d; else echo f; fi; printf "%s\\n" "$w"';

export default class OpenInExplorer extends View {
  init(_p, cx) {
    this.notice = ""; this.busy = false;
    this.path = InputState.new({ placeholder: "File or folder path (relative to the focused terminal)" });
    this.path.on("submit", (_e, cx) => this.open(this.path.value(), cx));
  }
  context() {
    const space = spaces().find(s => s.active), f = focused(), all = panes();
    // `focused()` can name a pane whose terminal id differs from the pane list's, so fall back to the pane flagged focused.
    const pane = all.find(p => p.terminal && p.terminal === f?.terminal) ?? all.find(p => p.focused);
    return { machine: space?.machine ?? null, cwd: pane?.cwd ?? "" };
  }
  // Desktop that owns the window: Windows has no `uname`, so a failed start means Windows.
  async platform() {
    if (!this.os) {
      try { const r = await exec("uname", ["-s"], { timeout: 4000 }); this.os = r.stdout.trim() === "Darwin" ? "mac" : "linux"; }
      catch { this.os = "windows"; }
    }
    return this.os;
  }
  async resolve(raw, { machine, cwd }, os) {
    let r;
    if (os === "windows" && !machine) {
      r = await exec("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", appHome() + "/mods/open-in-explorer/resolve.ps1", "-Path", raw, "-Cwd", cwd], { timeout: 6000 });
    } else if (os === "windows") {
      r = await exec("sh", ["-c", WSL, "sh", cwd, raw], { on: machine, timeout: 6000 });
    } else if (machine) {
      throw new Error("Remote machines are not supported: their files are not on this desktop.");
    } else {
      r = await exec("sh", ["-c", UNIX, "sh", cwd, raw], { timeout: 6000 });
    }
    if (r.code === 7) throw new Error("No terminal folder is known: enter an absolute path.");
    if (r.code === 5) throw new Error("Path does not exist.");
    if (r.code !== 0) throw new Error("Path cannot be resolved.");
    const [kind, path] = r.stdout.split(/\r?\n/);
    if (!path) throw new Error("Path cannot be resolved.");
    return { isDir: kind === "d", path };
  }
  reveal(found, os) {
    if (os === "windows") return exec("explorer.exe", found.isDir ? [found.path] : ["/select,", found.path], { timeout: 10000 }); // exit 1 is normal
    if (os === "mac") return exec("open", found.isDir ? [found.path] : ["-R", found.path], { timeout: 10000 });
    return exec("xdg-open", [found.isDir ? found.path : found.path.replace(/\/[^/]*$/, "") || "/"], { timeout: 10000 });
  }
  open(raw, cx) {
    const ctx = this.context();
    if (this.busy || !String(raw).trim()) return;
    this.busy = true; this.notice = "Opening…"; cx.notify();
    cx.spawn(async cx => {
      try {
        const os = await this.platform();
        const found = await this.resolve(raw, ctx, os);
        // Local on purpose: the file manager belongs to this desktop, not the machine the terminal runs on.
        const r = await this.reveal(found, os);
        // Only explorer.exe reports 1 on success; for open/xdg-open any non-zero code is a failure.
        if (r.code !== 0 && !(os === "windows" && r.code === 1)) throw new Error(r.stderr.trim() || `File manager exited ${r.code}`);
        const id = props()?.overlay; if (id) closeOverlay(id);
      } catch (e) { this.notice = String(e.message ?? e); }
      finally { this.busy = false; cx.notify(); }
    });
  }
  render(cx) {
    const t = theme(), ctx = this.context();
    const button = (id, label, fn) => div().id(id).px(10).py(6).rounded(5).bg(t.raised).hover(s => s.bg(t.hover)).cursor_pointer().on_click(fn).child(label);
    return v_flex().size_full().p(14).gap(10).bg(t.surface).text_color(t.foreground).text_size(12)
      .child(h_flex().gap(8).items_center()
        .child(svg("mods/open-in-explorer/folder.svg").size(16).flex_none().text_color(t.accent))
        .child(div().font_semibold().child("Open in Explorer")))
      .child(div().text_size(11).text_color(t.muted).truncate().child(ctx.cwd || "No focused terminal folder: use absolute paths"))
      .child(Input.new(this.path).h(32).px(8).rounded(5).border_1().border_color(t.border).bg(t.background))
      .child(h_flex().gap(6)
        .child(button("open", "Open path", (_e, cx) => this.open(this.path.value(), cx)))
        .child(button("project", "Terminal folder", (_e, cx) => ctx.cwd ? this.open(ctx.cwd, cx) : (this.notice = "No focused terminal folder.", cx.notify()))))
      .when(Boolean(this.notice), el => el.child(div().text_size(11).text_color(t.muted).child(this.notice)));
  }
}
