// Synthetic-only browser preview. No outbound network requests or real contacts.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
const root = resolve(new URL('../..', import.meta.url).pathname);
const people = [
  {id:'p1',name:'Example TSU Rider',campusAddress:'Texas Southern University Library',preferredAddressType:'campus',phone:'2025550100'},
  {id:'p2',name:'Example HCU Rider',campusAddress:'7502 Example Road',preferredAddressType:'campus',phone:'2025550101'},
  {id:'p3',name:'Example UH Rider',campusAddress:'University of Houston',preferredAddressType:'campus',phone:'2025550102'},
  {id:'p4',name:'Example Off Campus Rider',homeAddress:'100 Example Street',preferredAddressType:'home',phone:'2025550103'},
  {id:'p5',name:'Example SHSU Rider',campusAddress:'Sam Houston State University',preferredAddressType:'campus',phone:'2025550104'},
  {id:'p6',name:'Example Uncertain Rider',homeAddress:'',phone:'2025550105'},
];
const areas = {p1:'tsu',p2:'hcu',p3:'uh',p4:'off-campus',p5:'shsu',p6:''};
function rpc(name, args) {
  if (name === 'ride-ai-organizer' && args.mode === 'chat' && args.adminCode === 'synthetic-admin') {
    if (/setup/i.test(args.prompt)) return {ok:false,error:'ai_not_configured'};
    return {ok:true,reply:args.history?.length ? 'Confirm the pickup point with the rider before updating People Bank. A suggested address is not a verified pickup.' : 'Example Uncertain Rider has no saved pickup address. Confirm their pickup point before assigning a route. No other issue is evident in this synthetic preview.'};
  }
  if(args.p_admin_code !== 'synthetic-admin') return {ok:false};
  if(name === 'ride_admin_people_areas') return {ok:true,areas};
  if(name === 'ride_admin_set_people_area') {
    if(areas[args.p_person_id] !== args.p_expected_area) return {ok:false,error:'area_conflict'};
    areas[args.p_person_id] = args.p_area;
    return {ok:true,personId:args.p_person_id,pickupArea:args.p_area};
  }
  return {ok:false};
}
http.createServer(async (req,res) => {
  res.setHeader('Content-Security-Policy',"default-src 'self' data:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; worker-src 'none'");
  try {
    const url = new URL(req.url,'http://localhost');
    if(url.pathname === '/rpc' && req.method === 'POST') {
      let text = ''; for await(const chunk of req) text += chunk;
      const {name,args} = JSON.parse(text);
      res.setHeader('Content-Type','application/json'); res.end(JSON.stringify(rpc(name,args))); return;
    }
    const path = resolve(root,'.'+(url.pathname === '/' ? '/index.html' : url.pathname));
    if(!path.startsWith(root+'/')) { res.writeHead(403).end(); return; }
    let data = await readFile(path);
    if(path.endsWith('index.html')) {
      data = data.toString().replace('<script>',`<script>
        const fixtureFetch = window.fetch.bind(window);
        window.fetch = (url,init={}) => {
          const target = new URL(url,location.href);
          if(target.origin === location.origin) return fixtureFetch(url,init);
          return fixtureFetch('/rpc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:target.pathname.split('/').pop(),args:JSON.parse(init.body||'{}')})});
        };</script><script>`).replace('    loadDrivers();',`
        state.loading=false;state.adminCode='synthetic-admin';
        state.admin={people:${JSON.stringify(people)},drivers:[],stops:[],plan:{date:'2099-01-04',title:'Synthetic preview'}};
        state.planDate='2099-01-04';state.view='admin';state.adminActiveTab='people';
        loadAdminPeopleAreas().then(render);`);
    }
    res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.png':'image/png','.webmanifest':'application/json'})[extname(path)]||'application/octet-stream');res.end(data);
  } catch { res.writeHead(404).end('Not found'); }
}).listen(4177,'127.0.0.1',()=>console.log('Synthetic People Bank preview: http://127.0.0.1:4177/'));
