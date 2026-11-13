const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
function element(id){const node={id,nodes:[],attrs:{},handlers:{}};let p;p=new Proxy(node,{get(n,k){if(k==='id'&&n.id===undefined)return v=>(n.id=v,p);if(k in n)return n[k];if(k==='child'||k==='trigger'||k==='content')return v=>(n.nodes.push(v),p);if(k==='children')return v=>(n.nodes.push(...v),p);if(k==='when')return(c,fn)=>(c&&fn(p),p);return(...args)=>{n.attrs[k]=args;if(k.startsWith('on_'))n.handlers[k.slice(3)]=args.at(-1);return p;};}});return p;}
const find=(n,id)=>n?.id===id?n:n?.nodes?.map(x=>find(x,id)).find(Boolean);
const texts=n=>typeof n==='string'?n:(n?.nodes??[]).map(texts).join(' ');
const good=(percent=69)=>({state:'ok',mode:'subscription',checkedAt:Date.now()/1000,windows:[{label:'7d',usedPercent:percent,resetsAt:2000000000}],installed:true,authenticated:true});
function harness(execOverride){
 const pending=[],calls=[],timers=[];let machine=null,directory=null,inRender=false;
 const cx={focus_handle:()=>({}),notify(){if(inRender)throw new Error("cx.notify() is forbidden during render");},stop_propagation(){},open_url(){},spawn(fn){pending.push(fn(cx));},timer:{every(ms,fn){timers.push({ms,fn});}}};
 const context={Date,Map,Set,console,View:class{},div:element,svg:element,image:element,h_flex:element,v_flex:element,Button:{new:element},Popover:{new:element},focused:()=>({cwd:directory,tab:'tab'}),panes:()=>[],spaces:()=>[{active:true,machine,branch:'main'}],agents:()=>[{status:'working'}],theme:()=>new Proxy({},{get:(_,k)=>String(k)}),appHome:()=>'/home/herdr',readTextFile:async()=>fs.readFileSync(__dirname+'/../mods/workspace-usage/collect.py','utf8'),exec:async(cmd,args,options)=>{calls.push({cmd,args,options});if(execOverride)return execOverride(cmd,args,options);return {code:0,stdout:JSON.stringify(args[2]==='codex'?good():{state:'missing',mode:'unknown',checkedAt:Date.now()/1000,installed:false,note:'CLI not installed.'})};}};
 vm.createContext(context);
 const source=fs.readFileSync(__dirname+'/../mods/workspace-usage/connections.js','utf8').replace(/^import .*;\n/gm,'').replace(/export /g,'');vm.runInContext(source+'\nObject.assign(globalThis,{CONNECTIONS,connectionById,readConnection,mergeReading,quotaMeter,stale,modeLabel,age,resetIn});',context);
 const main=fs.readFileSync(__dirname+'/../mods/workspace-usage/main.js','utf8').replace(/^import .*;\n/gm,'').replace('export default class WorkspaceUsage','globalThis.WorkspaceUsage = class WorkspaceUsage');vm.runInContext(main,context);const view=new context.WorkspaceUsage();view.init({},cx);
 return {context,view,cx,calls,timers,render(){inRender=true;try{return view.render(cx);}finally{inRender=false;}},move:m=>machine=m,folder:value=>directory=value,async flush(){while(pending.length)await Promise.all(pending.splice(0));}};
}

