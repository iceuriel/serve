const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert/strict');
const source = fs.readFileSync(path.join(__dirname, '..', 'booking-live.js'), 'utf8');
function build() {
    let busy = false, updates = [], calls = 0, status, delay, resolver;
    const rootEvents = {}, windowEvents = {}, documentEvents = {};
    let next = { ok:true, view:'partner', instructions:{general:'Old'} };
    const details = [{ open:true, getAttribute:()=> 'KITCHEN' }];
    const root = { hidden:false, textContent:'Original',
        parentNode:{insertBefore:n=>{status=n;}}, querySelector:()=>busy ? {} : null,
        querySelectorAll:()=>details, contains:()=>false,
        addEventListener:(e,f)=>{rootEvents[e]=f;}, removeEventListener:()=>{} };
    const document = { hidden:false, activeElement:null, createElement:()=>({setAttribute:()=>{}}),
        addEventListener:(e,f)=>{documentEvents[e]=f;}, removeEventListener:()=>{} };
    const window = { scrollX:0, scrollY:100, scrollTo:()=>{},
        addEventListener:(e,f)=>{windowEvents[e]=f;}, removeEventListener:()=>{} };
    const box = {window,document,AbortController,console,
        setTimeout:(_,ms)=>{if(ms!==20000)delay=ms;return ms;}, clearTimeout:()=>{},
        fetch:async()=>{calls++; if(next==='WAIT')return new Promise(r=>{resolver=r;});
            if(next==='FAIL')throw new Error();return {ok:true,json:async()=>next};} };
    vm.runInNewContext(source,box);
    const watch=window.ServeLive.watch({url:'/api/job',view:'partner',root,initial:next,onData:d=>{updates.push(d);}});
    return {watch,document,windowEvents,documentEvents,rootEvents,root,details,
        setNext:v=>{next=v;},setBusy:v=>{busy=v;},resolve:v=>resolver({ok:true,json:async()=>v}),
        get calls(){return calls;},get updates(){return updates;},get status(){return status.textContent;},get delay(){return delay;}};
}
(async()=>{
    const b=build(); assert.equal(b.delay,25000,'polls every 25 seconds');
    await b.watch.refresh();assert.equal(b.updates.length,0,'unchanged data does not repaint');
    b.setNext({ok:true,view:'partner',instructions:{general:'New'},photos:[{id:'photo'}]});
    await b.watch.refresh();assert.equal(b.updates.length,1,'whole authorized view updates together');
    assert.equal(b.details[0].open,true,'expanded rooms remain open');
    b.setBusy(true); const before=b.calls;await b.watch.refresh();assert.equal(b.calls,before,'dirty form blocks refresh');
    b.setBusy(false);b.document.hidden=true;await b.watch.refresh();assert.equal(b.calls,before,'hidden page does not poll');
    b.document.hidden=false;b.setNext('WAIT');const flight=b.watch.refresh();
    await b.watch.refresh();assert.equal(b.calls,before+1,'requests do not overlap');
    b.rootEvents.input();b.resolve({ok:true,view:'partner',instructions:{general:'Stale'}});await flight;
    assert.equal(b.updates.length,1,'response started before an edit cannot overwrite that edit');
    b.setNext('FAIL');await b.watch.refresh();assert.match(b.status,/out of date/);assert.equal(b.delay,50000);
    b.setNext({ok:true,view:'partner',instructions:{general:'Recovered'}});await b.watch.refresh();assert.equal(b.updates.length,2);
    assert.equal(b.delay,25000,'successful reconnect restores regular polling');
    b.setNext({ok:false,error:'expired'});await b.watch.refresh();assert.equal(b.root.hidden,true);assert.equal(b.root.textContent,'');
    const finalCalls=b.calls;await b.watch.refresh();assert.equal(b.calls,finalCalls,'closed ticket stops polling');
    for (const event of ['focus','online']) assert.equal(typeof b.windowEvents[event],'function');
    assert.equal(typeof b.documentEvents.visibilitychange,'function');
    console.log('Live refresh, unchanged views, edits in flight, visibility, backoff and closed links passed.');
})().catch(e=>{console.error(e);process.exitCode=1;});
