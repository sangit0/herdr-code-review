// Opening things in tabs: the reusable preview diff, pinned reviews, file previews,
// and the commit-history dialog. Editor handoff lives in editor.js.
import { run, spaces, shared, setShared, openOverlay, panes, focused } from "herdr";
import { basename } from "./git.js";

export const MOD = "tabbed-changes";
export const VIEW_KEY = "tabbed-changes.view";   // { [spaceId]: { view, tab, pane?, at } } -> what the preview diff shows
export const OPEN_KEY = "tabbed-changes.open";   // "pane" (default): a split pane beside the focused one; "tab": a tab of its own
export const openMode = () => (shared(OPEN_KEY) === "tab" ? "tab" : "pane");

export const activeSpace = () => spaces().find((s) => s.active);
const tabIds = (spaceId) => new Set(spaces().find((s) => s.id === spaceId)?.tabs.map((t) => t.id) ?? []);

// `run` returns nothing, so find the tab it made by what appeared in the space.
function newTab(spaceId, args) {
  const before = tabIds(spaceId);
  run("tab.new", { space: spaceId, ...args });
  return [...tabIds(spaceId)].find((id) => !before.has(id)) ?? null;
}

// A view is { source, mode, file?, comparison?, commit?: {sha, short, subject} }.
export function previewView(spaceId) { return shared(VIEW_KEY)?.[spaceId]?.view ?? null; }

// The pane to split beside: the focused one if it is in `tab`, else the tab's last pane.
function paneBeside(tab) {
  const f = focused(), all = panes().filter((p) => p.tab === tab);
  return all.find((p) => p.pane === f?.pane)?.pane ?? all.at(-1)?.pane ?? null;
}

// The live diff pane of a preview entry. `run("pane.split")` returns nothing and the pane appears a moment later,
// so an entry made in pane mode may not know its pane id yet: then it is the one mod pane of ours in that tab.
function diffPaneOf(entry) {
  if (entry?.pane) return panes().find((p) => p.pane === entry.pane) ?? null;
  return entry?.paneMode ? panes().find((p) => p.tab === entry.tab && p.mod === MOD) ?? null : null;
}

// Pane mode (like herdr-gitview): the diff is a split pane beside the one you are working in, not a tab, so the
// terminal stays visible, the pane can be zoomed (cmd-shift-enter) and the panel keeps the keyboard. One diff pane
// per space; later clicks only change what it shows. Returns { pane, created } or null when it cannot split.
function showDiffInPane(space, view) {
  const tab = focused()?.tab ?? space.tabs.find((t) => t.active)?.id ?? null;
  if (!tab) return null;
  const all = { ...(shared(VIEW_KEY) ?? {}) };
  const entry = all[space.id], at = Date.now();
  const live = diffPaneOf(entry);
  if (live && live.tab === tab) {
    all[space.id] = { ...entry, pane: live.pane, view, at };
    setShared(VIEW_KEY, all);
    return { pane: live.pane, created: false };
  }
  if (live) run("pane.close", { pane: live.pane }); // it is in another tab, where you cannot see it
  const beside = paneBeside(tab);
  if (!beside) return null;
  const before = new Set(panes().map((p) => p.pane));
  run("pane.split", { direction: "right", pane: beside, mod: MOD, props: { role: "diff", space: space.id, paneMode: true } });
  const made = panes().find((p) => !before.has(p.pane) && p.mod === MOD)?.pane ?? null;
  // `tab` set, `pane` maybe not yet: the diff pane claims it itself on start (DiffTab.claim).
  all[space.id] = { view, tab, pane: made, paneMode: true, at };
  setShared(VIEW_KEY, all);
  return { pane: made, created: true };
}

// Single click: show `view` in the space's one reusable diff (a split pane, or a tab in "tab" mode), making it if it
// is gone. `pinned`: a tab of its own that nothing else reuses.
export function showDiff(view, { pinned = false, select = true } = {}) {
  const space = activeSpace();
  if (!space) return null;
  const name = view.commit
    ? `Commit ${view.commit.short ?? view.commit.sha?.slice(0, 8) ?? "review"}${view.mode === "file" && view.file?.path ? ` · ${basename(view.file.path)}` : ""}`
    : pinned && view.mode === "file" && view.file?.path ? `Changes · ${basename(view.file.path)}` : "Changes";
  if (pinned) {
    newTab(space.id, { name, mod: MOD, props: { role: "diff", pinned: true, view } });
    return null;
  }
  if (openMode() === "pane") {
    const shown = showDiffInPane(space, view);
    if (shown) return shown;
  }
  const all = { ...(shared(VIEW_KEY) ?? {}) };
  const entry = all[space.id];
  const live = !entry?.pane && entry?.tab && space.tabs.find((t) => t.id === entry.tab);
  all[space.id] = { view, tab: live ? live.id : null, at: Date.now() };
  setShared(VIEW_KEY, all);
  if (live) {
    run("tab.rename", { id: live.id, name });
    if (select) run("tab.select", { id: live.id });
    return { tab: live.id, created: false };
  }
  const id = newTab(space.id, { name, mod: MOD, props: { role: "diff", space: space.id } });
  if (id) setShared(VIEW_KEY, { ...(shared(VIEW_KEY) ?? {}), [space.id]: { view, tab: id, at: all[space.id].at } });
  return { tab: id, created: true };
}

// The diff pane this space shows (pane mode), if it is still there; `z` and the footer zoom it.
export function diffPane() {
  const space = activeSpace();
  return space ? diffPaneOf(shared(VIEW_KEY)?.[space.id]) : null;
}
export function zoomDiff() {
  const pane = diffPane();
  if (pane) run("pane.zoom", { pane: pane.pane });
}

// Keeps the preview tab's view current without stealing focus (staging moved the file, say).
export function updatePreview(view) {
  const space = activeSpace(), entry = space && shared(VIEW_KEY)?.[space.id];
  if (!entry) return;
  setShared(VIEW_KEY, { ...shared(VIEW_KEY), [space.id]: { ...entry, view } });
}

// A read-only tab on one file.
export function openFileTab(source, path, line) {
  const space = activeSpace();
  if (!space) return;
  run("tab.new", { name: basename(path), space: space.id, mod: MOD, props: { role: "file", file: path, root: source.root, on: source.on ?? null, line: line ?? null } });
}

export function showHistory(source) {
  if (!source?.root) return;
  openOverlay({ mod: MOD, kind: "dialog", width: 740, height: 660, props: { role: "history", source } });
}

