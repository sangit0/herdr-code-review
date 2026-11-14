import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {splitPatch} from '../mods/tabbed-changes/git.js';
const H=await import('../mods/tabbed-changes/history.js');

// --- empty/unborn repository -------------------------------------------------------------------
{
  const root=mkdtempSync(join(tmpdir(),'herdr-history-empty-'));
  const run=(args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']});
  const git=async args=>run(args);
  try {
    run(['init','-b','main']);
    const result=await H.listCommits(git);
    assert.deepEqual(result,{commits:[],hasMore:false});
  } finally {rmSync(root,{recursive:true,force:true});}
}

// --- a real history: root commit, ordinary commits, a divergent merge, nested paths, binaries --
{
  const root=mkdtempSync(join(tmpdir(),'herdr-history-'));
  // Commits in a fast test loop can land in the same wall-clock second; pin strictly increasing
  // author/committer dates so default (date-order) `git log` traversal is deterministic.
  let clock=1700000000;
  const tick=()=>{clock+=60;return {GIT_AUTHOR_DATE:`@${clock} +0000`,GIT_COMMITTER_DATE:`@${clock} +0000`};};
  const run=(args,env)=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe'],env:{...process.env,...env}});
  const commit=(args)=>run(['-c','commit.gpgsign=false','-c','core.hooksPath=/dev/null',...args],tick());
  const git=async args=>run(args);
  try {
    run(['init','-b','main']);run(['config','user.name','Test']);run(['config','user.email','test@example.invalid']);
    mkdirSync(join(root,'dir','sub'),{recursive:true});
    writeFileSync(join(root,'root.txt'),'root\n');
    writeFileSync(join(root,'deleteme.txt'),'bye\n');
    writeFileSync(join(root,'dir','sub','file.txt'),'hello\n');
    run(['add','.']);commit(['commit','-m','root commit']);
    const rootSha=run(['rev-parse','HEAD']).trim();

    writeFileSync(join(root,'root.txt'),'root\nmore\n');
    writeFileSync(join(root,'added.txt'),'new file\n');
    writeFileSync(join(root,'binary.bin'),Buffer.from([0,1,2,3,255,254]));
    run(['rm','deleteme.txt']);
    run(['add','.']);commit(['commit','-m','second commit']);
    const secondSha=run(['rev-parse','HEAD']).trim();

    run(['switch','-c','feature']);
    writeFileSync(join(root,'dir','sub','file.txt'),'feature change\n');
    run(['add','.']);commit(['commit','-m','feature change']);
    const featureSha=run(['rev-parse','HEAD']).trim();

    run(['switch','main']);
    writeFileSync(join(root,'root.txt'),'root\nmore\nmain-diverge\n');
    run(['add','.']);commit(['commit','-m','main diverges']);
    const mainSha=run(['rev-parse','HEAD']).trim();

    commit(['merge','--no-ff','-m','merge feature','feature']);
    const mergeSha=run(['rev-parse','HEAD']).trim();

    // A later, independent, whitespace-only change: isolates the ignoreWhitespace option.
    writeFileSync(join(root,'root.txt'),'root\nmore\nmain-diverge   \n');
    run(['add','.']);commit(['commit','-m','trailing whitespace']);
    const whitespaceSha=run(['rev-parse','HEAD']).trim();

    // --- pagination -----------------------------------------------------------------------------
    const all=await H.listCommits(git,{limit:50});
    assert.equal(all.commits.length,6);
    assert.equal(all.hasMore,false);
    assert.equal(all.commits[0].sha,whitespaceSha);
    assert.ok(all.commits[0].short.length<all.commits[0].sha.length);
    assert.deepEqual(all.commits[0].parents,[mergeSha]);
    assert.equal(all.commits.at(-1).sha,rootSha);
    assert.deepEqual(all.commits.at(-1).parents,[]);
    const merged=all.commits.find(c=>c.sha===mergeSha);
    assert.deepEqual(merged.parents,[mainSha,featureSha]);
    assert.match(merged.subject,/merge feature/);
    assert.equal(typeof merged.author,'string');
    assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(merged.date));

    const page1=await H.listCommits(git,{limit:2,skip:0});
    assert.equal(page1.commits.length,2);
    assert.equal(page1.hasMore,true);
    assert.equal(page1.commits[0].sha,whitespaceSha);
    const page2=await H.listCommits(git,{limit:2,skip:4});
    assert.equal(page2.commits.length,2);
    assert.equal(page2.hasMore,false);
    assert.equal(page2.commits.at(-1).sha,rootSha);

    // --- root commit: diffed against the empty tree, nested paths intact -----------------------
    const byPath=files=>Object.fromEntries(files.map(f=>[f.path,f]));
    const rootByPath=byPath(await H.commitFiles(git,rootSha));
    assert.equal(rootByPath['root.txt'].status,'A');
    assert.equal(rootByPath['dir/sub/file.txt'].status,'A');
    assert.equal(rootByPath['dir/sub/file.txt'].add,1);
    assert.equal(rootByPath['deleteme.txt'].status,'A');

    // --- ordinary commit: add/modify/delete, and a binary file ----------------------------------
    const secondFiles=byPath(await H.commitFiles(git,secondSha));
    assert.equal(secondFiles['root.txt'].status,'M');
    assert.equal(secondFiles['root.txt'].add,1);
    assert.equal(secondFiles['added.txt'].status,'A');
    assert.equal(secondFiles['deleteme.txt'].status,'D');
    assert.equal(secondFiles['binary.bin'].binary,true);
    assert.equal(secondFiles['binary.bin'].add,0);
    assert.equal(secondFiles['binary.bin'].del,0);

    // --- merge commit: compared to its FIRST parent, not a combined/second-parent diff ----------
    const mergeFiles=byPath(await H.commitFiles(git,mergeSha));
    assert.ok(!('root.txt' in mergeFiles),'root.txt only changed on the first-parent side; merge vs first parent shows no difference');
    assert.equal(mergeFiles['dir/sub/file.txt'].status,'M');
    assert.equal(Object.keys(mergeFiles).length,1);

    // --- nested path delimiters: path-scoped patch touches only the requested file --------------
    const nestedPatch=await H.commitPatch(git,featureSha,{path:'dir/sub/file.txt'});
    assert.match(nestedPatch,/dir\/sub\/file\.txt/);
    assert.match(nestedPatch,/\+feature change/);
    const scopedPatch=await H.commitPatch(git,secondSha,{path:'root.txt'});
    assert.doesNotMatch(scopedPatch,/added\.txt/);
    assert.doesNotMatch(scopedPatch,/deleteme\.txt/);

    // Context expansion must reveal the requested surrounding lines, not only change argv flags.
    const contextLines=Array.from({length:41},(_,i)=>`line ${i+1}`);
    writeFileSync(join(root,'context.txt'),contextLines.join('\n')+'\n');
    run(['add','context.txt']);commit(['commit','-m','context baseline']);
    contextLines[20]='changed line 21';
    writeFileSync(join(root,'context.txt'),contextLines.join('\n')+'\n');
    run(['add','context.txt']);commit(['commit','-m','middle-line change']);
    const contextSha=run(['rev-parse','HEAD']).trim();
    const compact=splitPatch(await H.commitPatch(git,contextSha,{path:'context.txt'}))[0].lines;
    const expanded=splitPatch(await H.commitPatch(git,contextSha,{path:'context.txt',context:10}))[0].lines;
    const unchanged=lines=>lines.filter(line=>line.startsWith(' ')).map(line=>line.slice(1));
    assert.deepEqual(unchanged(compact),['line 18','line 19','line 20','line 22','line 23','line 24']);
    assert.deepEqual(unchanged(expanded),[
      ...Array.from({length:10},(_,i)=>`line ${i+11}`),
      ...Array.from({length:10},(_,i)=>`line ${i+22}`),
    ]);
    assert.deepEqual(expanded.filter(line=>line.startsWith('+')||line.startsWith('-')),['-line 21','+changed line 21']);

    // --- whitespace-only edits can be hidden ---------------------------------------------------
    const whitespaceDiff=await H.commitPatch(git,whitespaceSha,{path:'root.txt',ignoreWhitespace:false});
    assert.match(whitespaceDiff,/@@/);
    const whitespaceIgnored=await H.commitPatch(git,whitespaceSha,{path:'root.txt',ignoreWhitespace:true});
    assert.doesNotMatch(whitespaceIgnored,/@@/);

    // --- immutability: uncommitted work after the fact never leaks into a past commit's view -----
    writeFileSync(join(root,'root.txt'),'UNCOMMITTED SURPRISE\n');
    writeFileSync(join(root,'added.txt'),'also uncommitted\n');
    const stillSecondFiles=byPath(await H.commitFiles(git,secondSha));
    assert.deepEqual(stillSecondFiles,secondFiles);
    const stillScopedPatch=await H.commitPatch(git,secondSha,{path:'root.txt'});
    assert.equal(stillScopedPatch,scopedPatch);
    assert.doesNotMatch(stillScopedPatch,/UNCOMMITTED SURPRISE/);
    run(['checkout','--','root.txt']);run(['clean','-fd','added.txt']);

    // --- invalid/unknown commits propagate instead of silently returning empty results ----------
    await assert.rejects(()=>H.commitFiles(git,'not-a-sha'),/Invalid commit/i);
    await assert.rejects(()=>H.commitPatch(git,'0123'),/Invalid commit/i);
    await assert.rejects(()=>H.commitFiles(git,'f'.repeat(40)),error=>error.status===128);
  } finally {rmSync(root,{recursive:true,force:true});}
}

