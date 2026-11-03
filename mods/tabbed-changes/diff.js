// The diff tab. One file (VS Code's diff editor) or every changed file stacked in one scrolling
// view (Zed's multibuffer), inline or side by side. Read-only; double-click a line to open the file there in Neovim.
import { div } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, v_virtual_list, InputState, VirtualListScrollHandle } from "gpui-base";
import { props, spaces, panes, focused, shared, setShared, exec, readTextFile, watchFolder, theme, settings } from "herdr";
import { InlineComments, lineComments, inlineHeight } from "./comments.js";
import { contextForRow, rangeContext, isOutdated, selectionForRows } from "./comment-model.js";
import { resolveOrigin, comparisonArgs } from "./comparison.js";
import { diffFlags,wordChanges,changedTargets,searchRows,stepTarget,fileTree,commentPlacement } from "./review-model.js";
import { Coalescer, Memo } from "./read-cache.js";
import { readGit, invalidateReads, invalidateRepository, REPOSITORY_EVENT } from "./repository.js";
import * as G from "./git.js";
import { VIEW_KEY, openInEditor, openFileTab, showDiff } from "./tabs.js";
import { reviewToolbar,searchBar,fileNavigator } from "./review-controls.js";
import { iconButton, toolButton, icon, codeLine, fileIcon } from "./ui.js";

const LAYOUT_KEY = "tabbed-changes.layout"; // "inline" | "split", shared so every diff tab agrees
const ROW = 20, FILE_ROW = 32, MAX_ROWS = 8000, MAX_UNTRACKED = 40;

