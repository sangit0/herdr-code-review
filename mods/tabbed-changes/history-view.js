// A read-only commit history overlay: HEAD's commits, paginated, drilling into one commit's
// changed files, then opening a historical review (one file or all) in the shared diff tab.
// Follows the BranchPicker/CommentOverview dialog pattern: a plain class with init/render/close,
// its own focus handle, and `closeOverlay(this.overlay)` to dismiss - it never closes a Herdr tab.
import { div } from "gpui-kit";
import { v_flex, h_flex, v_virtual_list, Scrollbar, VirtualListScrollHandle } from "gpui-base";
import { props, exec, theme, settings, closeOverlay } from "herdr";
import { READ, tidy, basename } from "./git.js";
import { listCommits, commitFiles } from "./history.js";
import { showDiff } from "./tabs.js";
import { icon, iconButton } from "./ui.js";
import { reviewAction } from "./shortcut-model.js";
import { shortcutFooter } from "./shortcuts.js";

const ROW = 34;
const PAGE = 50;

export class HistoryView {
  init(cx) {
    const p = props() ?? {};
    this.source = p.source; this.overlay = p.overlay;
    this.page = "commits"; // "commits" | "files"
    this.commits = []; this.commitIndex = 0; this.loadingCommits = false; this.hasMore = false; this.skip = 0; this.error = null;
    this.commit = null; this.files = []; this.fileIndex = 0; this.loadingFiles = false; this.filesError = null;
    this.handle = cx.focus_handle(); this.handle.focus();
    this.commitScroll = VirtualListScrollHandle.new(); this.fileScroll = VirtualListScrollHandle.new();
    this.loadCommits(cx, true);
  }

  close() { this.commitScroll.release(); this.fileScroll.release(); }

  async git(args) {
    if (!this.source?.root) throw new Error("No repository selected.");
    const r = await exec("git", [...READ, ...args], { cwd: this.source.root, on: this.source.on ?? null });
    if (r.code !== 0) throw Object.assign(new Error(tidy(r.stderr || r.stdout) || "Git command failed."), { code: r.code });
    return r.stdout;
  }

  // --- loading ------------------------------------------------------------------------------
  loadCommits(cx, reset = false) {
    if (this.loadingCommits) return;
    if (reset) { this.commits = []; this.skip = 0; this.hasMore = false; this.commitIndex = 0; }
    this.loadingCommits = true; this.error = null; cx.notify();
    const skip = this.skip;
    cx.spawn(async (cx) => {
      try {
        const { commits, hasMore } = await listCommits((args) => this.git(args), { limit: PAGE, skip });
        this.commits = reset ? commits : [...this.commits, ...commits];
        this.hasMore = hasMore; this.skip = this.commits.length;
      } catch (e) { this.error = String(e.message ?? e); }
      finally { this.loadingCommits = false; cx.notify(); }
    });
  }

