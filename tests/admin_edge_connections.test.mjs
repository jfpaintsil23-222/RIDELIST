import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import * as organizer from '../supabase/functions/ride-ai-organizer/organizer-core.js';

// Execute actual Edge handlers with synthetic environment and network responses.
async function handler(slug, fetch, extraEnv = {}) {
  const env = { SUPABASE_URL: 'https://example.test', SUPABASE_ANON_KEY: 'synthetic-public', GOOGLE_ROUTES_API_KEY: 'synthetic-google', ...extraEnv };
  let serve;
  const source = (await readFile(new URL(`../supabase/functions/${slug}/index.ts`, import.meta.url), 'utf8'))
    .replace(/^import "jsr:[^\n]+\n/, '')
    .replace(/import \{[\s\S]*?\} from "\.\/organizer-core\.js";/, '');
  vm.runInNewContext(stripTypeScriptTypes(source), { ...organizer, Request, Response, URL, console, fetch,
    Deno: { env: { get: key => env[key] }, serve: fn => { serve = fn; } } });
  return body => serve(new Request('https://example.test/function', { method: 'POST', headers: { authorization: 'Bearer synthetic-session', 'content-type': 'application/json' }, body: JSON.stringify(body) }));
}
const json = body => new Response(JSON.stringify(body));

test('Google address lookup accepts a server-verified admin session without a legacy code', async () => {
  const calls = [];
  const run = await handler('ride-place-autocomplete', async (url, init) => {
    calls.push({url, init});
    if (url.includes('/rpc/')) return json({ok:true});
    return json({suggestions:[{placePrediction:{placeId:'synthetic-place',text:{text:'100 Example Street'}}}]});
  });
  const result = await run({mode:'suggest',input:'Example',sessionToken:'synthetic-lookup'});
  assert.equal(result.status,200);
  assert.equal(calls[0].init.headers.authorization,'Bearer synthetic-session');
  assert.equal(JSON.parse(calls[0].init.body).p_admin_code,'');
  assert.equal((await result.json()).suggestions[0].placeId,'synthetic-place');
});

test('Google and OpenAI handlers deny unauthorized requests before calling providers', async () => {
  for (const slug of ['ride-place-autocomplete','ride-ai-organizer']) {
    let calls = 0;
    const run = await handler(slug, async url => { assert.ok(url.includes('/rpc/')); calls++; return json({ok:false}); });
    const result = await run({adminCode:'wrong',planDate:'2099-01-04',prompt:'Organize',mode:'suggest',input:'Example',sessionToken:'synthetic'});
    assert.equal(result.status,403);
    assert.equal(calls,1);
  }
});

test('OpenAI Organizer reports missing configuration without a provider request', async () => {
  const run = await handler('ride-ai-organizer', async url => { assert.ok(url.includes('/rpc/')); return json({ok:true}); });
  const result = await run({planDate:'2099-01-04',prompt:'Organize'});
  assert.equal(result.status,503);
  assert.equal((await result.json()).error,'ai_not_configured');
});

test('OpenAI Organizer uses server credentials, disables response storage, and returns reviewable suggestions', async () => {
  let request;
  const run = await handler('ride-ai-organizer', async (url, init) => {
    if (url.includes('/rpc/')) return json({ok:true});
    request = init;
    assert.equal(url,'https://api.openai.com/v1/responses');
    return json({output_text:JSON.stringify({summary:'Review this suggestion.',routes:[],assignments:[],warnings:[]})});
  }, {OPENAI_API_KEY:'synthetic-openai'});
  const result = await run({planDate:'2099-01-04',prompt:'Organize',stops:[{id:'s1',name:'Example Rider',address:'10 Example Street',phone:'2025550100'}],drivers:[]});
  assert.equal(result.status,200);
  assert.equal(request.headers.authorization,'Bearer synthetic-openai');
  const body = JSON.parse(request.body);
  assert.equal(body.store,false);
  assert.doesNotMatch(JSON.stringify(body),/2025550100|synthetic-openai/);
  const output = await result.json();
  assert.equal(output.summary,'Review this suggestion.');
  assert.deepEqual(output.assignments,[]);
});
