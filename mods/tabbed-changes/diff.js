// The diff tab. One file (VS Code's diff editor) or every changed file stacked in one scrolling
// view (Zed's multibuffer), inline or side by side. Read-only; double-click a line to open the file there in Neovim.
import { div } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, v_virtual_list } from "gpui-base";
import { props, spaces, panes, focused, shared, setShared, exec, readTextFile, watchFolder, theme, settings } from "herdr";
import { InlineComments, lineComments, inlineHeight } from "./comments.js";
import { contextForRow, rangeContext, isOutdated, selectionForRows } from "./comment-model.js";
import * as G from "./git.js";
import { VIEW_KEY, openInEditor, openFileTab, showDiff } from "./tabs.js";
import { iconButton, toolButton, icon, codeLine, fileIcon } from "./ui.js";

const LAYOUT_KEY = "tabbed-changes.layout"; // "inline" | "split", shared so every diff tab agrees
const ROW = 20, FILE_ROW = 32, MAX_ROWS = 8000, MAX_UNTRACKED = 40;

export class DiffTab {
  init(cx) {
    const p = props() ?? {};
    this.pinned = Boolean(p.pinned);
    this.space = p.space ?? spaces().find((s) => s.active)?.id;
    this.pinnedView = p.view ?? null;
    this.startLayout = p.layout ?? null; // "split" | "inline": this tab starts in that layout
    this.collapsed = new Set(); this.display = []; this.sizes = []; this.files = []; this.clicks = 1;
    this.handle=cx.focus_handle(); this.anchor=null; this.selection=null; this.shift=false; this.refs={old:[],new:[]};
    this.selectedRow = null; this.commentSide = "new"; this.thread = cx.new(InlineComments);
    this.diffWidth = 400; this.truncated = false;
    cx.timer.every(10000, (cx) => this.load(cx, true));
    this.claim();
  }

  // If showDiff could not tell which tab it made, the preview tab (the one now focused) says so itself.
  claim() {
    if (this.pinned || !this.space) return;
    const entry = shared(VIEW_KEY)?.[this.space];
    if (!entry || entry.tab) return;
    const f = focused(), pane = f?.pane ? panes().find((x) => x.pane === f.pane) : null;
    if (pane?.mod === "tabbed-changes") setShared(VIEW_KEY, { ...shared(VIEW_KEY), [this.space]: { ...entry, tab: pane.tab } });
  }

  // --- what to show -----------------------------------------------------------------------------
  get base() { return this.pinned ? this.pinnedView : shared(VIEW_KEY)?.[this.space]?.view ?? null; }
  get at() { return this.pinned ? 0 : shared(VIEW_KEY)?.[this.space]?.at ?? 0; }
  get mode() { return this.modeOverride ?? this.base?.mode ?? "file"; }
  get file() { return this.fileOverride ?? this.base?.file ?? null; }
  get layout() { return (this.startLayout ?? shared(LAYOUT_KEY)) === "split" ? "split" : "inline"; }
  sig() { return JSON.stringify([this.base?.source, this.mode, this.file?.group, this.file?.path, this.at]); }

  // --- loading ----------------------------------------------------------------------------------
  watch(root, cx) {
    if (this.base?.source?.on || this.watched === root) return;
    this.watched = root;
    cx.spawn(async (cx) => {
      try { while (this.watched === root) { await watchFolder(root); if (this.watched === root) this.load(cx, true); } }
      catch { this.watched = null; }
    });
  }

  load(cx, quiet = false) {
    const view = this.base;
    if (!view?.source?.root) return;
    if (this.inflight) { this.again = true; return; }
    const sig = this.sig();
    if (!quiet || sig !== this.loadedSig) { this.loadedSig = sig; this.error = null; }
    if (sig !== this.shownSig) { this.display = []; this.sizes = []; this.files = []; this.selectedRow = null; this.selection=null; this.anchor=null; this.loading = true; }
    this.inflight = true;
    const { root, on } = view.source, mode = this.mode, file = this.file;
    this.watch(root, cx);
    cx.spawn(async (cx) => {
      try {
        const git = async (args) => {
          const r = await exec("git", [...G.READ, ...args], { cwd: root, on: on ?? null });
          if (r.code !== 0) throw new Error(G.tidy(r.stderr) || `git ${args[0]} failed`);
          return r.stdout;
        };
        const files = mode === "all" ? await this.loadAll(git, root, on) : await this.loadOne(git, root, on, file);
        if (this.sig() !== sig) return;
        this.files = files; this.shownSig = sig; this.error = null;
        this.build();
      } catch (e) { if (this.sig() === sig) this.error = String(e?.message ?? e); }
      finally {
        this.inflight = false; this.loading = false;
        if (this.again) { this.again = false; this.load(cx, true); }
        cx.notify();
      }
    });
  }

