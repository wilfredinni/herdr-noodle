const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
function element(id){const n={id,children:[],attrs:{}};let p;return p=new Proxy(n,{get(n,k){if(k in n)return n[k];if(k==='child'||k==='trigger'||k==='content')return c=>(n.children.push(c),p);if(k==='children')return a=>(n.children.push(...a),p);if(k==='when')return(c,f)=>(c&&f(p),p);return(...a)=>(n.attrs[k]=a,p);}});}
const text=n=>typeof n==='string'?n:(n?.children||[]).map(text).join(' ');
function tools(zoom=1){const calls=[],cx={focus_handle:()=>({focus(){}}),notify(){}};const input={new:()=>({on(){},value:()=>'',set_value(){},focus(){}})};
 const c=vm.createContext({div:element,svg:element,h_flex:element,v_flex:element,Button:{new:element},Popup:{new:(id,trigger)=>element(id).child(trigger)},Input:{new:element},InputState:input,Date,Math,Map,Set,settings:()=>({zoom}),shared:()=>null,setShared(){},run:(...args)=>calls.push(args)});
 const source=fs.readFileSync(path.join(__dirname,'../mods/files-browser/tools.js'),'utf8').replace(/^import .*;\n/gm,'').replace(/export /g,'');vm.runInContext(source+'\nglobalThis.FileTools=FileTools',c);
 const owner={root:'/repo',on:null,git:{root:'/repo'}};return {tools:new c.FileTools(owner,cx),owner,cx,calls};}
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