// NUL-delimited metadata and paths must survive control characters without splitting records.
{
  const root=mkdtempSync(join(tmpdir(),'herdr-history-delimiters-'));
  const run=args=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']});
  const git=async args=>run(args);
  try {
    await assert.rejects(()=>H.listCommits(git),error=>error.status===128);
    run(['init','-b','main']);
    run(['config','commit.gpgsign','false']);run(['config','core.hooksPath','/dev/null']);
    const author='Author \x1f with \x1e separators',subject='Subject \x1e with \x1f separators';
    run(['config','user.name',author]);run(['config','user.email','test@example.invalid']);
    const name='with space\tand\nnewline.txt';
    writeFileSync(join(root,name),'original\n');
    run(['add','--',name]);run(['commit','-m',subject]);
    const sha=run(['rev-parse','HEAD']).trim();
    const {commits,hasMore}=await H.listCommits(git,{limit:1});
    assert.deepEqual(commits.map(c=>({sha:c.sha,subject:c.subject,author:c.author,parents:c.parents})),[{sha,subject,author,parents:[]}]);
    assert.equal(hasMore,false);
    assert.deepEqual(await H.commitFiles(git,sha),[{path:name,status:'A',add:1,del:0,binary:false}]);
    const patch=splitPatch(await H.commitPatch(git,sha,{path:name}));
    assert.equal(patch[0].path,name);assert.equal(patch[0].add,1);assert.equal(patch[0].deleted,false);
    run(['rm','--',name]);run(['commit','-m','delete unusual pathname']);
    const deletedSha=run(['rev-parse','HEAD']).trim();
    const deleted=splitPatch(await H.commitPatch(git,deletedSha,{path:name}));
    assert.equal(deleted[0].path,name);assert.equal(deleted[0].deleted,true);assert.equal(deleted[0].del,1);
  } finally {rmSync(root,{recursive:true,force:true});}
}
console.log('commit history pagination, merge/root diffing and immutable patches ok');
