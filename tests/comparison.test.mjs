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
 props:()=>({}),shared:()=>entry,read:async path=>{try{return readFileSync(path,'utf8');}catch{return null;}},
 exec:async (_command,args,{cwd})=>{try{return {code:0,stdout:execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}),stderr:''};}catch(e){return {code:e.status??1,stdout:String(e.stdout??''),stderr:String(e.stderr??'')};}}
};
registerHooks({resolve(specifier,context,next){return ['herdr','gpui-kit','gpui-base'].includes(specifier)?{url:`test:${specifier}`,shortCircuit:true}:next(specifier,context);},load(url,context,next){
 if(url==='test:herdr')return {format:'module',shortCircuit:true,source:`
 const h=globalThis.__comparisonHost;
 export const props=h.props,shared=h.shared,exec=h.exec,readTextFile=h.read;
 export const spaces=()=>[],panes=()=>[],focused=()=>null,setShared=()=>{},watchFolder=()=>{},theme=()=>({}),settings=()=>({}),run=()=>{},agents=()=>[],hc=()=>{};`};
 if(url==='test:gpui-kit')return {format:'module',shortCircuit:true,source:'export class View {} export const div=()=>{},svg=()=>{},image=()=>{};'};
 if(url==='test:gpui-base')return {format:'module',shortCircuit:true,source:'export const v_flex=()=>{},h_flex=()=>{},Scrollbar={},v_virtual_list=()=>{},TextareaState={},Textarea={};'};
 return next(url,context);
}});
const {DiffTab}=await import('../mods/tabbed-changes/diff.js');
const root=mkdtempSync(join(tmpdir(),'herdr-origin-'));
const run=args=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']});
const git=async args=>run(args);
try {
 run(['init','-b','main']);run(['config','user.name','Test']);run(['config','user.email','test@example.invalid']);
 writeFileSync(join(root,'tracked.txt'),'base\n');writeFileSync(join(root,'deleted.txt'),'remove me\n');run(['add','.']);run(['commit','-m','base']);
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
 writeFileSync(join(root,'staged.txt'),'staged only\n');run(['add','staged.txt']);
 const patch=await git(C.comparisonArgs(base));
 assert.match(patch,/-base/);assert.match(patch,/\+committed/);assert.match(patch,/\+local/);
 assert.ok(run(['ls-files','--others','--exclude-standard']).includes('new.txt'));
 const tab=new DiffTab();
 const remote=await C.resolveOrigin(git,'origin/main');
 const loaded=await tab.loadAll(git,root,null,remote);
 for(const path of ['tracked.txt','committed.txt','staged.txt','deleted.txt'])assert.ok(loaded.some(f=>f.path===path),path);
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
 // A branch called "origin/main" must not shadow the remote-tracking ref.
 run(['branch','origin/main']);assert.equal((await C.resolveOrigin(git,'origin/main')).sha,base);
 run(['update-ref','-d','refs/remotes/origin/main']);
 await assert.rejects(()=>C.resolveOrigin(git,'origin/main'),/origin\/main/);
} finally {rmSync(root,{recursive:true,force:true});}
console.log('origin comparison ok');
