import WebSocket from 'ws';
const ws = new WebSocket('ws://127.0.0.1:9931');
let snaps=0, snapBytes=0, projs=0, projBytes=0, other=0, otherBytes=0;
let t0=0; let parseT=0;
ws.on('open',()=>{ t0=Date.now(); });
ws.on('message',(d)=>{
  const s=String(d);
  const a=performance.now();
  const ev=JSON.parse(s);
  parseT+=performance.now()-a;
  if(ev.type==='snap'){snaps++;snapBytes+=s.length; if(snaps===5){
     console.log('snap bytes',s.length,'heads',ev.heads.length,'dmx universes',Object.keys(ev.dmx).length,'dmx len',Object.values(ev.dmx)[0].length);
     const j=JSON.stringify(ev.dmx); console.log('dmx portion bytes',j.length,'heads portion',JSON.stringify(ev.heads).length);
  }}
  else if(ev.type==='project'){projs++;projBytes+=s.length;}
  else {other++;otherBytes+=s.length;}
});
setTimeout(()=>{
  const secs=(Date.now()-t0)/1000;
  console.log(`over ${secs.toFixed(1)}s: snaps=${snaps} (${(snaps/secs).toFixed(1)}/s, ${(snapBytes/secs/1024).toFixed(1)} KiB/s)  projects=${projs} (${(projBytes/secs/1024).toFixed(1)} KiB/s)  other=${other}`);
  console.log('client-side JSON.parse total ms', parseT.toFixed(1), '=', (parseT/secs*100/1000).toFixed(2)+'% of one core');
  process.exit(0);
},10000);
