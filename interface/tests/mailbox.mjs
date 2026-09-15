// Run from the repository root: node interface/tests/mailbox.mjs
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import fs from 'node:fs';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const M = require('../render/mailbox.js');
const source = 'Intro.\n\n**Description.** Whole context.\n\n**Why it needs the operator.** First paragraph.\n\nSecond paragraph with **emphasis**.\n\n**What it affects.** A source file.\n';
const entries = [
  {id:'a', title:'Same title', project:'alpha', state:'open', body:source},
  {id:'b', title:'Same title', project:'beta', state:'resolved', body:'Needle in archive'},
  {id:'c', title:'Café', project:'beta', state:'pending', body:'Needle'},
  {id:'d', title:'Closed', project:'alpha', state:'archived', body:'Old'},
  {id:'e', title:'Unknown state', project:'alpha', state:'new-status', body:'Keep visible'}
];
assert.deepEqual(M.filter(entries,{}).map(e=>e.id), ['a','c','e']);
assert.deepEqual(M.filter(entries,{view:'archive'}).map(e=>e.id), ['b','d']);
assert.equal(new Set([...M.filter(entries,{}), ...M.filter(entries,{view:'archive'})]).size, entries.length);
assert.deepEqual(M.filter(entries,{project:'beta',q:'cafe'}).map(e=>e.id), ['c']);
assert.deepEqual(M.filter(entries,{q:'needle'}).map(e=>e.id), ['c']);
assert.deepEqual(M.filter(entries,{view:'archive',q:'needle'}).map(e=>e.id), ['b']);
assert.equal(M.select(entries,'b').entry,entries[1]);
assert.equal(M.select(entries,'absent').kind,'missing');
assert.equal(M.select([...entries,{...entries[0]}],'a').kind,'ambiguous');
assert.equal(M.state(entries[4]).label,'Estado sin clasificar');
const request = M.request(source);
assert.equal(request.text,'First paragraph.\n\nSecond paragraph with **emphasis**.');
assert.match(request.remainder,/Intro/);
assert.match(request.remainder,/Whole context/);
assert.match(request.remainder,/A source file/);
assert.doesNotMatch(request.remainder,/First paragraph/);
assert.equal(source.slice(request.start,request.end),request.original, 'The lifted passage is an exact source slice');
assert.equal(M.request('No structured fields.'),null);
assert.equal(M.request('```md\n**Asks** Do not extract code.\n```'),null);
assert.equal(M.request('**Asks** One\n**Asks** Two'),null,'Ambiguous fields stay in their original order');
assert.equal(M.request('**Asks** Choose.\n**Affects** One file.').text,'Choose.');
const loc={view:'archive',project:'A & %B',q:'árbol %26',id:'id/with & symbols'};
assert.deepEqual(M.location(new URLSearchParams(M.route(loc).split('?')[1])),loc);
assert.deepEqual(M.location(new URLSearchParams('filter=old')), {view:'pending',project:'',q:'',id:''});
console.log('Mailbox state boundary, identity, search, exact request and route checks passed.');

assert.equal(M.request('**Qué pasa.** Contexto.\n\n**Por qué necesita al operador.** Decidir esto.\n\n**Qué afecta.** Un archivo.').text,'Decidir esto.');
assert.equal(M.request('**Lo que hay que decidir:** Primera opción.').text,'Primera opción.');
// Exercise the actual browser renderer, including escaping and the task/mailbox boundary.
const app = fs.readFileSync(new URL('../app.js',import.meta.url),'utf8');
const escape = require('../render/escape.js');
globalThis.markdownit = require('../vendor/markdown-it/markdown-it.umd.min.js');
globalThis.katex = require('../vendor/katex/katex.min.js');
const Library = require('../render/library.js');
const context = vm.createContext({STATE:{mailbox:entries,projects:[],tasks:[{title:'TASK-MUST-NOT-APPEAR'}]},Mailbox:M,Library,...escape,window:{},staleBanner:()=>'',enhanceLibraryDiagrams:()=>{}});
vm.runInContext(app.slice(app.indexOf('function mailboxLocation()'),app.indexOf('// ═',app.indexOf('function mailboxLocation()'))),context);
const container = {dataset:{},innerHTML:'',querySelectorAll:()=>[],querySelector:()=>null};
context.container=container;
vm.runInContext('renderInbox(container)',context);
assert.doesNotMatch(container.innerHTML,/TASK-MUST-NOT-APPEAR|Needle in archive/);
assert.match(container.innerHTML,/Pendientes · 3/);
assert.match(container.innerHTML,/Archivo · 2/);
assert.equal((container.innerHTML.match(/class="mailbox-row"/g)||[]).length,3);
context.STATE.mailLocation = {id:'a'};
vm.runInContext('renderInbox(container)',context);
assert.match(container.innerHTML,/Qué necesitas decidir/);
assert.match(container.innerHTML,/Second paragraph with <strong>emphasis<\/strong>/);
assert.match(container.innerHTML,/A source file/);
assert.ok(container.innerHTML.includes(escape.esc(source)),'The entire original source remains accessible');
context.STATE.mailbox = [{id:'unsafe',state:'open',title:'<img src=x onerror=alert(1)>',project:'alpha',author:'<script>bad()</script>',body:'<script>bad()</script>\n\n[bad](javascript:alert(1))'}];
context.STATE.mailLocation = {id:'unsafe'};
vm.runInContext('renderInbox(container)',context);
assert.doesNotMatch(container.innerHTML,/<script>|<img |href="javascript:/);
context.STATE.mailLocation = {id:'missing'};
vm.runInContext('renderInbox(container)',context);
assert.match(container.innerHTML,/No se encuentra este asunto/);
// A regression control must fail by assertion, not merely by failing to load a module.
const moduleSource = fs.readFileSync(new URL('../render/mailbox.js',import.meta.url),'utf8');
const broken = vm.createContext({module:{exports:{}}});
vm.runInContext(moduleSource.replace("!['resolved', 'archived'].includes(entry.state)",'true'),broken);
assert.throws(()=>assert.deepEqual(Array.from(broken.module.exports.filter(entries,{}),e=>e.id),['a','c','e']),assert.AssertionError);
console.log('Actual mailbox renderer, complete source, escaping and bad membership control pass.');
// An unrelated model/tree refresh cannot discard a query or replace the list DOM.
let writes = 0, focused = false, selection;
const draftInput = {value:'unsent draft',selectionStart:3,selectionEnd:8,focus:()=>{focused=true;},setSelectionRange:(...v)=>{selection=v;}};
let html = '';
const liveContainer = {dataset:{route:M.route({})},querySelectorAll:()=>[],querySelector:s=>s==='#mailbox-query'?draftInput:s==='.mailbox-room'?{}:null,
  get innerHTML(){return html;},set innerHTML(value){writes++;html=value;}};
context.document = {activeElement:draftInput};
context.container=liveContainer; context.STATE.mailLocation={}; context.STATE.mailbox=entries;
vm.runInContext('renderInbox(container)',context);
const firstWrites = writes;
context.STATE.libraryRevision=77;
vm.runInContext('renderInbox(container)',context);
assert.equal(writes,firstWrites,'An unrelated tree revision does not replace the mailbox');
context.STATE.mailbox=[...entries,{id:'new',state:'open',title:'New arrival'}];
vm.runInContext('renderInbox(container)',context);
assert.equal(writes,firstWrites+1,'A new matter updates the list');
assert.equal(draftInput.value,'unsent draft');
assert.equal(focused,true); assert.deepEqual(selection,[3,8]);
console.log('Live mailbox refresh preserves DOM, query draft, focus and selection.');