test('footer shows one weekly quota per provider while details retain all windows',async()=>{
 const h=harness();await h.flush();
 for(const connection of h.context.CONNECTIONS){
  const prefix=connection.id==='opencode'?'Go · ':'';
  h.view.records.set(h.view.key(connection),h.context.mergeReading(null,{...good(),windows:[
   {label:prefix+'5h',usedPercent:4,resetsAt:2000000000},
   {label:prefix+'7d',usedPercent:20,resetsAt:2000000000},
   {label:prefix+'month',usedPercent:30,resetsAt:2000000000},
  ]}));
 }
 const root=find(h.view.render(h.cx),'ai-usage-toggle'),text=texts(root);
 assert.equal((text.match(/20%/g)||[]).length,h.context.CONNECTIONS.length);
 assert.doesNotMatch(text,/5h|mo|4%|30%/);
 assert.ok(find(root,'icons/codex.svg'));assert.ok(find(root,'icons/opencode.svg'));
 assert.ok(root.nodes.some(n=>n.attrs?.w?.[0]===1&&n.attrs?.h?.[0]===12));
 h.view.open=true;
 const details=texts(h.view.details(h.context.theme()));
 for(const value of ['5h','7d','month','4%','20%','30%'])assert.ok(details.includes(value),value);
});
test('footer falls back to the first available quota when no weekly quota exists',async()=>{
 const h=harness();await h.flush();const c=h.context.CONNECTIONS[0];
 h.view.records.set(h.view.key(c),h.context.mergeReading(null,{...good(),windows:[
  {label:'month',usedPercent:31,resetsAt:2000000000},
  {label:'5h',usedPercent:12,resetsAt:2000000000},
 ]}));
 const text=texts(find(h.view.render(h.cx),'ai-usage-toggle'));
 assert.match(text,/mo/);assert.match(text,/31%/);assert.doesNotMatch(text,/5h|12%/);
});
test('green, warning and red thresholds match in compact and detail progress bars',async()=>{const h=harness();await h.flush();const t=h.context.theme(),c=h.context.CONNECTIONS[0];for(const [percent,color] of [[0,'ansi2'],[4,'ansi2'],[69,'ansi2'],[70,'ansi3'],[89,'ansi3'],[90,'ansi1'],[100,'ansi1']]){const w={label:'5h',usedPercent:percent,resetsAt:2000000000,minutes:300};assert.equal(h.view.color(percent,t),color);const compact=h.view.compactQuota(c,w,t),detail=h.view.quota(w,false,t);const compactTrack=compact.nodes[1].nodes[0],detailTrack=detail.nodes[1].nodes[0];if(percent>0){assert.equal(compactTrack.nodes[0].attrs.bg[0],color);assert.equal(detailTrack.nodes[0].attrs.bg[0],color);}else{assert.equal(compactTrack.nodes.length,0);assert.equal(detailTrack.nodes.length,0);}}});
test('time marker uses known window length and is omitted for unknown monthly duration',async()=>{const h=harness();await h.flush();const now=10000;assert.equal(h.context.quotaMeter({label:'5h',usedPercent:5,resetsAt:now+150*60,minutes:300},now).tick,0.5);assert.equal(h.context.quotaMeter({label:'Go · month',usedPercent:5,resetsAt:now+10000},now).tick,null);assert.equal(h.context.quotaMeter({label:'Go · 7d',usedPercent:5,resetsAt:now+500,minutes:10080},now).label,'wk');});
test('expired quota shows a dash and never draws a fake zero or filled meter',async()=>{const h=harness();await h.flush();const w={label:'5h',usedPercent:88,resetsAt:100,minutes:300};assert.equal(h.context.quotaMeter(w,200).percent,null);const tree=h.view.compactQuota(h.context.CONNECTIONS[0],w,h.context.theme());assert.match(texts(tree),/—/);assert.doesNotMatch(texts(tree),/0%|88%/);assert.equal(tree.nodes[1].nodes[0].nodes.length,0);});
test('API estimates, account breakdown and cost explanation are removed from all presentation',async()=>{const h=harness();await h.flush();const c=h.context.connectionById('opencode');const data={...good(),mode:'mixed',spend:{today:{apiEstimateUsd:9},week:{apiEstimateUsd:25,subscriptionEquivalentUsd:20,unclassifiedUsd:5}},accounts:[{provider:'opencode-go',mode:'subscription'}],note:'Local estimates, not invoices. Based on current account types.'};h.view.records.set(h.view.key(c),h.context.mergeReading(null,data));h.view.open=true;const content=texts(h.view.render(h.cx));assert.doesNotMatch(content,/API estimate|Subscription token value|Unclassified|Local estimates|opencode-go:|\$/);assert.ok(h.view.record(c).good.spend);});
test('not-installed providers remain in their compact group at the end',async()=>{const h=harness();await h.flush();h.view.open=true;const content=texts(h.view.render(h.cx));assert.ok(content.indexOf('Not installed')>content.indexOf('Codex'));assert.ok(content.indexOf('Claude')>content.indexOf('Not installed'));assert.ok(content.indexOf('Kiro')>content.indexOf('Not installed'));});
test('failed reads preserve dated values while removed accounts disappear from the bar',async()=>{const h=harness();await h.flush();const c=h.context.CONNECTIONS[0];h.view.records.set(h.view.key(c),h.context.mergeReading(h.view.record(c),{state:'error',installed:true,note:'Could not read usage'}));assert.equal(h.context.stale(h.view.record(c)),true);assert.match(texts(find(h.view.render(h.cx),'ai-usage-toggle')),/69%/);h.view.records.set(h.view.key(c),h.context.mergeReading(h.view.record(c),{state:'missing',installed:false}));assert.doesNotMatch(texts(find(h.view.render(h.cx),'ai-usage-toggle')),/69%/);});
test('Go sign-in and usage errors remain readable without a fabricated percentage',async()=>{const h=harness();await h.flush();const c=h.context.connectionById('opencode');h.view.records.set(h.view.key(c),h.context.mergeReading(null,{state:'ok',mode:'subscription',installed:true,checkedAt:Date.now()/1000,go:{state:'unavailable',note:'Sign in to Console to read Go limits.'},windows:[]}));h.view.open=true;assert.match(texts(h.view.render(h.cx)),/Sign in to Console/);assert.match(texts(find(h.view.render(h.cx),'ai-usage-toggle')),/—/);});
test('quota data still follows project scope without mixing connection state',async()=>{const h=harness((cmd,args)=>Promise.resolve({code:0,stdout:JSON.stringify(args[2]==='opencode'?{...good(),windows:[{label:'Go · 7d',usedPercent:args[3]==='/b'?25:10,resetsAt:2000000000}]}:good())}));await h.flush();const c=h.context.connectionById('opencode');h.folder('/a');h.view.render(h.cx);await h.flush();assert.equal(h.view.record(c).good.windows[0].usedPercent,10);h.folder('/b');h.view.render(h.cx);assert.equal(h.view.record(c),undefined);await h.flush();assert.equal(h.view.record(c).good.windows[0].usedPercent,25);});

test('switching spaces never notifies synchronously during render',async()=>{
 const h=harness();await h.flush();
 h.folder('/workspace-a');assert.doesNotThrow(()=>h.render());await h.flush();
 h.folder('/workspace-b');assert.doesNotThrow(()=>h.render());await h.flush();
 h.folder('/workspace-a');assert.doesNotThrow(()=>h.render());await h.flush();
});
test('switching machines renders safely before async usage reads finish',async()=>{
 const h=harness();await h.flush();
 h.move('remote');assert.doesNotThrow(()=>h.render());await h.flush();
 h.move(null);assert.doesNotThrow(()=>h.render());await h.flush();
});
