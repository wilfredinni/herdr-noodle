const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
function element(id){const n={id,children:[],attrs:{}};let p;return p=new Proxy(n,{get(n,k){if(k==='id'&&n.id===undefined)return id=>(n.id=id,p);if(k in n)return n[k];if(k==='child'||k==='trigger'||k==='content')return c=>(n.children.push(c),p);if(k==='children')return a=>(n.children.push(...a),p);if(k==='when')return(c,f)=>(c&&f(p),p);return(...a)=>(n.attrs[k]=a,p);}});}
const text=n=>typeof n==='string'?n:(n?.children||[]).map(text).join(' ');
function tools(zoom=1){const calls=[],pending=[],cx={focus_handle:()=>({focus(){}}),notify(){},stop_propagation(){},spawn(fn){pending.push(fn(cx));}};
 const input={new:()=>{let value='';const handlers={};return{on(event,fn){handlers[event]=fn;},value:()=>value,set_value(next){value=next;},focus(){this.focused=true;},set_selected_range(range){this.selection=range;},emit(event){handlers[event]?.({},cx);}};}};
 const c=vm.createContext({View:class{},div:element,svg:element,h_flex:element,v_flex:element,Button:{new:element},Popup:{new:(id,trigger)=>element(id).child(trigger)},Input:{new:element},InputState:input,Date,Math,Map,Set,settings:()=>({zoom}),shared:()=>null,setShared(){},panes:()=>[],appHome:()=>'/app',exec:async(_cmd,args)=>{calls.push([args[1],JSON.parse(args[2])]);return{code:0,stdout:JSON.stringify(args[1]==='file_prepare'?{root:'/repo',drafts:[]}:{} )};},run:(...args)=>calls.push(args)});
 const icons=fs.readFileSync(path.join(__dirname,'../mods/files-browser/fileIcons.js'),'utf8').replace(/export /g,'');vm.runInContext(icons,c);
 const source=fs.readFileSync(path.join(__dirname,'../mods/files-browser/tools.js'),'utf8').replace(/^import .*;\n/gm,'').replace(/export /g,'');vm.runInContext(source+'\nglobalThis.FileTools=FileTools',c);
 const owner={root:'/repo',on:null,git:{root:'/repo'},folders:new Set(),toggle(folder){this.folders.add(folder);},refresh(){}};return {tools:new c.FileTools(owner,cx),owner,cx,calls,c,async flush(){while(pending.length)await Promise.all(pending.splice(0));}};}
test('file right-click menu exposes standard actions without folder-only terminal',()=>{const h=tools();Object.assign(h.tools,{target:'a.txt',targetDir:false,mode:'menu',menuRoot:'/repo'});const labels=text(h.tools.menu({},h.cx));for(const label of ['New File','New Folder','Rename','Move','Duplicate','Move to Trash','Copy Path','Copy Relative Path','View History','Reveal in Finder'])assert.ok(labels.includes(label),label);assert.ok(!labels.includes('Open in Terminal'));});
test('folder and empty-area right-click menus create items in context and open terminals',()=>{const h=tools();Object.assign(h.tools,{target:'src',targetDir:true,mode:'menu'});let labels=text(h.tools.menu({},h.cx));assert.ok(labels.includes('Open in Terminal'));assert.ok(!labels.includes('Duplicate'));Object.assign(h.tools,{target:''});labels=text(h.tools.menu({},h.cx));assert.ok(labels.includes('New File'));assert.ok(!labels.includes('Rename'));assert.ok(!labels.includes('Move to Trash'));});
test('row right-click passes its target to the pane and uses the pointer position',()=>{
 const h=tools(),row=h.tools.context(element('file-row'),'a.txt',false);
 assert.equal(row.id,'file-row');assert.equal(row.attrs.on_mouse_down[0],'right');
 row.attrs.on_mouse_down[1]();
 const area=h.tools.contextArea(element('files'),{},h.cx);
 area.attrs.on_mouse_down[1]({local_position:{x:227,y:302}},{...h.cx,stop_propagation(){}});
 assert.equal(h.tools.target,'a.txt');assert.equal(h.tools.targetDir,false);assert.equal(h.tools.contextPoint.x,227);assert.equal(h.tools.contextPoint.y,302);
 const rendered=h.tools.contextArea(element('files'),{},h.cx),popup=rendered.children[0];
 assert.deepEqual(popup.attrs.left,[227]);assert.deepEqual(popup.attrs.top,[302]);
});
test('the full pane handles blank space, padding and header right-clicks without a filler',()=>{
 const h=tools();
 for(const point of [{x:3,y:3},{x:5,y:130},{x:410,y:900}]){
  const area=h.tools.contextArea(element('files'),{},h.cx);
  area.attrs.on_mouse_down[1]({local_position:point},{...h.cx,stop_propagation(){}});
  assert.equal(h.tools.target,'');assert.equal(h.tools.targetDir,true);assert.equal(h.tools.contextPoint.x,point.x);assert.equal(h.tools.contextPoint.y,point.y);
 }
});
test('pointer position accounts for Herdr zoom instead of scaling the click twice',()=>{
 const h=tools(1.25),area=h.tools.contextArea(element('files'),{},h.cx);
 area.attrs.on_mouse_down[1]({local_position:{x:250,y:500}},{...h.cx,stop_propagation(){}});
 assert.equal(h.tools.contextPoint.x,200);assert.equal(h.tools.contextPoint.y,400);
});

