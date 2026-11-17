const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const {execFileSync} = require('node:child_process');
function harness(t, raw='﻿first\tline\r\nlast', gutter=false) {
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'noodle-documents-'));t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const home=path.join(base,'app'), root=path.join(base,'repo');fs.mkdirSync(root);fs.mkdirSync(home);fs.cpSync(path.join(__dirname,'../helpers'),path.join(home,'helpers'),{recursive:true});fs.writeFileSync(path.join(root,'file.txt'),raw);
  const jobs=[],timers=[],state=new Map(),calls=[],commands=[],bindings=[];
  const cx={notify(){},bind_keys(keys){bindings.push(...keys);},spawn(fn){jobs.push(fn(cx));},timer:{every(){},after(ms,fn){timers.push(fn);}}};
  const input=options=>{let value=options?.value||'', handlers={},range={start:0,end:5};return {options,value:()=>value,set_value:v=>{value=v;},on:(e,fn)=>{handlers[e]=fn;},emit:()=>handlers.change?.({},cx),release(){},...(gutter?{set_gutter_marks(marks){this.marks=marks;}}:{}),selected_range:()=>range,set_selected_range:r=>{range=r;},focus(){this.focused=true;},submit:e=>handlers.submit?.(e,cx)};};
  const element=id=>{let p;const node={id,nodes:[],attrs:{}};return p=new Proxy(node,{get:(n,k)=>k in n?n[k]:k==='when'?(b,fn)=>(b&&fn(p),p):k==='child'?c=>(n.nodes.push(c),p):k==='children'?a=>(n.nodes.push(...a),p):(...args)=>(n.attrs[k]=args,p)});};
  const context=vm.createContext({console,Map,Date,Math,Error,div:element,svg:element,h_flex:element,v_flex:element,Button:{new:element},Editor:{new:element},Input:{new:element},EditorState:{new:input},InputState:{new:input},
    theme:()=>({ansi1:"#ff0000",ansi2:"#00ff00",ansi3:"#ffff00"}),appHome:()=>home,settings:()=>({}),shared:k=>state.get(k),setShared:(k,v)=>state.set(k,v),panes:()=>[{mod:'file-editor',pane:'editor',tab:'one'}],run:(...args)=>commands.push(args),
    exec:async(command,args)=>{calls.push([command,args]);try{return {code:0,stdout:execFileSync(command,args,{encoding:'utf8'})};}catch(e){return {code:1,stdout:e.stdout.toString(),stderr:e.stderr.toString()};}},
    writeTextFile:async(file,value,expected)=>{assert.equal(fs.readFileSync(file,'utf8'),expected,'snapshot must match');fs.writeFileSync(file,value);}
  });
  const source=fs.readFileSync(path.join(__dirname,'../mods/file-editor/documents.js'),'utf8').replace(/^import .*;\n/gm,'').replace(/export /g,'');
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../mods/file-editor/gutter.js'),'utf8').replace(/export /g,'')+'\n'+source+'\nglobalThis.Documents=Documents;',context);
  const owner={selectionKey:'file-editor.one',selection:{root,on:null,kind:'file',file:{path:'file.txt'},hash:null},mode:'source',refresh(){},selectFile(){this.selection=null;},openFile(file,_commit,_cx,options){this.selection={...this.selection,...options,file};}};
  const docs=new context.Documents(owner,cx);
  return {context,docs,owner,cx,root,home,raw,state,calls,commands,bindings,async flush(){while(jobs.length)await Promise.all(jobs.splice(0));},async edit(){docs.edit(cx);while(jobs.length)await Promise.all(jobs.splice(0));}};
}

