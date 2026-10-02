import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

test('public rehearsal source contains only clearly synthetic rider and driver fixtures',()=>{
 const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
 const start=html.indexOf('    const REHEARSAL_DRIVER_BASE = [');
 const end=html.indexOf('    function destinationSummary()',start);
 assert.ok(start>=0&&end>start);
 const sandbox={};vm.runInNewContext(html.slice(start,end)+'\nglobalThis.fixtures={drivers:REHEARSAL_DRIVER_BASE,stops:REHEARSAL_STOPS,timings:REHEARSAL_ROUTE_TIMINGS};',sandbox);
 const {drivers,stops,timings}=sandbox.fixtures;
 assert.equal(stops.length,8,'Keep the existing rehearsal interactions and group cases');
 for(const driver of drivers){
  assert.ok(/^Synthetic driver \d+$/.test(driver.displayName),'Public rehearsal driver display must be synthetic');
  assert.ok(driver.display_name===driver.displayName,'Both display projections must be synthetic');
  assert.ok(/^Demo zone \d+$/.test(driver.routeLabel),'Public rehearsal route labels must be synthetic');
 }
 for(const stop of stops){
  assert.ok(/^demo-rider-\d+$/.test(stop.id),'Public rehearsal identity must be synthetic');
  assert.ok(/^Synthetic rider \d+(?: group)?$/.test(stop.name),'Public rehearsal rider name must be synthetic');
  assert.ok(!stop.phone||/^202-555-01\d{2}$/.test(stop.phone),'Public rehearsal phone must use reserved fictional numbers');
  assert.ok(!stop.address||/^\d+ Demo (?:Campus|Street|Hall), Example City$/.test(stop.address),'Public rehearsal address must be invented');
  assert.ok(/^(?:Demo zone \d+|Address pending)$/.test(stop.area),'Public rehearsal area must be synthetic');
  assert.ok(/^Demo route \d+$/.test(stop.routeLabel),'Public rehearsal route must be synthetic');
  assert.ok(/^Synthetic fixture\./.test(stop.notes),'Public rehearsal notes must be synthetic');
 }
 for(const timing of Object.values(timings))for(const name of timing.optimizedStopOrder??[])assert.ok(/^Synthetic rider \d+(?: group)?$/.test(name),'Public timing fixture must not restore real rider identities');
 assert.ok(html.includes('Local rehearsal with synthetic data. Nothing saves live.'),'Rehearsal must honestly identify its synthetic data');
});
