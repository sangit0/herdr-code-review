// Automated native materialization. No desktop input, Git writes, network or agent sends.
import {mkdtempSync,cpSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
const root=dirname(dirname(fileURLToPath(import.meta.url)));
const scratch=mkdtempSync(join(tmpdir(),'herdr-review-native-')),app=join(scratch,'mod');
try {
 cpSync(join(root,'mods/tabbed-changes'),app,{recursive:true,filter:path=>!['gpui-kit.d.ts','herdr.d.ts','jsconfig.json'].some(name=>path.endsWith('/'+name))});
 const check=()=>process.stdout.write(execFileSync('herdr-app',['check',app],{encoding:'utf8',stdio:['ignore','pipe','inherit'],timeout:30000}));
 check();
 const diff=split=>`import {View} from 'gpui-kit';import {DiffTab} from './diff.js';
 export default class extends View {
 init(_p,cx){this.part=new DiffTab();this.part.init(cx);this.part.pinned=true;this.part.startLayout=${JSON.stringify(split?'split':'inline')};
 this.part.pinnedView={source:{root:'/tmp/herdr-native-fixture',on:null},mode:'all'};
 this.part.files=[{path:'src/demo.js',lines:['@@ -1,2 +1,2 @@','-const oldName = 1;','+const newName = 2;',' same'],add:1,del:1},{path:'README.md',lines:['@@ -1 +1 @@','-old','+new'],add:1,del:1}];
 this.part.loadedSig=this.part.sig();this.part.shownSig=this.part.sig();this.part.shownScope=this.part.scopeSig();this.part.build();this.part.searchOpen=true;this.part.searchInput.set_value('new');
 this.part.selection=this.part.refs.new.find(c=>c.path==='src/demo.js'&&c.line===1);this.part.selectedRow=this.part.display.find(r=>r.path==='src/demo.js'&&(r.next===1||r.r?.n===1));this.part.updateThread(false);this.part.resizeRows();
 }
 render(cx){return this.part.render(cx);}}
 `;
 for(const split of [false,true]){writeFileSync(join(app,'main.js'),diff(split));check();}
 writeFileSync(join(app,'main.js'),`import {View} from 'gpui-kit';import {FileTab} from './viewer.js';
 export default class extends View {init(_p,cx){this.part=new FileTab();this.part.init(cx);Object.assign(this.part,{file:'/tmp/native/demo.js',source:{root:'/tmp/native',on:null},ready:true,loading:false,lines:['const demo = 1;','second line'],fileWidth:400});this.part.referenceRows=this.part.lines.map((code,i)=>({source:this.part.source,path:'demo.js',line:i+1,side:'new',code}));this.part.selection=this.part.referenceRows[0];this.part.selected=0;this.part.updateThread(false);}render(cx){return this.part.render(cx);}}`);
 check();
 writeFileSync(join(app,'main.js'),`import {View} from 'gpui-kit';import {BranchPicker} from './branch-picker.js';
 export default class extends View {init(_p,cx){this.part=new BranchPicker();this.part.init(cx);this.part.branches=[{ref:'refs/heads/main',name:'main',kind:'local',current:true},{ref:'refs/remotes/origin/demo',name:'origin/demo',kind:'remote'}];}render(cx){return this.part.render(cx);}}`);
 check();
 console.log('Native checks: panel, inline diff, split diff, file/comment, branch picker passed.');
} finally {rmSync(scratch,{recursive:true,force:true});}