test('raw editor save preserves BOM tabs CRLF and missing final newline; source never enters process args',async t=>{
 const h=harness(t);await h.edit();assert.equal(h.docs.current.input.value(),h.raw);
 const doc=h.docs.current;doc.input.set_value(h.raw+' edited');doc.input.emit();h.docs.save(h.cx);await h.flush();
 assert.equal(h.docs.error,null);assert.equal(fs.readFileSync(path.join(h.root,'file.txt'),'utf8'),h.raw+' edited');assert.equal(doc.dirty,false);
 assert.ok(h.calls.every(([,args])=>!args.some(arg=>arg.includes(h.raw))));assert.equal(h.commands.length,0);
});
test('external edits preserve both disk and the unsaved draft; stale merge acceptance is refused',async t=>{
 const h=harness(t,'original');await h.edit();const doc=h.docs.current;doc.input.set_value('my draft');doc.input.emit();fs.writeFileSync(path.join(h.root,'file.txt'),'agent edit');
 h.docs.save(h.cx);await h.flush();assert.equal(doc.input.value(),'my draft');assert.equal(h.docs.compare.disk,'agent edit');assert.equal(fs.readFileSync(path.join(h.root,'file.txt'),'utf8'),'agent edit');
 fs.writeFileSync(path.join(h.root,'file.txt'),'agent edit again');h.docs.accept(h.cx);await h.flush();assert.match(h.docs.error,/changed again/);
});
test('repeated Edit keeps the live buffer and closing checkpoints a recoverable draft',async t=>{
 const h=harness(t,'base');await h.edit();const doc=h.docs.current;doc.input.set_value('draft');doc.input.emit();h.docs.edit(h.cx);assert.equal(h.docs.current,doc);
 await h.docs.close();const p=path.dirname(doc.inputPath);assert.equal(fs.readFileSync(path.join(p,'draft'),'utf8'),'draft');
 assert.equal(h.state.get('noodle.documents')[doc.id],undefined);
});
test('file-operation handshake shows a readonly snapshot until the operation releases it',async t=>{
 const h=harness(t);await h.edit();h.state.set('noodle.documents.request',{id:'fixture'});h.docs.requests(h.cx);await h.flush();assert.ok(h.docs.frozen);assert.equal(h.state.get('noodle.documents.ack.fixture')['file-editor.one'],true);
 const before=h.calls.length;h.docs.save(h.cx);await h.flush();assert.equal(h.calls.length,before,'keyboard save must also respect the file-operation lock');
 h.state.set('noodle.documents.request',null);h.docs.requests(h.cx);await h.flush();assert.equal(h.docs.frozen,null);
});
test('editor controls render with a populated raw document',async t=>{const h=harness(t);await h.edit();assert.ok(h.docs.render({},h.cx));});

test('rapid file switches open the latest requested editor instead of a late previous file',async t=>{
 const h=harness(t,'first');fs.writeFileSync(path.join(h.root,'second.txt'),'second');
 h.docs.edit(h.cx);
 h.owner.selection={...h.owner.selection,file:{path:'second.txt'},editRequest:'second'};
 h.docs.edit(h.cx);await h.flush();
 assert.equal(h.docs.current.path,'second.txt');assert.equal(h.docs.current.input.value(),'second');assert.equal(h.owner.mode,'source');
});
test('a late editor load cannot replace a newly selected commit preview',async t=>{
 const h=harness(t,'first');h.docs.edit(h.cx);
 h.owner.selection={...h.owner.selection,hash:'commit',kind:'diff'};h.owner.mode='diff';await h.flush();
 assert.equal(h.docs.current,null);assert.equal(h.owner.mode,'diff');
});


test('editor has no controls toolbar and keeps Ctrl+S/Cmd+S saving',async t=>{
 const h=harness(t,'base');await h.edit();const doc=h.docs.current;
 const find=(n,id)=>n?.id===id?n:n?.nodes?.map(c=>find(c,id)).find(Boolean);
 const tree=h.docs.render({},h.cx);
 for(const id of [`open-${doc.id}`,`close-${doc.id}`,'save-file','close-open-file','save-file-as','discard-draft','find-file','goto-line','copy-reference','copy-selection','file-notes','copy-for-agent'])assert.equal(find(tree,id),undefined,id);
 assert.deepEqual(Array.from(h.bindings,b=>b.keystroke).sort(),['cmd-f','cmd-s','ctrl-f','ctrl-s']);
 assert.ok(h.bindings.filter(b=>b.action==='noodle.find').every(b=>b.context==='NoodleEditor > Input'),'find must override the native Input binding');
 doc.input.set_value('saved by keyboard');doc.input.emit();
 tree.attrs.on_action[1]({}, {...h.cx,stop_propagation(){}});await h.flush();
 assert.equal(fs.readFileSync(path.join(h.root,'file.txt'),'utf8'),'saved by keyboard');assert.equal(doc.dirty,false);
});

