'use strict';
const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
const {loadPlaywright}=require('./playwright-require');
const base='http://127.0.0.1:9527';
let key='';
try{const raw=execFileSync('sqlite3',['file:/Users/model/.ai_home/app-state.db?mode=ro',"select value from app_kv where key='config:server';"],{encoding:'utf8'}).trim();key=String(JSON.parse(raw).managementKey||'').trim();}catch(e){}

const profileFor=(origin,key)=>{const now=Date.now();return{id:'local',stableServerId:'local',name:'Local',endpoint:origin,routes:[{id:'direct',kind:'direct',endpoint:origin,viaServerId:'',health:'healthy',rttMs:1,failureRate:0,consecutiveFailures:0,lastCheckedAt:now,lastSuccessAt:now,lastFailureAt:0,updatedAt:now}],activeRouteId:'direct',authorizationState:'authorized',connectionMode:'direct',broker:null,state:'ready',managementKey:key,managementKeyConfigured:true,nodes:[],nodeCount:0,accountCount:0,activeAccountCount:0,schedulableAccountCount:0,sessionCount:0,lastNodeSyncAt:0,lastStatusSyncAt:0,lastAccountsSyncAt:0,lastSessionsSyncAt:0,descriptor:null,lastCheckedAt:now,lastError:'',createdAt:now,updatedAt:now};};
(async()=>{const{chromium}=loadPlaywright();const b=await chromium.launch({headless:true});const p=await b.newPage({viewport:{width:1440,height:960}});
p.on('console',m=>{if(m.type()==='error')console.log('CONSOLE',m.text().slice(0,300))});
p.on('websocket',ws=>{console.log('WS',ws.url());ws.on('close',()=>console.log('WS_CLOSE',ws.url()));ws.on('socketerror',e=>console.log('WS_ERR',String(e)));});
await p.addInitScript(({key,profile})=>{localStorage.setItem('aih:control-plane-profiles:v1',JSON.stringify([profile]));localStorage.setItem('aih:active-control-plane-profile:v1','local');},{key,profile:profileFor(base,key)});
await p.goto(base+'/ui/chat',{waitUntil:'domcontentloaded'});await p.waitForTimeout(1000);
const clickFirst=async(texts)=>{for(const text of texts){const loc=p.getByText(text,{exact:false}).first();if(await loc.count()){await loc.click().catch(()=>{});return text;}}return '';};
console.log('WORK_CLICK',await clickFirst(['Work','工作区项目模式']));await p.waitForTimeout(1500);
console.log('WORK_BUTTONS',JSON.stringify(await p.evaluate(()=>[...document.querySelectorAll('button')].map(b=>b.textContent||'').filter(Boolean).slice(-15))));
console.log('WS_CLICK',await clickFirst(['AIH (Local Mac)','远程工作区2']));await p.waitForTimeout(800);
await p.keyboard.press('Escape').catch(()=>{});
const sessionClick=await clickFirst(['OKAY NOW TELL ME MY ACCOUNTS INFO','EXPRESSING SADNESS','ARE U OK']);
console.log('SESSION_CLICK',sessionClick);
await p.waitForSelector('textarea',{timeout:15000}).catch(()=>{});
const sessionReady=await p.locator('textarea').count();
console.log('SESSION_READY',Boolean(sessionReady));
if(!sessionReady){console.log('NEW_CLICK',await clickFirst(['新建工作区会话','新建会话']));await p.waitForSelector('textarea',{timeout:20000}).catch(()=>{});}
await p.waitForTimeout(800);
console.log('BEFORE',JSON.stringify(await p.evaluate(()=>({textarea:!!document.querySelector('textarea'),retry:!!document.body.innerText.includes('重试 AIH Chat Runtime'),buttons:[...document.querySelectorAll('button')].map(b=>b.textContent||'').filter(Boolean).slice(-12)}))));
const account=p.locator('button').filter({hasText:/OAuth|API Key/}).first();await account.click().catch(()=>{});await p.waitForTimeout(500);await p.getByText('api.deepseek.com').first().click().catch(()=>{});await p.waitForTimeout(3000);await p.waitForFunction(()=>document.body.innerText.includes('实时已连接'),{timeout:15000}).catch(()=>{});const approval=p.locator('button').filter({hasText:/Full access|选择审批模式|确认/}).first();await approval.click().catch(()=>{});await p.waitForTimeout(700);const approvalMenu=await p.evaluate(()=>document.body.innerText.slice(-500));console.log('APPROVAL_MENU',JSON.stringify(approvalMenu));console.log('APPROVAL_RESTORED',!approvalMenu.includes('没有权限确认通道'));await p.screenshot({path:'output/playwright/chat-approval-restored.png'});
console.log('AFTER',JSON.stringify(await p.evaluate(()=>({textarea:!!document.querySelector('textarea'),retry:!!document.body.innerText.includes('重试 AIH Chat Runtime'),body:document.body.innerText.slice(-300)}))));
await p.screenshot({path:'output/playwright/chat-runtime-diagnose.png'});
await b.close();})().catch(e=>{console.error(e.stack);process.exit(1)});
