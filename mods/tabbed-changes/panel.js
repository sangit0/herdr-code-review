// The Source Control panel, after VS Code's: Merge / Staged / Changes sections, per-file stage,
// unstage and discard, a commit box and push / pull. Clicking a file shows its diff in a tab
// (single click reuses one preview tab, double click gets a tab of its own).
import { div } from "gpui-kit";
import { v_flex, h_flex, TextareaState, Textarea } from "gpui-base";
import { spaces, panes, focused, exec, watchFolder, theme, shared, openOverlay, run } from "herdr";
import { pushCurrent, pullCurrent, branchTarget, BRANCH_EVENT } from "./branches.js";
import { Coalescer } from "./read-cache.js";
import { readGit, invalidateReads, invalidateRepository, REPOSITORY_EVENT } from "./repository.js";
import { resolveOrigin } from "./comparison.js";
import * as G from "./git.js";
import { VIEW_KEY, showDiff, updatePreview, openFileTab, showHistory, diffPane, zoomDiff } from "./tabs.js";
import { iconButton, toolButton, icon, fileIcon } from "./ui.js";
import { commentsFor } from "./comments.js";
import { openInEditor, editorLabel } from "./editor.js";
import { reviewAction } from "./shortcut-model.js";
import { shortcutFooter } from "./shortcuts.js";

const REVIEW_SOURCE_ROLES = new Set(["diff", "file", "history", "branches", "comments"]);

// Terminals provide their cwd. Review panes provide a source in their saved props;
// a pinned/file view must not inherit an unrelated preview or space folder.
function location(previous, root, sourceOn) {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  if (pane?.mod === "tabbed-changes" && space) {
    const entry = shared(VIEW_KEY)?.[space.id];
    const source = entry?.tab === pane.tab ? entry.view?.source : null;
    if (source?.root) return { space: space.id, cwd: source.root, on: source.on ?? null };
    return { space: space.id, tab: pane.tab, reviewPane: pane.pane, on: space.machine ?? null };
  }
  if (space && pane && pane.terminal === null && previous?.space === space.id) {
    return root ? { space: space.id, cwd: root, on: sourceOn ?? null } : previous;
  }
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { space: space?.id ?? null, cwd: pane?.cwd || f?.cwd || space?.folder, on };
}

function findPane(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = findPane(child, id);
    if (found) return found;
  }
  return null;
}

async function readReviewLocation(request) {
  const query = { id: 1, method: "doc.get", params: { name: "herdr-app", ...(request.on ? { on: request.on } : {}) } };
  const result = await exec("/bin/sh", ["-c", 'printf "%s\\n" "$1" | herdr-core connect', "herdr-review-source", JSON.stringify(query)]);
  if (result.code !== 0) throw new Error(G.tidy(result.stderr || result.stdout) || "Could not read the focused review's repository.");
  const reply = JSON.parse(result.stdout);
  if (reply.error) throw new Error(reply.error.message);
  const localId = id => request.on && id.startsWith(`${request.on}/`) ? id.slice(request.on.length + 1) : id;
  const space = reply.result?.value?.spaces?.find(space => space.id === localId(request.space));
  const tab = space?.tabs?.find(tab => tab.id === localId(request.tab));
  const content = findPane(tab?.root, localId(request.reviewPane))?.content;
  if (content?.mod !== "tabbed-changes") throw new Error("The focused review is no longer available.");
  const props = content.props;
  if (!REVIEW_SOURCE_ROLES.has(props?.role)) return { cwd: space.folder, on: request.on ?? null };
  const source = props.role === "diff"
    ? props.pinned ? props.view?.source : shared(VIEW_KEY)?.[request.space]?.view?.source
    : props.role === "file" ? props : props.source;
  if (!source?.root) throw new Error("The focused review has no repository source.");
  return { cwd: source.root, on: source.on ?? null };
}

