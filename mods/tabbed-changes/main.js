// Herdr Code Review: a VS Code-style Source Control panel whose files open in tabs.
// One mod: Source Control, file/diff review tabs, history and review dialogs.
import { View } from "gpui-kit";
import { props, nextCommand } from "herdr";
import { BranchPicker } from "./branch-picker.js";
import { CommentOverview } from "./comment-overview.js";
import { ReviewPaneHeader } from "./pane-header.js";
import { Panel } from "./panel.js";
import { DiffTab } from "./diff.js";
import { FileTab } from "./viewer.js";
import { HistoryView } from "./history-view.js";

export default class ScmTabs extends View {
  init(_props, cx) {
    const role = props()?.role;
    this.role = role ?? "panel";
    this.part = role === "branches" ? new BranchPicker() : role === "comments" ? new CommentOverview() :
      role === "pane-header" ? new ReviewPaneHeader() : role === "history" ? new HistoryView() :
      role === "diff" ? new DiffTab() : role === "file" ? new FileTab() : new Panel();
    this.part.init(cx);
    cx.spawn(async cx => {
      for (;;) {
        const command = await nextCommand();
        if (this.closed) return;
        if (command === "focus" || command === `${this.role}.focus`) {
          if (typeof this.part.focus === "function") this.part.focus();
          else this.part.handle?.focus();
        } else if (command.startsWith(`${this.role}.key:`)) {
          const keystroke = command.slice(this.role.length + 5), parts = keystroke.split("-");
          this.part.keyEvent?.({ key: parts.at(-1), keystroke, viaApp: true, modifiers: {
            platform: parts.includes("cmd"), control: parts.includes("ctrl"), alt: parts.includes("alt"), shift: parts.includes("shift"),
          } }, cx);
        }
      }
    });
  }
  close(cx) { this.closed = true; return this.part.close?.(cx); }
  render(cx) { return this.part.render(cx); }
}