  async loadOne(git, root, on, f) {
    if (!f) return [];
    if (f.fresh) {
      const text = await readTextFile(`${root}/${f.path}`, { on: on ?? null }).catch(() => null);
      if (text === null) return [{ path: f.path, lines: ["Cannot preview this file (binary, too large, or unreadable)"], add: 0, del: 0 }];
      if (text.includes("\0")) return [{ path: f.path, lines: ["Binary file · no text diff"], add: 0, del: 0 }];
      const lines = G.freshLines(text);
      return [{ path: f.path, lines, add: G.countLines(text), del: 0, fresh: true }];
    }
    const out = await git(["diff", ...(f.group === "staged" ? ["--cached"] : f.group === "head" ? ["HEAD"] : []), "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames", "--", f.path]);
    const [one] = G.splitPatch(out);
    if (!one) return [{ path: f.path, lines: ["No text diff available"], add: 0, del: 0 }];
    if (!one.lines.length) one.lines = [one.binary ? "Binary file changed" : "No text diff available"];
    return [one];
  }

  async loadAll(git, root, on) {
    const base = ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames"];
    let head = true;
    try { await git(["rev-parse", "--verify", "HEAD"]); } catch { head = false; }
    const patch = head ? await git([...base, "HEAD"]) : (await git([...base, "--cached"])) + (await git(base));
    const files = G.splitPatch(patch);
    const seen = new Set(files.map((f) => f.path)), merged = [];
    for (const f of files) { if (!f.lines.length) f.lines = [f.binary ? "Binary file changed" : "No text diff available"]; merged.push(f); }
    const fresh = (await git(["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean);
    for (const path of fresh.slice(0, MAX_UNTRACKED)) {
      if (seen.has(path)) continue;
      const text = await readTextFile(`${root}/${path}`, { on: on ?? null }).catch(() => null);
      if (text === null || text.includes("\0")) { merged.push({ path, lines: ["Binary or unreadable file"], add: 0, del: 0, fresh: true }); continue; }
      merged.push({ path, lines: G.freshLines(text, 400), add: G.countLines(text), del: 0, fresh: true });
    }
    merged.sort((a, b) => a.path.localeCompare(b.path));
    this.moreUntracked = Math.max(0, fresh.length - MAX_UNTRACKED);
    return merged;
  }

  // Flattens the files into the rows the list draws (inline rows, or paired rows when split).
  build() {
    const selectedContext = this.selectedRow ? this.selection : null;
    const split = this.layout === "split", all = this.mode === "all", out = [];
    let widest = 0;
    this.truncated = false;
    for (const f of this.files) {
      const closed = all && this.collapsed.has(f.path);
      if (all) out.push({ kind: "file", path: f.path, add: f.add, del: f.del, closed });
      if (closed) continue;
      let rows = G.diffRows(f.lines);
      for (const r of rows) widest = Math.max(widest, r.text.length);
      if (split) rows = G.pairRows(rows);
      for (const r of rows) {
        if (out.length >= MAX_ROWS) { this.truncated = true; break; }
        out.push({ ...r, path: f.path });
      }
      if (this.truncated) break;
    }
    this.display = out;
    this.refs={old:out.map(r=>contextForRow(r,this.base?.source,"old")).filter(Boolean),new:out.map(r=>contextForRow(r,this.base?.source,"new")).filter(Boolean)};
    if(selectedContext){
      this.selection=selectionForRows(out,selectedContext,this.base?.source,this.commentSide);
      this.selectedRow=this.selection ? out.find(r=>{
        const c=contextForRow(r,this.base?.source,this.commentSide);
        return c && c.path===this.selection.path && c.side===this.selection.side && c.line===(this.selection.endLine??this.selection.line);
      }) ?? null : null;
      if(this.selectedRow)this.updateThread(false);
    } else this.selectedRow=null;
    this.resizeRows();
    this.diffWidth = Math.max(400, widest * 7.4 + 130);
  }

  // --- actions ----------------------------------------------------------------------------------
  setLayout(layout, cx) { this.startLayout = null; setShared(LAYOUT_KEY, layout); this.build(); cx.notify(); }

  setMode(mode, cx, file) {
    this.modeOverride = mode;
    if (file) this.fileOverride = file;
    this.load(cx); cx.notify();
  }

  // A file to act on: the one shown, else the clicked row's.
  abs(path) { return `${this.base.source.root}/${path}`; }
  lineOf(row) { return row.line ?? row.next ?? row.old ?? 1; }

  rowClicked(i, cx) {
    const row = this.display[i];
    if (!row) return;
    const double = this.clicks >= 2;
    const previousSide = this.commentSide;
    if (this.layout === "split" && this.clickedSide) this.commentSide=this.clickedSide;
    if (!double && contextForRow(row,this.base?.source,this.commentSide)) {
      this.handle.focus();
      const end=contextForRow(row,this.base.source,this.commentSide);
      if(!this.shift && this.selectedRow===row && previousSide===this.commentSide){this.selectedRow=null;this.resizeRows();cx.notify();return;}
      if(!this.shift || !this.anchor)this.anchor=end;
      this.selection=rangeContext(this.anchor,end,this.references());
      if(!this.selection){this.anchor=end;this.selection=end;}
      this.selectedRow=this.display.find(r=>{
        const c=contextForRow(r,this.base.source,this.commentSide);
        return c && c.path===this.selection.path && c.side===this.selection.side && c.line===(this.selection.endLine??this.selection.line);
      }) ?? row;
      this.updateThread(false);this.resizeRows();cx.notify();
    }
    if (row.kind === "file") {
      if (double) this.setMode("file", cx, this.fileFor(row.path));
      else { this.collapsed.has(row.path) ? this.collapsed.delete(row.path) : this.collapsed.add(row.path); this.build(); cx.notify(); }
      return;
    }
    if (double && row.kind !== "@" && row.path) openInEditor(cx, this.base.source, this.abs(row.path), this.lineOf(row));
  }

  references() { return this.refs[this.commentSide] ?? []; }
  updateThread(focus) { this.thread.set_props({context:this.selection,references:this.references(),space:this.space,focus}); }
  openComment(cx) {
    this.selection=selectionForRows(this.display,this.selection,this.base?.source,this.commentSide);
    if(!this.selection){
      const row=this.display.find(r=>contextForRow(r,this.base?.source,this.commentSide));
      if(!row)return;this.selection=contextForRow(row,this.base.source,this.commentSide);this.selectedRow=row;
    } else {
      this.selectedRow=this.display.find(r=>{const c=contextForRow(r,this.base?.source,this.commentSide);return c && c.path===this.selection.path && c.line===(this.selection.endLine??this.selection.line) && c.side===this.selection.side;}) ?? null;
    }
    if(this.selectedRow){this.updateThread(true);this.resizeRows();cx.notify();}
  }
  badge(context,t) {
    if(!context)return div().w(22).flex_none();
    const notes=lineComments(context), stale=notes.some(n=>isOutdated(n,this.refs[context.side]??[]));
    return div().w(22).flex_none().text_color(stale?t.ansi3:t.accent).child(notes.length?`●${notes.length}`:"+");
  }
  close() { this.thread.release(); }
  resizeRows() {
    this.sizes=this.display.map(r=> (r.kind==="file"?FILE_ROW:ROW) + (this.selectedRow===r?inlineHeight(this.selection):0));
  }
  notesForRow(row) { return lineComments(contextForRow(row,this.base?.source,this.commentSide)); }
  commentBar(t) {
    return h_flex().h(30).px(12).gap(8).items_center().flex_none()
      .child(div().flex_1().text_size(11).text_color(t.dim).child("Shift-click for range · ⌘⇧I comment"))
      .when(this.layout === "split", e => e
        .child(toolButton("comment-old", "minus", "Old side", t, cx => this.setCommentSide("old",cx), {active:this.commentSide === "old"}))
        .child(toolButton("comment-new", "plus", "New side", t, cx => this.setCommentSide("new",cx), {active:this.commentSide === "new"})));
  }
  setCommentSide(side,cx) {
    this.commentSide=side; this.selectedRow=null; this.anchor=null; this.selection=null; this.resizeRows(); cx.notify();
  }
  rowWithComments(row,t,split) {
    return v_flex().w_full().flex_none().child(split?this.splitRow(row,t):this.inlineRow(row,t))
      .when(this.selectedRow===row,e=>e.child(this.thread));
  }

  fileFor(path) {
    const known = this.base?.file;
    return known?.path === path ? known : { path, group: "changes", fresh: this.files.find((f) => f.path === path)?.fresh };
  }

  // --- drawing ----------------------------------------------------------------------------------
  // A line of code with syntax colours; `tint` keeps added/removed text readable on its stronger background.
  code(text, path, t) { return codeLine(text, path, t); }

  inlineRow(r, t) {
    if (r.kind === "file") return this.fileRow(r, t);
    if (r.kind === "@") return div().w_full().px(12).h(ROW).flex_none().truncate().bg(t.accent + "1c").text_color(t.accent).child(r.text);
    const add = r.kind === "+", del = r.kind === "-", tone = add ? t.ansi2 : t.ansi1;
    return h_flex().w_full().h(ROW).flex_none()
      .when(this.selection && r.path===this.selection.path && (r.next??r.old)>=this.selection.line && (r.next??r.old)<=(this.selection.endLine??this.selection.line),e=>e.bg(t.selected))
      .when(add || del, (e) => e.bg(tone + "40"))
      .child(div().w(40).flex_none().text_right().pr(6).text_color(del ? t.ansi1 : t.dim).when(del, (e) => e.bg(tone + "55").font_semibold()).child(r.old === undefined ? "" : String(r.old)))
      .child(div().w(40).flex_none().text_right().pr(6).text_color(add ? t.ansi2 : t.dim).when(add, (e) => e.bg(tone + "55").font_semibold()).child(r.next === undefined ? "" : String(r.next)))
      .child(div().w(18).flex_none().text_center().font_bold().text_color(tone).child(add ? "+" : del ? "−" : ""))
      .child(this.badge(contextForRow(r,this.base?.source,this.commentSide),t))
      .child(this.code(r.text, r.path, t));
  }

  half(cell, t, color, path, side) {
    return h_flex().flex_1().min_w(0).h(ROW)
      .when(Boolean(cell?.change), (e) => e.bg(color + "40")).when(!cell, (e) => e.bg(t.raised + "88"))
      .when(cell && this.selection && path===this.selection.path && side===this.selection.side && cell.n>=this.selection.line && cell.n<=(this.selection.endLine??this.selection.line),e=>e.bg(t.selected))
      .child(div().w(40).flex_none().text_right().pr(8).text_color(cell?.change ? color : t.dim).when(Boolean(cell?.change), (e) => e.bg(color + "55").font_semibold()).child(cell ? String(cell.n) : ""))
      .child(this.badge(cell?{source:this.base.source,path,line:cell.n,side,code:cell.text}:null,t))
      .child(cell ? this.code(cell.text, path, t) : div().flex_1());
  }

  splitRow(r, t) {
    if (r.kind === "file") return this.fileRow(r, t);
    if (r.kind === "@") return div().w_full().px(12).h(ROW).flex_none().truncate().bg(t.accent + "1c").text_color(t.accent).child(r.text);
    return h_flex().w_full().h(ROW).flex_none().child(this.half(r.l, t, t.ansi1, r.path,"old")).child(div().w(1).h_full().flex_none().bg(t.border)).child(this.half(r.r, t, t.ansi2, r.path,"new"));
  }

  fileRow(r, t) {
    const name = G.basename(r.path), dir = r.path.includes("/") ? r.path.slice(0, r.path.lastIndexOf("/")) : "";
    return h_flex().w_full().h(FILE_ROW).flex_none().px(10).gap(8).items_center().bg(t.raised).border_t(1).border_b(1).border_color(t.border)
      .child(icon(r.closed ? "chevron-right" : "chevron-down", 14).text_color(t.muted))
      .child(fileIcon(r.path, 16))
      .child(div().flex_none().text_size(14).font_bold().text_color(t.foreground).child(name))
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(dir))
      .when(r.add > 0, (e) => e.child(div().flex_none().text_size(12).font_bold().text_color(t.ansi2).child(`+${r.add}`)))
      .when(r.del > 0, (e) => e.child(div().flex_none().text_size(12).font_bold().text_color(t.ansi1).child(`−${r.del}`)));
  }

  header(t, cx) {
    const view = this.base, all = this.mode === "all", f = this.file;
    const add = this.files.reduce((n, x) => n + x.add, 0), del = this.files.reduce((n, x) => n + x.del, 0);
    const title = all ? "All changes" : G.basename(f?.path ?? "");
    const sub = all ? `${this.files.length} file${this.files.length === 1 ? "" : "s"}` : f?.path?.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : "";
    return h_flex().h(44).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
      .child(all ? icon("layers", 16).text_color(t.muted) : fileIcon(f?.path ?? "", 18))
      .child(div().font_bold().text_size(15).flex_none().text_color(t.foreground).child(title))
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(sub))
      .when(add > 0, (e) => e.child(div().text_size(12).font_bold().flex_none().text_color(t.ansi2).child(`+${add}`)))
      .when(del > 0, (e) => e.child(div().text_size(12).font_bold().flex_none().text_color(t.ansi1).child(`−${del}`)))
      .child(h_flex().flex_none().gap(2)
        .child(iconButton("lay-inline", "rows", t, (cx) => this.setLayout("inline", cx), { active: this.layout === "inline", title: "Inline" }))
        .child(iconButton("lay-split", "columns", t, (cx) => this.setLayout("split", cx), { active: this.layout === "split", title: "Side by side" })))
      .child(toolButton("mode", all ? "file-open" : "layers", all ? "Single file" : "All changes", t, (cx) => this.setMode(all ? "file" : "all", cx, all ? (f ?? this.firstFile()) : undefined)))
      .when(!all && Boolean(f), (e) => e
        .child(toolButton("open-file", "file-open", "Open file", t, () => openFileTab(view.source, this.abs(f.path))))
        .child(toolButton("open-nvim", "terminal", "Neovim", t, () => openInEditor(cx, view.source, this.abs(f.path), 1))));
  }

  firstFile() { const p = this.files[0]?.path; return p ? this.fileFor(p) : null; }

  footer(t) {
    const f = this.file, all = this.mode === "all";
    const what = all ? "Working tree against HEAD" : f?.fresh ? "New file" : f?.group === "staged" ? "Index against HEAD" : f?.group === "head" ? "Working tree against HEAD" : "Working tree against index";
    return h_flex().h(22).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border).text_size(11).text_color(t.dim)
      .child(div().flex_none().child(what))
      .child(div().flex_1().min_w(0).truncate().child(this.base?.source?.root ?? ""))
      .child(div().flex_none().child(this.error ? "" : this.loading ? "Loading…" : "Double-click a line: open in Neovim"));
  }

