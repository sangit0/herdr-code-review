// Pure keyboard-to-action rules shared by every review surface (panel, diff, file, history). No
// Herdr imports, so this is testable in Node. Each view owns its own on_key_down and `props()`
// derived context, and asks reviewAction what (if anything) the keystroke means right now.
//
// context: { surface: "panel" | "diff" | "file" | "history", typing, canEdit, canStage,
//   canUnstage, canOpen, canHistory, historyMode }. All booleans default to falsy/enabled as
// noted below when absent, so a caller only needs to set what applies to it.
//
// Returns one of "previous", "next", "edit", "history", "zoom", "stage", "unstage", "open", "back", or
// null when the keystroke means nothing here (unhandled keys, modified chords and text input all
// fall through to null so the view's own handling, or the browser default, still runs).
function isModified(e) {
  const m = e && e.modifiers;
  return Boolean(m && (m.platform || m.control || m.alt || m.shift));
}

const SURFACES = new Set(["panel", "diff", "file", "history"]);

export function reviewAction(event, context = {}) {
  if (!event || context.typing || isModified(event)) return null;
  const key = event.key;
  const surface = context.surface;
  if (!SURFACES.has(surface)) return null;

  if (surface === "history") {
    if (key === "l" || key === "escape") return "back";
    if (key === "enter") return context.canOpen ? "open" : null;
    if (key === "j" || key === "down") return "next";
    if (key === "k" || key === "up") return "previous";
    return null;
  }

  // Working-tree surfaces (panel, diff, file): Enter opens the selection in the editor, and `l`
  // opens history, unless the caller says history does not apply here right now.
  if (key === "enter") return context.canEdit ? "edit" : null;
  if (key === "l") return context.canHistory === false ? null : "history";
  // `z` zooms the diff pane (pane mode), the keyboard twin of the pane header's zoom button and cmd-shift-enter.
  if (key === "z") return context.canZoom ? "zoom" : null;

  if (surface === "panel") {
    if (key === "j" || key === "down") return "next";
    if (key === "k" || key === "up") return "previous";
    if (key === "s") return context.canStage ? "stage" : null;
    if (key === "u") return context.canUnstage ? "unstage" : null;
  }

  return null;
}
