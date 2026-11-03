import { div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { tokenize, extOf } from "./highlight.js";
import { iconFor } from "./fileicons.js";

export const DIR = "mods/tabbed-changes/icons";
export const icon = (name, size = 14) => svg(`${DIR}/${name}.svg`).size(size).flex_none();

// A square icon button. Presses never reach the row under it.
export function iconButton(id, name, t, onClick, { color, active, size = 22, title } = {}) {
  return div().id(id).w(size).h(size).flex_none().flex().items_center().justify_center().rounded(5).cursor_pointer()
    .text_color(active ? t.accent : color ?? t.muted)
    .when(active, (e) => e.bg(t.selected))
    .hover((s) => s.bg(t.raised).text_color(active ? t.accent : t.foreground))
    .when(Boolean(title), (e) => e.tooltip(title))
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); })
    .child(icon(name));
}

// An icon with a label, for a tab's header bar.
export function toolButton(id, name, label, t, onClick, { active } = {}) {
  return h_flex().id(id).h(24).px(8).gap(5).flex_none().items_center().rounded(6).cursor_pointer().text_size(12)
    .text_color(active ? t.accent : t.muted).when(active, (e) => e.bg(t.selected))
    .hover((s) => s.bg(t.raised).text_color(active ? t.accent : t.foreground))
    .on_click((_e, cx) => onClick(cx))
    .child(icon(name, 13)).child(div().child(label));
}

// One line of code with syntax colours.
export function codeLine(text, path, t) {
  const ext = extOf(path ?? ""), color = { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi6, constant: t.ansi6, punct: t.muted };
  return h_flex().flex_1().min_w(0).overflow_hidden().whitespace_nowrap()
    .children(tokenize(text, ext).map((tok) => div().flex_none().child(tok.text).when(Boolean(tok.kind), (e) => e.text_color(color[tok.kind]))
      .when(tok.kind === "keyword", (e) => e.font_semibold())));
}

// The file-type icon for a path (Material Icon Theme subset), in colour.
export const fileIcon = (path, size = 16) => image(`mods/tabbed-changes/icons/files/${iconFor(path)}.svg`).size(size).flex_none();
