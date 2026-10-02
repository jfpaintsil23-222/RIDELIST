// Emits a reviewable SQL artifact only. No connection, migration or deployment.
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
const root=new URL('../',import.meta.url);
const sources=Object.fromEntries(['admin_security','admin_ride_control','sunday_reset','collaborative_ride_control'].map(name=>[name,readFileSync(new URL(`supabase/${name}.sql`,root),'utf8')]));
// An explicit source allowlist. No setup tables, seeds, auth definitions or grants.
const selected=[
 ['admin_security','rides_private.ride_admin_actor','text'],
 ['admin_security','rides_private.log_ride_admin_event','text,date,jsonb'],
 ['admin_security','rides_private.log_ride_stop_admin_change',''],
 ['admin_ride_control','rides_private.ride_publish_plan_internal','text,date,jsonb,text[],boolean'],
 ['sunday_reset','public.ride_admin_publish_plan','text,date,jsonb,text[]'],
 ['sunday_reset','public.ride_admin_save_draft','text,date,jsonb'],
 ['sunday_reset','public.ride_admin_clear_draft','text,date'],
 ['sunday_reset','public.ride_admin_update_event_setup','text,date,jsonb'],
 ['admin_ride_control','public.ride_admin_upsert_people','text,jsonb,text'],
 ['sunday_reset','public.ride_admin_merge_people','text,uuid,uuid,jsonb'],
 ['sunday_reset','public.ride_admin_archive_people','text,uuid'],
 ['sunday_reset','public.ride_admin_start_new_sunday','text,date,text[],date,boolean'],
 ['sunday_reset','public.ride_admin_update_plan_drivers','text,date,text[]'],
 ['sunday_reset','public.ride_admin_add_driver','text,date,jsonb'],
];
export function extractFunction(source,name) {
 const marker=`create or replace function ${name}(`,start=source.indexOf(marker);
 if(start<0||source.indexOf(marker,start+marker.length)!==-1)throw Error(`Expected exactly one ${name}`);
 const end=source.indexOf('\n$$;',start);
 if(end<0)throw Error(`Missing function terminator ${name}`);
 const body=source.slice(start,end+4);
 // This extractor deliberately supports only the repository's untagged $$ form.
 // A new delimiter or nested function requires a reviewed parser update.
 if(body.split('$$').length!==3||body.indexOf('create or replace function ',marker.length)!==-1||!/\bas\s+\$\$/i.test(body))throw Error(`Unsupported function boundary ${name}`);
 if(!/security definer/i.test(body)||!/set search_path (?:to |=[ ]*)?''/i.test(body))throw Error(`Unexpected security shape ${name}`);
 return body;
}
export function buildRollout(input=sources) {
 const functions=selected.map(([file,name,args])=>{
  const body=extractFunction(input[file],name);
  const header=body.slice(body.indexOf('(')+1,body.indexOf('\nreturns')).trim();
  if(!header.endsWith(')'))throw Error(`Unsupported argument boundary ${name}`);
  const types=header.slice(0,-1).split(',').filter(p=>p.trim()).map(p=>p.trim().match(/^p_\w+\s+(text\[\]|text|date|jsonb|uuid|boolean)(?=\s|$)/ )?.[1]);
  if(types.some(t=>!t)||types.join(',')!==args)throw Error(`Signature changed ${name}`);
  return body;
 });
 if(extractFunction(input.admin_ride_control,'rides_private.ride_publish_plan_internal')!==extractFunction(input.sunday_reset,'rides_private.ride_publish_plan_internal'))throw Error('Canonical publish helpers differ');
 const trigger=`drop trigger if exists ride_admin_audit_stops on rides_private.ride_stops;\ncreate trigger ride_admin_audit_stops\nafter insert or update or delete on rides_private.ride_stops\nfor each row execute function rides_private.log_ride_stop_admin_change();`;
 if(!input.admin_security.includes(trigger))throw Error('Canonical audit trigger shape changed');
 const shared=input.collaborative_ride_control,begin=shared.indexOf('\nbegin;\n');
 if(begin<0||!shared.endsWith('\ncommit;\n'))throw Error('Unexpected shared transaction wrapper');
 const sharedBody=shared.slice(begin+8,-9);
 if(/^begin;|^commit;/m.test(sharedBody))throw Error('Unexpected nested shared transaction');
 const prerequisites=selected.filter(([,name])=>name!=='rides_private.ride_publish_plan_internal').map(([,name,args])=>`${name}(${args})`).concat('rides_private.current_ride_plan_date()');
 const guard=`do $preflight$\ndeclare signature text;\nbegin\n  foreach signature in array ARRAY[${prerequisites.map(s=>`'${s}'`).join(',')}] loop\n    if to_regprocedure(signature) is null then raise exception 'Missing existing prerequisite %',signature; end if;\n  end loop;\nend $preflight$;`;
 const hashes=Object.entries(input).map(([name,body])=>`-- ${name}.sql SHA256 ${createHash('sha256').update(body).digest('hex')}`).join('\n');
 return `-- Generated additive Ride Control patch; operator review required. No mode activation.\n${hashes}\nbegin;\n${guard}\n${functions.slice(0,3).join('\n')}\n${trigger}\n${functions.slice(3).join('\n')}\nrevoke execute on function rides_private.ride_publish_plan_internal(text,date,jsonb,text[],boolean) from public,anon,authenticated;\n${sharedBody}\ncommit;\n`;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))process.stdout.write(buildRollout());
