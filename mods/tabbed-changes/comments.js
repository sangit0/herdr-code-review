// A retained inline thread: mounted beneath its code line, never in a separate panel.
import { View, div } from 'gpui-kit';
import { v_flex, h_flex, TextareaState, Textarea } from 'gpui-base';
import { spaces, agents, shared, setShared, theme, hc } from 'herdr';
import { makeComment, forSource, forLine, sendAndRemove, isOutdated, lineLabel } from './comment-model.js';

const KEY = 'tabbed-changes.comments.v1';
const allNotes = () => shared(KEY) ?? [];
export const commentsFor = source => forSource(allNotes(), source);
export const lineComments = context => forLine(allNotes(), context);
export const inlineHeight = context => lineComments(context).length ? 208 : 132;
const button = (id, text, t, action, active = false) => div().id(id).px(8).py(3).rounded(3).cursor_pointer()
  .bg(active ? t.selected : t.raised).text_color(active ? t.accent : t.foreground).text_size(12)
  .hover(s=>s.bg(t.hover)).on_mouse_down('left',(_e,cx)=>cx.stop_propagation())
  .on_click((_e,cx)=>{cx.stop_propagation();action(cx);}).child(text);

export class InlineComments extends View {
  init(p, cx) {
    this.context=p?.context ?? null; this.space=p?.space ?? spaces().find(s=>s.active)?.id;
    this.references=p?.references ?? [];
    this.drafts = {};
    this.target=null; this.busy=false; this.error=null; this.note=null;
    this.input=TextareaState.new({placeholder:'Comment on this line…',rows:2});
    this.input.on('change',(_e,cx)=>{this.drafts[this.draftKey()]=this.input.value();cx.notify();});
  }
  draftKey() { const c=this.context; return JSON.stringify(c?[c.source,c.path,c.line,c.endLine??c.line,c.side]:null); }
  update(p) {
    this.drafts[this.draftKey()]=this.input.value();
    this.context=p?.context ?? null; this.space=p?.space ?? this.space;
    this.references=p?.references ?? this.references;
    this.error=null; this.note=null; this.input.set_value(this.drafts[this.draftKey()] ?? '');
    if(p?.focus)this.input.focus();
  }
  save(cx) {
    if(this.busy)return;
    try {
      const note=makeComment(this.context,this.input.value(),`${Date.now()}-${Math.random().toString(36).slice(2)}`);
      setShared(KEY,[...allNotes(),note]); this.drafts[this.draftKey()]=''; this.input.set_value(''); this.error=null; this.note=null;
    } catch(e) { this.error=String(e.message ?? e); }
    cx.notify();
  }
  send(note,cx) {
    if(this.busy||note.sentAt)return;
    const target=this.target;
    this.busy=true; this.error=null; this.note=null; cx.notify();
    cx.spawn(async cx=>{
      try {
        await sendAndRemove({note,target,space:this.space,agents:agents(),send:args=>hc(args),read:allNotes,write:next=>setShared(KEY,next)});
        this.note=`Sent line and comment to ${target}.`;
      } catch(e) { this.error=String(e.message ?? e); }
      finally { this.busy=false; cx.notify(); }
    });
  }
  render(cx) {
    const t=theme(), context=this.context, notes=lineComments(context);
    const targets=agents().filter(a=>a.space===this.space);
    return v_flex().w_full().max_w(600).h(inlineHeight(context)).flex_none().min_h(0).px(10).py(6).gap(4)
      .bg(t.surface).border_l(2).border_color(t.accent).text_color(t.foreground).text_size(12)
      .on_mouse_down('left',(_e,cx)=>cx.stop_propagation())
      .child(h_flex().h(18).flex_none().items_center().justify_between()
        .child(div().font_semibold().text_color(t.muted).child(context?`Line ${lineLabel(context)} · ${context.side === 'old' ? 'original' : 'current'}`:'Comment'))
        .child(div().text_size(10).text_color(t.dim).child('Click line to collapse')))
      .when(notes.length>0,el=>el.child(v_flex().id('line-thread').h(72).flex_none().gap(4).overflow_y_scrollbar()
        .children(notes.map(n=>v_flex().px(6).py(3).gap(2).rounded(3).bg(t.raised)
          .when(isOutdated(n,this.references),el=>el.child(div().text_size(10).text_color(t.ansi3).child("Outdated · code changed since this comment")))
          .child(div().child(n.text))
          .child(h_flex().gap(6).items_center()
            .child(n.sentAt?div().text_size(10).text_color(t.ansi2).child(`Sent to ${n.sentTo}`):button(`line-send-${n.id}`,this.busy?'Sending…':'Send to agent',t,cx=>this.send(n,cx),true))
            .child(button(`line-delete-${n.id}`,'Delete',t,cx=>{if(!this.busy){setShared(KEY,allNotes().filter(x=>x.id!==n.id));cx.notify();}})))))))
      .child(div().h(38).flex_none().px(6).py(2).bg(t.background).border(1).border_color(t.input).rounded(3)
        .child(Textarea.new(this.input).w_full().text_size(12)))
      .child(h_flex().h(24).flex_none().gap(6).items_center()
        .child(div().flex_1().min_w(0).overflow_hidden().child(h_flex().gap(4).children(targets.map(a=>button(`line-agent-${a.address}`,
          `${a.program?.name ?? a.app ?? 'Agent'} · ${a.address}`,t,cx=>{if(!this.busy){this.target=a.address;cx.notify();}},this.target===a.address)))
          .when(!targets.length,el=>el.child(div().text_size(11).text_color(t.dim).child('No agent in this space')))))
        .child(button('line-comment-save','Add comment',t,cx=>this.save(cx),true)))
      .when(Boolean(this.error || this.note),el=>el.child(div().h(16).flex_none().text_size(11).truncate().text_color(this.error?t.ansi1:t.ansi2).child(this.error || this.note)))
      .when(!this.error && !this.note,el=>el.child(div().h(16).flex_none().text_size(10).text_color(t.dim).child('⌘⇧I comment · Shift-click to select a range')));
  }
}