export class DiffTab {
  init(cx) {
    const p = props() ?? {};
    this.pinned = Boolean(p.pinned);
    this.space = p.space ?? spaces().find((s) => s.active)?.id;
    this.pinnedView = p.view ?? null; this.comparisonOverride=null; this.comparisonResolved=null;
    this.startLayout = p.layout ?? null; // "split" | "inline": this tab starts in that layout
    this.collapsed = new Set(); this.display = []; this.sizes = []; this.files = []; this.clicks = 1;
    this.handle=cx.focus_handle(); this.anchor=null; this.selection=null; this.shift=false; this.refs={old:[],new:[]};
    this.selectedRow = null; this.commentSide = "new"; this.thread = cx.new(InlineComments);
    this.refreshQueue=new Coalescer();this.dataStamp=null;
    this.contextLines=3;this.ignoreWhitespace=false;this.wordHighlight=true;this.wordCache=new Memo(256);this.wordPairs=new Map();
    this.commentPosition={inset:0,width:600};this.viewportWidth=600;this.horizontalVersion=0;
    this.scroll=VirtualListScrollHandle.new();this.cursor=-1;this.changeIndices=[];this.matches=[];this.searchQuery="";this.searchOpen=false;this.matchCursor=-1;
    this.showFiles=true;this.folderCollapsed=new Set();this.fileQuery="";this.treeNodes=[];
    this.searchInput=InputState.new({placeholder:"Find in diff…"});
    this.searchInput.on("change",(_e,cx)=>{this.searchQuery=this.searchInput.value();if(this.searchQuery.trim()&&this.collapsed.size){this.collapsed.clear();this.build();}this.matches=searchRows(this.display,this.searchQuery);this.matchSet=new Set(this.matches);this.matchCursor=-1;cx.notify();});
    this.searchInput.on("submit",(e,cx)=>this.moveMatch(e.shift?-1:1,cx));
    this.fileInput=InputState.new({placeholder:"Filter files…"});
    this.fileInput.on("change",(_e,cx)=>{this.fileQuery=this.fileInput.value();this.treeNodes=fileTree(this.files,this.fileQuery,this.folderCollapsed);cx.notify();});
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
  get comparison() { return this.comparisonOverride ?? this.base?.comparison ?? "local"; }
  scopeSig(){return JSON.stringify([this.comparison,this.base?.source,this.mode,this.file?.group,this.file?.path,this.at]);}
  sig(){return JSON.stringify([this.contextLines??3,this.ignoreWhitespace??false,this.scopeSig()]);}

  // --- loading ----------------------------------------------------------------------------------
  watch(root, cx) {
    if (this.base?.source?.on || this.watched === root) return;
    this.watched = root;
    cx.spawn(async (cx) => {
      try { while (this.watched === root) { await watchFolder(root); if (this.watched === root) this.requestRefresh(cx); } }
      catch { this.watched = null; }
    });
  }

  requestRefresh(cx) {
    this.refreshQueue.request(fn=>cx.timer.after(150,fn),cx=>{invalidateReads();this.load(cx,true);});
  }

  load(cx, quiet = false) {
    const view = this.base;
    if (!view?.source?.root) return;
    if (this.inflight) { this.again = true; return; }
    if(!this.pinned && this.requestAt!==this.at){
      this.requestAt=this.at;this.modeOverride=null;this.fileOverride=null;this.comparisonOverride=null;this.collapsed.clear();
    }
    const sig = this.sig(),scope=this.scopeSig();
    if (!quiet || sig !== this.loadedSig) { this.loadedSig = sig; this.error = null; }
    if (sig !== this.shownSig) {
      this.pendingSelection=scope===this.shownScope?(this.selection??this.pendingSelection):null;
      this.pendingAnchor=scope===this.shownScope?(this.anchor??this.pendingAnchor):null;
      this.dataStamp=null;this.display = []; this.baseSizes=[];this.changeIndices=[];this.matches=[];this.matchSet=new Set();this.treeNodes=[];this.sizes = []; this.files = []; this.selectedRow = null; this.selection=null; this.anchor=null; this.comparisonResolved=null; this.loading = true; }
    this.inflight = true;
    const { root, on } = view.source, mode = this.mode, file = this.file, comparison=this.comparison,options=this.diffOptions();
    this.watch(root, cx);
    cx.spawn(async (cx) => {
      let changed=this.loading;
      try {
        const git = async (args) => {
          const r = await readGit({root,on},args);
          if (r.code !== 0) throw new Error(G.tidy(r.stderr) || `git ${args[0]} failed`);
          return r.stdout;
        };
        const remote=comparison!=="local" ? await resolveOrigin(git,comparison) : null;
        const files = mode === "all" ? await this.loadAll(git, root, on,remote,options) : await this.loadOne(git, root, on, file,remote,options);
        if (this.sig() !== sig) return;
        const stamp=JSON.stringify([sig,remote,files]);
        if(stamp!==this.dataStamp || this.error){
          this.dataStamp=stamp;this.comparisonResolved=remote;this.files=files;this.shownSig=sig;this.shownScope=scope;this.error=null;this.build();changed=true;
        }
      } catch (e) { if (this.sig() === sig){const message=String(e?.message??e);changed=changed||this.error!==message;this.error=message;} }
      finally {
        this.inflight = false; this.loading = false;
        if (this.again) { this.again = false; this.load(cx, true); }
        if(changed)cx.notify();
      }
    });
  }

  async loadOne(git, root, on, f,remote=null,options=this.diffOptions()) {
    if (!f) return [];
    if (f.fresh) {
      const text = await readTextFile(`${root}/${f.path}`, { on: on ?? null }).catch(() => null);
      if (text === null) return [{ path: f.path, lines: ["Cannot preview this file (binary, too large, or unreadable)"], add: 0, del: 0 }];
      if (text.includes("\0")) return [{ path: f.path, lines: ["Binary file · no text diff"], add: 0, del: 0 }];
      const lines = G.freshLines(text);
      return [{ path: f.path, lines, add: G.countLines(text), del: 0, fresh: true }];
    }
    const out = await git(remote?comparisonArgs(remote.sha,f.path,options):["diff", ...(f.group === "staged" ? ["--cached"] : f.group === "head" ? ["HEAD"] : []), "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames", ...diffFlags(options), "--", f.path]);
    const [one] = G.splitPatch(out);
    if (!one) return [{ path: f.path, lines: ["No text diff available"], add: 0, del: 0 }];
    if (!one.lines.length) one.lines = [one.binary ? "Binary file changed" : "No text diff available"];
    return [one];
  }

  async loadAll(git, root, on,remote=null,options=this.diffOptions()) {
    const base = ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames",...diffFlags(options)];
    let head = true;
    try { await git(["rev-parse", "--verify", "HEAD"]); } catch { head = false; }
    const patch = remote ? await git(comparisonArgs(remote.sha,undefined,options)) : head ? await git([...base, "HEAD"]) : (await git([...base, "--cached"])) + (await git(base));
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
    const restoring=Boolean(this.pendingSelection);
    const selectedContext=this.pendingSelection??(this.selectedRow?this.selection:null);
    this.anchor=this.pendingAnchor??this.anchor;this.pendingSelection=null;this.pendingAnchor=null;
    const split = this.layout === "split", all = this.mode === "all", out = [];
    this.wordPairs=new Map();
    let widest = 0;
    this.truncated = false;
    for (const f of this.files) {
      const closed = all && this.collapsed.has(f.path);
      if (all) out.push({ kind: "file", path: f.path, add: f.add, del: f.del, closed });
      if (closed) continue;
      let rows = G.diffRows(f.lines);
      for (const r of rows) widest = Math.max(widest, r.text.length);
      const paired=G.pairRows(rows);
      for(const pair of paired)if(pair.l?.change && pair.r?.change){
        const value={old:pair.l.text,next:pair.r.text};
        this.wordPairs.set(JSON.stringify([f.path,"old",pair.l.n]),value);this.wordPairs.set(JSON.stringify([f.path,"new",pair.r.n]),value);
      }
      if (split) rows = paired;
      for (const r of rows) {
        if (out.length >= MAX_ROWS) { this.truncated = true; break; }
        out.push({ ...r, path: f.path, oldContextUnavailable:Boolean(this.ignoreWhitespace), ...(this.comparisonResolved?{baseRevision:this.comparisonResolved.sha,baseLabel:this.comparisonResolved.name}:{}) });
      }
      if (this.truncated) break;
    }
    this.display = out;this.baseSizes=out.map(r=>r.kind==="file"?FILE_ROW:ROW);
    this.changeIndices=changedTargets(out);this.matches=searchRows(out,this.searchQuery??"");this.matchSet=new Set(this.matches);
    this.treeNodes=fileTree(this.files,this.fileQuery??"",this.folderCollapsed??new Set());
    this.cursor=Math.min(this.cursor??-1,out.length-1);
    this.refs={old:out.map(r=>contextForRow(r,this.base?.source,"old")).filter(Boolean),new:out.map(r=>contextForRow(r,this.base?.source,"new")).filter(Boolean)};
    if(selectedContext){
      this.selection=selectionForRows(out,selectedContext,this.base?.source,this.commentSide);
      this.selectedRow=this.selection ? out.find(r=>{
        const c=contextForRow(r,this.base?.source,this.commentSide);
        return c && c.path===this.selection.path && c.side===this.selection.side && c.line===(this.selection.endLine??this.selection.line);
      }) ?? null : null;
      if(this.selectedRow){this.updateThread(false);if(restoring)this.scroll?.scroll_to_item(out.indexOf(this.selectedRow),"center");}
    } else this.selectedRow=null;
    this.resizeRows();
    this.diffWidth = Math.max(400, widest * 7.4 + 130);
  }

  diffOptions(){return {context:this.contextLines??3,ignoreWhitespace:this.ignoreWhitespace??false};}
  setDiffOption(name,value,cx){this[name]=value;this.load(cx);cx.notify();}
  highlights(path,line,side) {
    if(!this.wordHighlight)return [];
    const pair=this.wordPairs.get(JSON.stringify([path,side,line]));if(!pair)return [];
    const changes=this.wordCache.get(JSON.stringify([pair.old,pair.next]),()=>wordChanges(pair.old,pair.next));
    return side==="old"?changes.old:changes.next;
  }
  jump(index,cx) {
    if(index===null||!this.display[index])return;
    this.cursor=index;this.navFile=this.display[index].path;this.scroll.scroll_to_item(index,"top");cx.notify();
  }
  moveChange(direction,cx){this.jump(stepTarget(this.changeIndices,this.cursor,direction),cx);}
  moveMatch(direction,cx){const index=stepTarget(this.matches,this.matchCursor,direction);if(index!==null){this.matchCursor=index;this.jump(index,cx);}}
  openSearch(cx){this.searchOpen=true;this.searchInput.focus();cx.notify();}
  navigateFile(key,cx) {
    const node=this.treeNodes.find(n=>`${n.kind}:${n.path}`===key);if(!node)return;
    if(node.kind==="folder"){
      this.folderCollapsed.has(node.path)?this.folderCollapsed.delete(node.path):this.folderCollapsed.add(node.path);
      this.treeNodes=fileTree(this.files,this.fileQuery,this.folderCollapsed);cx.notify();return;
    }
    if(this.collapsed.delete(node.path))this.build();
    this.jump(this.display.findIndex(r=>r.kind==="file"&&r.path===node.path),cx);
  }

  setComparison(comparison,cx) {
    this.comparisonOverride=comparison; this.modeOverride="all"; this.fileOverride=null;
    this.collapsed.clear();this.load(cx);cx.notify();
  }
  fetchOrigin(cx) {
    if(this.fetching || !this.base?.source)return;
    const source={...this.base.source};this.fetching=true;this.fetchError=null;cx.notify();
    cx.spawn(async cx=>{
      try {
        const result=await exec("git",["fetch","--no-tags","origin"],{cwd:source.root,on:source.on??null});
        if(result.code!==0)throw new Error(G.tidy(result.stderr||result.stdout)||"Fetch origin failed");
        invalidateRepository(source);
        if(this.base?.source?.root===source.root && (this.base.source.on??null)===(source.on??null))this.load(cx);
      } catch(e){this.fetchError=String(e.message??e);}
      finally{this.fetching=false;cx.notify();}
    });
  }
  comparisonBar(t) {
    const remote=this.comparison!=="local";
    return h_flex().h(30).flex_none().px(12).gap(6).items_center()
      .child(div().text_size(11).text_color(t.dim).child("Compare:"))
      .child(toolButton("compare-local","files","Local",t,cx=>this.setComparison("local",cx),{active:!remote}))
      .child(toolButton("compare-main","branch","origin/main",t,cx=>this.setComparison("origin/main",cx),{active:this.comparisonResolved?.name==="origin/main"}))
      .child(toolButton("compare-master","branch","origin/master",t,cx=>this.setComparison("origin/master",cx),{active:this.comparisonResolved?.name==="origin/master"}))
      .child(div().flex_1())
      .child(toolButton("compare-fetch","refresh",this.fetching?"Fetching…":"Fetch origin",t,cx=>this.fetchOrigin(cx)));
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
    const row = this.display[i];this.cursor=i;if(row)this.navFile=row.path;
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
    this.horizontalVersion++;this.commentPosition={inset:0,width:Math.min(600,this.viewportWidth)};
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
  close() { this.watched=null;this.refreshQueue.cancel();this.thread.release();this.scroll.release();this.searchInput.release();this.fileInput.release(); }
  resizeRows() {
    const height=this.selectedRow?inlineHeight(this.selection):0;
    if(this.sizedDisplay===this.display && this.sizedRow===this.selectedRow && this.sizedHeight===height)return;
    this.sizedDisplay=this.display;this.sizedRow=this.selectedRow;this.sizedHeight=height;
    const base=this.baseSizes??this.display.map(r=>r.kind==="file"?FILE_ROW:ROW);
    this.sizes=this.selectedRow?base.map((size,i)=>size+(this.display[i]===this.selectedRow?height:0)):base;
  }
  notesForRow(row) { return lineComments(contextForRow(row,this.base?.source,this.commentSide)); }
  commentBar(t) {
    return h_flex().h(30).px(12).gap(8).items_center().flex_none()
      .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(this.ignoreWhitespace?"Original context comments require showing spaces · ⌘⇧I":"Shift-click for range · ⌘⇧I comment"))
      .when(this.layout === "split", e => e
        .child(toolButton("comment-old", "minus", "Old side", t, cx => this.setCommentSide("old",cx), {active:this.commentSide === "old"}))
        .child(toolButton("comment-new", "plus", "New side", t, cx => this.setCommentSide("new",cx), {active:this.commentSide === "new"})));
  }
  setCommentSide(side,cx) {
    this.commentSide=side; this.selectedRow=null; this.anchor=null; this.selection=null; this.resizeRows(); cx.notify();
  }
  rowWithComments(row,t,split,index) {
    return v_flex().w_full().flex_none().when(this.matchSet?.has(index),e=>e.border_l(3).border_color(t.ansi3)).child(split?this.splitRow(row,t):this.inlineRow(row,t))
      .when(this.selectedRow===row,e=>e.child(h_flex().w_full().child(div().w(this.commentPosition.inset).flex_none()).child(div().w(this.commentPosition.width).flex_none().child(this.thread))));
  }

  fileFor(path) {
    const known = this.base?.file;
    return known?.path === path ? known : { path, group: "changes", fresh: this.files.find((f) => f.path === path)?.fresh };
  }

  // --- drawing ----------------------------------------------------------------------------------
  // A line of code with syntax colours; `tint` keeps added/removed text readable on its stronger background.
  code(text,path,t,spans=[],tone=t.accent) { return codeLine(text,path,t,spans,tone); }

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
      .child(this.code(r.text, r.path, t,this.highlights(r.path,del?r.old:r.next,del?"old":"new"),tone));
  }

