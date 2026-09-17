// Run from the repository root: node interface/tests/office.mjs
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const source = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const functions = source.slice(source.indexOf('function normaliseTitle('), source.indexOf('const STATE_META'));
const context = vm.createContext({paintView:(container, html)=>{container.innerHTML=html;}, STATE: {
  fronts: [
    { id: 'one', name: 'Same title', project: 'first', row: 'summary', active: true, sheet: 'first.md' },
    { id: 'two', name: 'Same title', project: 'second', row: 'summary', active: true, sheet: 'second.md' },
    { id: 'three', name: 'Deferred task', project: 'first', row: 'summary', state: 'deferred', in_bin: true }
  ],
  tasks: [{ id: 'old', title: 'Archived queue item', project: 'first' }],
  livePlan: [{ text: 'WRONG-GLOBAL-PLAN' }], livePlanMeta: {}, plans: [], taskSheets: {}
}});
vm.runInContext(functions, context);
const cards = vm.runInContext('officeCards()', context);
assert.equal(cards.length, 3, 'Only wall entries, including two independent tasks with the same title');
assert.deepEqual(Array.from(cards, c => c.id), ['one', 'two', 'three']);
assert.equal(cards[2].inBin, true, 'Deferred work stays out of the live wall');
assert.equal(vm.runInContext('planForCard(officeCards()[0])', context), null, 'Never borrow the retired global plan');
console.log('Office identity, archive boundary and global-plan regression checks passed.');
