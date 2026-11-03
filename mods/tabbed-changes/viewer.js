// A read-only file in a tab of its own. The whole file with VS Code-style git
// markers in the gutter (green added, blue modified, red deleted-here) and a tint on changed lines.
import { div } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, v_virtual_list } from "gpui-base";
import { props, exec, readTextFile, theme, settings, watchFolder, shared } from "herdr";
import { InlineComments, lineComments, inlineHeight } from "./comments.js";
import { rangeContext, isOutdated } from "./comment-model.js";
import { Coalescer } from "./read-cache.js";
import { readGit, invalidateReads, REPOSITORY_EVENT } from "./repository.js";
import * as G from "./git.js";
import { toolButton, codeLine, fileIcon } from "./ui.js";
import { openInEditor, showDiff } from "./tabs.js";

const ROW = 20, MAX_LINES = 20000;

export class FileTab {
  init(cx) {
    const p = props() ?? {};
    this.file = typeof p.file === "string" ? p.file : null;
    this.source = { root: p.root ?? null, on: p.on ?? null };
    this.line = p.line ?? null; this.selected = null; this.anchor = null; this.selection = null; this.shift = false;
    this.handle=cx.focus_handle(); this.refreshQueue=new Coalescer(); this.referenceRows=[];this.fileWidth=400;this.rowSizes=ROW;this.metadataDirty=true;
    this.thread = cx.new(InlineComments);
    this.ready = false; this.lines = []; this.marks = {}; this.deletedBefore = new Set(); this.changed = 0;
    this.loading = Boolean(this.file);
    this.error = this.file ? null : "No file was provided";
    if (this.file) this.load(cx);
    this.watch(cx);
    cx.timer.every(10000,cx=>{this.metadataDirty=true;this.load(cx);});
  }

  rel() { const r = this.source.root; return r && this.file.startsWith(`${r}/`) ? this.file.slice(r.length + 1) : null; }

  watch(cx) {
    if(this.source.on || !this.source.root)return;
    this.watched=this.source.root;
    cx.spawn(async cx=>{try{while(this.watched){const paths=await watchFolder(this.watched);if(!this.watched)return;
      if(paths.some(p=>p===this.watched||p===this.file||p===`${this.watched}/.git`||p.startsWith(`${this.watched}/.git/`)))this.requestRefresh(cx);
    }}catch{this.watched=null;}});
  }
  requestRefresh(cx) {
    this.refreshQueue.request(fn=>cx.timer.after(150,fn),cx=>{invalidateReads();this.metadataDirty=true;this.load(cx);});
  }

  // The file's text, then its changes against HEAD (an untracked file is all added).
  load(cx) {
    if(!this.file)return;
    if(this.inflight){this.again=true;return;}
    this.inflight=true;
    const before=[this.loadedText,this.error,this.loading,this.ready,this.markStamp];
    const file = this.file, on = this.source.on, rel = this.rel();
    cx.spawn(async (cx) => {
      try {
        const text = await readTextFile(file, { on });
        if (text === null) { this.ready=false; this.error = "This file is no longer available"; return; }
        if(text===this.loadedText && !this.metadataDirty)return;
        const textChanged=text!==this.loadedText;this.loadedText=text;this.metadataDirty=false;
        if (text.includes("\0")) { this.ready=false; this.error = "Binary file · no text preview"; return; }
        const shown = text.length > 400000 ? text.slice(0, 400000) + "\n… (file truncated)" : text;
        if(textChanged){
          this.lines=shown.replace(/\n$/, "").split("\n").slice(0,MAX_LINES);
          const path=this.rel();this.referenceRows=path?this.lines.map((code,i)=>({source:this.source,path,line:i+1,side:"new",code})):[];
          this.fileWidth=Math.max(400,this.lines.reduce((n,line)=>Math.max(n,line.length),0)*7.4+90);this.sizesKey=null;
        }
        this.marks={}; this.deletedBefore=new Set(); this.changed=0;
        if (rel) await this.loadMarks(rel, on, this.lines.length);
        this.error=null; this.ready = true;
        if(this.selected!==null){
          this.selection=rangeContext(this.selection,{...this.selection,line:this.selection.endLine??this.selection.line},this.references()) ?? this.context(Math.min(this.selected,this.lines.length-1));
          this.selected=(this.selection.endLine??this.selection.line)-1;this.updateThread(false);
        }
      } catch (e) { this.error = String(e); }
      finally { this.inflight=false;this.loading=false;const after=[this.loadedText,this.error,this.loading,this.ready,this.markStamp];if(before.some((v,i)=>v!==after[i]))cx.notify();if(this.again){this.again=false;this.load(cx);} }
    });
  }

