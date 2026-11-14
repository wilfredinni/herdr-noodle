const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const {execFileSync} = require('node:child_process');
function harness(t, raw='\ufefffirst\tline\r\nlast') {
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'noodle-documents-'));t.after(()=>fs.rmSync(base,{recursive:true,force:true}));
  const home=path.join(base,'app'), root=path.join(base,'repo');fs.mkdirSync(root);fs.mkdirSync(home);fs.cpSync(path.join(__dirname,'../helpers'),path.join(home,'helpers'),{recursive:true});fs.writeFileSync(path.join(root,'file.txt'),raw);
  const jobs=[],timers=[],state=new Map(),calls=[],commands=[];
  const cx={notify(){},spawn(fn){jobs.push(fn(cx));},timer:{every(){},after(ms,fn){timers.push(fn);}}};
  const input=options=>{let value=options?.value||'', handlers={};return {value:()=>value,set_value:v=>{value=v;},on:(e,fn)=>{handlers[e]=fn;},emit:()=>handlers.change?.({},cx),release(){},selected_range:()=>({start:0,end:5})};};
  const element=()=>{let p;return p=new Proxy({}, {get:(_,k)=>k==='when'?(b,fn)=>(b&&fn(p),p):()=>p});};
  const context=vm.createContext({console,Map,Date,Math,Error,div:element,h_flex:element,v_flex:element,Button:{new:element},Editor:{new:element},Input:{new:element},EditorState:{new:input},InputState:{new:input},
    appHome:()=>home,settings:()=>({}),shared:k=>state.get(k),setShared:(k,v)=>state.set(k,v),panes:()=>[{mod:'git-file-preview',pane:'preview',tab:'one'}],run:(...args)=>commands.push(args),
    exec:async(command,args)=>{calls.push([command,args]);try{return {code:0,stdout:execFileSync(command,args,{encoding:'utf8'})};}catch(e){return {code:1,stdout:e.stdout.toString(),stderr:e.stderr.toString()};}},
    writeTextFile:async(file,value,expected)=>{assert.equal(fs.readFileSync(file,'utf8'),expected,'snapshot must match');fs.writeFileSync(file,value);}
  });
  const source=fs.readFileSync(path.join(__dirname,'../mods/git-file-preview/documents.js'),'utf8').replace(/^import .*;\n/gm,'').replace(/export /g,'');
  vm.runInContext(source+'\nglobalThis.Documents=Documents;',context);
  const owner={selectionKey:'git-file-preview.one',selection:{root,on:null,kind:'file',file:{path:'file.txt'},hash:null},mode:'source',refresh(){},openFile(file,_commit,_cx,options){this.selection={...this.selection,...options,file};}};
  const docs=new context.Documents(owner,cx);
  return {docs,owner,cx,root,home,raw,state,calls,commands,async flush(){while(jobs.length)await Promise.all(jobs.splice(0));},async edit(){docs.edit(cx);while(jobs.length)await Promise.all(jobs.splice(0));}};
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
 const h=harness(t);await h.edit();h.state.set('noodle.documents.request',{id:'fixture'});h.docs.requests(h.cx);await h.flush();assert.ok(h.docs.frozen);assert.equal(h.state.get('noodle.documents.ack.fixture')['git-file-preview.one'],true);
 h.state.set('noodle.documents.request',null);h.docs.requests(h.cx);await h.flush();assert.equal(h.docs.frozen,null);
});
test('editor controls render with a populated raw document',async t=>{const h=harness(t);await h.edit();assert.ok(h.docs.render({},h.cx));});
