// Optional, reproducible helper benchmark. This is not a live UI/FPS measurement.
import {execFileSync} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import * as current from '../mods/tabbed-changes/comment-model.js';
const source=execFileSync('git',['show','efdc50b:mods/tabbed-changes/comment-model.js'],{encoding:'utf8'});
const previous=await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const repository={root:'/benchmark',on:null};
const contexts=Array.from({length:20000},(_,i)=>({source:repository,path:'large.js',line:i+1,side:'new',code:`line ${i+1}`}));
const notes=Array.from({length:50},(_,i)=>({...contexts[i*100],text:'review',id:String(i)}));
const run=model=>{const begin=performance.now();let outdated=0;for(let pass=0;pass<4;pass++)for(const note of notes)outdated+=Number(model.isOutdated(note,contexts));assert.equal(outdated,0);return performance.now()-begin;};
const before=run(previous),after=run(current);
console.log(JSON.stringify({fixture:'20,000 lines; 50 comments; 4 badge passes',baselineCommit:'efdc50b',beforeMs:Number(before.toFixed(2)),afterMs:Number(after.toFixed(2)),note:'Helper benchmark only; no live UI speedup inferred.'},null,2));
