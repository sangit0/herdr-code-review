import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { closeOverlay, props, spaces, theme } from "herdr";
import { commentButton, commentsFor, idleCommentAgents, removeSavedComment, sendSavedComment } from "./comments.js";
import { lineLabel } from "./comment-model.js";
import { icon } from "./ui.js";

export class CommentOverview {
  init() {
    const config = props() ?? {};
    this.source = config.source;
    this.space = config.space ?? spaces().find(space => space.active)?.id;
    this.overlay = config.overlay;
    this.target = null;
    this.sending = null;
    this.message = null;
  }

  notes() {
    return this.source?.root ? commentsFor(this.source) : [];
  }

  send(id, cx) {
    if (this.sending) return;
    const note = this.notes().find(note => note.id === id);
    if (!note || note.sentAt) return;
    this.sending = id;
    this.message = null;
    cx.notify();
    cx.spawn(async cx => {
      try {
        await sendSavedComment(note, this.target, this.space);
        this.message = { text: "Comment and code sent to the agent." };
      } catch (error) {
        this.message = { text: String(error.message ?? error), error: true };
      } finally {
        this.sending = null;
        cx.notify();
      }
    });
  }

  remove(id, cx) {
    if (this.sending || !this.notes().some(note => note.id === id)) return;
    removeSavedComment(id);
    this.message = { text: "Comment removed." };
    cx.notify();
  }

  agentPicker(t, idle) {
    return h_flex().h(32).flex_none().min_w(0).gap(8).items_center()
      .child(div().flex_none().font_semibold().text_size(11).text_color(t.muted).child("Send to"))
      .child(div().id("review-comment-agents").flex_1().min_w(0).h_full().overflow_x_scrollbar()
        .child(idle.length ? h_flex().h_full().gap(5).items_center().children(idle.map(agent =>
          commentButton(`overview-agent-${agent.address}`,
            `${agent.program?.name ?? agent.app ?? "Agent"} · ${agent.address}`, t,
            cx => { this.target = agent.address; cx.notify(); },
            { active: this.target === agent.address, enabled: !this.sending }))) :
          div().h_full().flex().items_center().text_size(11).text_color(t.dim).child("No idle agent in this space")));
  }

  card(note, canSend, t) {
    const version = note.side === "old" ? note.base ?? "Original code" : "Current code";
    const location = `${note.path}:${lineLabel(note)}`;
    return v_flex().w_full().min_w(0).flex_none().p(10).gap(6).rounded(6).border(1).border_color(t.border).bg(t.background)
      .child(h_flex().gap(8).items_center()
        .child(icon("comment", 14).text_color(t.accent))
        .child(div().flex_1().min_w(0).truncate().font_semibold().child(location))
        .child(div().flex_none().text_size(11).text_color(t.muted).child(version)))
      .child(div().w_full().min_w(0).whitespace_normal().child(note.text))
      .child(h_flex().justify_end().gap(6)
        .child(commentButton(`overview-remove-${note.id}`, "Remove", t, cx => this.remove(note.id, cx), { enabled: !this.sending }))
        .child(note.sentAt ? div().text_size(11).text_color(t.ansi2).child(`Sent to ${note.sentTo}`) :
          commentButton(`overview-send-${note.id}`, this.sending === note.id ? "Sending…" : "Send to agent", t,
            cx => this.send(note.id, cx), { active: true, enabled: canSend })));
  }

  render() {
    const t = theme(), notes = this.notes(), idle = idleCommentAgents(this.space);
    const canSend = !this.sending && idle.some(agent => agent.address === this.target);
    return v_flex().size_full().min_h(0).p(14).gap(8).bg(t.surface).text_color(t.foreground).text_size(13)
      .child(h_flex().h(28).flex_none().gap(8).items_center()
        .child(icon("comment", 16).text_color(t.accent))
        .child(div().flex_1().min_w(0).font_semibold().child(`Review comments (${notes.length})`))
        .child(commentButton("overview-close", "Close", t, () => closeOverlay(this.overlay), { enabled: !this.sending })))
      .child(div().flex_none().truncate().text_size(11).text_color(t.dim).child(this.source?.root ?? ""))
      .when(notes.length > 0, e => e.child(this.agentPicker(t, idle)))
      .child(v_flex().id("review-comments-list").flex_1().min_h(0).gap(8).overflow_y_scrollbar()
        .when(!notes.length, e => e.child(div().p(12).text_color(t.muted).child("No saved comments in this repository.")))
        .children(notes.map(note => this.card(note, canSend, t))))
      .child(div().h(18).flex_none().text_size(11).truncate()
        .text_color(this.message?.error ? t.ansi1 : this.message ? t.ansi2 : t.dim)
        .child(this.message?.text ?? "Comments are saved locally until sent."));
  }
}
