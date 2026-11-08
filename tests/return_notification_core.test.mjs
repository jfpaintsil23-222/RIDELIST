import assert from 'node:assert/strict';
import {test} from 'node:test';
import * as core from '../supabase/functions/ride-driver-notifications/notification-core.js';

test("return-ready payload carries no rider details and uses a release-specific tag",()=>{
 assert.equal(typeof core.buildReturnReleasePayload,"function");
 const payload=core.buildReturnReleasePayload("synthetic-release");
 assert.equal(payload.body,"Your rides home are ready. Open the app to view your list.");
 assert.equal(payload.tag,"ridelist-return-synthetic-release");
});
test("return job delivery records missing devices, sent results and uncertain outcomes separately",async()=>{
 assert.equal(typeof core.dispatchReturnJobs,"function");
 const finished=[];
 const result=await core.dispatchReturnJobs([{id:"a",active:true},{id:"b",active:false},{id:"c",active:true}],{
 send:async job=>{if(job.id==="c")throw Error("connection lost");},
 finish:async(job,status)=>{finished.push([job.id,status]);}
 });
 assert.deepEqual(finished,[["a","sent"],["b","no_device"],["c","unknown"]]);
 assert.deepEqual(result,{sent:1,failed:0,unknown:1,noDevice:1});
});
