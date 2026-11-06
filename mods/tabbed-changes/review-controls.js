// Controls are built during render; virtual rows only describe data and visuals.
import {div} from 'gpui-kit';
import {h_flex,v_flex,Input,v_virtual_list,Scrollbar} from 'gpui-base';
import {iconButton,toolButton,icon,fileIcon} from './ui.js';
export function reviewToolbar(view,t) {
  const moreContext = view.contextLines > 3;
  // Narrow pane: icon-only buttons (labels stay as tooltips) so the toolbar is never cut off.
  const compact = view.viewportWidth + (view.mode === 'all' && view.showFiles ? 250 : 0) < 1000;
  return h_flex().h(30).flex_none().px(8).gap(4).items_center().border_b(1).border_color(t.border)
    .when(view.mode==='all',el=>el.child(iconButton('toggle-files','file-tree',t,cx=>{view.showFiles=!view.showFiles;cx.notify();},{active:view.showFiles,title:'Changed file navigator'})))
    .child(iconButton('previous-change','arrow-up',t,cx=>view.moveChange(-1,cx),{title:'Previous change (Alt+Up)'}))
    .child(iconButton('next-change','arrow-down',t,cx=>view.moveChange(1,cx),{title:'Next change (Alt+Down)'}))
    .child(div().id('change-count').text_size(11).text_color(t.dim).tooltip(view.commentHint()).child(`${view.changeIndices.length} changes`))
    .child(div().flex_1())
    .child(toolButton('word-highlights','columns','Words',t,cx=>{view.wordHighlight=!view.wordHighlight;cx.notify();},{active:view.wordHighlight,compact}))
    .child(toolButton('ignore-whitespace','rows','Ignore spaces',t,cx=>view.setDiffOption('ignoreWhitespace',!view.ignoreWhitespace,cx),{active:view.ignoreWhitespace,compact}))
    .child(toolButton('wrap-lines', 'rows', 'Wrap lines', t, cx => {
      view.wrapLines = !view.wrapLines;
      view.hx = 0;
      view.horizontalVersion++;
      view.commentPosition.inset = 0;
      cx.notify();
    }, { active: view.wrapLines, compact }))
    .child(toolButton('context-lines', moreContext ? 'arrow-up' : 'arrow-down',
      moreContext ? 'Show fewer lines' : 'Show more lines', t,
      cx => view.setDiffOption('contextLines', moreContext ? 3 : 10, cx), { compact }))
    .child(toolButton('diff-search','search','Find',t,cx=>view.openSearch(cx),{active:view.searchOpen,compact}));
}
export function searchBar(view,t) {
  return h_flex().h(34).flex_none().px(8).gap(5).items_center().border_b(1).border_color(t.border)
    .child(Input.new(view.searchInput).flex_1().min_w(0).h(26).px(6).bg(t.surface).border(1).border_color(t.input).rounded(3).text_size(12))
    .child(div().text_size(11).text_color(t.dim).child(view.searchQuery?`${view.matches.length} matches`:''))
    .child(iconButton('find-previous','arrow-up',t,cx=>view.moveMatch(-1,cx),{title:'Previous match (Shift+Enter)'}))
    .child(iconButton('find-next','arrow-down',t,cx=>view.moveMatch(1,cx),{title:'Next match (Enter)'}))
    .child(iconButton('find-close','minus',t,cx=>{view.searchOpen=false;view.searchInput.set_value('');view.handle.focus();cx.notify();},{title:'Close search'}));
}
export function fileNavigator(view,t) {
  const nodes=view.treeNodes;
  const ROW=24,active=n=>n.kind==='file'&&n.path===view.navFile;
  const list=v_virtual_list('review-file-tree',nodes.length,ROW,i=>`${nodes[i].kind}:${nodes[i].path}`,range=>nodes.slice(range.start,range.end).map(n=>{
    const f=n.file,add=n.kind==='file'&&f?.add>0?f.add:0,del=n.kind==='file'&&f?.del>0?f.del:0;
    // Faint indent guides (one hairline per level), an accent bar on the active file, and +/- pinned right.
    return h_flex().h(ROW).w_full().pr(8).items_center().relative().bg(active(n)?t.selected:t.surface).hover(s=>s.bg(active(n)?t.selected:t.raised))
      .when(active(n),e=>e.child(div().absolute().top(0).bottom(0).left(0).w(2).bg(t.accent)))
      .child(div().w(8).flex_none())
      .children(Array.from({length:n.depth},()=>div().w(12).h_full().flex_none().flex().justify_center().child(div().w(1).h_full().bg(t.border))))
      .child(div().w(16).flex_none().flex().items_center().justify_center()
        .child(n.kind==='folder'?icon(n.closed?'chevron-right':'chevron-down',12).text_color(t.dim):fileIcon(n.path,14)))
      .child(div().w(4).flex_none())
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(n.kind==='folder'?t.muted:t.foreground).when(active(n),e=>e.font_medium()).child(n.name))
      .when(add>0,e=>e.child(div().flex_none().ml(6).text_size(10).text_color(t.ansi2+'d0').child('+'+add)))
      .when(del>0,e=>e.child(div().flex_none().ml(4).text_size(10).text_color(t.ansi1+'d0').child('\u2212'+del)));
  }))
    .on_item_click((key,cx)=>view.navigateFile(key,cx)).size_full();
  return v_flex().size_full().min_h(0).bg(t.surface)
    .child(div().px(8).py(6).text_size(10).font_semibold().text_color(t.muted).child(`CHANGED FILES · ${view.files.length}`))
    .child(div().px(6).pb(5).child(Input.new(view.fileInput).h(26).w_full().px(5).bg(t.background).border(1).border_color(t.input).rounded(3).text_size(11)))
    .child(div().flex_1().min_h(0).relative().child(list).child(Scrollbar.vertical('review-file-tree').viewport_from_layout().absolute().inset_0()))
    .when(!nodes.length,el=>el.child(div().p(8).text_size(11).text_color(t.dim).child('No matching files')));
}