export class Panel {
  init(cx) {
    this.staged = []; this.changes = []; this.conflicts = []; this.branch = null; this.originBase=null;
    this.message = ""; this.collapsed = {}; this.hover = null; this.confirm = null; this.loc = null;
    this.cursorKey = null;
    this.handle = cx.focus_handle(); this.refreshQueue=new Coalescer();
    this.input = TextareaState.new({ placeholder: "Message (⌘Enter to commit)" });
    this.input.set_auto_grow(2, 6);
    this.input.on("change", (_e, cx) => {
      const had = Boolean(this.message.trim());
      this.message = this.input.value();
      if (had !== Boolean(this.message.trim())) cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.commit(cx));
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx));
  }

  get all() { return [...this.conflicts, ...this.staged, ...this.changes]; }
  key() { this.loc = location(this.loc, this.root, this.on); return JSON.stringify(this.loc); }
  source() { return { root: this.root, on: this.on ?? null }; }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    cx.spawn(async (cx) => {
      try { while (this.watched === root) { await watchFolder(root); if (this.watched === root) this.requestRefresh(cx); } }
      catch { this.watched = null; }
    });
  }

  requestRefresh(cx) {
    this.refreshQueue.request(fn=>cx.timer.after(150,fn),cx=>{invalidateReads();this.refresh(cx);});
  }
  close(){this.watched=null;this.refreshQueue.cancel();this.input.release();}

  reset() {
    this.root = null; this.staged = []; this.changes = []; this.conflicts = []; this.branch = null; this.originBase=null;
    this.message = ""; this.input.set_value(""); this.error = null; this.note = null; this.watched = null; this.limited = false; this.confirm = null; this.cursorKey = null;
    this.reviewLocation = null;
  }

  refresh(cx) {
    if (this.loading || this.busy) { this.dirty = true; return; }
    const context = this.key(), request = this.loc;
    if (context !== this.context) { this.context = context; this.reset(); }
    if (!request.cwd && !request.reviewPane) return;
    this.loading = true; this.dirty = false;
    cx.spawn(async (cx) => {
      try {
        const resolved = request.reviewPane ? this.reviewLocation ?? await readReviewLocation(request) : request;
        if (this.key() !== context) return;
        if (request.reviewPane) this.reviewLocation = resolved;
        const { cwd, on } = resolved;
        if (!cwd) return;
        const top = await readGit({root:cwd,on},["rev-parse", "--show-toplevel"]);
        if (this.key() !== context) return;
        if (top.code !== 0) { this.root = null; this.staged = []; this.changes = []; this.conflicts = []; this.branch = null; this.originBase=null; this.error = "Not a git repository"; return; }
        const root = top.stdout.trim(), git = (args) => readGit({root,on},args);
        const status = await git(["status", "--porcelain=v1", "-z", "-b", "--no-renames", "--untracked-files=all"]);
        if (status.code !== 0) throw new Error(status.stderr);
        const head = await git(["rev-parse", "--verify", "HEAD"]);
        const numstat = async (args) => {
          const r = await git(["diff", ...args, "--numstat", "-z", "--no-renames"]);
          if (r.code !== 0) throw new Error(r.stderr);
          return G.parseNumstat(r.stdout);
        };
        const parsed = G.parseStatus(status.stdout, await numstat(["--cached"]), await numstat([]));
        if(parsed.branch && !parsed.branch.detached){
          const target=await branchTarget(async args=>{const r=await git(args);if(r.code!==0)throw new Error(r.stderr);return r.stdout;},parsed.branch.name);
          parsed.branch.upstream=target?.label??null;
        }
        let originBase=null;
        try {originBase=await resolveOrigin(async args=>{const r=await git(args);if(r.code!==0)throw new Error(r.stderr);return r.stdout;},"origin");}catch { /* No conventional origin base has been fetched yet. */ }
        if (this.key() !== context) return;
        this.originBase=originBase;
        this.root = root; this.on = on; this.hasHead = head.code === 0;
        Object.assign(this, { branch: parsed.branch, staged: parsed.staged, changes: parsed.changes, conflicts: parsed.conflicts, limited: parsed.limited, error: null });
        this.syncCursor();
        this.watch(root, cx);
        this.followPick();
      } catch (e) { if (this.key() === context) this.error = String(e); }
      finally {
        this.loading = false;
        if (this.dirty) this.refresh(cx);
        cx.notify();
      }
    });
  }

  // Staging moves a file between sections: keep the preview tab on it.
  followPick() {
    const space = spaces().find((s) => s.active), entry = space && shared(VIEW_KEY)?.[space.id];
    const shown = entry?.view?.file;
    if (!shown || (entry.view.comparison && entry.view.comparison!=="local") || entry.view.mode === "all" || entry.view.source?.root !== this.root) return;
    if (this.all.some((f) => f.group === shown.group && f.path === shown.path)) return;
    const moved = this.all.find((f) => f.path === shown.path);
    if (moved) updatePreview({ ...entry.view, file: { group: moved.group, path: moved.path, status: moved.status, fresh: moved.fresh } });
  }

  // --- opening ----------------------------------------------------------------------------------
  pick(f, clicks, cx) {
    if (!this.root) return;
    this.confirm = null;
    this.cursorKey = `${f.group}:${f.path}`;
    const shown = showDiff({ source: this.source(), mode: "file", file: { group: f.group, path: f.path, status: f.status, fresh: f.fresh } }, { pinned: clicks >= 2 });
    if (shown?.created && "pane" in shown) this.reclaimKeyboard(cx);
    cx.notify();
  }
  compareOrigin(cx) { if(this.root&&this.originBase&&!this.busy&&!this.loading)showDiff({source:this.source(),mode:"all",comparison:this.originBase.name});cx.notify(); }
  openAll(cx) { if (this.root) showDiff({ source: this.source(), mode: "all" }); cx.notify(); }
  openFile(f) { if (this.root) openFileTab(this.source(), `${this.root}/${f.path}`); }
  openEditor(f, cx) { if (this.root) openInEditor(cx, this.source(), `${this.root}/${f.path}`, 1); }

  selectedFile() {
    const rows = this.all;
    return rows.find(file => `${file.group}:${file.path}` === this.cursorKey) ?? rows[0] ?? null;
  }

  syncCursor() {
    const previousPath = this.cursorKey?.slice(this.cursorKey.indexOf(":") + 1);
    const rows = this.all;
    const file = rows.find(row => `${row.group}:${row.path}` === this.cursorKey) ??
      rows.find(row => row.path === previousPath) ?? rows[0];
    this.cursorKey = file ? `${file.group}:${file.path}` : null;
  }

  focus() {
    const space = spaces().find(entry => entry.active);
    const view = space && shared(VIEW_KEY)?.[space.id]?.view;
    if (view?.source?.root === this.root && !view.commit && view.mode === "file" && view.file) {
      const file = this.all.find(row => row.path === view.file.path && row.group === view.file.group) ??
        this.all.find(row => row.path === view.file.path);
      if (file) this.cursorKey = `${file.group}:${file.path}`;
    }
    this.syncCursor();
    this.focusedAt = Date.now();
    this.handle.focus();
  }

  // Opening a diff split a new pane beside this one and the app focused it. Take the keyboard straight back (the
  // app's own focus, via pane.go, so only one thing looks focused and j/k/s/u keep working), a few tries at most.
  reclaimKeyboard(cx) {
    this.focusedAt = 0;
    let tries = 0;
    const attempt = () => {
      if (Date.now() - this.focusedAt < 2000 || tries++ >= 5) return;
      // From the diff pane, which sits at the tab's right edge beside this panel, `go right` lands here.
      const pane = diffPane()?.pane;
      if (pane) run("pane.focus", { pane });
      run("pane.go", { direction: "right" });
      cx.timer.after(300, attempt);
    };
    cx.timer.after(250, attempt);
  }

  moveSelection(delta, cx) {
    const rows = this.all;
    if (!rows.length || this.loading || this.busy) return;
    const current = Math.max(0, rows.findIndex(file => `${file.group}:${file.path}` === this.cursorKey));
    const file = rows[Math.max(0, Math.min(rows.length - 1, current + delta))];
    this.pick(file, 1, cx);
    cx.timer.after(0, () => this.handle.focus());
  }

  shortcutContext() {
    const file = this.selectedFile(), ready = Boolean(this.root && !this.busy && !this.loading);
    return { surface: "panel", typing: Boolean(this.typing),
      canEdit: ready && Boolean(file) && file.status !== "D",
      canHistory: ready, canStage: ready && Boolean(file) && file.group !== "staged",
      canUnstage: ready && file?.group === "staged", editorLabel: editorLabel(),
      canZoom: Boolean(diffPane()), zoomed: Boolean(diffPane()?.zoomed) };
  }

  performShortcut(action, cx) {
    const file = this.selectedFile(), available = this.shortcutContext();
    if (action === "previous") this.moveSelection(-1, cx);
    else if (action === "next") this.moveSelection(1, cx);
    else if (action === "history" && available.canHistory) showHistory(this.source());
    else if (action === "zoom" && available.canZoom) zoomDiff();
    else if (action === "edit" && available.canEdit) this.openEditor(file, cx);
    else if (action === "stage" && available.canStage) this.stage([file], cx);
    else if (action === "unstage" && available.canUnstage) this.unstage([file], cx);
  }

  keyEvent(event, cx) {
    if (event.key === "escape") {
      if (this.confirm) { this.confirm = null; cx.stop_propagation(); cx.notify(); return; }
      if (this.typing) { this.typing = false; this.handle.focus(); cx.stop_propagation(); cx.notify(); return; }
    }
    if (event.key === "enter" && (event.modifiers?.platform || event.modifiers?.control) && this.typing) {
      cx.stop_propagation(); this.commit(cx); return;
    }
    if ((!event.viaApp && !this.handle.is_focused()) || this.confirm) return;
    const action = reviewAction(event, this.shortcutContext());
    if (action) { cx.stop_propagation(); this.performShortcut(action, cx); }
  }

  chooseBranch() {
    if(!this.root||this.busy||this.loading)return;
    openOverlay({mod:"tabbed-changes",kind:"dialog",width:520,height:420,props:{role:"branches",source:this.source()}});
  }
  fetch(cx) { this.work(cx,"Fetch",git=>git(["fetch","--no-tags","origin"],["GIT_TERMINAL_PROMPT=0"]),"Fetched origin"); }

  // --- git writes -------------------------------------------------------------------------------
  // Runs git writes one after another, then refreshes. Failures show under the list.
  work(cx, label, job, doneText) {
    if (!this.root || this.busy || this.context !== this.key()) return;
    const root = this.root, on = this.on, context = this.context;
    this.busy = label; this.note = null; this.confirm = null; this.pushConfirm = false; this.result = null;
    const git = async (args, env = []) => {
      const r = env.length ? await exec("env", [...env, "git", ...G.WRITE, ...args], { cwd: root, on }) : await exec("git", [...G.WRITE, ...args], { cwd: root, on });
      if (r.code !== 0) throw new Error(G.tidy(r.stderr || r.stdout) || `git ${args[0]} failed`);
      return r;
    };
    cx.spawn(async (cx) => {
      try { await job(git); if (doneText && this.key() === context) this.flash(doneText, cx); }
      catch (e) { if (this.key() === context) this.note = `${label} failed: ${e.message ?? e}`; }
      finally { invalidateRepository({root,on}); this.busy = null; this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  async paths(git, prefix, files) {
    const paths = files.map((f) => f.path);
    for (let i = 0; i < paths.length; i += G.CHUNK) await git([...prefix, "--", ...paths.slice(i, i + G.CHUNK)]);
  }

  stage(files, cx) { this.work(cx, "Stage", (git) => this.paths(git, ["add"], files)); }
  unstage(files, cx) {
    const prefix = this.hasHead ? ["reset", "-q"] : ["rm", "--cached", "-r", "-f", "-q"];
    this.work(cx, "Unstage", (git) => this.paths(git, prefix, files));
  }
  discard(files, cx) {
    this.work(cx, "Discard", async (git) => {
      const fresh = files.filter((f) => f.fresh), tracked = files.filter((f) => !f.fresh);
      if (tracked.length) await this.paths(git, ["checkout"], tracked);
      if (fresh.length) await this.paths(git, ["clean", "-fq"], fresh);
    });
  }
  commit(cx) {
    if (!this.message.trim() || !this.staged.length || this.busy || this.loading) return;
    const message = this.message.trim(), context = this.context;
    this.work(cx, "Commit", async (git) => {
      await git(["commit", "-m", message]);
      if (this.key() === context) { this.message = ""; this.input.set_value(""); }
    });
  }
  // A short success line under the buttons; it clears itself.
  flash(text, cx) {
    const token = this.flashToken = (this.flashToken ?? 0) + 1;
    this.result = text; cx.notify();
    cx.timer.after(6000, () => { if (this.flashToken === token) { this.result = null; cx.notify(); } });
  }
  isProtected(name) {
    const base = this.originBase?.name?.split("/").slice(1).join("/");
    return name === "main" || name === "master" || Boolean(base && name === base);
  }
  // First click on a protected branch only arms the button ("Push to main?"); the second one pushes.
  requestPush(cx) {
    const b = this.branch;
    if (!b || b.detached || this.busy || this.loading) return;
    if (this.isProtected(b.name) && !this.pushConfirm) {
      this.pushConfirm = true; cx.notify();
      cx.timer.after(6000, () => { if (this.pushConfirm) { this.pushConfirm = false; cx.notify(); } });
      return;
    }
    this.push(cx);
  }
  push(cx) {
    const b = this.branch;
    if (!b || b.detached) return;
    const n = b.ahead ?? 0, done = b.upstream ? `Pushed ${n} commit${n === 1 ? "" : "s"} to ${b.upstream}` : `Published ${b.name} to origin`;
    this.work(cx, "Push", git => pushCurrent(async args => (await git(args,["GIT_TERMINAL_PROMPT=0"])).stdout,{name:b.name,upstream:b.upstream}), done);
  }
  pull(cx) {
    const b=this.branch;if(!b||b.detached||!b.upstream)return;
    const n = b.behind ?? 0;
    this.work(cx,"Pull",git=>pullCurrent(async args=>(await git(args,["GIT_TERMINAL_PROMPT=0"])).stdout,{name:b.name,upstream:b.upstream}), `Pulled ${n} commit${n === 1 ? "" : "s"} from ${b.upstream}`);
  }

  // --- drawing ----------------------------------------------------------------------------------
  pill(id, label, t, onClick) {
    return div().id(id).h(20).px(8).flex_none().flex().items_center().rounded(5).cursor_pointer().bg(t.ansi1).text_color(t.background).text_size(11).font_semibold()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); })
      .child(label);
  }

  statusColor(s, t) { return s === "A" || s === "U" ? t.ansi2 : s === "D" || s === "!" ? t.ansi1 : s === "R" ? t.ansi4 : t.ansi3; }

  fileRow(f, t, shown) {
    const parts = f.path.split("/"), name = parts.pop(), id = `${f.group}:${f.path}`;
    const selected = this.keyboardFocused ? this.cursorKey === id : shown?.group === f.group && shown?.path === f.path && shown?.mode !== "all";
    const hovered = this.hover === id, confirming = this.confirm === id;
    const actions = [];
    if (confirming) {
      actions.push(this.pill(`ok-${id}`, f.fresh ? "Delete file" : "Discard", t, (cx) => this.discard([f], cx)));
    } else if (hovered) {
      if (f.status !== "D") {
        actions.push(iconButton(`nvim-${id}`, "terminal", t, (cx) => this.openEditor(f, cx), { title: `Open in ${editorLabel()}` }));
        actions.push(iconButton(`open-${id}`, "file-open", t, () => this.openFile(f), { title: "Open file in a tab" }));
      }
      if (f.group === "changes") actions.push(iconButton(`discard-${id}`, "undo", t, (cx) => { this.confirm = id; cx.notify(); }, { title: "Discard changes" }));
      if (f.group === "staged") actions.push(iconButton(`unstage-${id}`, "minus", t, (cx) => this.unstage([f], cx), { title: "Unstage" }));
      else actions.push(iconButton(`stage-${id}`, "plus", t, (cx) => this.stage([f], cx), { title: "Stage" }));
    }
    return h_flex().id(`row-${id}`).h(26).flex_none().pl(22).pr(8).gap(6).items_center().rounded(6).cursor_pointer()
      .when(selected, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
      .on_hover((on, cx) => {
        if (on) this.hover = id;
        else { if (this.hover === id) this.hover = null; if (this.confirm === id) this.confirm = null; }
        cx.notify();
      })
      .on_click((e, cx) => this.pick(f, e.click_count ?? 1, cx))
      .child(fileIcon(f.path, 16))
      .child(h_flex().flex_1().min_w(0).overflow_hidden().gap(6)
        .child(div().max_w(220).min_w(24).truncate().text_color(f.status === "D" ? t.dim : t.foreground).child(name))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(parts.join("/"))))
      .when(actions.length > 0, (e) => e.child(h_flex().flex_none().gap(2).children(actions)))
      .when(actions.length === 0 && (f.add > 0 || f.del > 0), (e) => e.child(h_flex().flex_none().gap(5).text_size(11)
        .when(f.add > 0, (r) => r.child(div().text_color(t.ansi2).child(`+${f.add}`)))
        .when(f.del > 0, (r) => r.child(div().text_color(t.ansi1).child(`−${f.del}`)))))
      .child(div().w(14).flex_none().text_right().text_size(11).font_semibold().text_color(this.statusColor(f.status, t)).child(f.status));
  }

  sectionHeader(section, files, t) {
    const id = section.id, closed = Boolean(this.collapsed[id]), all = `all:${id}`;
    const actions = [];
    if (this.confirm === all) {
      actions.push(this.pill(`ok-${all}`, "Discard all", t, (cx) => this.discard(files, cx)));
    } else {
      if (id === "changes") actions.push(iconButton("discard-all", "undo", t, (cx) => { this.confirm = all; cx.notify(); }, { title: "Discard all changes" }));
      if (id === "staged") actions.push(iconButton("unstage-all", "minus", t, (cx) => this.unstage(files, cx), { title: "Unstage all" }));
      else actions.push(iconButton(`stage-all-${id}`, "plus", t, (cx) => this.stage(files, cx), { title: "Stage all" }));
    }
    return h_flex().id(`section-${id}`).h(26).flex_none().px(4).gap(4).items_center().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_hover((on, cx) => { if (!on && this.confirm === all) { this.confirm = null; cx.notify(); } })
      .on_click((_e, cx) => { this.collapsed[id] = !closed; cx.notify(); })
      .child(icon(closed ? "chevron-right" : "chevron-down", 13).text_color(t.dim))
      .child(div().font_semibold().text_size(11).text_color(t.muted).child(section.title.toUpperCase()))
      .child(div().min_w(16).h(16).px(4).flex().items_center().justify_center().rounded(8).bg(t.raised).text_size(10).text_color(t.muted).child(String(files.length)))
      .child(div().flex_1())
      .child(h_flex().flex_none().gap(2).children(actions));
  }

  headerBar(t) {
    return h_flex().h(36).flex_none().px(10).gap(4).items_center().border_b(1).border_color(t.border)
      .child(div().flex_1().text_size(11).font_semibold().text_color(t.muted).child("SOURCE CONTROL"))
      .when(Boolean(this.root), e => e
        .child(iconButton("review-history", "history", t, () => showHistory(this.source()), { title: "Commit history (l)" }))
        .child(iconButton("all-changes","file-diff",t,cx=>this.openAll(cx),{title:"Open all changes"}))
        .child(iconButton("refresh","refresh",t,cx=>this.refresh(cx),{title:"Refresh Source Control"})));
  }
  branchBar(t) {
    const b=this.branch;
    return h_flex().flex_none().px(10).py(6).gap(5).items_center().border_b(1).border_color(t.border)
        .child(h_flex().id("checkout-branch").flex_1().min_w(0).gap(5).items_center().cursor_pointer().rounded(3).hover(s=>s.bg(t.hover))
          .tooltip("Checkout branch…").on_click(()=>this.chooseBranch())
          .child(icon("branch",14).text_color(t.accent))
          .child(div().flex_1().min_w(0).truncate().child(b?.name??"Select repository"))
          .child(icon("chevron-down",12).text_color(t.dim)))
        .when(Boolean(this.root&&this.originBase),el=>el.child(toolButton("compare-default-branch","columns",this.originBase.name,t,cx=>this.compareOrigin(cx))
          .tooltip(`Review changes against ${this.originBase.name}`)))
        .when(Boolean(b?.upstream),el=>el.child(div().flex_none().text_size(11).text_color(t.muted).child(`↓${b.behind} ↑${b.ahead}`)));
  }

  // Fetch / Pull / Push (or Publish) with what each will do, in words and counts: a status line, then buttons that
  // follow the branch's state. Pushing to main/master needs a second click, and the result is said afterwards.
  remoteActions(t) {
    const b = this.branch, usable = Boolean(b && !b.detached && this.hasHead), free = usable && !this.busy && !this.loading;
    const up = b?.upstream, ahead = b?.ahead ?? 0, behind = b?.behind ?? 0, plural = (n) => (n === 1 ? "" : "s");
    const state = !usable ? "none" : !up ? "publish" : ahead && behind ? "diverged" : ahead ? "push" : behind ? "pull" : "synced";
    const arming = this.pushConfirm && (state === "push" || state === "publish");
    const status = arming ? `Push ${state === "push" ? `↑${ahead} ` : ""}straight to ${b.name}? Click again to confirm` : {
      none: !b ? "No repository" : b.detached ? "Detached HEAD: check out a branch to sync" : "Make a commit to enable push",
      publish: `${b?.name} is not on origin yet`,
      diverged: `Diverged: ↑${ahead} ahead, ↓${behind} behind ${up}`,
      push: `↑${ahead} commit${plural(ahead)} to push to ${up}`,
      pull: `↓${behind} commit${plural(behind)} to pull from ${up}`,
      synced: `Up to date with ${up}`,
    }[state];
    const tone = arming || state === "diverged" ? t.ansi3 : state === "synced" || state === "none" ? t.dim : t.muted;
    const button = (id, label, iconName, { onClick, enabled, primary = false, warn = false, tip }) => {
      const on = enabled && primary;
      return h_flex().id(id).h(26).px(9).gap(6).items_center().justify_center().rounded(6).flex_none().border_1()
        .border_color(on ? (warn ? t.ansi3 : t.accent) : t.border).bg(on ? (warn ? t.ansi3 : t.accent) : t.raised)
        .text_color(on ? t.accent_foreground : enabled ? t.foreground : t.dim).text_size(11).font_semibold()
        .when(enabled, e => e.cursor_pointer().hover(s => s.opacity(0.88)).on_click((_e, cx) => onClick(cx)))
        .when(Boolean(tip), e => e.tooltip(tip)).child(icon(iconName, 13)).child(div().truncate().child(label));
    };
    const busy = this.busy ? `${this.busy}…` : null;
    let row;
    if (arming) {
      row = h_flex().gap(6).items_center()
        .child(button("push-cancel", "Cancel", "minus", { enabled: true, onClick: (cx) => { this.pushConfirm = false; cx.notify(); } }))
        .child(div().flex_1().min_w(0).flex().child(button("push-confirm", state === "push" ? `Push ↑${ahead} to ${b.name}` : `Publish ${b.name}`, "arrow-up", { enabled: free, primary: true, warn: true, onClick: (cx) => this.requestPush(cx) })));
    } else {
      const pullable = free && Boolean(up) && behind > 0 && ahead === 0;
      const main = state === "publish" ? { label: "Publish branch", icon: "cloud-upload", enabled: free, primary: true, tip: `Publish ${b?.name} to origin and track it` }
        : state === "push" ? { label: `Push ↑${ahead}`, icon: "arrow-up", enabled: free, primary: true, tip: `Push ${b?.name} to ${up}` }
        : state === "pull" ? { label: `Pull ↓${behind}`, icon: "arrow-down", enabled: pullable, primary: true, tip: `Fast-forward ${b?.name} from ${up}` }
        : state === "synced" ? { label: "Up to date", icon: "check", enabled: false, tip: `${b?.name} matches ${up}` }
        : state === "diverged" ? { label: "Diverged", icon: "arrow-up", enabled: false, tip: "Both sides have new commits: rebase or merge in a terminal" }
        : { label: "Push", icon: "arrow-up", enabled: false, tip: status };
      row = h_flex().gap(6).items_center()
        .child(button("fetch", "Fetch", "cloud", { enabled: free, onClick: (cx) => this.fetch(cx), tip: "Fetch origin (updates remote branches, changes nothing local)" }))
        .when(state !== "pull", e => e.child(button("pull", behind ? `Pull ↓${behind}` : "Pull", "arrow-down", { enabled: pullable, onClick: (cx) => this.pull(cx),
          tip: !up ? "Pull needs an upstream branch" : ahead && behind ? "Diverged: pull would not fast-forward" : behind ? `Fast-forward from ${up}` : "Nothing to pull" })))
        .child(div().flex_1().min_w(0).flex().justify_end().child(button("push-branch", busy ?? main.label, main.icon, {
          enabled: main.enabled && !busy, primary: main.primary, tip: main.tip,
          onClick: (cx) => (state === "pull" ? this.pull(cx) : this.requestPush(cx)) })));
    }
    return v_flex().flex_none().px(10).py(8).gap(6).border_t(1).border_color(t.border)
      .child(div().id("sync-status").text_size(11).text_color(tone).truncate().tooltip(status).child(status))
      .child(row)
      .when(Boolean(this.result), e => e.child(h_flex().gap(5).items_center().text_size(11).text_color(t.ansi2)
        .child(icon("check", 12)).child(div().flex_1().min_w(0).truncate().child(this.result))));
  }

  commitBox(t) {
    const count = this.staged.length;
    const enabled = Boolean(this.message.trim() && count > 0 && this.root && !this.busy && !this.loading);
    const label = this.busy === "Commit" ? "Committing…" : count ? `Commit ${count} staged` : "Commit";
    return v_flex().flex_none().p(10).gap(8).border_b(1).border_color(t.border)
      .child(div().id("commit-message").w_full().px(10).py(6).rounded(8).border_1().border_color(this.typing ? t.accent : t.border).cursor_text()
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(Textarea.new(this.input).w_full().text_size(12).text_color(t.foreground)))
      .child(div().id("commit").w_full().h(30).flex().items_center().justify_center().rounded(8)
        .bg(enabled ? t.solid : t.raised).text_color(enabled ? t.solid_foreground : t.dim).text_size(12).font_semibold()
        .when(enabled, (e) => e.cursor_pointer()).on_click((_e, cx) => this.commit(cx)).child(icon("check",13)).child(div().ml(5).child(label)))
      .when(Boolean(this.message.trim()) && !count && Boolean(this.root) && !this.loading, (e) => e.child(div().text_size(11).text_color(t.dim).child("Stage changes with + to commit them")));
  }

  commentsBar(t, space) {
    const count = commentsFor(this.source()).length;
    return div().flex_none().px(8).py(6).border_t(1).border_color(t.border)
      .child(h_flex().id("open-review-comments").w_full().h(30).px(8).gap(7).items_center().rounded(5)
        .cursor_pointer().bg(t.raised).hover(style => style.bg(t.hover))
        .on_click(() => openOverlay({
          mod: "tabbed-changes", kind: "dialog", width: 580, height: 450,
          props: { role: "comments", source: this.source(), space },
        }))
        .child(icon("comment", 14).text_color(count ? t.accent : t.muted))
        .child(div().flex_1().font_semibold().text_size(12).child("Comments"))
        .child(div().min_w(19).px(5).rounded(8).bg(count ? t.selected : t.background)
          .text_center().text_size(11).text_color(count ? t.accent : t.muted).child(String(count))));
  }

  render(cx) {
    const event=shared(REPOSITORY_EVENT)??shared(BRANCH_EVENT);
    if(event && event.root===this.root && (event.on??null)===(this.on??null) && (event.version??event.at)!==this.lastBranchEvent){this.lastBranchEvent=event.version??event.at;invalidateReads();this.refresh(cx);}
    if (this.key() !== this.context) this.refresh(cx);
    const t = theme();
    const space = spaces().find((s) => s.active), entry = space && shared(VIEW_KEY)?.[space.id];
    const shown = entry?.view?.source?.root === this.root ? { ...entry.view.file, mode: entry.view.mode } : null;
    this.keyboardFocused = this.handle.is_focused();
    const visible = G.SECTIONS.map((s) => ({ ...s, files: this[s.id] })).filter((s) => s.files.length > 0);
    const list = v_flex().id("scm-list").flex_1().min_h(0).p(6).gap(2).overflow_y_scrollbar()
      .children(visible.flatMap((s) => [this.sectionHeader(s, s.files, t), ...(this.collapsed[s.id] ? [] : s.files.map((f) => this.fileRow(f, t, shown)))]))
      .when(!visible.length, (e) => e.child(div().p(8).text_color(t.dim).child(this.error || (this.loading ? "Loading changes…" : this.root ? "No uncommitted changes" : "No folder"))))
      .when(this.limited, (e) => e.child(div().px(8).py(4).text_size(11).text_color(t.dim).child(`Showing the first ${G.LIMIT.toLocaleString()} changed files`)));

    return v_flex().id("scm-panel").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(this.keyboardFocused ? t.accent : t.border).text_color(t.foreground).text_size(13).track_focus(this.handle)
      .on_mouse_down("left", () => this.handle.focus())
      .on_key_down((event, cx) => this.keyEvent(event, cx))
      .child(this.headerBar(t))
      .when(Boolean(this.root), e => e.child(this.branchBar(t)).child(this.commitBox(t)))
      .child(list)
      .when(Boolean(this.root), e => e.child(this.commentsBar(t, space?.id)).child(this.remoteActions(t)))
      .when(Boolean(this.note), (e) => e.child(div().px(10).py(6).border_t(1).border_color(t.border).text_size(11).text_color(t.ansi1).child(this.note)))
      .child(shortcutFooter("panel", this.shortcutContext(), (action, cx) => this.performShortcut(action, cx), t, { active: this.keyboardFocused }));
  }
}
