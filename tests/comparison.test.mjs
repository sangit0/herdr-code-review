import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const C=await import('../mods/tabbed-changes/comparison.js').catch(()=>({}));
assert.equal(typeof C.resolveOrigin,'function','origin comparison resolver is required');
// Stub only native host APIs; exercise the production diff loader against real Git.
const {registerHooks}=await import('node:module');
let entry=null;
globalThis.__comparisonHost={
 props:()=>({}),shared:key=>key==='tabbed-changes.view'?entry:null,read:async path=>{try{return readFileSync(path,'utf8');}catch{return null;}},
 exec:async (_command,args,{cwd})=>{await globalThis.__comparisonHost.beforeExec?.(args);try{return {code:0,stdout:execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}),stderr:''};}catch(e){return {code:e.status??1,stdout:String(e.stdout??''),stderr:String(e.stderr??'')};}}
};
registerHooks({resolve(specifier,context,next){return ['herdr','gpui-kit','gpui-base'].includes(specifier)?{url:`test:${specifier}`,shortCircuit:true}:next(specifier,context);},load(url,context,next){
 if(url==='test:herdr')return {format:'module',shortCircuit:true,source:`
 const h=globalThis.__comparisonHost;
 export const props=h.props,shared=h.shared,exec=h.exec,readTextFile=h.read;
 export const spaces=()=>[],panes=()=>[],focused=()=>null,setShared=()=>{},watchFolder=()=>{},theme=()=>({}),settings=()=>({}),run=()=>{},agents=()=>[],hc=()=>{};`};
 if(url==='test:gpui-kit')return {format:'module',shortCircuit:true,source:'export class View {} export const div=()=>{},svg=()=>{},image=()=>{};'};
 if(url==='test:gpui-base')return {format:'module',shortCircuit:true,source:`
 export const v_flex=()=>{},h_flex=()=>{},Scrollbar={},v_virtual_list=()=>{},TextareaState={},Textarea={},Input={};
 export const InputState={new:()=>{let value='',handlers={};return {on:(name,fn)=>handlers[name]=fn,value:()=>value,set_value:v=>{value=v;handlers.change?.({},globalThis.__comparisonHost.context);},focus(){this.focused=true;},release(){}};}};
 export const VirtualListScrollHandle={new:()=>({positions:[],scroll_to_item(i){this.positions.push(i);},release(){}})};
 `};
 return next(url,context);
}});
const {DiffTab}=await import('../mods/tabbed-changes/diff.js');
const {FileTab}=await import('../mods/tabbed-changes/viewer.js');
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
 writeFileSync(join(root,'tracked.txt'),'committed\n');writeFileSync(join(root,'committed.txt'),'committed only\n');rmSync(join(root,'deleted.txt'));run(['add','.']);run(['commit','-m','branch change']);
 writeFileSync(join(root,'tracked.txt'),'committed\nlocal\n');writeFileSync(join(root,'new.txt'),'untracked\n');
 writeFileSync(join(root,'spacing.txt'),'const   x = 1;\n');writeFileSync(join(root,'contextspace.txt'),'const   x = 1;\nnew\n');
 writeFileSync(join(root,'staged.txt'),'staged only\n');run(['add','staged.txt']);
 const patch=await git(C.comparisonArgs(base));
 assert.ok(C.comparisonArgs(base,undefined,{context:10,ignoreWhitespace:true}).includes('--ignore-all-space'));
 assert.ok(C.comparisonArgs(base,undefined,{context:10}).includes('--unified=10'));
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
 const viewTasks=[],viewCx={focus_handle:()=>({focus(){}}),new:()=>({set_props(){},release(){}}),timer:{every(){}},spawn:fn=>viewTasks.push(fn(viewCx)),notify(){}};
 globalThis.__comparisonHost.context=viewCx;
 let drained=0;const drain=async()=>{while(drained<viewTasks.length){const pending=viewTasks.slice(drained);drained=viewTasks.length;await Promise.all(pending);}};
 const review=new DiffTab();review.init(viewCx);review.pinned=true;review.pinnedView={source:{root,on:null},mode:'all'};review.watch=()=>{};
 review.load(viewCx);await drain();assert.ok(review.display.length>0);
 const snapshot=review.display;review.load(viewCx,true);await drain();assert.equal(review.display,snapshot,'unchanged reload retains the built display');
 const gitBeforeNavigation=review.dataStamp;
 review.moveChange(1,viewCx);assert.equal(review.scroll.positions.at(-1),review.changeIndices[0]);
 review.collapsed.add('tracked.txt');review.build();review.searchInput.set_value('committed');assert.ok(!review.collapsed.has('tracked.txt'),'search opens folded files');assert.ok(review.matches.length>0);review.moveMatch(1,viewCx);assert.equal(review.cursor,review.matches[0]);
 review.navigateFile('file:tracked.txt',viewCx);assert.equal(review.display[review.cursor].path,'tracked.txt');assert.equal(review.dataStamp,gitBeforeNavigation);
 // Comment selections must survive context-only changes in the same review.
 const selectable=review.display.findIndex(r=>r.path==='tracked.txt'&&r.kind==='+');
 review.rowClicked(selectable,viewCx);const savedSelection={...review.selection};
 review.setDiffOption('contextLines',30,viewCx);await drain();
 assert.equal(review.selection?.code,savedSelection.code,'context expansion must retain a surviving selection');
 assert.equal(review.selection?.line,savedSelection.line);
 review.setDiffOption('contextLines',3,viewCx);await drain();
 // File metadata polls should not rebuild an unchanged comment child.
 const file=new FileTab();file.init(viewCx);Object.assign(file,{file:join(root,'tracked.txt'),source:{root,on:null},watch:()=>{}});
 file.load(viewCx);await drain();file.selectLine(0,viewCx);
 let childUpdates=0;file.thread.set_props=()=>childUpdates++;
 const contexts=file.references();file.metadataDirty=true;file.load(viewCx);await drain();
 assert.equal(file.references(),contexts,'file contexts are reused');assert.equal(childUpdates,0,'unchanged metadata must not rebuild the comment child');
 // Rapid A -> B -> A while B is loading must rebuild A after the view was cleared.
 let releaseSlow,beginSlow;const slowStarted=new Promise(resolve=>beginSlow=resolve);
 globalThis.__comparisonHost.beforeExec=async args=>{if(args.includes('--unified=10')){beginSlow();await new Promise(resolve=>releaseSlow=resolve);}};
 review.setDiffOption('contextLines',10,viewCx);await slowStarted;
 review.setDiffOption('contextLines',3,viewCx);releaseSlow();await drain();
 globalThis.__comparisonHost.beforeExec=null;
 assert.ok(review.display.length>0,'returning to the original option must not leave an empty diff');
 assert.equal(review.contextLines,3);
 review.setDiffOption('ignoreWhitespace',true,viewCx);await drain();
 assert.ok(!review.refs.old.some(c=>c.path==='contextspace.txt'&&c.line===1),'Git -w original context is unavailable for exact comments');
 assert.equal(review.refs.new.find(c=>c.path==='contextspace.txt'&&c.line===1).code,'const   x = 1;');
 assert.equal(review.refs.old.find(c=>c.path==='contextspace.txt'&&c.line===2).code,'old');
 review.setComparison('origin/main',viewCx);await drain();
 assert.ok(!review.refs.old.some(c=>c.path==='contextspace.txt'&&c.line===1));
 assert.equal(review.refs.old.find(c=>c.path==='contextspace.txt'&&c.line===2).revision,base);
 run(['add','contextspace.txt']);invalidateReads();
 review.pinnedView={source:{root,on:null},mode:'file',file:{path:'contextspace.txt',group:'staged'}};review.comparisonOverride='local';review.modeOverride=null;review.fileOverride=null;
 review.load(viewCx);await drain();
 assert.ok(!review.refs.old.some(c=>c.path==='contextspace.txt'&&c.line===1));
 assert.equal(review.refs.old.find(c=>c.path==='contextspace.txt'&&c.line===2).code,'old');
 // A branch called "origin/main" must not shadow the remote-tracking ref.
 run(['branch','origin/main']);assert.equal((await C.resolveOrigin(git,'origin/main')).sha,base);
 run(['update-ref','-d','refs/remotes/origin/main']);
 await assert.rejects(()=>C.resolveOrigin(git,'origin/main'),/origin\/main/);
} finally {rmSync(root,{recursive:true,force:true});}
console.log('origin comparison ok');