  async loadMarks(rel, on, total) {
    const root = this.source.root, git = (args) => readGit({root,on},args);
    try {
      const status = await git(["status", "--porcelain=v1", "-z", "--", rel]);
      if (status.code !== 0) return;
      if (status.stdout.startsWith("??")) { for (let i = 1; i <= total; i++) this.marks[i] = "add"; }
      else {
        const diff = await git(["diff", "HEAD", "-U0", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "--", rel]);
        if (diff.code === 0) Object.assign(this, G.lineMarks(diff.stdout));
      }
      this.changed = Object.keys(this.marks).length;this.markStamp=JSON.stringify([this.marks,[...this.deletedBefore]]);
    } catch { /* no git here: the file still shows */ }
  }

  row(i, t) {
    const n = i + 1, mark = this.marks[n], tone = mark === "add" ? t.ansi2 : mark === "mod" ? t.ansi4 : null;
    const notes=lineComments(this.context(i));
    const up = this.deletedBefore.has(n), below = n === this.lines.length && this.deletedBefore.has(n + 1);
    return h_flex().w_full().h(ROW).flex_none().relative()
      .when(this.selection && n>=this.selection.line && n<=(this.selection.endLine??this.selection.line), e => e.bg(t.selected))
      .when(Boolean(tone), (e) => e.bg(tone + "26"))
      .child(div().w(4).h_full().flex_none().when(Boolean(tone), (e) => e.bg(tone)))
      .child(div().w(48).flex_none().text_right().pr(10).text_color(tone ?? t.dim).when(Boolean(tone), (e) => e.font_semibold()).whitespace_nowrap().child(String(n)))
      .child(div().w(22).flex_none().text_color(notes.some(note=>isOutdated(note,this.references()))?t.ansi3:t.accent).child(notes.length?`●${notes.length}`:"+"))
      .child(codeLine(this.lines[i] || " ", this.file, t))
      .when(up, (e) => e.child(div().absolute().top(0).left(0).w_full().h(2).bg(t.ansi1)))
      .when(below, (e) => e.child(div().absolute().bottom(0).left(0).w_full().h(2).bg(t.ansi1)));
  }

  context(i) { return this.referenceRows[i]??null; }
  references() { return this.referenceRows; }
  updateSizes() {
    const height=this.selected===null?0:inlineHeight(this.selection),key=`${this.lines.length}:${this.selected}:${height}`;
    if(key===this.sizesKey)return;this.sizesKey=key;
    this.rowSizes=this.selected===null?ROW:this.lines.map((_l,i)=>ROW+(this.selected===i?height:0));
  }
  updateThread(focus) {
    this.thread.set_props({context:this.selection,references:this.references(),focus});
  }
  selectLine(i, cx) {
    this.handle.focus();
    if (!this.shift && i === this.selected) { this.selected=null; cx.notify(); return; }
    if(!this.shift || this.anchor===null)this.anchor=i;
    this.selection=rangeContext(this.context(this.anchor),this.context(i),this.references());
    if(!this.selection){this.anchor=i;this.selection=this.context(i);}
    this.selected=Math.max(this.anchor,i);this.line=i+1;
    this.updateThread(false);cx.notify();
  }
  openComment(cx) {
    if(!this.selection){this.anchor=Math.max(0,(this.line??1)-1);this.selection=this.context(this.anchor);}
    if(!this.selection)return;
    this.selected=(this.selection.endLine??this.selection.line)-1;
    this.updateThread(true);cx.notify();
  }
  close() { this.watched=null;this.refreshQueue.cancel();this.thread.release(); }

  changesView(t) {
    this.updateSizes();
    const width=this.fileWidth;
    const list = v_virtual_list("scm-file-rows", this.lines.length, this.rowSizes, (i) => String(i),
      (range) => { const out = []; for (let i = range.start; i < range.end; i++) out.push(v_flex().w_full().flex_none().child(this.row(i, t))
        .when(this.selected===i,e=>e.child(this.thread))
); return out; }).on_item_click((key, cx) => { this.selectLine(Number(key), cx); }).size_full();
    return div().flex_1().min_h(0).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(13)
      .child(div().id("scm-file-x").size_full().overflow_x_scrollbar().child(div().w_full().min_w(width).h_full().child(list)))
      .child(Scrollbar.vertical("scm-file-rows").viewport_from_layout().absolute().inset_0());
  }

  render(cx) {
    const event=shared(REPOSITORY_EVENT);
    if(event?.root===this.source.root && (event.on??null)===(this.source.on??null) && event.version!==this.repositoryVersion){this.repositoryVersion=event.version;this.requestRefresh(cx);}
    const t = theme(), has = this.changed > 0 || this.deletedBefore.size > 0, rel = this.rel();
    const name = G.basename(this.file ?? "File");
    return v_flex().id("scm-file").track_focus(this.handle)
      .on_mouse_down("left",e=>{this.shift=Boolean(e.modifiers?.shift);})
      .on_key_down((e,cx)=>{if(e.keystroke==="cmd-shift-i"){cx.stop_propagation();this.openComment(cx);}}).size_full().min_h(0).overflow_hidden().bg(t.background).text_color(t.foreground)
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
