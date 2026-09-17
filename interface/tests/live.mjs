// Run from the repository root: node interface/tests/live.mjs
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import fs from 'node:fs';
import vm from 'node:vm';
const require = createRequire(import.meta.url), live = require('../render/live.js');
const initial = {mode:'snapshot',revision:'a',entities:[{id:'a',kind:'front',name:'Task'}, {id:'b',kind:'mailbox-entry',title:'Letter'}]};
const first = live.apply(null, initial).model;
const update = live.apply(first,{mode:'delta',base:'a',revision:'b',upsert:[{id:'b',kind:'mailbox-entry',title:'Changed'}],remove:[],metadata:{problems:[]}});
assert.equal(update.model.entities[0],first.entities[0], 'Unchanged raw rows retain object identity');
assert.deepEqual([...update.changed],['mailbox-entry']);
assert.equal(update.model.entities[1].title,'Changed');
const same = live.apply(update.model,{...initial,revision:'restart',entities:update.model.entities.map(e=>({...e}))});
assert.equal(same.model.entities[0],first.entities[0]);
assert.equal(same.changed.size,0,'A restart snapshot with unchanged content need not rebuild rows');
assert.throws(()=>live.apply(first,{mode:'delta',base:'wrong'}));
assert.throws(()=>live.apply(first,{mode:'delta',base:'a',order:['a'],upsert:[],remove:[]}));
const reordered=live.apply(first,{mode:'delta',base:'a',upsert:[{id:'c',kind:'skill'}],remove:['b'],order:['c','a'],metadata:{}});
assert.equal(reordered.model.entities[1],first.entities[0]);
assert.deepEqual(reordered.model.entities.map(e=>e.id),['c','a']);
const source=fs.readFileSync(new URL('../app.js',import.meta.url),'utf8');
const context=vm.createContext({STATE:{fronts:[],mailbox:[],projects:[]},LiveModel:live,STORAGE_KEYS:{TASKS:'test'},localStorage:{getItem:()=>null},updateHUD:()=>{}});
vm.runInContext(source.slice(source.indexOf('function projectViewModel('),source.indexOf('function updateHUD(')),context);
context.ingestModel(first);
const fronts=context.STATE.fronts, front=fronts[0], letters=context.STATE.mailbox;
context.ingestModel(update.model,update.changed);
assert.equal(context.STATE.fronts,fronts,'Unrelated projections are not rebuilt');
assert.equal(context.STATE.fronts[0],front);
assert.notEqual(context.STATE.mailbox,letters);
assert.equal(context.STATE.mailbox[0].title,'Changed');
// Deliberately reinstate the old replacement behavior; the preservation assertion must fail.
assert.throws(()=>assert.equal(update.model.entities.map(e=>({...e}))[0],first.entities[0]),assert.AssertionError);
console.log('Live entity deltas, identity, order, restart recovery and scoped projections passed.');

const records=live.apply(null,{revision:'records',entities:[{id:'D1',uid:'one-d1',kind:'decision',title:'One'},{id:'D1',uid:'two-d1',kind:'decision',title:'Two'}]}).model;
const changedRecord=live.apply(records,{mode:'delta',base:'records',revision:'next',upsert:[{...records.entities[0],title:'Changed'}],remove:[],metadata:{}});
assert.equal(changedRecord.model.entities.length,2);
assert.equal(changedRecord.model.entities[1],records.entities[1],'A repeated display ID never overwrites another project');

const readers=vm.createContext({STATE:{projects:[{name:'sample',projectRoot:'projects/sample'}],taskSheets:{open:{path:'sheet.md'},other:{path:'other.md'}},projectCatalogs:{sample:{}},projectDocuments:{'["sample","plan.md"]':{},'["sample","objectives.md"]':{}}}});
vm.runInContext(source.slice(source.indexOf('function invalidateReaders('),source.indexOf('async function loadTree(')),readers);
const tree=version=>({files:[{root:'.',path:'sheet.md',version},{root:'projects',path:'sample/plan.md',version},{root:'projects',path:'sample/objectives.md',version:'same'}]});
readers.invalidateReaders(tree('before'),tree('after'));
assert.equal(readers.STATE.taskSheets.open.stale,true,'A root declared as . still invalidates its open sheet');
assert.equal(readers.STATE.taskSheets.other.stale,undefined);
assert.equal(readers.STATE.projectCatalogs.sample.stale,true);
assert.equal(readers.STATE.projectDocuments['["sample","plan.md"]'].stale,true);
assert.equal(readers.STATE.projectDocuments['["sample","objectives.md"]'].stale,undefined);