  half(cell, t, color, path, side) {
    return h_flex().flex_1().min_w(0).h(ROW)
      .when(Boolean(cell?.change), (e) => e.bg(color + "40")).when(!cell, (e) => e.bg(t.raised + "88"))
      .when(cell && this.selection && path===this.selection.path && side===this.selection.side && cell.n>=this.selection.line && cell.n<=(this.selection.endLine??this.selection.line),e=>e.bg(t.selected))
      .child(div().w(40).flex_none().text_right().pr(8).text_color(cell?.change ? color : t.dim).when(Boolean(cell?.change), (e) => e.bg(color + "55").font_semibold()).child(cell ? String(cell.n) : ""))
      .child(this.badge(cell?contextForRow({kind:"c",path,l:side==="old"?cell:null,r:side==="new"?cell:null,baseRevision:this.comparisonResolved?.sha,baseLabel:this.comparisonResolved?.name,oldContextUnavailable:Boolean(this.ignoreWhitespace)},this.base.source,side):null,t))
      .child(cell ? this.code(cell.text,path,t,this.highlights(path,cell.n,side),color) : div().flex_1());
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
    const what = this.comparison!=="local" ? `Working tree against ${this.comparisonResolved?.name??this.comparison} · last fetched reference` : all ? "Working tree against HEAD" : f?.fresh ? "New file" : f?.group === "staged" ? "Index against HEAD" : f?.group === "head" ? "Working tree against HEAD" : "Working tree against index";
    return h_flex().h(22).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border).text_size(11).text_color(t.dim)
      .child(div().flex_none().child(what))
      .child(div().flex_1().min_w(0).truncate().child(this.base?.source?.root ?? ""))
      .child(div().flex_none().child(this.error ? "" : this.loading ? "Loading…" : "Double-click a line: open in Neovim"));
  }

  render(cx) {
    const t = theme(),event=shared(REPOSITORY_EVENT);
    if(event && event.root===this.base?.source?.root && (event.on??null)===(this.base?.source?.on??null) && event.version!==this.repositoryVersion){this.repositoryVersion=event.version;invalidateReads();this.load(cx,true);}
    if (this.base?.source?.root && (this.sig() !== this.loadedSig)) this.load(cx);
    const shell = (children) => v_flex().id("scm-diff").track_focus(this.handle)
      .on_key_down((e,cx)=>{
        if(e.keystroke==="cmd-shift-i"){cx.stop_propagation();this.openComment(cx);}
        else if(e.keystroke==="cmd-f"){cx.stop_propagation();this.openSearch(cx);}
        else if(e.keystroke==="alt-down"||e.keystroke==="alt-up"){cx.stop_propagation();this.moveChange(e.keystroke==="alt-down"?1:-1,cx);}
      }).size_full().min_h(0).overflow_hidden().bg(t.background).text_color(t.foreground).text_size(13).children(children);
    if (!this.base) return shell([div().p(16).text_color(t.dim).child("Pick a changed file in the Changes panel.")]);
    const split = this.layout === "split";
    this.resizeRows();
    const list = v_virtual_list("scm-diff-rows", this.display.length, this.sizes, (i) => String(i),
      (range) => this.display.slice(range.start, range.end).map((r, k) => this.rowWithComments(r,t,split,range.start+k)))
      .on_item_click((key, cx) => this.rowClicked(Number(key), cx)).track_scroll(this.scroll).size_full();
    const contentWidth=split?Math.max(760,this.diffWidth*2):this.diffWidth;
    const body=div().flex_1().min_w(0).min_h(0).relative()
      .on_size_change((size,cx)=>{if(this.viewportWidth!==size.width){this.viewportWidth=size.width;this.commentPosition.width=Math.min(600,size.width);if(this.selectedRow)cx.notify();}})
      .on_mouse_down("left",e=>{this.commentPosition=commentPlacement(this.contentLeft??0,e.bounds?.x??0,this.contentWidth??this.viewportWidth,this.viewportWidth);})
      .font_family(settings().font_family??"JetBrains Mono").text_size(12)
      .child(div().id(`scm-diff-x-${this.horizontalVersion}`).size_full().overflow_x_scrollbar().child(div().w_full().min_w(contentWidth).h_full()
        .on_size_change(size=>{this.contentWidth=size.width;})
        .on_mouse_down("left",e=>{
          this.contentLeft=e.bounds?.x??0;this.clicks=e.click_count??1;this.shift=Boolean(e.modifiers?.shift);
          this.clickedSide=e.local_position&&this.contentWidth?(e.local_position.x<this.contentWidth/2?"old":"new"):null;
        }).child(list)))
      .child(Scrollbar.vertical("scm-diff-rows").viewport_from_layout().absolute().inset_0());
    return shell([
      this.header(t, cx),this.comparisonBar(t),reviewToolbar(this,t),this.commentBar(t),this.footer(t),
      this.searchOpen?searchBar(this,t):null,
      this.fetchError ? div().px(12).py(6).text_size(12).text_color(t.ansi1).child(this.fetchError) : null,
      this.error ? div().px(12).py(8).text_size(12).text_color(t.ansi1).child(this.error) : null,
      !this.display.length && !this.loading && !this.error ? div().p(16).text_color(t.dim).child(this.mode==="all"?"No changes for this comparison":"No changes in this file") : h_flex().flex_1().min_h(0).child(this.mode==="all"&&this.showFiles?fileNavigator(this,t):div().w(0)).child(body),
      this.truncated ? div().px(12).py(4).border_t(1).border_color(t.border).text_size(11).text_color(t.dim).child(`Showing the first ${MAX_ROWS.toLocaleString()} lines`) : null,
    ].filter(Boolean));
  }
}
