import assert from 'node:assert/strict';
const R=await import('../mods/tabbed-changes/read-cache.js').catch(()=>({}));
assert.equal(typeof R.ReadCache,'function','coalesced read cache is required');
let now=0,calls=0,release;
const cache=new R.ReadCache({ttl:400,maxEntries:2,maxValue:20,clock:()=>now});
const loader=()=>{calls++;return new Promise(resolve=>release=resolve);};
const first=cache.read('repo:a:status',loader),second=cache.read('repo:a:status',loader);
await Promise.resolve();assert.equal(calls,1);release('ok');assert.deepEqual(await Promise.all([first,second]),['ok','ok']);
assert.equal(await cache.read('repo:a:status',()=>assert.fail('valid cache should avoid loader')),'ok');
now=401;assert.equal(await cache.read('repo:a:status',async()=>{calls++;return 'fresh';}),'fresh');assert.equal(calls,2);
assert.equal(await cache.read('remote:a:status',async()=> 'remote'),'remote');
cache.invalidate();let staleRelease;
const stale=cache.read('repo:a:status',()=>new Promise(resolve=>staleRelease=resolve));await Promise.resolve();cache.invalidate();
assert.equal(await cache.read('repo:a:status',async()=> 'after write'),'after write');staleRelease('before write');await stale;
assert.equal(await cache.read('repo:a:status',()=>assert.fail('old result must not replace fresh cache')),'after write');
await assert.rejects(()=>cache.read('bad',async()=>{throw new Error('offline');}),/offline/);
assert.equal(await cache.read('bad',async()=> 'retry'),'retry');
await cache.read('large',async()=> 'x'.repeat(100));assert.ok(cache.size<=2);
let largeCalls=0;await cache.read('large',async()=>{largeCalls++;return 'x'.repeat(100);});assert.equal(largeCalls,1);
assert.equal(typeof R.Coalescer,'function');let scheduled=[],ran=0;
const burst=new R.Coalescer();const schedule=fn=>{const task={fn,canceled:false,cancel(){this.canceled=true;}};scheduled.push(task);return task;};
for(let i=0;i<25;i++)burst.request(schedule,()=>ran++);
assert.equal(scheduled.length,1);scheduled[0].fn({});assert.equal(ran,1);
burst.request(schedule,()=>ran++);burst.cancel();scheduled[1].fn({});assert.equal(ran,1);
// A read that never settles (issue #3) must not be handed out forever: after the deadline the next caller reloads.
{
  let t=0,loads=0,lateRelease;const hung=new R.ReadCache({ttl:400,deadline:1000,clock:()=>t});
  hung.read('k',()=>{loads++;return new Promise(resolve=>{lateRelease=resolve;});});await Promise.resolve();await Promise.resolve();
  t=999;hung.read('k',()=>assert.fail('a pending read inside its deadline is still shared'));assert.equal(loads,1);
  t=1000;assert.equal(await hung.read('k',async()=>{loads++;return 'fresh';}),'fresh');assert.equal(loads,2);
  lateRelease('stale');await Promise.resolve();
  assert.equal(await hung.read('k',()=>assert.fail('the late result must not replace the fresh one')),'fresh');
  const dflt=new R.ReadCache({clock:()=>t});assert.equal(dflt.deadline,35000);
}
console.log('read cache: 2 overlapping reads -> 1 load; 25 watch events -> 1 refresh; invalidation and bounds ok; a never-settling read is replaced after its deadline');
