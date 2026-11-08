import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
import vm from 'node:vm';
import * as core from '../supabase/functions/ride-driver-notifications/notification-core.js';
async function loadHandler({authorized=true,configured=true,jobs=[],finish=true}={}){
 let serve;const sent=[],calls=[];
 const source=(await readFile(new URL('../supabase/functions/ride-driver-notifications/index.ts',import.meta.url),'utf8'))
  .replace(/^import "jsr:[^\n]+\n/,'').replace(/^import webpush[^\n]+\n/m,'').replace(/import \{[\s\S]*?\} from "\.\/notification-core\.js";/,'');
 const env={SUPABASE_URL:'https://example.test',SUPABASE_ANON_KEY:'synthetic',...(configured?{VAPID_PUBLIC_KEY:'synthetic-public',VAPID_PRIVATE_KEY:'synthetic-private'}:{})};
 vm.runInNewContext(stripTypeScriptTypes(source),{...core,console,Request,Response,URL,
 webpush:{setVapidDetails(){},async sendNotification(subscription,payload){sent.push(JSON.parse(payload));}},
 fetch:async(url,init)=>{const name=url.split('/').pop();calls.push({name,body:JSON.parse(init.body),auth:init.headers.authorization});let data;
 if(name==='ride_admin_return_state')data={ok:authorized,phase:'return',releaseId:'00000000-0000-0000-0000-000000000001'};
 else if(name==='ride_admin_claim_return_notifications')data={ok:true,jobs:jobs.splice(0,1)};
 else if(name==='ride_admin_finish_return_notification')data={ok:finish};else throw Error('Unexpected RPC');
 return new Response(JSON.stringify(data));},
 Deno:{env:{get:key=>env[key]},serve:fn=>serve=fn}});
 return {sent,calls,run:()=>serve(new Request('https://example.test/function',{method:'POST',headers:{authorization:'Bearer synthetic-session','content-type':'application/json'},body:JSON.stringify({mode:'send-return-release',planDate:'2099-01-04',releaseId:'00000000-0000-0000-0000-000000000001'})}))};
}
test('return notification handler authenticates before claiming or sending and supports an admin bearer session',async()=>{
 const denied=await loadHandler({authorized:false});assert.equal((await denied.run()).status,403);assert.equal(denied.sent.length,0);assert.equal(denied.calls.length,1);
 const allowed=await loadHandler();assert.equal((await allowed.run()).status,200);assert.equal(allowed.calls[0].auth,'Bearer synthetic-session');
});
test('missing notification setup leaves durable jobs unclaimed',async()=>{
 const h=await loadHandler({configured:false});assert.equal((await h.run()).status,503);assert.equal(h.calls.length,1);assert.equal(h.sent.length,0);
});
test('return notification handler sends generic payload and persists the matching lease result',async()=>{
 const h=await loadHandler({jobs:[{id:'job',leaseToken:'lease',active:true,subscription:{endpoint:'synthetic'}}]});
 assert.equal((await h.run()).status,200);assert.equal(h.sent.length,1);assert.match(h.sent[0].body,/rides home are ready/);
 const result=h.calls.find(c=>c.name==='ride_admin_finish_return_notification');assert.equal(result.body.p_lease_token,'lease');assert.equal(result.body.p_status,'sent');
});
test('accepted send with failed result persistence reports failure without another send',async()=>{
 const h=await loadHandler({jobs:[{id:'job',leaseToken:'lease',active:true,subscription:{}}],finish:false});
 assert.equal((await h.run()).status,500);assert.equal(h.sent.length,1);
});
