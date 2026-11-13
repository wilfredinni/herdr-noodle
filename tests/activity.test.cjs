const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs'),vm=require('node:vm');
function element(id){const n={id,nodes:[],attrs:{},handlers:{}};let p;p=new Proxy(n,{get(n,k){if(k==='id'&&n.id===undefined)return v=>(n.id=v,p);if(k in n)return n[k];if(['child','trigger','content'].includes(k))return v=>(n.nodes.push(v),p);if(k==='children')return v=>(n.nodes.push(...v),p);if(k==='when')return(c,f)=>(c&&f(p),p);return(...a)=>{n.attrs[k]=a;if(k.startsWith('on_'))n.handlers[k.slice(3)]=a.at(-1);return p;}}});return p;}
function input(){let v='';return{value:()=>v,set_value:x=>v=x,focus(){},on(){}}}
const find=(n,id)=>n?.id===id?n:n?.nodes?.map(x=>find(x,id)).find(Boolean);const texts=n=>typeof n==='string'?n:(n?.nodes??[]).map(texts).join(' ');
function harness(){const pending=[],errors=[],notices=[],saved={};let key='repo',response={subject:'Update selected files'};const owner={root:'/repo',on:null,context:key,files:[{path:'a',staged:true},{path:'b',staged:false}],message:'',messageRevision:0,input:input(),refresh(){}};const cx={focus_handle:()=>({focus(){}}),notify(){},stop_propagation(){},spawn(f){pending.push(f(cx));}};owner.gitToolbar={snapshot:()=>({root:owner.root,on:owner.on,context:owner.context,head:'hash',branch:'main'}),enabled:()=>!owner.busy};const c={div:element,svg:src=>{const el=element();el.attrs.src=[src];return el},image:element,h_flex:element,v_flex:element,Button:{new:element},Popover:{new:element},InputState:{new:input},Input:{new:element},ScrollHandle:{new:()=>({scroll_to_item(){}})},shared:k=>saved[k],setShared:(k,v)=>saved[k]=v,notify:v=>notices.push(v),showGitError:(l,e)=>errors.push(e.message)};vm.createContext(c);vm.runInContext(fs.readFileSync(__dirname+'/../mods/changes-graph/commitGenerator.js','utf8').replace(/^import .*;\n/gm,'').replace(/export /g,'')+'\nObject.assign(globalThis,{CommitGenerator,selectedPaths,sameDraft})',c);const gen=new c.CommitGenerator(owner,()=>key,cx);gen.machine=null;gen.connections=[{id:'codex',name:'Codex',icon:'icon',models:[{id:'model1',name:'Model One'},{id:'model2',name:'Model Two'}]}];gen.selected={connection:'codex',model:'model1'};const requests=[];gen.call=async req=>{requests.push(req);return typeof response==='function'?response(req):response};return{c,gen,owner,cx,requests,errors,notices,saved,setKey:v=>key=v,setResponse:v=>response=v,async flush(){while(pending.length)await Promise.all(pending.splice(0))}}}
const t=new Proxy({},{get:(_,k)=>k});
test('subset request includes exactly checked files and never commits',async()=>{const h=harness();h.gen.generate(h.cx);await h.flush();assert.equal(JSON.stringify(h.requests[0].selected),'["a"]');assert.equal(h.owner.message,'Update selected files');assert.equal(h.owner.input.value(),h.owner.message);assert.equal(h.requests[0].action,'generate');assert.equal(h.owner.busy,false)});
test('none selected remains enabled and requests all semantics',async()=>{const h=harness();h.owner.files.forEach(f=>f.staged=false);assert.equal(find(h.gen.render(t,h.cx),'generate-commit-message').attrs.disabled[0],false);h.gen.generate(h.cx);await h.flush();assert.equal(JSON.stringify(h.requests[0].selected),'[]')});
test('all checked is passed intact',async()=>{const h=harness();h.owner.files.forEach(f=>f.staged=true);h.gen.generate(h.cx);await h.flush();assert.equal(JSON.stringify(h.requests[0].selected),'["a","b"]')});
test('late response does not overwrite edited draft',async()=>{const h=harness();h.gen.generate(h.cx);h.owner.message='My own subject';h.owner.messageRevision++;await h.flush();assert.equal(h.owner.message,'My own subject');assert.equal(h.notices.length,1)});
test('repo change discards late response',async()=>{const h=harness();h.gen.generate(h.cx);h.setKey('other');await h.flush();assert.equal(h.owner.message,'');assert.equal(h.notices.length,1)});
test('selection change discards late response',async()=>{const h=harness();h.gen.generate(h.cx);h.owner.files[1].staged=true;await h.flush();assert.equal(h.owner.message,'')});
test('provider failure preserves draft and releases lock',async()=>{const h=harness();h.owner.message='Keep';h.setResponse(()=>{throw Error('Quota exceeded')});h.gen.generate(h.cx);await h.flush();assert.equal(h.owner.message,'Keep');assert.equal(h.owner.busy,false);assert.equal(h.errors[0],'Quota exceeded')});
test('connection leads to model selection, persistence and matching icon',()=>{const h=harness();h.gen.open=true;let body=h.gen.body(t,h.cx);find(body,'generate-connection-codex').handlers.click({},h.cx);assert.equal(h.gen.picking,'codex');body=h.gen.body(t,h.cx);assert.match(texts(body),/Model One/);find(body,'generate-model-model2').handlers.click({},h.cx);assert.equal(h.gen.selected.model,'model2');assert.equal(h.saved['ai.commit.local'].model,'model2');assert.equal(h.gen.open,false)});
test('working label remains Generate with native spinner',()=>{const h=harness();h.gen.running=true;const tree=h.gen.render(t,h.cx);assert.match(texts(tree),/Generate/);assert.doesNotMatch(texts(tree),/Working|Generating/);assert.equal(find(tree,'generate-commit-message').attrs.disabled[0],true)});
test('stale model choice disables generation instead of falling back',()=>{const h=harness();h.gen.selected.model='removed';assert.equal(find(h.gen.render(t,h.cx),'generate-commit-message').attrs.disabled[0],true)});
test('generation never sets the Git toolbar activity state',async()=>{const h=harness();h.gen.generate(h.cx);assert.equal(h.gen.running,true);assert.equal(h.owner.busy,true);assert.equal(h.owner.gitToolbar.running,undefined);await h.flush();assert.equal(h.owner.gitToolbar.running,undefined);assert.equal(h.gen.running,false)});

