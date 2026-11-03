// Tabbed Changes: a VS Code-style Source Control panel whose files open in tabs.
// One mod, three roles (props.role): the panel (default), the diff tab, and the file tab.
import { View } from "gpui-kit";
import { props } from "herdr";
import { Panel } from "./panel.js";
import { DiffTab } from "./diff.js";
import { FileTab } from "./viewer.js";

export default class ScmTabs extends View {
  init(_props, cx) {
    const role = props()?.role;
    this.part = role === "diff" ? new DiffTab() : role === "file" ? new FileTab() : new Panel();
    this.part.init(cx);
  }
  close() { this.part.close?.(); }
  render(cx) { return this.part.render(cx); }
}
