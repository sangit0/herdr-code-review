// A read-only file in a tab of its own. The whole file with VS Code-style git
// markers in the gutter (green added, blue modified, red deleted-here) and a tint on changed lines.
import { div } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, v_virtual_list } from "gpui-base";
import { props, exec, readTextFile, theme, settings } from "herdr";
import { InlineComments, lineComments, inlineHeight } from "./comments.js";
import * as G from "./git.js";
import { toolButton, codeLine, fileIcon } from "./ui.js";
import { openInEditor, showDiff } from "./tabs.js";

const ROW = 20, MAX_LINES = 20000;

export class FileTab {
  init(cx) {
    const p = props() ?? {};
    this.file = typeof p.file === "string" ? p.file : null;
    this.source = { root: p.root ?? null, on: p.on ?? null };
    this.line = p.line ?? null; this.selected = null;
    this.thread = cx.new(InlineComments);
    this.ready = false; this.lines = []; this.marks = {}; this.deletedBefore = new Set(); this.changed = 0;
    this.loading = Boolean(this.file);
    this.error = this.file ? null : "No file was provided";
    if (this.file) this.load(cx);
  }

  rel() { const r = this.source.root; return r && this.file.startsWith(`${r}/`) ? this.file.slice(r.length + 1) : null; }

  // The file's text, then its changes against HEAD (an untracked file is all added).
  load(cx) {
    const file = this.file, on = this.source.on, rel = this.rel();
    cx.spawn(async (cx) => {
      try {
        const text = await readTextFile(file, { on });
        if (text === null) { this.error = "This file is no longer available"; return; }
        if (text.includes("\0")) { this.error = "Binary file · no text preview"; return; }
        const shown = text.length > 400000 ? text.slice(0, 400000) + "\n… (file truncated)" : text;
        this.lines = shown.replace(/\n$/, "").split("\n").slice(0, MAX_LINES);
        if (rel) await this.loadMarks(rel, on, this.lines.length);
        this.ready = true;
      } catch (e) { this.error = String(e); }
      finally { this.loading = false; cx.notify(); }
    });
  }

  async loadMarks(rel, on, total) {
    const root = this.source.root, git = (args) => exec("git", [...G.READ, ...args], { cwd: root, on });
    try {
      const status = await git(["status", "--porcelain=v1", "-z", "--", rel]);
      if (status.code !== 0) return;
      if (status.stdout.startsWith("??")) { for (let i = 1; i <= total; i++) this.marks[i] = "add"; }
      else {
        const diff = await git(["diff", "HEAD", "-U0", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "--", rel]);
        if (diff.code === 0) Object.assign(this, G.lineMarks(diff.stdout));
      }
      this.changed = Object.keys(this.marks).length;
    } catch { /* no git here: the file still shows */ }
  }

  row(i, t) {
    const n = i + 1, mark = this.marks[n], tone = mark === "add" ? t.ansi2 : mark === "mod" ? t.ansi4 : null;
    const up = this.deletedBefore.has(n), below = n === this.lines.length && this.deletedBefore.has(n + 1);
    return h_flex().w_full().h(ROW).flex_none().relative()
      .when(this.selected === i, e => e.bg(t.selected))
      .when(Boolean(tone), (e) => e.bg(tone + "26"))
      .child(div().w(4).h_full().flex_none().when(Boolean(tone), (e) => e.bg(tone)))
      .child(div().w(48).flex_none().text_right().pr(10).text_color(tone ?? t.dim).when(Boolean(tone), (e) => e.font_semibold()).whitespace_nowrap().child(String(n)))
      .child(div().w(18).flex_none().text_color(t.accent).child("+"))
      .child(codeLine(this.lines[i] || " ", this.file, t))
      .when(up, (e) => e.child(div().absolute().top(0).left(0).w_full().h(2).bg(t.ansi1)))
      .when(below, (e) => e.child(div().absolute().bottom(0).left(0).w_full().h(2).bg(t.ansi1)));
  }

  context(i) {
    const path = this.rel();
    return path && i !== null ? {source:this.source,path,line:i+1,side:"new",code:this.lines[i]} : null;
  }
  selectLine(i, cx) {
    if (i === this.selected) { this.selected = null; cx.notify(); return; }
    this.selected = i; this.line = i + 1;
    this.thread.set_props({context:this.context(i)}); cx.notify();
  }
  close() { this.thread.release(); }

  changesView(t) {
    const width = Math.max(400, Math.max(...this.lines.map((l) => l.length), 0) * 7.4 + 90);
    const list = v_virtual_list("scm-file-rows", this.lines.length, this.lines.map((_l,i)=>ROW+(this.selected===i?inlineHeight(this.context(i)):lineComments(this.context(i)).length?22:0)), (i) => String(i),
      (range) => { const out = []; for (let i = range.start; i < range.end; i++) out.push(v_flex().w_full().flex_none().child(this.row(i, t))
        .when(this.selected===i,e=>e.child(this.thread))
        .when(this.selected!==i && lineComments(this.context(i)).length>0,e=>e.child(div().h(22).px(54).text_color(t.accent).child(`${lineComments(this.context(i)).length} comment(s) · click line to view`)))); return out; }).on_item_click((key, cx) => { this.selectLine(Number(key), cx); }).size_full();
    return div().flex_1().min_h(0).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(13)
      .child(div().id("scm-file-x").size_full().overflow_x_scrollbar().child(div().w_full().min_w(width).h_full().child(list)))
      .child(Scrollbar.vertical("scm-file-rows").viewport_from_layout().absolute().inset_0());
  }

  render(cx) {
    const t = theme(), has = this.changed > 0 || this.deletedBefore.size > 0, rel = this.rel();
    const name = G.basename(this.file ?? "File");
    return v_flex().id("scm-file").size_full().min_h(0).overflow_hidden().bg(t.background).text_color(t.foreground)
      .child(h_flex().h(44).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
        .child(fileIcon(this.file ?? "", 18))
        .child(div().font_bold().text_size(15).flex_none().child(name))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(rel && rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : this.file ?? ""))
        .when(this.changed > 0, (e) => e.child(div().flex_none().text_size(12).font_bold().text_color(t.ansi2).child(`${this.changed} changed line${this.changed === 1 ? "" : "s"}`)))
        .when(has && Boolean(rel), (e) => e.child(toolButton("open-diff", "columns", "Diff", t, () => showDiff({ source: this.source, mode: "file", file: { group: "head", path: rel } }))))
        .when(Boolean(this.file), (e) => e.child(toolButton("open-editor", "terminal", "Neovim", t, () => openInEditor(cx, this.source, this.file, this.line)))))
      .when(!this.ready, (e) => e.child(div().flex_1().p(14).text_color(t.dim).child(this.error || (this.loading ? "Loading file…" : "File unavailable"))))
      .when(this.ready, (e) => e.child(this.changesView(t)));
  }
}
