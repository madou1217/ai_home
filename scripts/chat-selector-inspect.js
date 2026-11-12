'use strict';
const fs=require('node:fs'),{execFileSync}=require('node:child_process');
const {loadPlaywright}=require('./playwright-require');
const base='http://127.0.0.1:9527';
let key='';
try{const raw=execFileSync('sqlite3',['file:/Users/model/.ai_home/app-state.db?mode=ro',"select value from app_kv where key='config:server';"],{encoding:'utf8'}).trim();key=String(JSON.parse(raw).managementKey||'').trim();}catch(_error){}
const now=Date.now();
const profile={id:'local',stableServerId:'local',name:'Local',endpoint:base,routes:[{id:'direct',kind:'direct',endpoint:base,viaServerId:'',health:'healthy',rttMs:1,failureRate:0,consecutiveFailures:0,lastCheckedAt:now,lastSuccessAt:now,lastFailureAt:0,updatedAt:now}],activeRouteId:'direct',authorizationState:'authorized',connectionMode:'direct',broker:null,state:'ready',managementKey:key,managementKeyConfigured:true,nodes:[],nodeCount:0,accountCount:0,activeAccountCount:0,schedulableAccountCount:0,sessionCount:0,lastNodeSyncAt:0,lastStatusSyncAt:0,lastAccountsSyncAt:0,lastSessionsSyncAt:0,descriptor:null,lastCheckedAt:now,lastError:'',createdAt:now,updatedAt:now};
(async()=>{const{chromium}=loadPlaywright();const b=await chromium.launch({headless:true});const p=await b.newPage({viewport:{width:1440,height:960}});
await p.addInitScript(({key,profile})=>{localStorage.setItem('aih:control-plane-profiles:v1',JSON.stringify([profile]));localStorage.setItem('aih:active-control-plane-profile:v1','local');},{key,profile});
await p.goto(base+'/ui/chat',{waitUntil:'domcontentloaded'});await p.waitForTimeout(4000);
const out=await p.evaluate(()=>{
  const hits=[...document.querySelectorAll('*')].filter(el=>String(el.textContent||'').trim()==='妹妹你坐船头');
  return hits.map(el=>{const chain=[];let cur=el;for(let i=0;i<5&&cur;i++,cur=cur.parentElement){chain.push({tag:cur.tagName,cls:cur.className,role:cur.getAttribute('role'),label:cur.getAttribute('aria-label'),data:[...cur.attributes].filter(a=>a.name.startsWith('data-')).map(a=>a.name+'='+a.value)});}return chain;});
});
console.log(JSON.stringify(out));await b.close();})().catch(e=>{console.error(e.stack);process.exit(1)});
