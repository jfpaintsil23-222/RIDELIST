// Public-safe synthetic transport. Never proxies requests or loads real accounts.
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,extname} from 'node:path';
const root=resolve(new URL('../..',import.meta.url).pathname), date='2099-01-04';
const drivers=['a','b','c'].map((slug,i)=>({slug,displayName:`Example Driver ${i+1}`,initials:`E${i+1}`,phone:'',active:true}));
let snapshot={ok:true,planDate:date,writeMode:'shared',draftRevision:1,eventCursor:1,publishedRevision:0,baselinePublishedRevision:0,settingsVersion:1,drivers,groupVersions:{a:1,b:1,c:1,'':1,'@drivers':1},riders:[{id:'00000000-0000-4000-8000-000000000001',name:'Example Rider with a deliberately long synthetic name',address:'100 Example Street',area:'FLOC',driverSlug:'a',stopOrder:1,entityVersion:1,phone:'',pickupTime:'09:00',readyBy:'08:55'},{id:'00000000-0000-4000-8000-000000000002',name:'Sample Rider Two',address:'200 Fictional Avenue',area:'FLOC',driverSlug:'b',stopOrder:1,entityVersion:1,phone:'',pickupTime:'09:10'}],publishedSnapshot:{ok:true,plan:{date,title:'Sunday Ride Plan'},drivers,stops:[],people:[],destination:{name:'Example destination',address:'300 Sample Street'}}};
const results=new Map(),events=[];
function rpc(name,args){const actorKey=`profile:${args.p_admin_code||'a'}`;
 if(name==='ride_admin_shared_context')return {...snapshot,actorKey,initialized:true,events:events.filter(e=>e.eventCursor>(args.p_after_event||0))};
 if(name==='ride_admin_shared_snapshot')return snapshot;
 if(name==='ride_admin_shared_secondary')return {ok:true,actorKey,planDate:date,people:[],driverPool:drivers,brandingVersion:1,branding:{}};
 if(name==='ride_admin_shared_recovery')return {ok:true,candidates:[]};
 if(name==='ride_admin_shared_operation')return results.get(args.p_operation_id)?.result||{ok:false,code:'not_found'};
 if(name==='ride_admin_shared_mutate'||name==='ride_admin_shared_publish'){
 const op=args.p_operation,id=op?.operationId||args.p_operation_id,body=JSON.stringify({...args,p_admin_code:undefined});
 if(results.has(id))return results.get(id).body===body?results.get(id).result:{ok:false,code:'operation_id_reused'};
 const rider=snapshot.riders.find(r=>r.id===op?.entityId);let result;
 if(op && (op.expectedBaselinePublishedRevision!==snapshot.baselinePublishedRevision || (op.entityId&&op.kind!=='rider_add'&&rider?.entityVersion!==op.expectedEntityVersion)||Object.entries(op.expectedGroupVersions||{}).some(([k,v])=>snapshot.groupVersions[k]!==v)))result={ok:false,code:'conflict',conflict:{current:rider}};
 else if(!op&&(args.p_expected_draft_revision!==snapshot.draftRevision||args.p_expected_baseline_revision!==snapshot.baselinePublishedRevision))result={ok:false,code:'conflict'};
 else {if(op){if(op.kind==='rider_remove')snapshot.riders=snapshot.riders.filter(r=>r.id!==op.entityId);else if(op.kind==='rider_add')snapshot.riders.push({...op.payload,id:op.entityId,entityVersion:1});else Object.assign(rider,op.payload,{entityVersion:rider.entityVersion+1});for(const k of Object.keys(op.expectedGroupVersions||{}))snapshot.groupVersions[k]++;snapshot.draftRevision++;}else{snapshot.publishedRevision++;snapshot.baselinePublishedRevision=snapshot.publishedRevision;snapshot.publishedSnapshot={...snapshot.publishedSnapshot,stops:structuredClone(snapshot.riders)};}snapshot.eventCursor++;events.push({eventCursor:snapshot.eventCursor,actorKey,type:op?.kind||'published',draftRevision:snapshot.draftRevision});result={ok:true,draftRevision:snapshot.draftRevision,eventCursor:snapshot.eventCursor};}
 result.operationId=id;results.set(id,{body,result});return result;}
 if(name==='ride_context')return {ok:true,plan:snapshot.publishedSnapshot.plan,drivers:[],appSettings:{}};
 return [];
}
const server=http.createServer(async(req,res)=>{res.setHeader('Content-Security-Policy',"default-src 'self' data:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; worker-src 'none'");try{const url=new URL(req.url,'http://localhost');if(url.pathname==='/rpc'){let body='';for await(const chunk of req)body+=chunk;const {name,args}=JSON.parse(body);res.setHeader('Content-Type','application/json');res.end(JSON.stringify(rpc(name,args)));return;}
 const path=resolve(root,'.'+(url.pathname==='/'?'/index.html':url.pathname));if(!path.startsWith(root+'/')){res.writeHead(403).end();return;}let data=await readFile(path);if(path.endsWith('index.html')){let html=data.toString();html=html.replace('<script>',`<script>const fixtureFetch=window.fetch.bind(window);window.fetch=(url,init={})=>{const target=new URL(url,location.href);if(target.origin===location.origin)return fixtureFetch(url,init);const name=target.pathname.split('/').pop();return fixtureFetch('/rpc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,args:JSON.parse(init.body||'{}')})});};</script><script>`);html=html.replace('    loadDrivers();',`    window.fixtureApp={state,render,loadAdminSnapshot,reviewAdminShared,applyAdminSharedState};
    state.planDate='${date}';
    if(new URLSearchParams(location.search).has('home')) { state.loading=false;render(); } else { loadAdminSnapshot(new URLSearchParams(location.search).get('actor')||'a').then(()=>{state.view='admin';state.adminExpandedZone='floc';render();}); }`);data=html;}
 res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.png':'image/png','.css':'text/css','.webmanifest':'application/json'})[extname(path)]||'application/octet-stream');res.end(data);
 }catch(error){res.writeHead(404).end('Not found');}});
server.listen(Number(process.env.PORT||4176),'127.0.0.1',()=>console.log('Synthetic-only preview: http://127.0.0.1:4176/?actor=a (a, b, c); home: /?home=1'));
