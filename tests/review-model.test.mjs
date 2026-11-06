import assert from 'node:assert/strict';
const M=await import('../mods/tabbed-changes/review-model.js').catch(()=>({}));
assert.equal(typeof M.wordChanges,'function','word-level diff helper required');
assert.deepEqual(M.wordChanges('return first + count;','return second + count;'),{old:[{start:7,end:12}],next:[{start:7,end:13}]});
assert.deepEqual(M.wordChanges('same','same'),{old:[],next:[]});
const unicode=M.wordChanges('🐈 cat','🐕 dog');assert.deepEqual(unicode.old,[{start:0,end:6}]); // words split by one space merge into one block
assert.deepEqual(M.wordChanges('const alpha = computeTotal(items, taxRate, discount);','return await fetchEverything(request, response, context)'),{old:[],next:[]}); // rewritten line: no word boxes
assert.equal(M.wordChanges('x'.repeat(9000),'y'.repeat(9000)).old[0].end,9000);
const tokens=[{text:'const',kind:'keyword'},{text:' value = 1;'}];
const split=M.splitTokens(tokens,[{start:6,end:11}]);assert.equal(split.map(t=>t.text).join(''),'const value = 1;');assert.equal(split.filter(t=>t.changed).map(t=>t.text).join(''),'value');
assert.equal(split[0].kind,'keyword');
assert.deepEqual(M.diffFlags({context:10,ignoreWhitespace:true}),['--unified=10','--ignore-all-space']);
assert.deepEqual(M.diffFlags({context:999}),['--unified=3']);
const rows=[{kind:'file',path:'a.js'},{kind:'@',path:'a.js',text:'@@ -1 +1 @@'},{kind:'c',path:'a.js',l:{n:1,text:'old'},r:{n:1,text:'Find me'}},{kind:'file',path:'b.js'},{kind:'@',path:'b.js',text:'@@ -1 +1 @@'},{kind:'+',path:'b.js',text:'find ME',next:1}];
assert.deepEqual(M.changedTargets(rows),[1,4]);assert.deepEqual(M.searchRows(rows,'find me'),[2,5]);
assert.deepEqual(M.searchRows(rows,''),[]);assert.equal(M.stepTarget([1,4],4,1),1);assert.equal(M.stepTarget([],0,1),null);assert.equal(M.stepTarget([1,4],-1,-1),4);
const files=[{path:'src/lib/a.js'},{path:'src/b.js'},{path:'README.md'}];
let tree=M.fileTree(files,'',new Set());assert.ok(tree.some(n=>n.kind==='folder'&&n.path==='src/lib'));assert.equal(tree.filter(n=>n.kind==='file').length,3);
tree=M.fileTree(files,'a.js',new Set(['src']));assert.deepEqual(tree.filter(n=>n.kind==='file').map(n=>n.path),['src/lib/a.js']);
assert.equal(M.fileTree(files,'',new Set(['src'])).filter(n=>n.kind==='file').length,1);

// Hanging indent: continuation rows reserve the indent so they never overflow the column budget.
{ const b=M.wrapBreaks('    alpha beta gamma delta epsilon zeta',16,M.hangFor('    alpha beta gamma delta epsilon zeta'));
  assert.ok(b&&b.hang>0,'hang recorded');
  let prev=0; for(const cut of b){assert.ok(cut-prev<=16-b.hang+ (prev?0:b.hang),'row fits');prev=cut;}
  assert.equal(M.hangFor('\t\tx'),10);assert.equal(M.hangFor('x'),2);
  assert.deepEqual(M.wrapBreaks('const value = 42;',8),[6,14]); }
console.log('word diffs, navigation, search and file tree ok');
assert.equal(typeof M.commentPlacement,'function');
assert.deepEqual(M.commentPlacement(-1200,0,2000,500),{inset:1200,width:500});
assert.deepEqual(M.commentPlacement(0,0,700,700),{inset:0,width:600});
assert.deepEqual(M.wrapBreaks('const value = 42;', 8), [6, 14]);
assert.deepEqual(M.wrapBreaks('abcdefghij', 4), [4, 8]);
assert.deepEqual(M.wrapBreaks('a🐈b', 2), [1, 3]);
assert.deepEqual(M.wrapBreaks('\tcode', 5), [1]);
assert.equal(M.wrapBreaks('short', 8), null);
assert.deepEqual(M.wrapTokens([{ text: 'abcde', kind: 'string', changed: true }], [2]), [
  [{ text: 'ab', kind: 'string', changed: true }],
  [{ text: 'cde', kind: 'string', changed: true }],
]);