test('historical, staged and deleted selections never open a writable working file',async t=>{
 const h=harness(t,'base');
 for(const extra of [{hash:'commit'},{diffMode:'staged'},{file:{path:'file.txt',status:'D'}}]){
  h.owner.selection={root:h.root,on:null,kind:'diff',file:{path:'file.txt'},hash:null,...extra};
  h.docs.edit(h.cx);await h.flush();assert.equal(h.docs.current,undefined);assert.equal(h.calls.length,0);
 }
});

test('file editor selects native syntax highlighting from the filename',async t=>{
 const h=harness(t);
 for(const [name,language] of [['example.TSX','typescript'],['script.py','python'],['config.yml','yaml'],['Dockerfile','dockerfile']]){
  fs.writeFileSync(path.join(h.root,name),'fixture');h.owner.selection={...h.owner.selection,file:{path:name}};await h.edit();
  assert.equal(h.docs.current.input.options.language,language);assert.equal(h.docs.current.input.options.line_numbers,true);assert.notEqual(h.docs.current.input.options.readonly,true);
 }
});

test('closing file tabs keeps the selected path aligned and refuses to drop an unsaved draft',async t=>{
 const h=harness(t,'first');await h.edit();const first=h.docs.current;
 fs.writeFileSync(path.join(h.root,'second.txt'),'second');h.owner.selection={...h.owner.selection,file:{path:'second.txt'}};await h.edit();
 h.docs.remove(h.docs.current,h.cx);assert.equal(h.docs.current,first);assert.equal(h.owner.selection.file.path,'file.txt');
 first.input.set_value('draft');first.input.emit();h.docs.remove(first,h.cx);assert.equal(h.docs.current,first);assert.equal(h.docs.open.size,1);assert.ok(h.docs.confirmDiscard);
 h.owner.selection={...h.owner.selection,file:{path:'second.txt'}};await h.edit();assert.equal(h.docs.confirmDiscard,false);
 h.docs.remove(first,h.cx);assert.equal(h.owner.selection.file.path,'file.txt');assert.equal(h.docs.current,first);assert.ok(h.docs.confirmDiscard);
});

test('reviewing an external change enables a snapshot-checked save of the merged draft',async t=>{
 const h=harness(t,'base');await h.edit();const doc=h.docs.current;
 doc.input.set_value('my edit');doc.input.emit();fs.writeFileSync(path.join(h.root,'file.txt'),'external edit');
 h.docs.save(h.cx);await h.flush();h.docs.accept(h.cx);await h.flush();assert.equal(typeof doc.revision,'number');
 doc.input.set_value('merged edit');doc.input.emit();h.docs.save(h.cx);await h.flush();
 assert.equal(h.docs.error,null);assert.equal(fs.readFileSync(path.join(h.root,'file.txt'),'utf8'),'merged edit');
});

test('native Source gutter tracks HEAD versus unsaved edits and keeps markers after saving',async t=>{
 const h=harness(t,'keep\nmodify\ndelete\nlast\n',true);
 const git=(...args)=>execFileSync('git',['-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null',...args],{cwd:h.root,stdio:'pipe'});
 git('init','-q','-b','main');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');git('add','.');git('-c','commit.gpgsign=false','commit','-qm','Baseline');
 await h.edit();const doc=h.docs.current;assert.equal(doc.input.marks.length,0);
 doc.input.set_value('keep\nchanged\nlast\nnew\n');doc.input.emit();h.docs.checkpoint(doc,h.cx);await h.flush();
 assert.equal(fs.readFileSync(path.join(h.root,'file.txt'),'utf8'),'keep\nmodify\ndelete\nlast\n');
 assert.ok(doc.input.marks.some(m=>m.line===2&&m.color==='#ffff00'&&m.deleted_after==='#ff0000'));
 assert.ok(doc.input.marks.some(m=>m.line===4&&m.color==='#00ff00'));
 h.docs.save(h.cx);await h.flush();await h.docs.refreshGutter(doc);assert.ok(doc.input.marks.length);
 git('add','.');git('-c','commit.gpgsign=false','commit','-qm','Saved');await h.docs.refreshGutter(doc);assert.equal(doc.input.marks.length,0);
});