function activityHarness(){
 const h=harness();
 h.c.exec=async(_cmd,args)=>({code:0,stdout:args.includes("symbolic-ref")?"refs/heads/main\n":"",stderr:""});
 h.c.shortAge=()=>"";h.c.verify=async()=>{};h.c.stage=async()=>{};
 vm.runInContext(fs.readFileSync(__dirname+'/../mods/changes-graph/gitToolbar.js','utf8').replace(/^import .*;\n/gm,'').replace(/export /g,'')+'\nglobalThis.GitToolbar=GitToolbar;',h.c);
 vm.runInContext(fs.readFileSync(__dirname+'/../mods/changes-graph/fileActions.js','utf8').replace(/^import .*;\n/gm,'').replace(/export /g,'')+'\nglobalThis.FileActions=FileActions;',h.c);
 h.owner.gitToolbar=new h.c.GitToolbar(h.owner,()=>h.owner.context,h.cx);
 h.owner.branch='main';h.owner.head='hash';h.owner.fileActions=new h.c.FileActions(h.owner,()=>h.owner.context,h.cx);
 return h;
}
test('file selection keeps Fetch, Generate and branch appearance steady',async()=>{
 const h=activityHarness(),toolbar=h.owner.gitToolbar;
 const branchColor=find(toolbar.render(t,h.cx),'git-current-branch').attrs.text_color[0];
 const generateColor=find(h.gen.render(t,h.cx),'generate-commit-message').attrs.text_color[0];
 h.owner.fileActions.stageFiles(['a'],true,h.cx);
 assert.equal(h.owner.busy,true);assert.equal(toolbar.running,undefined);assert.equal(toolbar.remoteRunning,undefined);assert.equal(h.gen.running,false);
 assert.equal(find(toolbar.render(t,h.cx),'fetch-action-spinner'),undefined);
 assert.equal(find(h.gen.render(t,h.cx),'commit-generation-spinner'),undefined);
 assert.equal(find(toolbar.render(t,h.cx),'git-current-branch').attrs.text_color[0],branchColor);
 assert.equal(find(h.gen.render(t,h.cx),'generate-commit-message').attrs.text_color[0],generateColor);
 await h.flush();assert.equal(h.owner.busy,false);
});
test('branch switching does not spin Fetch or Generate',async()=>{
 const h=activityHarness(),toolbar=h.owner.gitToolbar;
 toolbar.run('Switch to test',['switch','--','test'],h.cx,toolbar.snapshot());
 assert.equal(toolbar.remoteRunning,false);assert.equal(find(toolbar.render(t,h.cx),'fetch-action-spinner'),undefined);assert.equal(find(h.gen.render(t,h.cx),'commit-generation-spinner'),undefined);await h.flush();
});
test('Fetch-menu remote actions spin only Fetch',async()=>{
 for(const action of ['fetch','pull','push']){
  const h=activityHarness(),toolbar=h.owner.gitToolbar;
  toolbar.run(action,[action],h.cx,toolbar.snapshot());
  assert.equal(toolbar.remoteRunning,true);assert.ok(find(toolbar.render(t,h.cx),'fetch-action-spinner'));assert.equal(find(h.gen.render(t,h.cx),'commit-generation-spinner'),undefined);await h.flush();assert.equal(toolbar.remoteRunning,false);
 }
});
test('message generation spins only Generate',async()=>{
 const h=activityHarness();h.gen.generate(h.cx);
 assert.ok(find(h.gen.render(t,h.cx),'commit-generation-spinner'));assert.equal(find(h.owner.gitToolbar.render(t,h.cx),'fetch-action-spinner'),undefined);await h.flush();
});
