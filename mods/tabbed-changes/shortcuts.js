// A compact, wrapping row of keyboard shortcuts at the bottom of a review surface (panel, diff,
// file or history). Shows exactly the keys that apply right now; clicking one runs the same
// action a keypress would (reviewAction in shortcut-model.js owns what each key means — this only
// decides what is visible and clickable for a given surface/context).
import { div } from "gpui-kit";
import { h_flex } from "gpui-base";

// Pure, so it is testable without a host: { key, label, action, enabled }[]. `action: null` marks
// an informational entry (e.g. "navigate") that is never clickable.
export function footerActions(surface, context = {}) {
  const canEdit = Boolean(context.canEdit);
  const canStage = Boolean(context.canStage);
  const canUnstage = Boolean(context.canUnstage);
  const canOpen = Boolean(context.canOpen);
  const canHistory = context.canHistory !== false;

  if (surface === "history") {
    const openLabel = context.openLabel ?? (context.historyMode === "files" ? "Open file" : "Open commit");
    return [
      { key: "↑ ↓ / j k", label: "Navigate", action: null, enabled: true },
      { key: "Enter", label: openLabel, action: "open", enabled: canOpen },
      { key: "l / Esc", label: context.historyMode === "files" ? "Commits" : "Close", action: "back", enabled: true },
    ];
  }

  // "z" only appears where a diff pane can be zoomed (the context says so by setting canZoom).
  const zoom = "canZoom" in context ? [{ key: "z", label: context.zoomed ? "Unzoom" : "Zoom", action: "zoom", enabled: Boolean(context.canZoom) }] : [];
  const shared = [
    { key: "Enter", label: surface === "panel" ? "Edit" : `Edit in ${context.editorLabel ?? "Neovim"}`, action: "edit", enabled: canEdit },
    { key: "l", label: "History", action: "history", enabled: canHistory },
  ];
  if (surface === "panel") {
    return [
      { key: "j k", label: "Move", action: null, enabled: true },
      ...shared,
      { key: "s", label: "Stage", action: "stage", enabled: canStage },
      { key: "u", label: "Unstage", action: "unstage", enabled: canUnstage },
      ...zoom,
    ];
  }
  return [...shared, ...zoom]; // diff | file
}

function keycap(t, item, onAction) {
  const clickable = Boolean(item.action) && item.enabled;
  return h_flex().id(`shortcut-${item.action ?? "info"}-${item.key}`).flex_none().items_center().gap(5)
    .opacity(item.enabled ? 1 : 0.45)
    .when(clickable, (e) => e.cursor_pointer().hover((s) => s.opacity(0.85))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); onAction(item.action, cx); }))
    .child(div().px(5).h(18).flex().items_center().justify_center().rounded(4)
      .bg(t.raised).border(1).border_color(t.border).text_size(11).font_semibold().text_color(t.foreground).child(item.key))
    .child(div().text_size(11).text_color(t.muted).child(item.label));
}

// `onAction(action, eventCx)` runs exactly what pressing the matching key would. Disabled and
// informational entries never call it.
export function shortcutFooter(surface, context, onAction, theme, { active = true } = {}) {
  // Dimmed while this view does not hold the keyboard: the keys only work after you click it (or move into it).
  return h_flex().id("review-shortcuts").flex_none().w_full().px(10).py(6).gap(11).items_center()
    .flex_wrap().border_t(1).border_color(theme.border).opacity(active ? 1 : 0.62)
    .children(footerActions(surface, context).map((item) => keycap(theme, item, onAction)));
}
