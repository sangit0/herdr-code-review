// The diff tab. One file (VS Code's diff editor) or every changed file stacked in one scrolling
// view (Zed's multibuffer), inline or side by side, with line and range comments.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, v_virtual_list, InputState, VirtualListScrollHandle, h_resizable, resizable_panel } from "gpui-base";
import { props, spaces, panes, focused, shared, setShared, exec, readTextFile, watchFolder, theme, settings } from "herdr";
import { InlineComments, lineComments, INLINE_COMMENT_HEIGHT, CLOSE_THREAD_KEY } from "./comments.js";
import { contextForRow, rangeContext, isOutdated, selectionForRows, selectionCovers, lineLabel } from "./comment-model.js";
import { resolveReviewBase, comparisonArgs } from "./comparison.js";
import { diffFlags,wordChanges,changedTargets,searchRows,stepTarget,fileTree,commentPlacement,wrapBreaks,wrapColumns,hangFor } from "./review-model.js";
import { Coalescer, Memo } from "./read-cache.js";
import { readGit, invalidateReads, invalidateRepository, REPOSITORY_EVENT } from "./repository.js";
import * as G from "./git.js";
import { VIEW_KEY, openFileTab, showDiff, showHistory, diffPane, zoomDiff } from "./tabs.js";
import { reviewToolbar,searchBar,fileNavigator } from "./review-controls.js";
import { iconButton, toolButton, icon, codeLine, fileIcon, commentGutter, inCommentGutter, COMMENT_GUTTER, CODE_ROW as ROW } from "./ui.js";
import { openInEditor, editorLabel } from "./editor.js";
import { commitPatch } from "./history.js";
import { reviewAction } from "./shortcut-model.js";
import { shortcutFooter } from "./shortcuts.js";

const LAYOUT_KEY = "tabbed-changes.layout"; // "inline" | "split", shared so every diff tab agrees
const FILE_ROW = 32, MAX_ROWS = 8000, MAX_UNTRACKED = 40, FONT_SIZE = 12;
const INLINE_GUTTER_START = 98, SPLIT_GUTTER_START = 40, MATCH_BORDER = 3;
const selectedDiffRow = (row, t) => row.relative().bg(t.accent + "60")
  .child(div().absolute().top(0).bottom(0).left(0).w(4).bg(t.accent));

export class DiffTab {
  init(cx) {
    const p = props() ?? {};
    this.pinned = Boolean(p.pinned);
    this.space = p.space ?? spaces().find((s) => s.active)?.id;
    this.pinnedView = p.view ?? null; this.comparisonOverride=null; this.comparisonResolved=null;
    this.startLayout = p.layout ?? null; // "split" | "inline": this tab starts in that layout
    this.collapsed = new Set(); this.display = []; this.sizes = []; this.files = []; this.clicks = 1;
    this.handle=cx.focus_handle(); if (!p.paneMode) this.handle.focus(); /* a pane the panel opened stays passive: the panel keeps the keyboard */ this.anchor=null; this.selection=null; this.shift=false; this.refs={old:[],new:[]};
    this.selectedRow = null; this.selectionMode = null; this.thread = cx.new(InlineComments); this.closeSeen = shared(CLOSE_THREAD_KEY)?.at ?? 0;
    this.refreshQueue=new Coalescer();this.dataStamp=null;
    this.contextLines=3;this.ignoreWhitespace=false;this.wordHighlight=true;this.wordCache=new Memo(256);this.wordPairs=new Map();
    this.commentPosition={inset:0,width:600};this.viewportWidth=600;this.horizontalVersion=0;
    this.wrapLines = false; // off by default: long lines scroll sideways (turn on "Wrap lines" to fit them)
    this.pointerRows = [];
    this.pointerSlots = [];
    const review = this;
    // The list renderer cannot register handlers. Retain one lightweight hit
    // target per visible slot, independent of how many rows the diff contains.
    this.PointerRow = class extends View {
      init(p) { this.slot = p.slot; }
      render() {
        const hit = event => {
          review.pointerHit = { index: review.pointerSlots[this.slot], position: event.position };
        };
        return div().id(`diff-pointer-${this.slot}`).absolute().inset_0()
          .on_mouse_down("left", hit).on_mouse_move(hit);
      }
    };
    this.scroll=VirtualListScrollHandle.new();this.cursor=-1;this.changeIndices=[];this.matches=[];this.searchQuery="";this.searchOpen=false;this.matchCursor=-1;
    this.showFiles=true;this.folderCollapsed=new Set();this.fileQuery="";this.treeNodes=[];
    this.searchInput=InputState.new({placeholder:"Find in diff…"});
    this.searchInput.on("change",(_e,cx)=>{this.searchQuery=this.searchInput.value();if(this.searchQuery.trim()&&this.collapsed.size){this.collapsed.clear();this.build();}this.matches=searchRows(this.display,this.searchQuery);this.matchSet=new Set(this.matches);this.matchCursor=-1;cx.notify();});
    this.searchInput.on("submit",(e,cx)=>this.moveMatch(e.shift?-1:1,cx));
    this.fileInput=InputState.new({placeholder:"Filter files…"});
    this.fileInput.on("change",(_e,cx)=>{this.fileQuery=this.fileInput.value();this.treeNodes=fileTree(this.files,this.fileQuery,this.folderCollapsed);cx.notify();});
    this.diffWidth = 400; this.truncated = false;
    this.hx = 0; // side-by-side, wrap off: shared horizontal offset (px) of both columns' code
    cx.timer.every(10000, (cx) => this.load(cx, true));
    this.claim();
  }

