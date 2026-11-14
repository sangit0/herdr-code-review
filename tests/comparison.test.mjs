import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const C=await import('../mods/tabbed-changes/comparison.js');
// Stub only native host APIs; exercise the production diff loader against real Git.
const {registerHooks}=await import('node:module');
let entry=null, savedNotes=[];
globalThis.__comparisonHost={
 props:()=>({}),shared:key=>key==='tabbed-changes.view'?entry:key==='tabbed-changes.comments.v1'?savedNotes:null,
 setShared:(key,value)=>{if(key==='tabbed-changes.comments.v1')savedNotes=value;},
 read:async path=>{try{return readFileSync(path,'utf8');}catch{return null;}},
 exec:async (command,args,{cwd}={})=>{
  if(command==='/bin/sh')return {code:0,stderr:'',stdout:JSON.stringify({id:1,jsonrpc:'2.0',result:{version:1,value:globalThis.__comparisonHost.reviewDocument}})};
  await globalThis.__comparisonHost.beforeExec?.(args);
  try{return {code:0,stdout:execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}),stderr:''};}
  catch(e){return {code:e.status??1,stdout:String(e.stdout??''),stderr:String(e.stderr??'')};}
 }
};
registerHooks({resolve(specifier,context,next){return ['herdr','gpui-kit','gpui-base'].includes(specifier)?{url:`test:${specifier}`,shortCircuit:true}:next(specifier,context);},load(url,context,next){
 if(url==='test:herdr')return {format:'module',shortCircuit:true,source:`
 const h=globalThis.__comparisonHost;
 export const props=h.props,shared=h.shared,exec=h.exec,readTextFile=h.read;
 export const appHome=()=>'/tmp/herdr-comparison-home',notify=()=>{};
 export const openOverlay=()=>{},spaces=()=>h.spaces?.()??[],setShared=(key,value)=>h.setShared?.(key,value);
 export const panes=()=>h.panes?.()??[],focused=()=>h.focused?.()??null,watchFolder=()=>{},theme=()=>({}),settings=()=>({}),run=(...args)=>h.run?.(...args),agents=()=>[],hc=()=>{};`};
 if(url==='test:gpui-kit')return {format:'module',shortCircuit:true,source:'export class View {} export const div=()=>{},svg=()=>{},image=()=>{};'};
 if(url==='test:gpui-base')return {format:'module',shortCircuit:true,source:`
 export const v_flex=()=>{},h_flex=()=>{},Scrollbar={},v_virtual_list=()=>{},h_resizable=()=>{},resizable_panel=()=>{},Textarea={},Input={};
 export const InputState={new:()=>{let value='',handlers={};return {on:(name,fn)=>handlers[name]=fn,value:()=>value,set_value:v=>{value=v;handlers.change?.({},globalThis.__comparisonHost.context);},focus(){this.focused=true;},release(){}};}};
 export const TextareaState={new:()=>({...InputState.new(),set_auto_grow(){}})};
 export const VirtualListScrollHandle={new:()=>({positions:[],scroll_to_item(i){this.positions.push(i);},release(){}})};
 `};
 return next(url,context);
}});
const {DiffTab}=await import('../mods/tabbed-changes/diff.js');
const {FileTab}=await import('../mods/tabbed-changes/viewer.js');
const {InlineComments}=await import('../mods/tabbed-changes/comments.js');
const {Panel}=await import('../mods/tabbed-changes/panel.js');
const {invalidateReads}=await import('../mods/tabbed-changes/repository.js');
const root=mkdtempSync(join(tmpdir(),'herdr-origin-'));
const run=args=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']});
const git=async args=>run(args);
try {
 run(['init','-b','main']);run(['config','user.name','Test']);run(['config','user.email','test@example.invalid']);
 writeFileSync(join(root,'tracked.txt'),'base\n');writeFileSync(join(root,'deleted.txt'),'remove me\n');writeFileSync(join(root,'spacing.txt'),'const x = 1;\n');writeFileSync(join(root,'contextspace.txt'),'const x = 1;\nold\n');run(['add','.']);run(['commit','-m','base']);
 const base=run(['rev-parse','HEAD']).trim();
 await assert.rejects(()=>C.resolveOrigin(git,'origin'),/origin\/main.*origin\/master/);
 run(['update-ref','refs/remotes/origin/master',base]);
 assert.deepEqual(await C.resolveOrigin(git,'origin'),{name:'origin/master',sha:base});
 run(['update-ref','refs/remotes/origin/main',base]);
 assert.equal((await C.resolveOrigin(git,'origin')).name,'origin/main');
 run(['symbolic-ref','refs/remotes/origin/HEAD','refs/remotes/origin/master']);
 assert.equal((await C.resolveOrigin(git,'origin')).name,'origin/master');
 assert.equal((await C.resolveOrigin(git,'origin/main')).name,'origin/main');
 await assert.rejects(()=>C.resolveOrigin(git,'--bad'),/comparison/i);
 writeFileSync(join(root,'upstream.txt'),'main only\n');
 run(['add','upstream.txt']);run(['commit','-m','main advances']);
 const upstream=run(['rev-parse','HEAD']).trim();
 run(['switch','-c','feature',base]);
 writeFileSync(join(root,'tracked.txt'),'committed\n');writeFileSync(join(root,'committed.txt'),'committed only\n');rmSync(join(root,'deleted.txt'));run(['add','.']);run(['commit','-m','branch change']);
 writeFileSync(join(root,'tracked.txt'),'committed\nlocal\n');writeFileSync(join(root,'new.txt'),'untracked\n');
 writeFileSync(join(root,'spacing.txt'),'const   x = 1;\n');writeFileSync(join(root,'contextspace.txt'),'const   x = 1;\nnew\n');
 writeFileSync(join(root,'staged.txt'),'staged only\n');run(['add','staged.txt']);
 const patch=await git(C.comparisonArgs(base));
 assert.match(patch,/-base/);assert.match(patch,/\+committed/);assert.match(patch,/\+local/);
 assert.ok(run(['ls-files','--others','--exclude-standard']).includes('new.txt'));
 const tab=new DiffTab();
 const remote=await C.resolveOrigin(git,'origin/main');
 const loaded=await tab.loadAll(git,root,null,remote);
 for(const path of ['tracked.txt','committed.txt','staged.txt','deleted.txt'])assert.ok(loaded.some(f=>f.path===path),path);
 const ignored=await tab.loadAll(git,root,null,remote,{context:10,ignoreWhitespace:true});
 assert.ok(!ignored.some(f=>f.path==='spacing.txt'));
 const localIgnored=await tab.loadOne(git,root,null,{path:'spacing.txt',group:'changes'},null,{context:30,ignoreWhitespace:true});
 assert.ok(localIgnored[0].lines.includes('No text diff available'));
 const untracked=loaded.find(f=>f.path==='new.txt');assert.equal(untracked.fresh,true);
 const one=await tab.loadOne(git,root,null,untracked,remote);assert.match(one[0].lines.join('\n'),/untracked/);
 // A new preview request must override earlier toolbar state.
 entry={at:2,view:{source:{root,on:null},mode:'file',file:{path:'tracked.txt',group:'changes'}}};
 Object.assign(tab,{pinned:false,space:'s',requestAt:1,comparisonOverride:'origin/master',modeOverride:'all',collapsed:new Set(),watched:null});
 // The production shared lookup expects entries keyed by space.
 const actual=entry;entry={s:actual};
 let builds=0,notifications=0;tab.watch=()=>{};tab.build=()=>builds++;
 const tasks=[],cx={spawn:fn=>tasks.push(fn(cx)),notify:()=>notifications++};
 tab.load(cx);await Promise.all(tasks);
 assert.equal(tab.comparison,'local');assert.equal(tab.mode,'file');assert.equal(tab.error,null);
 assert.equal(tab.files[0].path,'tracked.txt');
 tab.load(cx,true);await Promise.all(tasks);
 assert.equal(builds,1,'an identical diff refresh must not rebuild its rows');assert.equal(notifications,1,'an unchanged refresh must not redraw');
 // Exercise the real native-view state logic with host-only input/scroll handles.
 const viewTasks=[],viewCx={focus_handle:()=>({focused:false,focus(){this.focused=true;}}),new:()=>({set_props(){},release(){}}),timer:{every(){}},spawn:fn=>viewTasks.push(fn(viewCx)),notify(){}};
 globalThis.__comparisonHost.context=viewCx;
 let drained=0;const drain=async()=>{while(drained<viewTasks.length){const pending=viewTasks.slice(drained);drained=viewTasks.length;await Promise.all(pending);}};
 const review=new DiffTab();review.init(viewCx);assert.equal(review.handle.focused,true,'a newly opened diff must receive keyboard shortcuts');review.pinned=true;review.pinnedView={source:{root,on:null},mode:'all'};review.watch=()=>{};
 review.load(viewCx);await drain();assert.ok(review.display.length>0);
 const snapshot=review.display;review.load(viewCx,true);await drain();assert.equal(review.display,snapshot,'unchanged reload retains the built display');
 const gitBeforeNavigation=review.dataStamp;
 review.moveChange(1,viewCx);assert.equal(review.scroll.positions.at(-1),review.changeIndices[0]);
 review.collapsed.add('tracked.txt');review.build();review.searchInput.set_value('committed');assert.ok(!review.collapsed.has('tracked.txt'),'search opens folded files');assert.ok(review.matches.length>0);review.moveMatch(1,viewCx);assert.equal(review.cursor,review.matches[0]);
 review.navigateFile('file:tracked.txt',viewCx);assert.equal(review.display[review.cursor].path,'tracked.txt');assert.equal(review.dataStamp,gitBeforeNavigation);
 // Comment selections must survive context-only changes in the same review.
 const selectable=review.display.findIndex(r=>r.path==='tracked.txt'&&r.kind==='+');
 const editorTabs=[];
 globalThis.__comparisonHost.spaces=()=>[{id:'s',active:true,tabs:[]}];
 globalThis.__comparisonHost.run=(command,args)=>{if(command==='tab.new')editorTabs.push(args);};
 review.editorClick=true;review.rowClicked(selectable,viewCx);review.editorClick=false;
 assert.deepEqual(editorTabs.map(tab=>tab.argv.slice(-3)),[['nvim','+2',join(root,'tracked.txt')]]);
 review.rowClicked(selectable,viewCx);const savedSelection={...review.selection};
 assert.equal(review.selectedRow, null, 'a single code click leaves the thread closed');
 review.clicks = 2;review.rowClicked(selectable,viewCx);review.clicks = 1;
 assert.equal(review.selectionMode, 'row', 'double click selects the whole row');
 assert.equal(review.selectedRow, null, 'double click leaves the thread closed');
 review.clickedX = 105;review.rowClicked(selectable,viewCx);review.clickedX = undefined;
 assert.equal(review.selectedRow, review.display[selectable], 'clicking the comment gutter opens the thread');
 const heightBeforeSave = review.sizes[selectable];
 const thread = new InlineComments();
 const threadProps = { context: review.selection, references: review.refs.new, focus: true };
 thread.init(threadProps, viewCx);
 assert.equal(thread.composing, true);
 thread.input.set_value('Saved feedback');
 thread.save(viewCx);
 assert.equal(thread.composing, false, 'saving immediately shows the saved comment');
 assert.equal(savedNotes[0].text, 'Saved feedback');
 assert.equal(thread.input.value(), '');
 review.resizeRows();
 assert.equal(review.sizes[selectable], heightBeforeSave, 'the comment card stays within the virtual row after saving');
 thread.update(threadProps);
 assert.equal(thread.composing, false, 'clicking a saved badge opens the notes');
 thread.update({...threadProps, compose: true});
 assert.equal(thread.composing, true, 'the keyboard shortcut still opens the composer');
 review.setDiffOption('contextLines',10,viewCx);await drain();
 assert.equal(review.selection?.code,savedSelection.code,'context expansion must retain a surviving selection');
 assert.equal(review.selection?.line,savedSelection.line);
 review.setDiffOption('contextLines',3,viewCx);await drain();
 // File metadata polls should not rebuild an unchanged comment child.
 const file=new FileTab();file.init(viewCx);Object.assign(file,{file:join(root,'tracked.txt'),source:{root,on:null},watch:()=>{}});
 file.load(viewCx);await drain();
 file.editorClick=true;file.selectLine(1,viewCx);file.editorClick=false;
 assert.deepEqual(editorTabs.at(-1)?.argv.slice(-3),['nvim','+2',join(root,'tracked.txt')]);
 file.selectLine(0,viewCx);
 assert.equal(file.selected, null, 'a file line click leaves the thread closed');
 file.clicks = 2;file.selectLine(0,viewCx);file.clicks = 1;
 assert.equal(file.selectionVisible, true);
 assert.equal(file.selected, null, 'double click selects a file row without opening the thread');
 file.clickedX = 55;file.selectLine(0,viewCx);file.clickedX = undefined;
 assert.equal(file.selected, 0, 'the file gutter opens the selected comment');
 let childUpdates=0;file.thread.set_props=()=>childUpdates++;
 const contexts=file.references();file.metadataDirty=true;file.load(viewCx);await drain();
 assert.equal(file.references(),contexts,'file contexts are reused');assert.equal(childUpdates,0,'unchanged metadata must not rebuild the comment child');
 // Rapid A -> B -> A while B is loading must rebuild A after the view was cleared.
 invalidateReads();
 let releaseSlow,beginSlow;const slowStarted=new Promise(resolve=>beginSlow=resolve);
 globalThis.__comparisonHost.beforeExec=async args=>{if(args.includes('--unified=10')){beginSlow();await new Promise(resolve=>releaseSlow=resolve);}};
 review.setDiffOption('contextLines',10,viewCx);await slowStarted;
 review.setDiffOption('contextLines',3,viewCx);releaseSlow();await drain();
 globalThis.__comparisonHost.beforeExec=null;
 assert.ok(review.display.length>0,'returning to the original option must not leave an empty diff');
 assert.equal(review.contextLines,3);
 // The clicked half determines the comment target, including when both sides share a row.
 review.startLayout='split';review.build();
 const paired=review.display.findIndex(row=>row.path==='contextspace.txt'&&row.l?.text==='old'&&row.r?.text==='new');
 assert.ok(paired>=0);
 review.clickedSide='old';review.editorClick=true;review.rowClicked(paired,viewCx);review.editorClick=false;
 assert.deepEqual(editorTabs.at(-1)?.argv.slice(-3),['nvim','+2',join(root,'contextspace.txt')]);
 review.clickedSide='old';review.rowClicked(paired,viewCx);
 assert.equal(review.selection.side,'old');
 assert.equal(review.selection.code,'old');
 review.openComment(viewCx);assert.equal(review.selection.side,'old','the shortcut keeps the clicked side');
 review.contentWidth=600;review.clickedX=350;
 review.clickedSide='new';review.rowClicked(paired,viewCx);review.clickedX=undefined;
 assert.equal(review.selection.side,'new');
 assert.equal(review.selection.code,'new');
 assert.equal(review.selectedRow,review.display[paired],'the right gutter opens the current version');
 const selected = review.selectedRow;
 const longPair = review.display.findIndex(row => row.path === 'contextspace.txt' && row.l?.text.startsWith('const'));
 assert.ok(longPair >= 0);
 assert.equal(review.wrapLines, false, 'wrapping is off by default');
 review.wrapLines = true;
 review.viewportWidth = 240;
 review.resizeRows();
 assert.ok(review.baseSizes[longPair] > 20, 'the virtual row grows with the taller wrapped side');
 assert.equal(review.selectedRow, selected, 'wrapping does not move the comment to a different source line');
 review.wrapLines = false;
 review.resizeRows();
 assert.equal(review.baseSizes[longPair], 20, 'unwrapped rows return to one visual line');
 review.wrapLines = true;
 review.viewportWidth = 600;
 const previous = review.display.findIndex(row => row.path === 'contextspace.txt' && row.r?.n === 1);
 assert.ok(previous >= 0);
 review.clickedX = 480;
 review.startDrag(paired, { position: { x: 480, y: 100 } });
 review.moveDrag(previous, { position: { x: 160, y: 80 } }, viewCx);
 assert.equal(review.selection.side, 'new', 'dragging across the divider keeps the side where the drag started');
 assert.deepEqual([review.selection.line, review.selection.endLine], [1, 2]);
 assert.equal(review.selectedRow, null, 'dragging selects the range without opening a comment');
 review.rowClicked(previous, viewCx);
 assert.equal(review.selection.endLine, 2, 'the click on mouse release preserves the range');
 review.openComment(viewCx);
 assert.equal(review.selectedRow, review.display[paired], 'the comment opens under the end of the range');
 review.drag = null; review.didDrag = false; review.clickedX = undefined;
 review.startLayout='inline';review.build();
 const removed=review.display.findIndex(row=>row.path==='contextspace.txt'&&row.kind==='-');
 review.rowClicked(removed,viewCx);
 assert.equal(review.selection.side,'old','an inline deletion always targets the original code');
 review.setDiffOption('ignoreWhitespace',true,viewCx);await drain();
 assert.ok(!review.refs.old.some(c=>c.path==='contextspace.txt'&&c.line===1),'Git -w original context is unavailable for exact comments');
 assert.equal(review.refs.new.find(c=>c.path==='contextspace.txt'&&c.line===1).code,'const   x = 1;');
 assert.equal(review.refs.old.find(c=>c.path==='contextspace.txt'&&c.line===2).code,'old');
 review.setComparison('origin/main',viewCx);await drain();
 assert.ok(!review.refs.old.some(c=>c.path==='contextspace.txt'&&c.line===1));
 assert.equal(review.refs.old.find(c=>c.path==='contextspace.txt'&&c.line===2).revision,base);
 run(['update-ref','refs/remotes/origin/main',upstream]);invalidateReads();
 review.load(viewCx,true);await drain();
 assert.equal(review.error,null);
 assert.ok(!review.files.some(f=>f.path==='upstream.txt'),'a file added only on main must not appear as a branch deletion');
 for(const path of ['tracked.txt','committed.txt','staged.txt','deleted.txt','new.txt']){
  assert.ok(review.files.some(f=>f.path===path),`review still includes ${path}`);
 }
 assert.equal(review.refs.old.find(c=>c.path==='contextspace.txt'&&c.line===2).revision,base);
 run(['add','contextspace.txt']);invalidateReads();
 review.pinnedView={source:{root,on:null},mode:'file',file:{path:'contextspace.txt',group:'staged'}};review.comparisonOverride='local';review.modeOverride=null;review.fileOverride=null;
 review.load(viewCx);await drain();
 assert.ok(!review.refs.old.some(c=>c.path==='contextspace.txt'&&c.line===1));
 assert.equal(review.refs.old.find(c=>c.path==='contextspace.txt'&&c.line===2).code,'old');
 // A branch called "origin/main" must not shadow the remote-tracking ref.
 run(['branch','origin/main']);assert.equal((await C.resolveOrigin(git,'origin/main')).sha,upstream);
 run(['update-ref','-d','refs/remotes/origin/main']);
 await assert.rejects(()=>C.resolveOrigin(git,'origin/main'),/origin\/main/);
 // The single checkout-adjacent control must open the exact detected base.
 let selectedView=null;globalThis.__comparisonHost.spaces=()=>[{id:'s',active:true,tabs:[]}];
 globalThis.__comparisonHost.setShared=(key,value)=>{if(key==='tabbed-changes.view'){entry=value;selectedView=value.s.view;}};
 const panel=new Panel();Object.assign(panel,{root,on:null,originBase:await C.resolveOrigin(git,'origin')});
 panel.compareOrigin(viewCx);assert.equal(selectedView.comparison,'origin/master');
 run(['update-ref','refs/remotes/origin/main',base]);run(['symbolic-ref','refs/remotes/origin/HEAD','refs/remotes/origin/main']);
 panel.originBase=await C.resolveOrigin(git,'origin');panel.compareOrigin(viewCx);assert.equal(selectedView.comparison,'origin/main');
 // A reloaded panel must resolve the focused review's repository, not the space's default folder.
 const otherRoot=mkdtempSync(join(tmpdir(),'herdr-other-repository-'));
 try {
  execFileSync('git',['init','-b','main'],{cwd:otherRoot,stdio:'ignore'});
  writeFileSync(join(otherRoot,'space-only.txt'),'untracked in the space repository\n');
  const otherRepositoryRoot=execFileSync('git',['rev-parse','--show-toplevel'],{cwd:otherRoot,encoding:'utf8'}).trim();
  const repositoryRoot=run(['rev-parse','--show-toplevel']).trim();
  const host=globalThis.__comparisonHost;
  host.spaces=()=>[{id:'review-space',active:true,machine:null,folder:otherRoot,tabs:[{id:'review-tab',active:true}]}];
  host.panes=()=>[{pane:'review-pane',tab:'review-tab',mod:'tabbed-changes',terminal:null,cwd:null}];
  host.focused=()=>({space:'review-space',tab:'review-tab',pane:'review-pane',terminal:null,cwd:null});
  entry={'review-space':{tab:'unrelated-preview',view:{source:{root:otherRoot,on:null}}}};
  for(const reviewProps of [
   {role:'diff',pinned:true,view:{source:{root,on:null},mode:'file',file:{path:'tracked.txt',group:'changes'}}},
   {role:'file',root,on:null,file:join(root,'tracked.txt')},
   {role:'diff',space:'review-space'},
   {role:'panel'},
   {},
  ]) {
   if(reviewProps.role==='diff'&&!reviewProps.pinned)entry={'review-space':{tab:null,view:{source:{root,on:null},mode:'file',file:{path:'tracked.txt',group:'changes'}}}};
   host.reviewDocument={spaces:[{id:'review-space',folder:otherRoot,tabs:[{id:'review-tab',root:{id:'review-row',type:'row',children:[{id:'review-pane',type:'block',content:{mod:'tabbed-changes',props:reviewProps}}]}}]}]};
   const sourcePanel=new Panel();sourcePanel.watch=()=>{};
   try {
    sourcePanel.init(viewCx);await drain();
    const standalone=!reviewProps.role||reviewProps.role==='panel';
    assert.equal(sourcePanel.root,standalone?otherRepositoryRoot:repositoryRoot,`${reviewProps.role??'default panel'} must load its own repository`);
    assert.equal(sourcePanel.error,null);
    assert.equal(sourcePanel.loading,false);
    if(standalone)assert.deepEqual(sourcePanel.changes.map(file=>file.path),['space-only.txt']);
    else {
     assert.ok(sourcePanel.changes.some(file=>file.path==='tracked.txt'));
     assert.ok(sourcePanel.staged.some(file=>file.path==='staged.txt'));
    }
   } finally {sourcePanel.close();}
  }
 } finally {rmSync(otherRoot,{recursive:true,force:true});}
} finally {rmSync(root,{recursive:true,force:true});}
console.log('origin comparison ok');
