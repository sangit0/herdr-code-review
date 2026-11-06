import { div, svg, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { tokenize, extOf } from "./highlight.js";
import { Memo } from "./read-cache.js";
import { splitTokens, wrapTokens } from "./review-model.js";
import { iconFor } from "./fileicons.js";

const syntax=new Memo(128,4096);

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
export function toolButton(id, name, label, t, onClick, { active, compact = false } = {}) {
  return h_flex().id(id).h(24).px(compact ? 6 : 8).gap(5).flex_none().items_center().rounded(6).cursor_pointer().text_size(12)
    .text_color(active ? t.accent : t.muted).when(active, (e) => e.bg(t.selected))
    .hover((s) => s.bg(t.raised).text_color(active ? t.accent : t.foreground))
    .on_click((_e, cx) => onClick(cx))
    .child(icon(name, 13)).when(!compact, e => e.child(div().child(label))).tooltip(label);
}

// One line of code with syntax colours.
export const CODE_ROW = 20;
export const CODE_CHAR_W = 7.2; // 0.6em of the 12px code font
export const COMMENT_GUTTER = 22;

// A virtual row uses native hover styling to reveal this glyph. Its list
// handles the click since deferred rows cannot register event listeners.
// The row and its gutter need IDs so GPUI retains their hover state.
export function commentGutter(t, count, stale, selected) {
  const color = stale ? t.ansi3 : t.accent;
  return div().id("comment-gutter").w(COMMENT_GUTTER).h(CODE_ROW).flex_none().flex().items_center().justify_center()
    .rounded(4).cursor_pointer().hover(style => style.bg(t.selected).text_color(t.accent))
    .when(count > 0 || selected, element => element.text_color(color))
    .when(count > 0, element => element.bg(color + "38"))
    .child(count ? h_flex().items_center()
      .child(icon("comment", count === 1 ? 16 : count > 9 ? 12 : 15))
      .when(count > 1, e => e.child(div().text_size(8).child(count > 9 ? "9+" : String(count)))) : "+");
}

export function inCommentGutter(x, start) {
  return x >= start && x < start + COMMENT_GUTTER;
}

// Blend two #rrggbb colours (alpha, if any, is dropped): `amount` of `b` into `a`.
export function mix(a, b, amount) {
  const ch = (hex, i) => parseInt(String(hex).replace('#', '').slice(i * 2, i * 2 + 2), 16);
  if (![a, b].every(c => /^#[0-9a-f]{6}/i.test(String(c)))) return a;
  const out = [0, 1, 2].map(i => Math.round(ch(a, i) + (ch(b, i) - ch(a, i)) * amount).toString(16).padStart(2, '0'));
  return '#' + out.join('');
}
// `changed` rows sit on a red/green tint: lift the dim grays (comments, punctuation) toward the text colour so they stay legible.
export function codeLine(text, path, t, spans=[], tone=t.accent, breaks=null, changed=false) {
  const ext = extOf(path ?? ""), color = { keyword: t.ansi5, string: t.ansi2, comment: changed ? mix(t.dim, t.foreground, 0.5) : t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi6, constant: t.ansi6, punct: changed ? mix(t.muted, t.foreground, 0.4) : t.muted };
  const tokens = splitTokens(syntax.get(`${ext}\0${text}`, () => tokenize(text, ext)), spans);
  const hang = (breaks?.hang ?? 0) * CODE_CHAR_W; // continuation rows hang in, as wrapBreaks reserved
  return v_flex().flex_1().min_w(0).overflow_hidden().text_color(t.foreground).children(wrapTokens(tokens, breaks).map((row, rowIndex) =>
    h_flex().w_full().h(CODE_ROW).flex_none().whitespace_nowrap()
      .when(rowIndex > 0 && hang > 0, e => e.child(div().w(hang).flex_none()))
      .children(row.map((tok) => div().flex_none().child(tok.text.replace(/\t/g, "    ")).when(Boolean(tok.kind), (e) => e.text_color(color[tok.kind]))
      .when(tok.kind === "keyword", (e) => e.font_semibold()).when(Boolean(tok.changed),e=>e.bg(tone+"52"))))));
}

// The file-type icon for a path (Material Icon Theme subset), in colour.
export const fileIcon = (path, size = 16) => image(`mods/tabbed-changes/icons/files/${iconFor(path)}.svg`).size(size).flex_none();