  render(cx) {
    const t = theme();
    if (this.base?.source?.root && (this.sig() !== this.loadedSig)) this.load(cx);
    const shell = (children) => v_flex().id("scm-diff").track_focus(this.handle)
      .on_key_down((e,cx)=>{if(e.keystroke==="cmd-shift-i"){cx.stop_propagation();this.openComment(cx);}}).size_full().min_h(0).overflow_hidden().bg(t.background).text_color(t.foreground).text_size(13).children(children);
    if (!this.base) return shell([div().p(16).text_color(t.dim).child("Pick a changed file in the Changes panel.")]);
    const split = this.layout === "split";
    this.resizeRows();
    const list = v_virtual_list("scm-diff-rows", this.display.length, this.sizes, (i) => String(i),
      (range) => this.display.slice(range.start, range.end).map((r, k) => this.rowWithComments(r,t,split)))
      .on_item_click((key, cx) => this.rowClicked(Number(key), cx)).size_full();
    const body = div().flex_1().min_h(0).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(12)
      .on_size_change((size) => { this.bodyWidth = size.width; })
      .on_mouse_down("left", (e) => {
        this.clicks = e.click_count ?? 1; this.shift=Boolean(e.modifiers?.shift);
        this.clickedSide = e.local_position && this.bodyWidth ? (e.local_position.x < this.bodyWidth/2 ? "old" : "new") : null;
      })
      .child(split
        ? div().size_full().child(list)
        : div().id("scm-diff-x").size_full().overflow_x_scrollbar().child(div().w_full().min_w(this.diffWidth).h_full().child(list)))
      .child(Scrollbar.vertical("scm-diff-rows").viewport_from_layout().absolute().inset_0());
    return shell([
      this.header(t, cx), this.commentBar(t), this.footer(t),
      this.error ? div().px(12).py(8).text_size(12).text_color(t.ansi1).child(this.error) : null,
      !this.display.length && !this.loading && !this.error ? div().p(16).text_color(t.dim).child("No changes in this file") : body,
      this.truncated ? div().px(12).py(4).border_t(1).border_color(t.border).text_size(11).text_color(t.dim).child(`Showing the first ${MAX_ROWS.toLocaleString()} lines`) : null,
    ].filter(Boolean));
  }
}