test('creation opens an inline empty name inside the contextual folder', async()=>{
 for(const operation of ['new_file','new_folder']) for(const [target,directory,parent] of [['src',true,'src'],['src/old.txt',false,'src'],['',true,'']]){
  const h=tools();h.tools.targetDir=directory;h.tools.operation(operation,target,h.cx);
  assert.equal(h.tools.mode,'inline');assert.equal(h.tools.inlineParent,parent);assert.equal(h.tools.path.value(),'');assert.equal(h.tools.path.focused,true);assert.equal(h.tools.contextOpen,null);
  if(parent)assert.ok(h.owner.folders.has(parent));
  h.tools.path.set_value('new name');h.tools.path.emit('submit');await h.flush();
  assert.equal(h.calls[0][0],'file_prepare');assert.equal(h.calls[0][1].path,parent?`${parent}/new name`:'new name');assert.equal(h.calls[1][0],'file_apply');assert.equal(h.tools.mode,null);
 }
});

test('rename selects the basename and keeps its parent out of the input',async()=>{
 for(const [target,directory,end] of [['src/file.md',false,4],['src/.env',false,4],['src/folder.name',true,11]]){
  const h=tools();h.tools.targetDir=directory;h.tools.operation('rename',target,h.cx);
  assert.equal(h.tools.path.value(),target.split('/').pop());assert.equal(h.tools.path.selection.start,0);assert.equal(h.tools.path.selection.end,end);
  h.tools.path.set_value('changed');h.tools.path.emit('submit');await h.flush();
  assert.equal(h.calls[0][1].path,target);assert.equal(h.calls[0][1].destination,'src/changed');
 }
});

test('inline invalid names do not call the helper and Escape cancels without writes',()=>{
 const h=tools();h.tools.targetDir=true;
 for(const name of ['', ' ', '.', '..', '../bad', 'bad\\path', 'bad\0name', 'bad\nname']){
  h.tools.operation('new_file','',h.cx);h.tools.path.set_value(name);h.tools.path.emit('submit');assert.ok(h.tools.error);assert.equal(h.calls.length,0);
 }
 const row=h.tools.inlineRow(0,{});row.attrs.on_key_down[0]({key:'escape'},h.cx);assert.equal(h.tools.mode,null);assert.equal(h.calls.length,0);
});

test('unchanged rename cancels and helper errors keep the inline name retryable',async()=>{
 const h=tools();h.tools.targetDir=false;h.tools.operation('rename','file.md',h.cx);h.tools.path.emit('submit');assert.equal(h.tools.mode,null);assert.equal(h.calls.length,0);
 h.tools.operation('new_file','',h.cx);h.tools.path.set_value('taken');
 h.c.exec=async()=>({code:1,stdout:JSON.stringify({error:'An item already exists at that destination'})});
 h.tools.path.emit('submit');await h.flush();assert.equal(h.tools.mode,'inline');assert.match(h.tools.error,/already exists/);assert.equal(h.tools.prepared,null);assert.equal(h.tools.busy,false);
 h.tools.path.set_value('available');h.tools.path.emit('change');assert.equal(h.tools.error,null);
 h.c.exec=async(_cmd,args)=>({code:0,stdout:JSON.stringify(args[1]==='file_prepare'?{root:'/repo',drafts:[]}:{} )});
 h.tools.path.emit('submit');await h.flush();assert.equal(h.tools.mode,null);
});

