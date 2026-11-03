// A retained inline thread: mounted beneath its code line, never in a separate panel.
import { View, div } from 'gpui-kit';
import { v_flex, h_flex, TextareaState, Textarea } from 'gpui-base';
import { spaces, agents, shared, setShared, theme, hc } from 'herdr';
import { makeComment, forSource, forLine, deliverComments } from './comment-model.js';

const KEY = 'tabbed-changes.comments.v1';
const allNotes = () => shared(KEY) ?? [];
export const commentsFor = source => forSource(allNotes(), source);
export const lineComments = context => forLine(allNotes(), context);
export const INLINE_HEIGHT = 300;
const button = (id, text, t, action, active = false) => div().id(id).px(8).py(4).rounded(5).cursor_pointer()
  .bg(active ? t.selected : t.raised).text_color(active ? t.accent : t.foreground).text_size(12)
  .hover(s=>s.bg(t.hover)).on_mouse_down('left',(_e,cx)=>cx.stop_propagation())
  .on_click((_e,cx)=>{cx.stop_propagation();action(cx);}).child(text);

export class InlineComments extends View {
  init(p, cx) {
    this.context=p?.context ?? null; this.space=p?.space ?? spaces().find(s=>s.active)?.id;
    this.drafts = {};
    this.target=null; this.busy=false; this.error=null; this.note=null;
    this.input=TextareaState.new({placeholder:'Comment on this line…',rows:2});
    this.input.on('change',(_e,cx)=>{this.drafts[this.draftKey()]=this.input.value();cx.notify();});
  }
  draftKey() { return JSON.stringify(this.context); }
  update(p) {
    this.drafts[this.draftKey()]=this.input.value();
    this.context=p?.context ?? null; this.space=p?.space ?? this.space;
    this.error=null; this.note=null; this.input.set_value(this.drafts[this.draftKey()] ?? '');
  }
  save(cx) {
    if(this.busy)return;
    try {
      const note=makeComment(this.context,this.input.value(),`${Date.now()}-${Math.random().toString(36).slice(2)}`);
      setShared(KEY,[...allNotes(),note]); this.drafts[this.draftKey()]=''; this.input.set_value(''); this.error=null; this.note='Saved on this line.';
    } catch(e) { this.error=String(e.message ?? e); }
    cx.notify();
  }
  send(note,cx) {
    if(this.busy||note.sentAt)return;
    const target=this.target;
    this.busy=true; this.error=null; this.note=null; cx.notify();
    cx.spawn(async cx=>{
      try {
        await deliverComments({notes:[note],target,space:this.space,agents:agents(),send:args=>hc(args)});
        const sentAt=Date.now();
        setShared(KEY,allNotes().map(n=>n.id===note.id?{...n,sentAt,sentTo:target}:n));
        this.note=`Sent line and comment to ${target}.`;
      } catch(e) { this.error=String(e.message ?? e); }
      finally { this.busy=false; cx.notify(); }
    });
  }
  render(cx) {
    const t=theme(), context=this.context, notes=lineComments(context);
    const targets=agents().filter(a=>a.space===this.space);
    return v_flex().w_full().h(INLINE_HEIGHT).flex_none().min_h(0).p(10).gap(6).bg(t.surface).border(1).border_color(t.accent).text_color(t.foreground).text_size(12)
      .on_mouse_down('left',(_e,cx)=>cx.stop_propagation())
      .child(div().font_semibold().child(context?`Comment · ${context.path}:${context.line} (${context.side})`:'Select a line'))
      .child(Textarea.new(this.input).w_full().text_size(12))
      .child(h_flex().gap(6).items_center()
        .child(button('line-comment-save','Save comment',t,cx=>this.save(cx)))
        .child(div().text_size(11).text_color(t.dim).child('Saved here · Send submits immediately')))
      .child(h_flex().flex_wrap().gap(4).children(targets.map(a=>button(`line-agent-${a.address}`,
        `${a.program?.name ?? a.app ?? 'Agent'} · ${a.address} · ${a.status}`,t,cx=>{if(!this.busy){this.target=a.address;cx.notify();}},this.target===a.address)))
        .when(!targets.length,el=>el.child(div().text_color(t.dim).child('No Herdr agents in this space. Your comment can still be saved.'))))
      .child(v_flex().id('line-thread').flex_1().min_h(0).gap(5).overflow_y_scrollbar()
        .children(notes.map(n=>v_flex().p(6).gap(3).rounded(4).bg(t.raised)
          .child(div().child(n.text))
          .child(h_flex().gap(6).items_center()
            .child(n.sentAt?div().text_color(t.ansi2).child(`Sent to ${n.sentTo}`):button(`line-send-${n.id}`,this.busy?'Sending…':'Send line + comment',t,cx=>this.send(n,cx),true))
            .child(button(`line-delete-${n.id}`,'Delete',t,cx=>{if(!this.busy){setShared(KEY,allNotes().filter(x=>x.id!==n.id));cx.notify();}}))))))
      .when(Boolean(this.error),el=>el.child(div().text_color(t.ansi1).child(this.error)))
      .when(Boolean(this.note),el=>el.child(div().text_color(t.ansi2).child(this.note)));
  }
}