test('typing publishes only dirty-state transitions while preserving checkpoints and undo',async t=>{
 const h=harness(t,'base');await h.edit();const doc=h.docs.current;let publications=0,notifications=0;
 h.context.setShared=(key,value)=>{if(key==='noodle.documents')publications++;h.state.set(key,value);};
 h.cx.notify=()=>notifications++;
 for(let i=0;i<100;i++){doc.input.set_value('edit '+i);doc.input.emit();}
 assert.equal(publications,1);assert.equal(notifications,1);assert.equal(doc.change,100);
 await h.docs.flush(doc);assert.equal(fs.readFileSync(doc.inputPath,'utf8'),'edit 99');
 doc.input.set_value('base');doc.input.emit();assert.equal(publications,2);assert.equal(doc.dirty,false);
});


test('find selects literal UTF-16 matches, wraps both ways and leaves the draft unchanged',async t=>{
 const h=harness(t,'😀 match first\nmatch last');await h.edit();const doc=h.docs.current;
 doc.input.set_selected_range({start:0,end:0});h.docs.showFind(h.cx);
 assert.equal(h.docs.findOpen,true);assert.equal(h.docs.query.focused,true);
 h.docs.query.set_value('match');h.docs.query.emit();
 assert.equal(doc.input.selected_range().start,3);
 h.docs.query.submit({});assert.equal(doc.input.selected_range().start,15);
 h.docs.query.submit({});assert.equal(doc.input.selected_range().start,3);
 h.docs.query.submit({shift:true});assert.equal(doc.input.selected_range().start,15);
 h.docs.query.set_value('MATCH');h.docs.query.emit();assert.equal(h.docs.noMatch,true);
 assert.equal(doc.input.selected_range().start,15);
 h.docs.query.set_value('');h.docs.query.emit();assert.equal(h.docs.noMatch,false);
 h.docs.query.set_value('😀');h.docs.query.emit();assert.equal(doc.input.selected_range().end,2);
 h.docs.find(h.cx,-1);assert.equal(doc.input.selected_range().start,0);
 h.docs.closeFind(h.cx);assert.equal(h.docs.findOpen,false);assert.equal(doc.input.focused,true);
 assert.equal(doc.input.value(),h.raw);assert.equal(doc.dirty,false);
});

test('find uses the current buffer and supports the readonly file-operation snapshot',async t=>{
 const h=harness(t,'base');await h.edit();const doc=h.docs.current;
 doc.input.set_value('draft match');doc.input.emit();h.docs.query.set_value('match');h.docs.find(h.cx);
 assert.equal(doc.input.selected_range().start,6);
 h.state.set('noodle.documents.request',{id:'find-snapshot'});h.docs.requests(h.cx);await h.flush();
 h.docs.find(h.cx);assert.equal(h.docs.frozen.selected_range().start,6);
 assert.equal(fs.readFileSync(path.join(h.root,'file.txt'),'utf8'),'base');
});


test('native search drives highlights independently of the focused find field and clears them on close',async t=>{
 const h=harness(t,'match match');await h.edit();const input=h.docs.current.input,calls=[];
 input.search=(query,direction)=>{calls.push([query,direction]);return query==='missing'?'0/0':'1/2';};
 input.close_search=()=>calls.push('close');
 h.docs.query.set_value('match');h.docs.showFind(h.cx);
 assert.deepEqual(calls,[['match',0]]);assert.equal(h.docs.query.focused,true);
 h.docs.find(h.cx,1);h.docs.find(h.cx,-1);
 assert.deepEqual(calls.slice(-2),[['match',1],['match',-1]]);
 h.docs.query.set_value('missing');h.docs.find(h.cx);assert.equal(h.docs.noMatch,true);
 h.docs.closeFind(h.cx);assert.equal(calls.at(-1),'close');assert.equal(input.focused,true);
 assert.equal(input.value(),'match match');assert.equal(h.docs.current.dirty,false);
});
