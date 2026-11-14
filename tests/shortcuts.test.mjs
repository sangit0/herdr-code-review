import assert from 'node:assert/strict';
import { reviewAction } from '../mods/tabbed-changes/shortcut-model.js';

const key = (name, modifiers = {}) => ({ key: name, modifiers });
for (const surface of ['panel', 'diff', 'file', 'history']) {
  assert.equal(reviewAction(key('enter'), { surface, typing: true, canEdit: true, canOpen: true }), null);
  assert.equal(reviewAction(key('l'), { surface, typing: true, canHistory: true }), null);
  for (const modifiers of [{ platform: true }, { control: true }, { alt: true }, { shift: true }]) {
    assert.equal(reviewAction(key('enter', modifiers), { surface, canEdit: true, canOpen: true }), null);
  }
}
assert.equal(reviewAction(null, { surface: 'panel' }), null);
assert.equal(reviewAction(key('enter'), { surface: 'terminal', canEdit: true }), null);
assert.equal(reviewAction(key('l'), { surface: 'terminal' }), null);

assert.equal(reviewAction(key('j'), { surface: 'panel' }), 'next');
assert.equal(reviewAction(key('k'), { surface: 'panel' }), 'previous');
assert.equal(reviewAction(key('up'), { surface: 'history' }), 'previous');
assert.equal(reviewAction(key('down'), { surface: 'history' }), 'next');
assert.equal(reviewAction(key('s'), { surface: 'panel', canStage: false }), null);
assert.equal(reviewAction(key('s'), { surface: 'panel', canStage: true }), 'stage');
assert.equal(reviewAction(key('u'), { surface: 'panel', canUnstage: false }), null);
assert.equal(reviewAction(key('u'), { surface: 'panel', canUnstage: true }), 'unstage');

for (const surface of ['panel', 'diff', 'file']) {
  assert.equal(reviewAction(key('enter'), { surface, canEdit: true }), 'edit');
  assert.equal(reviewAction(key('enter'), { surface, canEdit: false }), null);
  assert.equal(reviewAction(key('l'), { surface, canHistory: true }), 'history');
  assert.equal(reviewAction(key('l'), { surface, canHistory: false }), null);
}
for (const surface of ['diff', 'file', 'history']) {
  assert.equal(reviewAction(key('s'), { surface, canStage: true }), null);
  assert.equal(reviewAction(key('u'), { surface, canUnstage: true }), null);
}
assert.equal(reviewAction(key('j'), { surface: 'diff' }), null);
assert.equal(reviewAction(key('d'), { surface: 'panel' }), null);
assert.equal(reviewAction(key('x'), { surface: 'panel' }), null);
assert.equal(reviewAction(key('enter'), { surface: 'history', canOpen: false, canEdit: true }), null);
assert.equal(reviewAction(key('enter'), { surface: 'history', canOpen: true }), 'open');
assert.equal(reviewAction(key('escape'), { surface: 'history' }), 'back');
assert.equal(reviewAction(key('l'), { surface: 'history', canHistory: false }), 'back');
// z zooms the diff pane, only where a pane can be zoomed
for (const surface of ['panel', 'diff', 'file']) {
  assert.equal(reviewAction(key('z'), { surface, canZoom: true }), 'zoom');
  assert.equal(reviewAction(key('z'), { surface, canZoom: false }), null);
  assert.equal(reviewAction(key('z'), { surface, canZoom: true, typing: true }), null);
}
assert.equal(reviewAction(key('z'), { surface: 'history', canZoom: true }), null);
console.log('Scoped review keyboard decisions and text-input/history safeguards passed.');