  // If showDiff could not tell which tab it made, the preview tab (the one now focused) says so itself.
  claim() {
    if (this.pinned || !this.space) return;
    const entry = shared(VIEW_KEY)?.[this.space];
    if (!entry || (entry.tab && (entry.pane || !entry.paneMode))) return;
    const f = focused(), pane = f?.pane ? panes().find((x) => x.pane === f.pane) : null;
    if (pane?.mod === "tabbed-changes") setShared(VIEW_KEY, { ...shared(VIEW_KEY), [this.space]: { ...entry, tab: pane.tab, pane: entry.paneMode ? pane.pane : entry.pane } });
  }

  // --- what to show -----------------------------------------------------------------------------
  get base() { return this.pinned ? this.pinnedView : shared(VIEW_KEY)?.[this.space]?.view ?? null; }
  get at() { return this.pinned ? 0 : shared(VIEW_KEY)?.[this.space]?.at ?? 0; }
  get mode() { return this.modeOverride ?? this.base?.mode ?? "file"; }
  get file() { return this.fileOverride ?? this.base?.file ?? null; }
  get layout() { return (this.startLayout ?? shared(LAYOUT_KEY)) === "split" ? "split" : "inline"; }
  get isHistorical() { return Boolean(this.base?.commit); }
  get comparison() { return this.isHistorical ? "local" : this.comparisonOverride ?? this.base?.comparison ?? "local"; }
  scopeSig(){return JSON.stringify([this.base?.commit?.sha??null,this.comparison,this.base?.source,this.mode,this.file?.group,this.file?.path,this.at]);}
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
    if (this.isHistorical && this.shownSig === this.sig() && !this.error && !this.loading) return;
    if (this.inflight && Date.now() - this.inflightSince > 45000) { this.loadToken++; this.inflight = false; this.loading = false; invalidateReads(); } // a read that never settled
    if (this.inflight) { this.again = true; return; }
    if(!this.pinned && this.requestAt!==this.at){
      this.requestAt=this.at;this.modeOverride=null;this.fileOverride=null;this.comparisonOverride=null;this.collapsed.clear();
    }
    const sig = this.sig(),scope=this.scopeSig();
    if (!quiet || sig !== this.loadedSig) { this.loadedSig = sig; this.error = null; }
    if (sig !== this.shownSig) {
      this.pendingSelection=scope===this.shownScope?(this.selection??this.pendingSelection):null;
      this.pendingAnchor=scope===this.shownScope?(this.anchor??this.pendingAnchor):null;
      this.pendingCommentOpen=scope===this.shownScope && Boolean(this.selectedRow || this.pendingCommentOpen);
      if (scope !== this.shownScope) this.selectionMode = null;
      this.dataStamp=null;this.display = []; this.baseSizes=[];this.changeIndices=[];this.matches=[];this.matchSet=new Set();this.treeNodes=[];this.sizes = []; this.files = []; this.selectedRow = null; this.selection=null; this.anchor=null; this.comparisonResolved=null; this.loading = true; }
    this.inflight = true; this.inflightSince = Date.now();
    const token = this.loadToken = (this.loadToken ?? 0) + 1;
    const { root, on } = view.source, mode = this.mode, file = this.file, comparison=this.comparison,options=this.diffOptions(),commit=view.commit;
    if (commit) this.watched = null; else this.watch(root, cx);
    cx.spawn(async (cx) => {
      let changed=this.loading;
      try {
        const git = async (args) => {
          const r = await readGit({root,on},args);
          if (r.code !== 0) throw Object.assign(new Error(G.tidy(r.stderr) || `git ${args[0]} failed`), { code: r.code });
          return r.stdout;
        };
        const remote=!commit && comparison!=="local" ? await resolveReviewBase(git,comparison) : null;
        let files;
        if (commit) {
          files = mode === "file" && !file?.path ? [] : G.splitPatch(await commitPatch(git, commit.sha, { ...options, path: mode === "file" ? file.path : undefined }));
          for (const entry of files) if (!entry.lines.length) entry.lines = [entry.binary ? "Binary file changed" : "No text diff available"];
        } else files = mode === "all" ? await this.loadAll(git, root, on,remote,options) : await this.loadOne(git, root, on, file,remote,options);
        if (this.sig() !== sig) return;
        const stamp=JSON.stringify([sig,remote,files]);
        if(stamp!==this.dataStamp || this.error){
          this.dataStamp=stamp;this.comparisonResolved=remote;this.files=files;this.shownSig=sig;this.shownScope=scope;this.error=null;this.build();changed=true;
        }
      } catch (e) { if (this.sig() === sig){const message=String(e?.message??e);changed=changed||this.error!==message;this.error=message;} }
      finally {
        if (token !== this.loadToken) return; // an abandoned run must not end the one that replaced it
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
    const restoring = this.pendingCommentOpen;
    const threadOpen = Boolean(this.selectedRow || restoring);
    const selectedContext = this.pendingSelection ?? this.selection;
    this.pendingCommentOpen = false;
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
    this.display = out;
    this.changeIndices=changedTargets(out);this.matches=searchRows(out,this.searchQuery??"");this.matchSet=new Set(this.matches);
    this.treeNodes=fileTree(this.files,this.fileQuery??"",this.folderCollapsed??new Set());
    this.cursor=Math.min(this.cursor??-1,out.length-1);
    this.refs={old:out.map(r=>contextForRow(r,this.base?.source,"old")).filter(Boolean),new:out.map(r=>contextForRow(r,this.base?.source,"new")).filter(Boolean)};
    if(selectedContext){
      this.selection = selectionForRows(out, selectedContext, this.base?.source, selectedContext.side);
      this.selectedRow = threadOpen ? this.rowForComment(this.selection) : null;
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
  moveChange(direction,cx){this.handle.focus();this.jump(stepTarget(this.changeIndices,this.cursor,direction),cx);}
  moveMatch(direction,cx){if(this.searchOpen)this.searchInput.focus();const index=stepTarget(this.matches,this.matchCursor,direction);if(index!==null){this.matchCursor=index;this.jump(index,cx);}}
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
  // Merged into header(): "N files · vs origin/master" plus Local changes / Fetch.
  comparisonBar() { return null; }

  // --- actions ----------------------------------------------------------------------------------
  setLayout(layout, cx) { this.hx = 0; this.startLayout = null; setShared(LAYOUT_KEY, layout); this.build(); cx.notify(); }

  setMode(mode, cx, file) {
    this.modeOverride = mode;
    if (file) this.fileOverride = file;
    this.load(cx); cx.notify();
  }

  // A file to act on: the one shown, else the clicked row's.
  abs(path) { return `${this.base.source.root}/${path}`; }
  resizePointerRows(height, cx) {
    const count = Math.ceil(height / ROW) + 8;
    if (count <= this.pointerRows.length) return false;
    while (this.pointerRows.length < count) {
      this.pointerRows.push(cx.new(this.PointerRow, { slot: this.pointerRows.length }));
    }
    return true;
  }
  pointerIndex(event) {
    const hit = this.pointerHit;
    this.pointerHit = null;
    return hit?.position.x === event.position.x && hit.position.y === event.position.y ? hit.index : undefined;
  }
  commentGutterHit(index, side) {
    const split = this.layout === "split";
    const inset = this.matchSet?.has(index) ? MATCH_BORDER : 0;
    const half = (this.contentWidth - inset - 1) / 2;
    const left = split && side === "new" ? inset + half + 1 : inset;
    return inCommentGutter(this.clickedX - left, split ? SPLIT_GUTTER_START : INLINE_GUTTER_START);
  }
  // Dragging toward (or past) the top or bottom edge scrolls the rows and keeps extending the selection, so a long
  // range can be selected in one drag. dir: -1 up, 1 down, 0 stop. It ends on mouse-up, or 4s after the last
  // pointer event (mouse-up outside the pane is never delivered).
  autoscroll(dir, cx) {
    if (!this.drag) return;
    if (dir === 0) { this.auto = null; return; }
    if (this.auto?.dir === dir) { this.auto.seen = Date.now(); return; }
    const token = { dir, seen: Date.now(), pos: this.firstVisible ?? 0 };
    this.auto = token;
    const tick = () => {
      if (this.auto !== token || !this.drag) return;
      if (Date.now() - token.seen > 4000) { this.auto = null; return; }
      this.autoStep(token, cx);
      cx.timer.after(45, tick);
    };
    cx.timer.after(0, tick);
  }
  // One tick: move the top row by 2 (our own running position, so the speed does not depend on repaint timing).
  autoStep(token, cx) {
    const last = this.display.length - 1;
    if (last < 0) return;
    const first = this.firstVisible ?? 0, count = Math.max(4, (this.lastVisible ?? first + 10) - first + 1);
    token.pos = Math.max(0, Math.min(Math.max(0, last - count + 1), token.pos + token.dir * 2));
    // scroll_to_item moves the least needed: a row below the view ends up at its bottom edge, one above at its top.
    const edge = token.dir < 0 ? token.pos : Math.min(last, token.pos + count - 1);
    this.scroll.scroll_to_item(edge, "top");
    this.extendDragTo(edge, cx);
  }
  startDrag(index, event) {
    this.auto = null;
    this.drag = null;
    this.didDrag = false;
    const side = this.layout === "split" ? this.clickedSide : "new";
    if (!side || this.clicks !== 1 || this.shift || this.editorClick || this.commentGutterHit(index, side)) return;
    const anchor = contextForRow(this.display[index], this.base?.source, side);
    if (anchor) this.drag = { anchor, position: event.position, index, origin: index, display: this.display };
  }
  moveDrag(index, event, cx) {
    const drag = this.drag;
    if (!drag || drag.display !== this.display || index === undefined) return;
    if (this.didDrag && index === drag.index) return;
    if (!this.didDrag && Math.hypot(event.position.x - drag.position.x, event.position.y - drag.position.y) < 4) return;
    this.extendDragTo(index, cx);
  }
  // Selection from the drag's anchor to row `index` (used by the pointer and by autoscroll).
  extendDragTo(index, cx) {
    const drag = this.drag;
    if (!drag || drag.display !== this.display || index === undefined || !this.display[index]) return;
    const side = drag.anchor.side;
    const rangeTo = (i) => { const c = contextForRow(this.display[i], this.base?.source, side); return c ? rangeContext(drag.anchor, c, this.refs[side]) : null; };
    let selection = rangeTo(index);
    if (!selection) {
      // Past a hidden gap, a file boundary or the 500-line limit: take the farthest row that still works, so the
      // selection grows as far as it can instead of freezing. (Validity only fails going outward: binary search.)
      const origin = drag.origin ?? drag.index, sign = Math.sign(index - origin);
      if (!sign) return;
      let lo = 0, hi = Math.abs(index - origin) - 1, best = null, bestIndex = origin;
      while (lo <= hi) {
        const mid = (lo + hi + 1) >> 1, i = origin + sign * mid, sel = mid === 0 ? null : rangeTo(i);
        if (sel) { best = sel; bestIndex = i; lo = mid + 1; } else hi = mid - 1;
      }
      if (!best) return;
      selection = best; index = bestIndex;
    }
    if (!this.didDrag) this.handle.focus();
    this.didDrag = true;
    drag.index = index;
    this.anchor = drag.anchor;
    this.selection = selection;
    this.selectionMode = "range";
    this.cursor = index;
    this.selectedRow = null;
    this.resizeRows();
    cx.notify();
  }
  rowClicked(i, cx) {
    if (this.didDrag) return;
    const row = this.display[i];this.cursor=i;if(row)this.navFile=row.path;
    if (!row) return;
    const double = this.clicks >= 2;
    const side = this.layout === "split" ? this.clickedSide : "new";
    const end = side ? contextForRow(row, this.base?.source, side) : null;
    if (this.editorClick && !this.isHistorical) {
      const line = end && (row.r?.n ?? row.next);
      if (line) openInEditor(cx, end.source, this.abs(row.path), line);
      return;
    }
    if (end) {
      this.handle.focus();
      const gutter = !this.isHistorical && this.commentGutterHit(i, side);
      if (!gutter || this.shift || !selectionCovers(this.selection, end)) {
        if (!this.shift || !this.anchor) this.anchor = end;
        this.selection = rangeContext(this.anchor, end, this.refs[end.side]);
        if (!this.selection) this.anchor = this.selection = end;
        this.selectionMode = this.shift ? "range" : double ? "row" : null;
      }
      if (gutter) this.showComment(cx);
      else {
        this.selectedRow = null;
        this.resizeRows();
        cx.notify();
      }
      return;
    }
    if (row.kind === "file") {
      if (double) this.setMode("file", cx, this.fileFor(row.path));
      else { this.collapsed.has(row.path) ? this.collapsed.delete(row.path) : this.collapsed.add(row.path); this.build(); cx.notify(); }
      return;
    }
  }

  rowForComment(selection) {
    if (!selection) return null;
    return this.display.find(row => {
      const context = contextForRow(row, this.base?.source, selection.side);
      return context?.path === selection.path && context.side === selection.side &&
        context.line === (selection.endLine ?? selection.line);
    }) ?? null;
  }
  updateThread(focus, compose = false) {
    this.thread.set_props({ context: this.selection, references: this.refs[this.selection?.side] ?? [], space: this.space, focus, compose });
  }
  openComment(cx) {
    if (this.isHistorical) return;
    this.horizontalVersion++;this.commentPosition={inset:0,width:Math.min(600,this.viewportWidth)};
    const source = this.base?.source;
    const row = this.display[this.cursor];
    this.selection = selectionForRows(this.display, this.selection, source, this.selection?.side) ??
      contextForRow(row, source, "new") ?? contextForRow(row, source, "old") ??
      this.refs.new[0] ?? this.refs.old[0] ?? null;
    this.showComment(cx, true);
  }
  showComment(cx, compose = false) {
    if (this.isHistorical) return;
    this.selectedRow = this.rowForComment(this.selection);
    if(this.selectedRow){this.updateThread(true, compose);this.resizeRows();cx.notify();}
  }
  badge(context,t) {
    if(!context || this.isHistorical)return div().w(COMMENT_GUTTER).flex_none();
    const notes=lineComments(context), stale=notes.some(n=>isOutdated(n,this.refs[context.side]??[]));
    const selected = (this.selectionMode || this.selectedRow) && selectionCovers(this.selection, context);
    return commentGutter(t, notes.length, stale, selected);
  }
  close() {
    this.watched=null;this.refreshQueue.cancel();this.thread.release();this.scroll.release();this.searchInput.release();this.fileInput.release();
    for (const target of this.pointerRows) target.release();
  }
  resizeRows() {
    const split = this.layout === "split";
    const columns = this.wrapLines ? wrapColumns(split ? (this.viewportWidth - 1) / 2 : this.viewportWidth, split ? 62 : 120, FONT_SIZE) : 0;
    if (this.wrapDisplay !== this.display || this.wrapColumnCount !== columns || this.wrapSplit !== split) {
      this.wrapDisplay = this.display;
      this.wrapColumnCount = columns;
      this.wrapSplit = split;
      this.rowWraps = this.display.map(row => {
        if (row.kind === "file" || row.kind === "@") return null;
        return split ? [wrapBreaks(row.l?.text, columns, hangFor(row.l?.text)), wrapBreaks(row.r?.text, columns, hangFor(row.r?.text))] : [wrapBreaks(row.text, columns, hangFor(row.text))];
      });
      this.baseSizes = this.display.map((row, index) => {
        if (row.kind === "file") return FILE_ROW;
        const [left, right] = this.rowWraps[index] ?? [];
        return ROW * (1 + Math.max(left?.length ?? 0, right?.length ?? 0));
      });
    }
    const height = this.selectedRow ? INLINE_COMMENT_HEIGHT : 0;
    if(this.sizedBase===this.baseSizes && this.sizedRow===this.selectedRow && this.sizedHeight===height)return;
    this.sizedBase=this.baseSizes;this.sizedRow=this.selectedRow;this.sizedHeight=height;
    this.sizes=this.selectedRow?this.baseSizes.map((size,i)=>size+(this.display[i]===this.selectedRow?height:0)):this.baseSizes;
  }
  // Text to copy: the selected line range, else the current row's code (new side in split view).
  copyText() {
    if (this.selection?.code) return this.selection.code;
    const r = this.display[this.cursor];
    if (!r || r.kind === "file" || r.kind === "@") return null;
    return r.text ?? r.r?.text ?? r.l?.text ?? null;
  }
  copyKey() { const s = this.selection; return s ? `${s.path}:${s.side}:${s.line}-${s.endLine ?? s.line}` : null; }
  copySelection(cx) {
    const text = this.copyText();
    if (text === null || text === undefined) return false;
    cx.write_to_clipboard(text);
    this.copiedFor = this.copyKey() ?? "row";
    cx.notify();
    return true;
  }

  commentHint() {
    return this.ignoreWhitespace && this.layout === "split"
      ? "Show spaces to comment on unchanged lines on the left"
      : "Hover for + · Drag or Shift-click to select lines · ⌘C to copy · ⌘⇧I to comment";
  }
  // A fixed-height line above the shortcut footer: the hint when nothing is selected, the selection and Copy when
  // something is. Always the same height, so selecting never moves the diff above it.
  commentBar(t, cx) {
    const selected = this.selection && (this.selectionMode || this.selectedRow);
    const copied = this.copiedFor === this.copyKey();
    const hint = selected && !(this.ignoreWhitespace && this.layout === "split") ? "⌘C copy · ⌘⇧I comment" : this.commentHint();
    return h_flex().id("selection-bar").h(26).px(12).gap(10).flex_none().items_center().text_size(11).border_t(1).border_color(t.border)
      .when(selected, e => e.child(div().flex_none().font_semibold().text_color(t.accent)
        .child(`Selected: ${lineLabel(this.selection)} · ${this.selection.side === "old" ? "original" : "current"}`))
        .child(toolButton("copy-selection", copied ? "check" : "copy", copied ? "Copied" : "Copy", t, cx => this.copySelection(cx), { active: copied, compact: true })))
      .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(hint));
  }
  // Where the inline comment card starts: under the "+" of the side being commented (right column in split view),
  // pulled back only as far as needed to stay inside the pane.
  commentLeft(index, split) {
    const inset = this.matchSet?.has(index) ? MATCH_BORDER : 0;
    const total = this.contentWidth ?? this.viewportWidth;
    let anchor = split ? SPLIT_GUTTER_START : INLINE_GUTTER_START;
    if (split && this.selection?.side !== "old") anchor += inset + (total - inset - 1) / 2 + 1;
    return Math.max(0, Math.min(anchor - 6, this.viewportWidth - this.commentPosition.width));
  }
  rowWithComments(row,t,split,index, pointer, font) {
    const height = this.baseSizes[index], breaks = this.rowWraps[index];
    return v_flex().w_full().flex_none().when(this.matchSet?.has(index),e=>e.border_l(MATCH_BORDER).border_color(t.ansi3))
      .child(div().w_full().h(height).flex_none().relative().font_family(font)
        .child(split ? this.splitRow(row, t, height, breaks, index) : this.inlineRow(row, t, height, breaks?.[0], index))
        .when(Boolean(pointer), e => e.child(pointer)))
      .when(!this.isHistorical && this.selectedRow===row,e=>e.child(h_flex().w_full().child(div().w(this.commentPosition.inset + this.commentLeft(index, split)).flex_none()).child(div().w(this.commentPosition.width).flex_none().child(this.thread))));
  }

  fileFor(path) {
    const known = this.base?.file;
    return known?.path === path ? known : { path, group: "changes", fresh: this.files.find((f) => f.path === path)?.fresh };
  }

  // --- drawing ----------------------------------------------------------------------------------
  // A line of code with syntax colours; `tint` keeps added/removed text readable on its stronger background.
  inlineRow(r, t, height, breaks, index) {
    if (r.kind === "file") return this.fileRow(r, t);
    if (r.kind === "@") return div().w_full().px(12).h(ROW).flex_none().truncate().bg(t.raised).border_t(1).border_b(1).border_color(t.border).text_color(t.dim).child(r.text);
    const add = r.kind === "+", del = r.kind === "-", tone = add ? t.ansi2 : t.ansi1;
    const context = contextForRow(r, this.base?.source);
    const selected = (this.selectionMode || this.selectedRow) && selectionCovers(this.selection, context);
    return h_flex().id(`diff-hover-${index}`).w_full().h(height).items_start().flex_none()
      .text_color(t.dim + "66").hover(style => style.text_color(t.accent))
      .when(add || del, (e) => e.bg(tone + "1c"))
      .child(div().w(40).flex_none().text_right().pr(6).text_color(del ? tone + "cc" : t.dim).when(del, (e) => e.bg(tone + "30")).child(r.old === undefined ? "" : String(r.old)))
      .child(div().w(40).flex_none().text_right().pr(6).text_color(add ? tone + "cc" : t.dim).when(add, (e) => e.bg(tone + "30")).child(r.next === undefined ? "" : String(r.next)))
      .child(div().w(18).flex_none().text_center().text_color(tone + "b0").child(add ? "+" : del ? "−" : ""))
      .child(this.badge(context, t))
      .child(codeLine(r.text, r.path, t, this.highlights(r.path, del ? r.old : r.next, del ? "old" : "new"), tone, breaks, add || del))
      .when(selected, e => selectedDiffRow(e, t));
  }

  // Side by side with wrapping off: each column stays half the pane and its code slides under a shared offset,
  // so changes on the right are never pushed off-screen by a long line on the left.
  hscrolled(el) {
    if (this.layout !== "split" || this.wrapLines) return el;
    return div().flex_1().min_w(0).overflow_hidden().child(div().w(this.diffWidth).flex_none().ml(-this.hx).child(el));
  }
  maxHx() {
    const half = (this.viewportWidth - 1) / 2;
    return Math.max(0, (this.diffWidth - 130) - (half - 62) + 24);
  }
  half(cell, t, color, path, side, height, breaks, wholeRowSelected, index) {
    const selected = wholeRowSelected || (cell && (this.selectionMode || this.selectedRow) &&
      selectionCovers(this.selection, { path, side, line: cell.n }));
    return h_flex().id(`diff-hover-${index}-${side}`).flex_1().min_w(0).h(height).items_start()
      .text_color(t.dim + "66").hover(style => style.text_color(t.accent))
      .when(Boolean(cell?.change), (e) => e.bg(color + "1c")).when(!cell, (e) => e.bg(t.raised + "88"))
      .child(div().w(40).flex_none().text_right().pr(8).text_color(cell?.change ? color + "cc" : t.dim).when(Boolean(cell?.change), (e) => e.bg(color + "30")).child(cell ? String(cell.n) : ""))
      .child(this.badge(cell?contextForRow({kind:"c",path,l:side==="old"?cell:null,r:side==="new"?cell:null,baseRevision:this.comparisonResolved?.sha,baseLabel:this.comparisonResolved?.name,oldContextUnavailable:Boolean(this.ignoreWhitespace)},this.base.source,side):null,t))
      .child(cell ? this.hscrolled(codeLine(cell.text, path, t, this.highlights(path, cell.n, side), color, breaks, Boolean(cell.change))) : div().flex_1())
      .when(selected, e => selectedDiffRow(e, t));
  }

  splitRow(r, t, height, breaks, index) {
    if (r.kind === "file") return this.fileRow(r, t);
    if (r.kind === "@") return div().w_full().px(12).h(ROW).flex_none().truncate().bg(t.raised).border_t(1).border_b(1).border_color(t.border).text_color(t.dim).child(r.text);
    const wholeRowSelected = this.selectionMode === "row" && this.selection && selectionCovers(
      this.selection, contextForRow(r, this.base?.source, this.selection.side));
    return h_flex().w_full().h(height).flex_none()
      .child(this.half(r.l, t, t.ansi1, r.path, "old", height, breaks?.[0], wholeRowSelected, index))
      .child(div().w(1).h_full().flex_none().bg(t.border))
      .child(this.half(r.r, t, t.ansi2, r.path, "new", height, breaks?.[1], wholeRowSelected, index));
  }

  // A slim position marker under each column while the code is wider than the column.
  hscrollThumbs(t, maxHx) {
    const half = (this.viewportWidth - 1) / 2, code = Math.max(1, half - 62);
    const thumb = Math.max(28, Math.min(code, code * code / Math.max(code, this.diffWidth - 130)));
    const left = 62 + (this.hx / maxHx) * (code - thumb);
    const column = () => div().w(half).h_full().flex_none().relative()
      .child(div().absolute().top(1).h(3).w(thumb).left(left).rounded(2).bg(t.dim + "90"));
    return h_flex().absolute().bottom(0).left(0).w_full().h(5).child(column()).child(div().w(1).flex_none()).child(column());
  }

  // All-files view: while a file's own header has scrolled off, pin that file's name and +/- at the top.
  stickyFileHeader(t, cx) {
    const first = this.firstVisible ?? 0;
    if (this.mode !== "all" || first <= 0 || !this.display[first] || this.display[first].kind === "file") return null;
    let at = first;
    while (at > 0 && this.display[at]?.kind !== "file") at--;
    const header = this.display[at];
    if (header?.kind !== "file") return null;
    return div().id("sticky-file-header").absolute().top(0).left(0).w_full().h(FILE_ROW).bg(t.raised).cursor_pointer()
      .on_mouse_down("left", (_e, c) => c.stop_propagation())
      .on_click((_e, c) => { c.stop_propagation(); this.jump(at, c); })
      .child(this.fileRow(header, t));
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

  // What this diff is of, as a small chip: staged vs unstaged is otherwise invisible.
  scopeChip(t) {
    const f = this.file;
    if (this.isHistorical || this.comparison !== "local") return null; // the title / "vs <branch>" already say it
    const [label, color] = this.mode === "all" ? ["Uncommitted", t.muted]
      : f?.fresh ? ["New file", t.ansi2]
      : ({ staged: ["Staged", t.ansi2], changes: ["Unstaged", t.ansi3], conflicts: ["Conflict", t.ansi1], head: ["vs HEAD", t.muted] }[f?.group] ?? [null]);
    if (!label) return null;
    return div().id("scope-chip").flex_none().px(6).h(18).flex().items_center().rounded(9).border(1).border_color(t.border).bg(t.raised)
      .text_size(10).font_semibold().text_color(color).tooltip(`Showing the ${label.toLowerCase()} diff`).child(label);
  }

  header(t, cx) {
    const view = this.base, all = this.mode === "all", f = this.file;
    // Narrow pane: text buttons become icons (labels stay as tooltips) so nothing is cut off.
    const compact = this.viewportWidth + (all && this.showFiles ? 250 : 0) < 780;
    const chip = this.scopeChip(t);
    const add = this.files.reduce((n, x) => n + x.add, 0), del = this.files.reduce((n, x) => n + x.del, 0);
    const commit = view.commit;
    const title = all ? (commit ? `Commit ${commit.short ?? commit.sha.slice(0, 8)}` : "All changes") : G.basename(f?.path ?? "");
    const against = commit ? ` · ${commit.subject ?? ""}` : this.comparison !== "local" ? ` · vs ${this.comparisonResolved?.name ?? (this.comparison === "origin" ? "origin default branch" : this.comparison)}` : "";
    const sub = all ? `${this.files.length} file${this.files.length === 1 ? "" : "s"}${against}` : (f?.path?.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : "") + against;
    return h_flex().h(44).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
      .child(all ? icon("layers", 16).text_color(t.muted) : fileIcon(f?.path ?? "", 18))
      .child(div().font_bold().text_size(15).flex_none().text_color(t.foreground).child(title))
      .when(this.isHistorical, element => element.child(div().flex_none().text_size(11).text_color(t.muted).child("Read-only commit")))
      .when(Boolean(chip), e => e.child(chip))
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(sub))
      .when(add > 0, (e) => e.child(div().text_size(12).font_bold().flex_none().text_color(t.ansi2).child(`+${add}`)))
      .when(del > 0, (e) => e.child(div().text_size(12).font_bold().flex_none().text_color(t.ansi1).child(`−${del}`)))
      .when(this.comparison !== "local", e => e
        .child(toolButton("compare-local", "files", "Local changes", t, cx => this.setComparison("local", cx), { compact }))
        .child(iconButton("compare-fetch", "refresh", t, cx => this.fetchOrigin(cx), { title: this.fetching ? "Fetching…" : "Fetch origin" })))
      .child(h_flex().flex_none().gap(2)
        .child(iconButton("lay-inline", "rows", t, (cx) => this.setLayout("inline", cx), { active: this.layout === "inline", title: "Inline" }))
        .child(iconButton("lay-split", "columns", t, (cx) => this.setLayout("split", cx), { active: this.layout === "split", title: "Side by side" })))
      .child(toolButton("mode", all ? "file-open" : "layers", all ? "Single file" : "All changes", t, (cx) => this.setMode(all ? "file" : "all", cx, all ? (f ?? this.firstFile()) : undefined), { compact }))
      .when(!all && Boolean(f) && !this.isHistorical && f.status !== "D" && !this.files.find(entry => entry.path === f.path)?.deleted, (e) => e
        .child(toolButton("open-file", "file-open", "Open file", t, () => openFileTab(view.source, this.abs(f.path)), { compact }))
        .child(toolButton("open-nvim", "terminal", editorLabel(), t, eventCx => openInEditor(eventCx, view.source, this.abs(f.path), 1), { compact })));
  }

  firstFile() { const p = this.files[0]?.path; return p ? this.fileFor(p) : null; }

  // The "Working tree against …" caption and repo path are gone; only a slim row while loading remains.
  footer(t) {
    if (this.error || !this.loading) return null;
    return h_flex().h(22).flex_none().px(12).items_center().border_b(1).border_color(t.border).text_size(11).text_color(t.dim)
      .child(div().flex_none().child("Loading…"));
  }

  editorTarget() {
    if (this.isHistorical || this.loading || !this.base?.source?.root) return null;
    const row = this.display[this.cursor];
    const path = this.selection?.path ?? row?.path ?? this.file?.path ?? this.files.find(entry => !entry.deleted)?.path;
    if (!path || this.files.find(entry => entry.path === path)?.deleted || (this.file?.path === path && this.file.status === "D")) return null;
    const codeRow = row && row.kind !== "file" && row.kind !== "@";
    const line = this.selection?.side === "new" ? this.selection.line : codeRow ? row.r?.n ?? row.next : 1;
    return line ? { path: this.abs(path), line } : null;
  }

  shortcutContext() {
    return { surface: "diff", typing: false, canEdit: Boolean(this.editorTarget()),
      canHistory: Boolean(this.base?.source?.root), editorLabel: editorLabel(),
      canZoom: !this.pinned && Boolean(diffPane()), zoomed: Boolean(diffPane()?.zoomed) };
  }

  performShortcut(action, cx) {
    if (action === "history" && this.base?.source?.root) showHistory(this.base.source);
    else if (action === "zoom") zoomDiff();
    else if (action === "edit") {
      const target = this.editorTarget();
      if (target) openInEditor(cx, this.base.source, target.path, target.line);
    }
  }

  keyEvent(event, cx) {
    if (event.key === "escape" && (this.selectedRow || this.pendingCommentOpen)) {
      cx.stop_propagation(); this.selectedRow = null; this.pendingCommentOpen = false;
      this.handle.focus(); this.resizeRows(); cx.notify(); return;
    }
    if (event.keystroke === "cmd-shift-i") { cx.stop_propagation(); this.openComment(cx); return; }
    if (event.keystroke === "cmd-f") { cx.stop_propagation(); this.openSearch(cx); return; }
    if (event.keystroke === "cmd-c" && this.handle.is_focused() && this.copySelection(cx)) { cx.stop_propagation(); return; }
    if (event.keystroke === "alt-down" || event.keystroke === "alt-up") {
      cx.stop_propagation(); this.moveChange(event.keystroke === "alt-down" ? 1 : -1, cx); return;
    }
    if (!event.viaApp && !this.handle.is_focused()) return;
    const action = reviewAction(event, this.shortcutContext());
    if (action) { cx.stop_propagation(); this.performShortcut(action, cx); }
  }

  render(cx) {
    const t = theme(),event=shared(REPOSITORY_EVENT);
    if(event && event.root===this.base?.source?.root && (event.on??null)===(this.base?.source?.on??null) && event.version!==this.repositoryVersion){this.repositoryVersion=event.version;invalidateReads();this.load(cx,true);}
    if (this.base?.source?.root && (this.sig() !== this.loadedSig)) this.load(cx);
    // The thread deleted the last comment on its line: close the inline panel (same as Esc).
    const closeReq = shared(CLOSE_THREAD_KEY);
    if (closeReq && closeReq.at > this.closeSeen) {
      this.closeSeen = closeReq.at;
      if (this.selectedRow && this.selection?.path === closeReq.path) { this.selectedRow = null; this.pendingCommentOpen = false; this.handle.focus(); this.resizeRows(); }
    }
    const shell = (children) => v_flex().id("scm-diff").track_focus(this.handle)
      .on_key_down((event, cx) => this.keyEvent(event, cx)).size_full().min_h(0).overflow_hidden().bg(t.background).text_color(t.foreground).text_size(13).children(children);
    if (!this.base) return shell([div().p(16).text_color(t.dim).child("Pick a changed file in the Changes panel.")]);
    const split = this.layout === "split";
    const font = settings().font_family ?? "JetBrains Mono";
    this.resizeRows();
    const list = v_virtual_list("scm-diff-rows", this.display.length, this.sizes, (i) => String(i),
      range => {
        // Remember the first visible row for the pinned file header. Never notify from here: asking the view to
        // re-render while the list is rendering blanks the list. The wheel handler below refreshes the header instead.
        this.firstVisible = range.start; this.lastVisible = range.end - 1;
        return this.display.slice(range.start, range.end).map((row, offset) => {
        const index = range.start + offset;
        const slot = index % this.pointerRows.length;
        const pointer = offset < this.pointerRows.length && this.pointerRows[slot];
        if (pointer) this.pointerSlots[slot] = index;
        return this.rowWithComments(row, t, split, index, pointer, font);
        });
      })
      .on_item_click((key, cx) => this.rowClicked(Number(key), cx)).track_scroll(this.scroll).size_full();
    const sticky = this.stickyFileHeader(t, cx);
    const hscroll = !this.wrapLines && !split;      // inline view: the whole row scrolls
    const splitScroll = !this.wrapLines && split;   // side by side: columns stay put, code slides
    const maxHx = splitScroll ? this.maxHx() : 0;
    this.hx = Math.min(this.hx, maxHx);
    const contentWidth=this.diffWidth;
    const body=div().id("diff-viewport").flex_1().min_w(0).min_h(0).h_full().relative()
      .on_size_change((size, cx) => {
        const targetsChanged = this.resizePointerRows(size.height, cx);
        const widthChanged = this.viewportWidth !== size.width;
        this.viewportWidth = size.width;
        this.commentPosition.width = Math.min(600, size.width);
        if (targetsChanged || (widthChanged && (this.wrapLines || this.selectedRow))) cx.notify();
      })
      .on_mouse_up("left", () => { this.drag = null; this.auto = null; })
      .on_hover((hovered, cx) => {
        // Leaving the rows mid-drag no longer cancels the selection: scroll toward the edge it left by instead.
        if (!this.drag) return;
        if (hovered) { this.auto = null; return; }
        const m = this.lastMove;
        this.autoscroll(m?.bounds ? (m.y < m.bounds.y + m.bounds.height / 2 ? -1 : 1) : 0, cx);
      })
      .on_mouse_down("left",e=>{this.commentPosition=commentPlacement(this.contentLeft??0,e.bounds?.x??0,this.contentWidth??this.viewportWidth,this.viewportWidth);})
      .text_size(FONT_SIZE)
      .on_scroll_wheel((e, cx) => {
        // Vertical scrolling: re-render once the list has moved so the sticky file header follows (one event behind).
        if (this.mode === "all" && e.delta.y) cx.notify();
        if (!splitScroll) return;
        const dx = Math.abs(e.delta.x) >= Math.abs(e.delta.y) ? e.delta.x : (e.modifiers?.shift ? e.delta.y : 0);
        if (!dx) return;
        const next = Math.max(0, Math.min(this.maxHx(), this.hx - dx));
        if (next !== this.hx) { this.hx = next; cx.notify(); }
      })
      .child(div().id(`scm-diff-x-${this.horizontalVersion}`).size_full().when(hscroll, e => e.overflow_x_scrollbar())
        .child(div().size_full().when(hscroll, e => e.min_w(contentWidth))
        .on_size_change(size=>{this.contentWidth=size.width;})
        .on_mouse_down("left",e=>{
          this.contentLeft=e.bounds?.x??0;this.clicks=e.click_count??1;this.shift=Boolean(e.modifiers?.shift);
          this.editorClick = Boolean(e.modifiers?.platform);
          this.clickedX = e.local_position?.x;
          const width = e.bounds?.width ?? this.contentWidth;
          this.contentWidth = width;
          this.clickedSide = this.clickedX === undefined ? null : this.clickedX < width / 2 ? "old" : "new";
          this.startDrag(this.pointerIndex(e), e);
        })
        .on_mouse_move((e, cx) => {
          const index = this.pointerIndex(e);
          this.lastMove = { y: e.position.y, bounds: e.bounds };
          if (!this.drag) return;
          this.moveDrag(index, e, cx);
          const b = e.bounds, edge = 26;
          this.autoscroll(!b ? 0 : e.position.y < b.y + edge ? -1 : e.position.y > b.y + b.height - edge ? 1 : 0, cx);
        }).child(list)))
      .when(Boolean(sticky), e => e.child(sticky))
      .when(maxHx > 0, e => e.child(this.hscrollThumbs(t, maxHx)))
      .child(Scrollbar.vertical("scm-diff-rows").viewport_from_layout().absolute().inset_0());
    return shell([
      this.header(t, cx),this.isHistorical?null:this.comparisonBar(t),reviewToolbar(this,t),this.footer(t),
      this.searchOpen?searchBar(this,t):null,
      this.fetchError ? div().px(12).py(6).text_size(12).text_color(t.ansi1).child(this.fetchError) : null,
      this.error ? div().px(12).py(8).text_size(12).text_color(t.ansi1).child(this.error) : null,
      !this.display.length && !this.loading && !this.error ? div().p(16).text_color(t.dim).child(this.mode==="all"?"No changes for this comparison":"No changes in this file") : h_flex().id("review-content").w_full().flex_1().min_h(0).items_stretch().overflow_hidden().child(this.mode==="all"&&this.showFiles?h_resizable("review-file-split").size_full().child(resizable_panel().size(248).size_range(160,520).child(fileNavigator(this,t))).child(resizable_panel().child(body)):body),
      this.truncated ? div().px(12).py(4).border_t(1).border_color(t.border).text_size(11).text_color(t.dim).child(`Showing the first ${MAX_ROWS.toLocaleString()} lines`) : null,
      this.isHistorical && !(this.selection && (this.selectionMode || this.selectedRow)) ? null : this.commentBar(t, cx),
      shortcutFooter("diff", this.shortcutContext(), (action, eventCx) => this.performShortcut(action, eventCx), t, { active: this.handle.is_focused() }),
    ].filter(Boolean));
  }
}