test('inline rename preserves draft resolution and cannot dismiss during a write',async()=>{
 const h=tools();h.tools.operation('rename','file.md',h.cx);h.tools.path.set_value('next.md');
 h.c.exec=async(_cmd,args)=>{h.calls.push(args[1]);return{code:0,stdout:JSON.stringify(args[1]==='file_prepare'?{root:'/repo',drafts:[{id:'dirty'}]}:{})};};
 h.tools.path.emit('submit');h.tools.inlineRow(0,{}).attrs.on_key_down[0]({key:'escape'},h.cx);assert.equal(h.tools.mode,'inline');
 await h.flush();assert.deepEqual(h.calls,['file_prepare']);
 let row=h.tools.inlineRow(0,{});assert.match(text(row),/unsaved draft/);row.attrs.on_mouse_down_out[0]({},h.cx);assert.equal(h.tools.mode,'inline');
 h.tools.confirm('save',h.cx);await h.flush();assert.deepEqual(h.calls,['file_prepare','file_apply']);assert.equal(h.tools.mode,null);
});

test('tree replaces the renamed row and inserts new items at their actual depth',()=>{
 const h=tools();
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../mods/files-browser/gitState.js'),'utf8').replace(/export /g,''),h.c);
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../mods/files-browser/main.js'),'utf8').replace(/^import .*;\n/gm,'').replace(/export default class /,'class ')+'\nglobalThis.Files=Files',h.c);
 Object.assign(h.owner,{tools:h.tools,rows:h.c.Files.prototype.rows,entries:new Map([['',[{name:'src',dir:true},{name:'root.md',dir:false}]],['src',[{name:'old.md',dir:false}]]]),git:h.c.gitState(null)});
 h.tools.targetDir=true;h.tools.operation('new_file','src',h.cx);
 let rows=h.c.Files.prototype.rows.call(h.owner,'',0,[],{});assert.equal(rows[1].id,'files-inline-operation');assert.deepEqual(rows[1].attrs.pl,[26]);
 h.tools.targetDir=false;h.tools.operation('rename','src/old.md',h.cx);
 rows=h.c.Files.prototype.rows.call(h.owner,'',0,[],{});assert.equal(rows[1].id,'files-inline-operation');assert.ok(!rows.some(row=>row.id==='file-src/old.md'));assert.equal(rows.length,3);
});

test('Quick Open starts immediately and coalesces typing while rejecting stale results',async()=>{
 const h=tools(),timers=[];h.cx.timer={after(ms,fn){timers.push({ms,fn});}};
 let first;
 h.c.exec=async(_cmd,args)=>{h.calls.push([args[1],JSON.parse(args[2])]);if(args[1]==='search')return new Promise(resolve=>{first=resolve;});return{code:0,stdout:'{}'};};
 h.tools.show('files',h.cx);assert.equal(timers[0].ms,0);assert.equal(h.calls.length,0);
 timers.shift().fn(h.cx);assert.equal(h.calls[0][0],'search');
 h.tools.query.set_value('m');h.tools.query.emit('change');h.tools.query.set_value('main');h.tools.query.emit('change');
 assert.ok(timers.every(timer=>timer.ms===150));
 first({code:0,stdout:JSON.stringify({items:[{path:'old'}],incomplete:false})});await h.flush();assert.equal(h.tools.results.length,0);
 h.c.exec=async(_cmd,args)=>{h.calls.push([args[1],JSON.parse(args[2])]);return{code:0,stdout:JSON.stringify({items:[{path:'main.js'}],incomplete:false})};};
 timers.forEach(timer=>timer.fn(h.cx));await h.flush();
 assert.equal(h.calls.filter(([action])=>action==='search').length,2);assert.equal(h.calls.at(-1)[1].query,'main');assert.equal(h.tools.results[0].path,'main.js');assert.equal(h.tools.searching,false);
});