  openCommit(commit, cx) {
    if (this.loadingFiles) return;
    this.page = "files"; this.commit = commit; this.files = []; this.fileIndex = 0; this.filesError = null; this.loadingFiles = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try { this.files = await commitFiles((args) => this.git(args), commit.sha); }
      catch (e) { this.filesError = String(e.message ?? e); }
      finally { this.loadingFiles = false; cx.notify(); }
    });
  }

  // --- navigation -----------------------------------------------------------------------------
  back(cx) {
    if (this.page === "files") { this.page = "commits"; this.commit = null; this.files = []; this.filesError = null; cx.notify(); }
    else closeOverlay(this.overlay);
  }

  rowCount() { return this.page === "commits" ? this.commits.length : this.files.length + 1; } // +1: "Review all files"
  index() { return this.page === "commits" ? this.commitIndex : this.fileIndex; }
  setIndex(i, cx) {
    const count = this.rowCount(); if (!count) return;
    const next = Math.max(0, Math.min(count - 1, i));
    if (this.page === "commits") this.commitIndex = next; else this.fileIndex = next;
    (this.page === "commits" ? this.commitScroll : this.fileScroll).scroll_to_item(next, "center");
    cx.notify();
  }

  openSelected(cx) {
    if (this.page === "commits") { const c = this.commits[this.commitIndex]; if (c) this.openCommit(c, cx); return; }
    if (this.fileIndex === 0) this.reviewAll(cx); else { const f = this.files[this.fileIndex - 1]; if (f) this.openFile(f, cx); }
  }

  // --- opening a historical review ------------------------------------------------------------
  commitRef() { const c = this.commit; return c ? { sha: c.sha, short: c.short, subject: c.subject } : null; }
  openFile(file, cx) {
    closeOverlay(this.overlay);
    showDiff({ source: this.source, mode: "file", file: { path: file.path }, commit: this.commitRef() });
  }
  reviewAll(cx) {
    closeOverlay(this.overlay);
    showDiff({ source: this.source, mode: "all", commit: this.commitRef() });
  }

  // --- keyboard ------------------------------------------------------------------------------
  context() {
    return { surface: "history", typing: false, canEdit: false, canStage: false, canUnstage: false, canOpen: this.rowCount() > 0, historyMode: this.page,
      openLabel: this.page === "commits" ? "Open commit" : this.fileIndex === 0 ? "Review all" : "Open file" };
  }
  keyEvent(e, cx) {
    if (!event.viaApp && !this.handle.is_focused()) return;
    const action = reviewAction(e, this.context());
    if (!action) return;
    cx.stop_propagation();
    this.perform(action, cx);
  }
  perform(action, cx) {
    if (action === "previous") this.setIndex(this.index() - 1, cx);
    else if (action === "next") this.setIndex(this.index() + 1, cx);
    else if (action === "open") this.openSelected(cx);
    else if (action === "back") this.back(cx);
  }

  // --- render ---------------------------------------------------------------------------------
  commitRow(c, index, t) {
    const selected = this.page === "commits" && index === this.commitIndex;
    return h_flex().id(`history-commit-${c.sha}`).h(ROW).w_full().px(10).gap(8).items_center().bg(selected ? t.selected : t.surface)
      .child(div().flex_none().w(56).font_family(settings().font_family ?? "Geist Mono").text_size(11).text_color(t.muted).child(c.short))
      .child(div().flex_1().min_w(0).truncate().child(c.subject))
      .child(div().flex_none().max_w(140).truncate().text_size(11).text_color(t.dim).child(c.author))
      .child(div().flex_none().text_size(11).text_color(t.dim).child(c.date.slice(0, 10)));
  }

  renderCommits(t, cx) {
    const list = v_virtual_list("history-commit-list", this.commits.length, ROW, (i) => this.commits[i].sha,
      (range) => this.commits.slice(range.start, range.end).map((c, offset) => this.commitRow(c, range.start + offset, t)))
      .on_item_click((sha, cx) => {
        const index = this.commits.findIndex(commit => commit.sha === sha);
        if (index < 0) return;
        this.commitIndex = index; this.handle.focus(); this.openCommit(this.commits[index], cx);
      }).track_scroll(this.commitScroll).size_full();
    return v_flex().flex_1().min_h(0).gap(6)
      .child(div().flex_1().min_h(0).relative().child(list).child(Scrollbar.vertical("history-commit-list").viewport_from_layout().absolute().inset_0()))
      .when(!this.commits.length, (e) => e.child(div().p(12).text_color(t.dim).child(this.loadingCommits ? "Loading commits…" : "No commits yet")))
      .when(this.hasMore, (e) => e.child(h_flex().justify_center().py(6)
        .child(div().id("history-load-more").px(10).py(4).rounded(6).cursor_pointer().text_size(12).text_color(t.accent)
          .hover((s) => s.bg(t.raised)).on_click((_e, cx) => this.loadCommits(cx, false))
          .child(this.loadingCommits ? "Loading…" : "Load more commits"))));
  }

  fileRow(f, index, t) {
    const selected = this.page === "files" && index === this.fileIndex;
    const color = f.status === "D" ? t.ansi1 : f.status === "A" ? t.ansi2 : t.foreground;
    return h_flex().id(`history-file-${f.path}`).h(ROW).w_full().px(10).gap(8).items_center().bg(selected ? t.selected : t.surface)
      .child(div().w(14).flex_none().text_size(11).font_semibold().text_color(color).child(f.status))
      .child(div().flex_1().min_w(0).truncate().text_color(f.status === "D" ? t.dim : t.foreground).child(basename(f.path)))
      .child(div().flex_none().max_w(200).truncate().text_size(11).text_color(t.dim).child(f.path))
      .when(!f.binary, (e) => e.child(div().flex_none().text_size(11).text_color(t.ansi2).child(`+${f.add}`)).child(div().flex_none().text_size(11).text_color(t.ansi1).child(`-${f.del}`)))
      .when(f.binary, (e) => e.child(div().flex_none().text_size(11).text_color(t.dim).child("binary")));
  }

  renderFiles(t, cx) {
    const list = v_virtual_list("history-files-list", this.files.length + 1, ROW, (i) => String(i), (range) => {
      const rows = [];
      for (let i = range.start; i < range.end; i++) {
        rows.push(i ? this.fileRow(this.files[i - 1], i, t) : h_flex().h(ROW).w_full().px(10).gap(8).items_center()
          .bg(this.fileIndex === 0 ? t.selected : t.surface)
          .child(icon("columns", 14).text_color(t.muted))
          .child(div().flex_1().min_w(0).font_semibold().child(`Review all files (${this.files.length})`)));
      }
      return rows;
    }).on_item_click((key, eventCx) => {
      this.fileIndex = Number(key); this.handle.focus(); this.openSelected(eventCx);
    }).track_scroll(this.fileScroll).size_full();
    return v_flex().flex_1().min_h(0).gap(2)
      .child(div().flex_1().min_h(0).relative().child(list).child(Scrollbar.vertical("history-files-list").viewport_from_layout().absolute().inset_0()))
      .when(!this.files.length && !this.loadingFiles, (e) => e.child(div().p(12).text_color(t.dim).child("No changed files")))
      .when(this.loadingFiles, (e) => e.child(div().p(12).text_color(t.dim).child("Loading files…")));
  }

  render(cx) {
    const t = theme();
    const title = this.page === "commits" ? "Commit history" : (this.commit ? `${this.commit.short} · ${this.commit.subject}` : "Commit");
    const body = this.page === "commits" ? this.renderCommits(t, cx) : this.renderFiles(t, cx);
    const message = this.page === "commits" ? this.error : this.filesError;
    return v_flex().id("history-view").size_full().min_h(0).p(12).gap(8).bg(t.surface).text_color(t.foreground).text_size(13)
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.keyEvent(e, cx))
      .child(h_flex().items_center().gap(6)
        .when(this.page === "files", (e) => e.child(iconButton("history-back", "undo", t, (cx) => this.back(cx), { title: "Back to commits" })))
        .child(icon("file-diff", 14).text_color(t.muted))
        .child(div().flex_1().min_w(0).truncate().font_semibold().child(title))
        .when(this.page === "commits", (e) => e.child(iconButton("history-refresh", "refresh", t, (cx) => this.loadCommits(cx, true), { title: "Refresh" })))
        .child(iconButton("history-close", "minus", t, () => closeOverlay(this.overlay), { title: "Close" })))
      .child(div().text_size(11).text_color(t.dim).truncate().child(this.source?.root ?? ""))
      .when(Boolean(message), (e) => e.child(div().text_size(12).text_color(t.ansi1).child(message)))
      .child(body)
      .child(shortcutFooter("history", this.context(), (action, cx) => this.perform(action, cx), t));
  }
}
