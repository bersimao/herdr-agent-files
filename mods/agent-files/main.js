import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { spaces, panes, focused, exec, run, theme, props, closeOverlay, window as appWindow } from "herdr";
import { machineFor, Reader } from "./backend.js";

const NAME = "agent-files";
const POLL_MS = 3000;
const basename = p => p.replace(/[\\/]$/, "").split(/[\\/]/).pop() || p;
const kindOf = p => {
  const s = `${p.app ?? ""} ${p.program?.key ?? ""} ${p.program?.name ?? ""}`;
  return /codex/i.test(s) ? "codex" : /claude/i.test(s) ? "claude" : /gemini/i.test(s) ? "gemini" : null;
};

export default class AgentFiles extends View {
  init(_p, cx) {
    // Opened with mod.open (the key): act as a launcher. Close this tab's panel if it is open,
    // else split one beside the focused pane, then close the invisible overlay.
    const overlay = props()?.overlay;
    if (overlay) {
      this.launcher = true;
      const tab = focused()?.tab, open = panes().filter(p => p.mod === NAME && p.tab === tab);
      if (open.length) for (const p of open) run("pane.close", { pane: p.pane });
      else run("pane.split", { direction: "right", mod: NAME, props: { terminal: focused()?.terminal ?? null } });
      closeOverlay(overlay);
      return;
    }
    this.selected = {}; this.lastAgent = {}; this.readers = new Map();
    const from = props()?.terminal, sp = spaces().find(s => s.active);
    if (from && sp) this.lastAgent[sp.id] = from; // the terminal the key was pressed in this.data = null; this.error = ""; this.notice = "";
    this.busy = false; this.opening = false; this.context = ""; this.lastRead = 0;
    this.filter = InputState.new({ placeholder: "Filter paths…" });
    this.filter.on("change", (_e, cx) => cx.notify());
    this.path = InputState.new({ placeholder: "Or enter a file or folder path…" });
    this.path.on("submit", (_e, cx) => this.openRaw(this.path.value(), cx));
    this.tab = focused()?.tab; this.pane = null; this.ticks = 0;
    cx.timer.every(250, cx => { if (!this.pane || ++this.ticks % 3 === 0) this.tick(cx); });
    this.refresh(cx, true);
  }
  // The new pane is not in panes() during init; on the first tick it is, and it has the focus.
  tick(cx) {
    if (!this.pane) {
      const f = focused(), mine = panes().filter(p => p.mod === NAME && p.tab === this.tab);
      if (!mine.length) return;
      this.pane = mine.find(p => p.pane === f?.pane)?.pane ?? mine[0].pane;
      // Hand the keyboard back to the terminal the panel describes.
      const target = this.source().target;
      if (target && f?.pane === this.pane) run("pane.focus", { terminal: target.terminal });
    }
    this.refresh(cx);
  }
  myPane() { return panes().find(p => p.pane === this.pane) ?? panes().find(p => p.mod === NAME && p.tab === this.tab); }
  source() {
    const space = spaces().find(s => s.active);
    const tabs = new Set(space?.tabs?.map(t => t.id) ?? []);
    const all = panes().filter(p => p.terminal && tabs.has(p.tab) && kindOf(p));
    const here = all.filter(p => p.tab === this.tab), list = here.length ? here : all;
    // Clicking this panel moves focus off the terminal (focused().terminal is null for a mod pane),
    // so the last agent terminal that had focus is remembered and kept.
    const f = focused(), sid = space?.id;
    if (f?.terminal && list.some(p => p.terminal === f.terminal)) this.lastAgent[sid] = f.terminal;
    const pick = t => t && list.find(p => p.terminal === t);
    const target = pick(this.selected[sid]) ?? pick(this.lastAgent[sid]) ?? list[0];
    return { space, list, target, kind: target && kindOf(target), cwd: target?.cwd ?? null,
      key: JSON.stringify([space?.id, target?.terminal, target?.cwd]) };
  }
  reader(src) {
    let r = this.readers.get(src.key);
    if (!r) {
      const platform = appWindow().platform;
      r = new Reader(machineFor(src.space, platform), src.kind, src.target.terminal.split("/").pop(), src.cwd);
      this.readers.clear(); // one reader at a time: the old ones' paths are not shown any more
      this.readers.set(src.key, r);
    }
    return r;
  }
  refresh(cx, force = false) {
    if (!force && focused()?.tab !== this.tab) return; // another tab is shown: don't poll
    const src = this.source();
    if (this.context !== src.key) { this.context = src.key; this.data = null; this.error = ""; this.notice = ""; this.lastRead = 0; cx.notify(); }
    if (this.busy || !src.target || (!force && Date.now() - this.lastRead < POLL_MS)) return;
    if (src.kind === "gemini") { this.error = "Gemini CLI sessions are not supported yet."; cx.notify(); return; }
    this.busy = true; this.lastRead = Date.now();
    cx.spawn(async cx => {
      try {
        const data = await this.reader(src).refresh();
        if (this.source().key !== src.key) return;
        this.data = data; this.error = ""; cx.notify();
      } catch (e) {
        if (this.source().key === src.key) { this.data = null; this.error = String(e.message ?? e); cx.notify(); }
      } finally { this.busy = false; }
    });
  }
  // The file manager is on this desktop; the path may live on another machine.
  async reveal(item, src) {
    const platform = appWindow().platform, remote = Boolean(src.space?.machine);
    if (platform === "windows") {
      const w = item.windows ?? (!remote ? item.raw : null);
      if (!w) throw new Error("This machine's files are not reachable from this desktop.");
      const r = await exec("explorer.exe", item.isDir ? [w] : ["/select,", w], { timeout: 10000 });
      if (r.code !== 0 && r.code !== 1) throw new Error(r.stderr.trim() || `Explorer exited ${r.code}`); // 1 is normal for explorer.exe
      return;
    }
    if (remote) throw new Error("This machine's files are not reachable from this desktop.");
    const r = platform === "macos"
      ? await exec("open", item.isDir ? [item.raw] : ["-R", item.raw], { timeout: 10000 })
      : await exec("xdg-open", [item.isDir ? item.raw : item.raw.replace(/\/[^/]*$/, "") || "/"], { timeout: 10000 });
    if (r.code !== 0) throw new Error(r.stderr.trim() || `File manager exited ${r.code}`);
  }
  canReveal(item, src) {
    const remote = Boolean(src.space?.machine);
    return appWindow().platform === "windows" ? Boolean(item.windows || !remote) : !remote;
  }
  run(cx, fn) {
    if (this.opening) return;
    this.opening = true; this.notice = "Opening…"; cx.notify();
    cx.spawn(async cx => {
      try { await fn(); this.notice = ""; }
      catch (e) { this.notice = String(e.message ?? e); }
      finally { this.opening = false; cx.notify(); }
    });
  }
  openItem(item, cx) { const src = this.source(); this.run(cx, () => this.reveal(item, src)); }
  openRaw(raw, cx) {
    const src = this.source();
    if (!String(raw).trim()) return;
    this.run(cx, async () => {
      const machine = machineFor(src.space, appWindow().platform);
      const hit = (await machine.exists([String(raw).trim()], src.cwd)).values().next().value;
      if (!hit) throw new Error("Path does not exist.");
      await this.reveal({ raw: hit.path, windows: hit.windows, isDir: hit.isDir }, src);
    });
  }
  render(cx) {
    if (this.launcher) return div();
    const t = theme(), src = this.source(), data = this.context === src.key ? this.data : null;
    const q = this.filter.value().trim().toLowerCase();
    const paths = (data?.paths ?? []).filter(p => p.raw.toLowerCase().includes(q));
    const button = (id, label, fn) => div().id(id).px(8).py(5).rounded(5).bg(t.raised).hover(s => s.bg(t.hover)).cursor_pointer().on_click(fn).child(label);
    const note = (text, color = t.muted) => div().p(6).text_color(color).child(text);
    const list = v_flex().gap(6).p(10);
    if (!src.target) list.child(note("No Claude Code or Codex terminal in this space."));
    else if (this.error) list.child(note(this.error, t.ansi1));
    else if (!data) list.child(note("Reading the session…"));
    else if (data.state === "empty") list.child(note(data.message));
    else if (!paths.length) list.child(note(q ? "No matching paths." : "No paths yet. Files the agent reads, edits, writes or mentions appear here."));
    else for (const item of paths) list.child(v_flex().p(9).gap(5).rounded(7).bg(t.raised)
      .child(h_flex().gap(8).items_center()
        .child(svg(`mods/${NAME}/folder.svg`).size(15).flex_none().text_color(t.accent))
        .child(div().flex_1().min_w(0).truncate().font_semibold().tooltip(item.raw).child(basename(item.raw) + (item.isDir ? "/" : "")))
        .when(item.exists && this.canReveal(item, src), el => el.child(button(`open-${item.raw}`, item.isDir ? "Open" : "Reveal", (_e, cx) => this.openItem(item, cx)))))
      .child(div().text_size(10.5).text_color(t.muted).truncate().tooltip(item.raw).child(item.raw))
      .child(div().text_size(10).text_color(t.dim).child(item.origins.join(" · ") + (item.exists ? "" : " · missing"))));
    const where = src.target ? `${src.space?.name ?? ""} · ${src.target.terminal}${data?.state === "ready" && !data.exact ? " · matched by folder" : ""}` : (src.space?.name ?? "No space");
    return v_flex().size_full().min_h(0).bg(t.surface).text_color(t.foreground).text_size(12)
      .child(h_flex().h(42).flex_none().px(12).gap(6).items_center().border_b(1).border_color(t.border)
        .child(div().flex_1().font_semibold().child("Agent Files"))
        .child(button("refresh", "Refresh", (_e, cx) => this.refresh(cx, true)))
        .child(button("close", "×", () => { const p = this.myPane(); if (p) run("pane.close", { pane: p.pane }); })))
      .child(v_flex().p(10).gap(7).flex_none()
        .child(div().text_size(11).text_color(t.muted).truncate().child(where))
        .when(src.list.length > 1, el => el.child(h_flex().flex_wrap().gap(4).children(src.list.map(p =>
          button(`agent-${p.terminal}`, `${kindOf(p)} ${p.terminal.split("/").pop()}`, (_e, cx) => { this.selected[src.space.id] = p.terminal; this.refresh(cx, true); })))))
        .child(Input.new(this.filter).h(30).px(8).rounded(5).border_1().border_color(t.border).bg(t.background)))
      .child(div().flex_1().min_h(0).overflow_y_scrollbar().child(list))
      .child(v_flex().p(10).gap(8).flex_none().border_t(1).border_color(t.border)
        .child(Input.new(this.path).h(32).px(8).rounded(5).border_1().border_color(t.border).bg(t.background))
        .child(h_flex().gap(6)
          .child(button("manual-open", "Open path", (_e, cx) => this.openRaw(this.path.value(), cx)))
          .when(Boolean(src.cwd), el => el.child(button("project-folder", "Project folder", (_e, cx) => this.openRaw(src.cwd, cx)))))
        .when(Boolean(this.notice), el => el.child(div().text_size(11).child(this.notice))));
  }
}
