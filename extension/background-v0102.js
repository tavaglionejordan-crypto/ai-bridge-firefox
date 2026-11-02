"use strict";

// The content script never makes cross-origin HTTP requests. All bridge requests
// originate from this extension background page, which has localhost permission.
const BASE = "http://127.0.0.1:37987";
const ALLOWED = new Set(["/health", "/models", "/settings", "/run", "/status", "/cancel"]);
const watchers = new Map();
let outputServices=null;
const pageRepairs=new Map();
const missingReceiver=error=>/receiving end.*(?:not exist|doesn't exist)|no receiv(?:er|ing end)|no handler/i.test(error?.message || '');
const supportedChat = value => /^https:\/\/(chatgpt\.com|chat\.openai\.com|grok\.com|gemini\.google\.com)\//.test(value || '');
const isGrok = value => /^https:\/\/grok\.com\//.test(value || '');
const isGemini = value => /^https:\/\/gemini\.google\.com\//.test(value || '');
const providerFor=value=>isGemini(value)?'gemini':isGrok(value)?'grok':'chatgpt';
const conversationPromotion=(before,after,provider)=>provider==='gemini'?
  /^https:\/\/gemini\.google\.com\/(?:app\/?)?$/.test(before)&&/^https:\/\/gemini\.google\.com\/app\/[a-zA-Z0-9_-]+\/?$/.test(after || ''):
  before==='https://grok.com/'&&/^https:\/\/grok\.com\/(?:c|chat)\/[^/]+\/?$/.test(after || '');
async function senderConversation(sender){
  if(!sender.tab?.id || (sender.frameId ?? 0)!==0 || !supportedChat(sender.url))throw new Error('Unauthorized conversation sender');
  const tab=await browser.tabs.get(sender.tab.id);
  // A same-document route change can leave sender.url behind location.href.
  // Keep its origin check, but bind conversation ownership to the live tab.
  if(!supportedChat(tab.url) || new URL(tab.url).origin!==new URL(sender.url).origin)throw new Error('The sending tab changed site. Reconnect in the intended conversation.');
  const url=new URL(tab.url);
  return url.origin+url.pathname;
}
async function showPairedBadge(tabId){
  const value='PAIR#26764b';
  if(badges.get(tabId)===value)return;
  await browser.action.setBadgeBackgroundColor({tabId,color:'#26764b'});
  await browser.action.setBadgeText({tabId,text:'PAIR'});badges.set(tabId,value);
}
async function inspectChat(tabId,{repairMissing=true}={}){
  const tab=await browser.tabs.get(tabId);
  if(!supportedChat(tab.url))throw new Error('Select the ChatGPT, Grok or Gemini tab you want to inspect');
  const chat=tab.url.split(/[?#]/)[0];
  let page;
  try{page=await browser.tabs.sendMessage(tabId,{type:'RELAY_STATUS'});}catch(error){
    if(!repairMissing||!missingReceiver(error))throw error;
    page=await repairPageListener(tabId,chat);
  }
  if((await browser.tabs.get(tabId)).url?.split(/[?#]/)[0]!==chat)throw new Error('The tab changed conversation. Try again in the intended chat.');
  const expected=providerFor(tab.url);
  if(page?.version!=='0.11.0' || page?.diagnostics?.provider!==expected)throw new Error('This tab has an older or mismatched AI Bridge script. Reload the updated add-on, then refresh this tab.');
  return {tab,chat,page};
}
async function repairPageListener(tabId,chat){
  if(pageRepairs.has(tabId))return pageRepairs.get(tabId);
  const repair=(async()=>{
    // Another pairing or the normal page injection may have recovered first.
    try{return await browser.tabs.sendMessage(tabId,{type:'RELAY_STATUS'});}catch(error){if(!missingReceiver(error))throw error;}
    if((await browser.tabs.get(tabId)).url?.split(/[?#]/)[0]!==chat)throw new Error('The tab changed conversation. Pair again in the intended chat.');
    if(!browser.scripting?.executeScript)throw new Error('Reload the updated add-on, allow access to this site, then refresh this tab');
    try{
      // Firefox can retain this guard after an extension reload while the
      // runtime listener it guarded no longer exists. Reset it only after a
      // missing-receiver probe, never on a live or merely outdated listener.
      await browser.scripting.executeScript({target:{tabId},func:()=>{globalThis.__codexRelayContentInstalled=false;}});
      const results=await browser.scripting.executeScript({target:{tabId},files:['execution-settings.js','relay-plan-v0102.js','relay-media-v0102.js','relay-files-v0102.js','goal-state-v011.js','content-v0102.js']});
      if(results?.some(result=>result.error))throw new Error('Page script initialization failed');
    }catch{throw new Error('AI Bridge could not start its page listener. In Firefox extension permissions, allow this site, then refresh the tab and pair again.');}
    try{return await browser.tabs.sendMessage(tabId,{type:'RELAY_STATUS'});}catch(error){
      if(!missingReceiver(error))throw error;
      throw new Error('AI Bridge page listener is still unavailable after recovery. Refresh this Gemini, Grok or ChatGPT tab, then pair again.');
    }
  })();
  pageRepairs.set(tabId,repair);
  try{return await repair;}finally{if(pageRepairs.get(tabId)===repair)pageRepairs.delete(tabId);}
}
async function pairGrok(tabId,provider='grok'){
  const gemini=provider==='gemini',name=gemini?'Gemini':'Grok',key=gemini?'relayGeminiTarget':'relayGrokTarget';
  const tab=await browser.tabs.get(tabId);
  if(!(gemini?isGemini(tab.url):isGrok(tab.url)))throw new Error(`Open the intended ${gemini?'gemini.google.com':'grok.com'} conversation to pair ${name}`);
  let inspected=await inspectChat(tabId),d=inspected.page.diagnostics;
  const existing=(await browser.storage.local.get(key))[key];
  if(!d.editorFound && existing?.tabId===tabId && existing.chat===inspected.chat){
    await showPairedBadge(tabId);
    return {ok:true,paired:true,provider,tabId,readiness:'waiting-for-editor'};
  }
  const deadline=Date.now()+2500;
  while(!d.editorFound && Date.now()<deadline){
    await new Promise(resolve=>setTimeout(resolve,150));
    inspected=await inspectChat(tabId);d=inspected.page.diagnostics;
  }
  if(!d.editorFound)throw new Error(`${name} composer not found (${d.composer?.reason || 'unknown layout'}). Copy this tab's layout diagnostics.`);
  // A pairing identifies a destination. It neither submits a prompt nor needs
  // transcript detection/Watch, a native helper connection, or an empty draft.
  await browser.storage.local.set({[key]:{tabId,chat:inspected.chat}});
  await showPairedBadge(tabId);
  const token=(await browser.storage.local.get('bridgeToken')).bridgeToken || '';
  return {ok:true,paired:true,provider,tabId,token,readiness:'ready'};
}
async function connectionSummary(){
  const saved=await browser.storage.local.get(['relayConnectedTab','relayGrokTarget','relayGrokJobs','relayGeminiTarget','relayGeminiJobs']);
  const describe=async(target,provider)=>{
    if(!target)return {state:provider!=='chatgpt'?'not-paired':'not-connected'};
    try{
      const tab=await browser.tabs.get(target.tabId);
      if(tab.url?.split(/[?#]/)[0]!==target.chat)return {state:'conversation-changed',tabId:target.tabId};
      if(providerFor(tab.url)!==provider)return {state:'wrong-provider',tabId:target.tabId};
      const value=await browser.tabs.sendMessage(target.tabId,{type:'RELAY_STATUS'});
      return {state:provider!=='chatgpt'?'paired':value?.status?.running?(value?.diagnostics?.startup?.state==='starting'?'starting':'watching'):'not-watching',tabId:target.tabId,
        phase:value?.status?.phase || 'unknown',composerReady:value?.diagnostics?.editorFound===true,
        detectionReason:value?.diagnostics?.watcher?.reason || null,
        startup:value?.diagnostics?.startup || null,composerSend:value?.diagnostics?.composerSend || null,
        mediaTransfer:value?.diagnostics?.mediaTransfer || null,grokCompletion:value?.diagnostics?.grokCompletion || null,
        responseCompletion:value?.diagnostics?.responseCompletion || null,workers:value?.diagnostics?.workers || null};
    }catch{return {state:'tab-or-script-unavailable',tabId:target.tabId};}
  };
  const [chatgpt,grok,gemini]=await Promise.all([describe(saved.relayConnectedTab,'chatgpt'),describe(saved.relayGrokTarget,'grok'),describe(saved.relayGeminiTarget,'gemini')]);
  const jobs=Object.entries(saved.relayGrokJobs || {}).slice(-5).map(([id,job])=>({id,status:job.status,sourceTab:job.sourceTab,targetTab:job.target.tabId}));
  return {chatgpt,grok,gemini,recentGrokJobs:jobs,recentGeminiJobs:Object.entries(saved.relayGeminiJobs || {}).slice(-5).map(([id,job])=>({id,status:job.status,sourceTab:job.sourceTab,targetTab:job.target.tabId}))};
}
let grokWrites=Promise.resolve(),geminiWrites=Promise.resolve();
function enqueueWeb(provider,work){const result=(provider==='gemini'?geminiWrites:grokWrites).catch(()=>{}).then(work);if(provider==='gemini')geminiWrites=result;else grokWrites=result;return result;}
const GEMINI_COOLDOWN_MS=60000;
async function geminiSendGate(message,sender){
  const chat=await senderConversation(sender);
  if(!isGemini(chat)||!['peek','claim','complete'].includes(message.action)||!/^[a-f0-9]{64}$/.test(message.id || ''))throw Error('Invalid Gemini send guard request');
  const saved=await browser.storage.local.get(['relayGeminiSendGate','relayGeminiTarget','relayGeminiJobs']);
  const gate=saved.relayGeminiSendGate || {nextAllowedAt:0,claims:{}},claims=gate.claims ||= {},prior=claims[message.id],target=saved.relayGeminiTarget;
  const paired=target?.tabId===sender.tab.id&&(target.chat===chat||conversationPromotion(target.chat,chat,'gemini'));
  if(!paired&&prior?.tabId!==sender.tab.id)throw Error('Pair this Gemini conversation before sending');
  if(message.action==='complete'){
    const recovered=paired&&saved.relayGeminiJobs?.[message.id]?.target?.tabId===sender.tab.id&&saved.relayGeminiJobs[message.id].target.chat===chat;
    if(prior&&(prior.tabId===sender.tab.id||recovered)&&!prior.completedAt){prior.tabId=sender.tab.id;prior.completedAt=Date.now();gate.nextAllowedAt=Math.max(gate.nextAllowedAt || 0,Date.now()+GEMINI_COOLDOWN_MS);await browser.storage.local.set({relayGeminiSendGate:gate});}
    return {ok:true,waitUntil:gate.nextAllowedAt || 0};
  }
  if(prior)return {ok:false,duplicate:true,error:'This Gemini request ID already reserved a Send action. It will not be submitted again.'};
  if(Date.now()<(gate.nextAllowedAt || 0))return {ok:true,waiting:true,waitUntil:gate.nextAllowedAt};
  if(message.action==='claim'){
    if(!paired)throw Error('The paired Gemini conversation changed before Send');
    claims[message.id]={tabId:sender.tab.id,claimedAt:Date.now()};gate.nextAllowedAt=Date.now()+GEMINI_COOLDOWN_MS;
    const ids=Object.keys(claims);for(const id of ids.slice(0,Math.max(0,ids.length-1000)))delete claims[id];
    await browser.storage.local.set({relayGeminiSendGate:gate}); // Durable before the click, including uncertain outcomes.
  }
  return {ok:true,waiting:false,waitUntil:0};
}
async function grokRequest(message,sender,{cancel=false,provider='grok'}={}){
  const gemini=provider==='gemini',targetKey=gemini?'relayGeminiTarget':'relayGrokTarget',jobsKey=gemini?'relayGeminiJobs':'relayGrokJobs';
  const label=value=>gemini?String(value).replaceAll('Grok','Gemini').replaceAll('grok.com','gemini.google.com'):value;
  const load=async()=>{const value=await browser.storage.local.get([targetKey,jobsKey]);return {relayGrokTarget:value[targetKey],relayGrokJobs:value[jobsKey]};};
  const save=value=>browser.storage.local.set(Object.fromEntries(Object.entries(value).map(([key,v])=>[key==='relayGrokTarget'?targetKey:key==='relayGrokJobs'?jobsKey:key,v])));
  const send=(id,value)=>browser.tabs.sendMessage(id,{...value,type:gemini?value.type.replace('GROK','GEMINI'):value.type});
  if(gemini)message={...message,type:message.type.replace(/^GEMINI_/,'GROK_')};
  // Only a watching ChatGPT conversation can delegate to the explicitly paired
  // Grok tab. Grok replies cannot call this router or select another destination.
  if(!sender.tab?.id || !/^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(sender.url || ''))throw new Error('Grok delegation requires a watching ChatGPT conversation');
  await ownerWrites;await loadOwners();
  const chat=await senderConversation(sender);
  if(!cancel && watchers.get(chat)!==sender.tab.id)throw new Error('Start Watch in the sending ChatGPT conversation first');
  if(!/^[a-f0-9]{64}$/.test(message.id || ''))throw new Error('Invalid Grok task identity');
  const saved=await load();
  const jobs=saved.relayGrokJobs || {},prior=jobs[message.id];
  if(prior && (prior.source!==chat || prior.sourceTab!==sender.tab.id))throw new Error('Grok task belongs to another conversation');
  if(message.type==='GROK_MEDIA_RELEASE'){
    if(prior&&['done','error'].includes(prior.status)){
      prior.released=true;delete prior.images;delete prior.outputFiles;delete prior.outputCode;await save({relayGrokJobs:jobs});
      await send(prior.target.tabId,{type:'RELAY_GROK_MEDIA_RELEASE',id:message.id}).catch(()=>{});
    }
    return {ok:true};
  }
  if(message.type==='GROK_STATUS'){
    if(!prior)throw new Error('Unknown Grok task');
    if(!['done','error'].includes(prior.status)){
      let changed=false;
      try{
        const target=await browser.tabs.get(prior.target.tabId);
        const reply=await send(prior.target.tabId,{type:'RELAY_GROK_STATUS',id:message.id});
        if(!reply?.ok){if(/task state missing|unknown .*task/i.test(reply?.error || '')){Object.assign(prior,{status:'error',resultState:'SUBMISSION_FAILED',error:'Original request receipt is missing; submission is unconfirmed and was not repeated'});await save({relayGrokJobs:jobs});return {ok:true,id:message.id,status:'error',resultState:prior.resultState,error:prior.error};}throw new Error(reply?.error || 'Grok task state unavailable; submission may be uncertain');}
        // Progress is read-only while running. Persist the terminal receipt
        // with the result so a reply cannot turn a submission failure into success.
        prior.resultState=reply.resultState || prior.resultState;prior.submission=reply.submission || prior.submission;prior.cooldownUntil=reply.cooldownUntil || null;
        const actual=target.url?.split(/[?#]/)[0];
        if(actual!==prior.target.chat){
          if(!conversationPromotion(prior.target.chat,actual,provider) || reply.chat!==actual)throw new Error('The paired Grok tab changed conversation');
          prior.target={...prior.target,chat:actual};await save({relayGrokTarget:prior.target});
          changed=true;
        }
        if(['done','error'].includes(reply.status)){Object.assign(prior,{status:reply.status,reply:reply.reply || '',images:globalThis.RelayMedia.validate(reply.images || []),outputFiles:reply.files || [],outputCode:reply.code || [],error:reply.error || ''});changed=true;}
      }catch(error){prior.connectionError=label(error.message);await save({relayGrokJobs:jobs});return {ok:true,id:message.id,status:'recovering',error:prior.connectionError};}
      if(changed)await save({relayGrokJobs:jobs});
    }
    return {ok:true,id:message.id,status:prior.status,reply:prior.reply,images:prior.images || [],files:prior.outputFiles || [],code:prior.outputCode || [],error:prior.error?label(prior.error):prior.error,resultState:prior.resultState || null,submission:prior.submission || null,cooldownUntil:prior.cooldownUntil || null};
  }
  if(typeof message.prompt!=='string' || !message.prompt.trim() || message.prompt.length>16000)throw new Error('Invalid Grok task text');
  const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(message.prompt)))].map(b=>b.toString(16).padStart(2,'0')).join('');
  if(message.promptHash!==hash)throw new Error('Grok task integrity mismatch');
  const images=globalThis.RelayMedia.validate(message.images || []);
  const files=message.files?.length?globalThis.RelayFiles.validate(message.files):[];globalThis.RelayFiles?.combined(images,files);
  const mediaHash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(files.length?[images,files]:images))))].map(b=>b.toString(16).padStart(2,'0')).join('');
  if(prior){if(prior.hash!==hash || prior.mediaHash && prior.mediaHash!==mediaHash)throw new Error('Conflicting Grok task identity');return {ok:true,id:message.id,status:prior.status};}
  const target=saved.relayGrokTarget;
  if(!target || !(gemini?isGemini(target.chat):isGrok(target.chat)))throw new Error('Open the intended Grok conversation and click AI Bridge once to pair it');
  // Reconcile an orphaned coordinator before accepting another task. This only
  // reads recorded jobs; it never resubmits a browser prompt.
  for(const [id,job] of Object.entries(jobs)){
    if(['done','error'].includes(job.status))continue;
    try{
      const live=await browser.tabs.get(job.target.tabId);
      if(live.url?.split(/[?#]/)[0]!==job.target.chat)throw new Error('Previous Grok tab changed conversation');
      const state=await send(job.target.tabId,{type:'RELAY_GROK_STATUS',id});
      if(!state?.ok){if(/task state missing|unknown .*task/i.test(state?.error || '')){Object.assign(job,{status:'error',resultState:'SUBMISSION_FAILED',error:'Original request receipt is missing; not resent'});continue;}throw new Error(state?.error || 'Previous task state unavailable');}
      if(['done','error'].includes(state.status))Object.assign(job,{status:state.status,reply:state.reply || '',images:globalThis.RelayMedia.validate(state.images || []),outputFiles:state.files || [],outputCode:state.code || [],resultState:state.resultState,submission:state.submission,error:state.error || ''});
      else{
        let source;try{source=await browser.tabs.get(job.sourceTab);}catch{}
        if(source?.url?.split(/[?#]/)[0]!==job.source){
          job.connectionError='Coordinator disconnected; original job continues and will be reconciled';
        }
      }
    }catch(error){job.connectionError=label(error.message);}
  }
  await save({relayGrokJobs:jobs});
  if(Object.values(jobs).some(job=>!['done','error'].includes(job.status)))throw new Error('A Grok task is already running. Wait for its result or stop its originating Watch.');
  const targetTab=await browser.tabs.get(target.tabId);
  if(targetTab.url?.split(/[?#]/)[0]!==target.chat)throw new Error('The paired Grok tab changed conversation. Click AI Bridge there again.');
  for(const job of Object.values(jobs))if(job.images?.length){
    if(watchers.get(job.source)===job.sourceTab)throw new Error('A previous image result is still awaiting delivery. Wait for its coordinator or stop that Watch.');
    // Retain an unread completed receipt while its coordinator is closed.
  }
  jobs[message.id]={source:chat,sourceTab:sender.tab.id,target,hash,mediaHash,status:'dispatching'};
  const ids=Object.keys(jobs);for(const id of ids.slice(0,Math.max(0,ids.length-100)))if(['done','error'].includes(jobs[id].status)&&jobs[id].released)delete jobs[id];
  await save({relayGrokJobs:jobs}); // Durable before any browser send.
  try{
    const accepted=await send(target.tabId,{type:'RELAY_GROK_EXECUTE',id:message.id,prompt:message.prompt,images,...(files.length?{files}:{})});
    if(!accepted?.ok)Object.assign(jobs[message.id],{status:'error',resultState:'FAILED',error:accepted?.error || 'Grok did not accept the task; nothing was submitted'});
    else jobs[message.id].status='running';
  }catch(error){Object.assign(jobs[message.id],{status:'recovering',connectionError:label(error.message)+'; not automatically resent'});}
  await save({relayGrokJobs:jobs});
  return {ok:true,id:message.id,status:jobs[message.id].status};
}
let nativePort=null,nativeFlight=null,nativeSequence=0;
const nativeRequests=new Map(),quickStarts=new Map();
const nativeHelp='Run Install One Click.cmd once, then reload the AI Bridge add-on.';
function connectNativeBridge(){
  if(nativeFlight)return nativeFlight;
  nativeFlight=(async()=>{
    if(!browser.runtime.connectNative)throw new Error(nativeHelp);
    if(!nativePort){
      const port=browser.runtime.connectNative('ai_bridge_firefox');nativePort=port;
      port.onMessage.addListener(value=>{
        const request=nativeRequests.get(value?.id);if(!request)return;
        nativeRequests.delete(value.id);clearTimeout(request.timer);
        if(value.ok && /^[a-f0-9]{48}$/.test(value.token || ''))request.resolve(value);
        else request.reject(new Error(value.error || 'Invalid response from local bridge helper'));
      });
      port.onDisconnect.addListener(()=>{
        if(nativePort!==port)return;
        nativePort=null;
        for(const [id,request] of nativeRequests){clearTimeout(request.timer);request.reject(new Error(`${port.error?.message || 'Local helper disconnected'}. ${nativeHelp}`));nativeRequests.delete(id);}
      });
    }
    const id='connect-'+(++nativeSequence);
    const value=await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{nativeRequests.delete(id);reject(new Error('Local bridge startup timed out. '+nativeHelp));},15000);
      nativeRequests.set(id,{resolve,reject,timer});
      try{nativePort.postMessage({id,action:'connect'});}catch(error){nativePort=null;clearTimeout(timer);nativeRequests.delete(id);reject(error);}
    });
    await browser.storage.local.set({bridgeToken:value.token,relayNativeEnabled:true});
    return value;
  })().finally(()=>{nativeFlight=null;});
  return nativeFlight;
}
async function quickStart(tabId){
  const tab=await browser.tabs.get(tabId);
  if(!supportedChat(tab.url))throw new Error('Select a ChatGPT or Grok tab to start the relay');
  if(isGrok(tab.url)||isGemini(tab.url))return pairGrok(tabId,providerFor(tab.url));
  const url=new URL(tab.url),chat=url.origin+url.pathname;
  let restoredDuringStart=false;
  const connection=await connectNativeBridge();
  if((await browser.tabs.get(tabId)).url?.split(/[?#]/)[0]!==chat)throw new Error('The selected tab changed conversation during connection. Click the icon again.');
  await browser.storage.local.set({relayConnectedTab:{tabId,chat}});
  const {page}=await inspectChat(tabId).catch(error=>{error.watchStartFailed=true;throw error;});
  let ready=page.diagnostics?.startup?.state==='ready' || page.status?.ready===true;
  if(!page?.status?.running){
    const started=await browser.tabs.sendMessage(tabId,{type:'RELAY_WATCH_START',token:connection.token,maxExchanges:1})
      .catch(error=>{error.watchStartFailed=true;throw error;});
    restoredDuringStart=started?.ok===false && started.error==='A relay is already running in this tab';
    // Saved Watch can restore between the status read and start request.
    if(!started?.ok && !restoredDuringStart)throw Object.assign(new Error(started?.error || 'Watch could not start'),{watchStartFailed:true,startup:started?.startup});
    ready=started?.ready===true;
  }
  return {ok:true,...connection,ready,alreadyWatching:restoredDuringStart || !!page?.status?.running,provider:'chatgpt'};
}
const stateStore = browser.storage?.session || browser.storage?.local;
let ownerWrites = Promise.resolve();
let ownersLoaded=false;
const loadOwners=async()=>{
  if(ownersLoaded)return;
  const saved=await stateStore?.get("relayWatchOwners");
  for(const [key,id] of Object.entries(saved?.relayWatchOwners || {}))watchers.set(key,id);
  ownersLoaded=true;
};
const badges=new Map();
// Global toolbar icon: remains useful while another browser tab is selected.
const toolbarStates=new Map();
const toolbarPriority={idle:0,watching:1,working:2,waiting:3,error:4};
const toolbarTitles={idle:'Idle — Watch stopped',watching:'Idle — listening for tasks',working:'Working',waiting:'Waiting — starting or reconnecting',error:'Needs attention'};
let toolbarWrites=Promise.resolve(),lastToolbar='',toolbarRevision=0;
function toolbarState(status){
  const workers=status.workers;
  if(status.phase==='error'||workers?.attention>0)return 'error';
  if(['reconnecting','starting'].includes(status.phase))return 'waiting';
  if(workers){
    if(['codex','grok','gemini'].some(name=>['running','stopping'].includes(workers[name]?.state)||workers[name]?.queued>0))return 'working';
    if(status.running&&status.plan?.paused&&status.plan.queued>0)return 'waiting';
    if(status.running&&(status.plan?.jobs?.some(job=>job.state==='running')||!status.plan?.paused&&status.plan?.queued>0))return 'working';
    return status.running?'watching':'idle';
  }
  if(status.phase==='failed')return 'error';
  if(['running','codex'].includes(status.phase)&&status.running)return 'working';
  return status.running?'watching':'idle';
}
function updateToolbar(){
  toolbarWrites=toolbarWrites.catch(()=>{}).then(async()=>{
    const state=[...toolbarStates.values()].reduce((best,value)=>toolbarPriority[value]>toolbarPriority[best]?value:best,'idle');
    if(state===lastToolbar)return;
    await browser.action.setIcon?.({path:`icons/${state}.svg`});
    await browser.action.setTitle?.({title:`AI Bridge — ${toolbarTitles[state]}`});
    lastToolbar=state;
  });
  return toolbarWrites.catch(()=>{});
}
// Recover from the existing owned tabs; do not persist a potentially stale
// "working" flag or let a delayed startup read overwrite a fresh live event.
void (async()=>{
  const owners=await (ownerWrites=ownerWrites.catch(()=>{}).then(async()=>{await loadOwners();return [...watchers];}));
  for(const [chat,tabId] of owners){
    if(toolbarStates.has(tabId))continue;
    try{
      const revision=toolbarRevision;
      const tab=await browser.tabs.get(tabId);
      if(tab.url?.split(/[?#]/)[0]!==chat)continue;
      const page=await browser.tabs.sendMessage(tabId,{type:'RELAY_STATUS'});
      if(page?.ok&&page.status&&revision===toolbarRevision&&!toolbarStates.has(tabId))toolbarStates.set(tabId,toolbarState(page.status));
    }catch{}
  }
  if(toolbarStates.size)await updateToolbar();
})().catch(()=>{});
browser.tabs.onUpdated?.addListener((tabId,change)=>{
  if(change.status==='loading'||change.url){toolbarRevision++;toolbarStates.delete(tabId);void updateToolbar();}
});
const writeOwners = () => stateStore?.set({relayWatchOwners:Object.fromEntries(watchers)});
browser.tabs.onRemoved?.addListener(tabId => {
  ownerWrites = ownerWrites.catch(()=>{}).then(async()=>{
    await loadOwners();badges.delete(tabId);toolbarRevision++;toolbarStates.delete(tabId);await updateToolbar();
    const size=watchers.size;
    for (const [key,id] of watchers) if (id === tabId) watchers.delete(key);
    if(watchers.size!==size)await writeOwners();
  });
});

browser.runtime.onMessage.addListener(async (message, sender) => {
  if(message?.type==='RELAY_WAKE_GATE'){
    try{const chat=await senderConversation(sender);await ownerWrites;await loadOwners();
      const saved=await browser.storage.local.get(['relayConnectedTab','relayWatchIntent']);
      return {ok:true,allowed:saved.relayConnectedTab?.chat===chat&&saved.relayConnectedTab.tabId===sender.tab.id&&watchers.get(chat)===sender.tab.id&&saved.relayWatchIntent?.[chat]!==false};
    }catch{return {ok:true,allowed:false};}
  }
  if(['RELAY_WAKE_CONTROL','RELAY_GOAL_CONTROL'].includes(message?.type)){
    if(!sender.url?.startsWith('moz-extension://'))return {ok:false,error:'Unauthorized wake control'};
    try{const target=(await browser.storage.local.get('relayConnectedTab')).relayConnectedTab;
      if(!target)throw Error('Connect ChatGPT Watch first');
      if((await browser.tabs.get(target.tabId)).url?.split(/[?#]/)[0]!==target.chat)throw Error('Connected conversation changed');
      return await browser.tabs.sendMessage(target.tabId,{...message,chat:target.chat});
    }catch(error){
      if(!Object.hasOwn(message,'config')&&!Object.hasOwn(message,'newGoal')){
        const saved=await browser.storage.local.get(['relayConnectedTab','relayWakeDiagnostics']),target=saved.relayConnectedTab;
        const watch=target&&(await browser.storage.local.get('aiBridgeWatch:'+target.chat))['aiBridgeWatch:'+target.chat];
        if(message.type==='RELAY_GOAL_CONTROL'&&watch?.goal)return {ok:true,goal:watch.goal,history:watch.goalHistory || [],offline:true};
        if(message.type==='RELAY_WAKE_CONTROL'&&watch?.goal?.wake)return {ok:true,wake:watch.goal.wake,transport:saved.relayWakeDiagnostics || null,offline:true};
      }
      return {ok:false,error:error.message};
    }
  }
  if(message?.type==='WATCH_INTENT'){try{const live=await senderConversation(sender),chat=message.chat;if(chat!==live){const target=(await browser.storage.local.get('relayConnectedTab')).relayConnectedTab;if(message.wanted!==false||target?.tabId!==sender.tab.id||target.chat!==chat)throw Error('Watch intent conversation changed');}const map=(await browser.storage.local.get('relayWatchIntent')).relayWatchIntent || {};map[chat]=message.wanted===true;await browser.storage.local.set({relayWatchIntent:map});return {ok:true};}catch(error){return {ok:false,error:error.message};}}
  if(['RELAY_RECOVERY_STATUS','RELAY_RECONNECT'].includes(message?.type)){if(!sender.url?.startsWith('moz-extension://'))return {ok:false,error:'Recovery controls require the extension popup'};try{if(!recovery)throw Error('Reload the updated extension');if(message.type==='RELAY_RECONNECT')return await recovery.reconnect(message.provider,message.tabId);if(message.refresh)await recovery.all();return {ok:true,health:(await browser.storage.local.get('relayConnectionHealth')).relayConnectionHealth || {}};}catch(error){return {ok:false,error:error.message};}}
  if(message?.type==='RELAY_DESTINATION_READY'){try{await senderConversation(sender);await ownerWrites;if(watchers.get(await senderConversation(sender))!==sender.tab.id)throw Error('Watch ownership required');if(message.provider==='codex'){let h=(await browser.storage.local.get('relayConnectionHealth')).relayConnectionHealth?.codex;if(!h||Date.now()-h.checkedAt>30000){await recovery?.check('codex');h=(await browser.storage.local.get('relayConnectionHealth')).relayConnectionHealth?.codex;}return {ok:true,ready:!h||h.state==='ready'};}const key=message.provider==='gemini'?'relayGeminiTarget':'relayGrokTarget',target=(await browser.storage.local.get(key))[key];if(!target)return {ok:true,ready:false};const tab=await browser.tabs.get(target.tabId);if(tab.url?.split(/[?#]/)[0]!==target.chat)return {ok:true,ready:false};const live=await browser.tabs.sendMessage(tab.id,{type:'RELAY_STATUS'});return {ok:true,ready:live?.ok===true&&(!message.guardDraft||live.diagnostics?.generating!==true&&!live.diagnostics?.composer?.hasDraft&&live.diagnostics?.editorFound!==false),reason:'Waiting for '+message.provider+' connection or composer'};}catch(error){return {ok:true,ready:false,reason:error.message};}}

  if(/^(?:OUTPUTS_|ALERTS_SETTINGS)/.test(message?.type || '')){try{if(!outputServices)throw Error('Reload the updated extension to load the outputs library');return await outputServices.handle(message,sender);}catch(error){return {ok:false,error:error.message};}}
  if(message?.type==='GEMINI_SEND_GATE')return enqueueWeb('gemini',async()=>{try{return await geminiSendGate(message,sender);}catch(error){return {ok:false,error:error.message};}});
  if(message?.type==='RELAY_IMAGE_FETCH'){
    try{
      const chat=await senderConversation(sender);
      if(!globalThis.RelayMedia.allowedURL(message.url,chat))throw new Error('Image URL is outside this provider');
      const response=await fetch(message.url,{credentials:'include',redirect:'follow',signal:AbortSignal.timeout(20000)});
      if(!globalThis.RelayMedia.allowedURL(response.url,chat))throw new Error('Image download redirected outside this provider');
      return {ok:true,image:await globalThis.RelayMedia.readResponse(response)};
    }catch(error){return {ok:false,error:'IMAGE_BYTES_UNAVAILABLE: '+String(error.message || 'Image network access was denied').replace(/https?:\/\/\S+/g,'[image resource]').slice(0,350)};}
  }
  if(message?.type==='RELAY_CONNECTIONS'){
    if(!sender.url?.startsWith('moz-extension://'))return {ok:false,error:'Unauthorized popup'};
    try{return {ok:true,connections:await connectionSummary()};}catch(error){return {ok:false,error:error.message};}
  }
  if(['RELAY_PAIR_GROK','RELAY_UNPAIR_GROK','RELAY_PAIR_GEMINI','RELAY_UNPAIR_GEMINI','RELAY_INSPECT_TAB'].includes(message?.type)){
    if(!sender.url?.startsWith('moz-extension://'))return {ok:false,error:'Unauthorized popup'};
    try{
      if(!Number.isInteger(message.tabId))throw new Error('Select a conversation tab first');
      const provider=message.type.includes('GEMINI')?'gemini':'grok',prefix=provider.toUpperCase(),name=provider==='gemini'?'Gemini':'Grok',key=provider==='gemini'?'relayGeminiTarget':'relayGrokTarget',jobsKey=provider==='gemini'?'relayGeminiJobs':'relayGrokJobs';
      if(message.type==='RELAY_PAIR_'+prefix)return await pairGrok(message.tabId,provider);
      if(message.type==='RELAY_INSPECT_TAB'){
        const {page}=await inspectChat(message.tabId),result=await browser.tabs.sendMessage(message.tabId,{type:'RELAY_DIAGNOSTICS'});
        if(!result?.ok)throw new Error(result?.error || 'No diagnostics returned');
        return {ok:true,snapshot:{...result.snapshot,connections:await connectionSummary(),inspection:{provider:page.diagnostics.provider,source:'selected-tab',tabId:message.tabId}}};
      }
      const target=(await browser.storage.local.get(key))[key];
      if(target?.tabId===message.tabId){
        await browser.storage.local.set({[key]:null});await browser.action.setBadgeText({tabId:message.tabId,text:''});badges.delete(message.tabId);
        await enqueueWeb(provider,async()=>{
          const jobs=(await browser.storage.local.get(jobsKey))[jobsKey] || {};
          for(const [id,job] of Object.entries(jobs))if(job.target.tabId===message.tabId&&!['done','error'].includes(job.status)){
            await browser.tabs.sendMessage(message.tabId,{type:'RELAY_'+prefix+'_CANCEL',id}).catch(()=>{});
            Object.assign(job,{status:'error',error:name+' was unpaired; existing website generation may continue'});
          }
          await browser.storage.local.set({[jobsKey]:jobs});
        });
      }
      return {ok:true};
    }catch(error){return {ok:false,error:error.message};}
  }
  if(/^(?:GROK|GEMINI)_(?:START|STATUS|CANCEL|MEDIA_RELEASE)$/.test(message?.type || '')){
    const provider=message.type.startsWith('GEMINI')?'gemini':'grok',prefix=provider.toUpperCase(),jobsKey=provider==='gemini'?'relayGeminiJobs':'relayGrokJobs';
    return enqueueWeb(provider,async()=>{
      try{
        if(message.type===prefix+'_CANCEL'){
          await grokRequest({...message,type:prefix+'_STATUS'},sender,{cancel:true,provider});
          const jobs=(await browser.storage.local.get(jobsKey))[jobsKey] || {},job=jobs[message.id];
          if(job&&!['done','error'].includes(job.status)){
            await browser.tabs.sendMessage(job.target.tabId,{type:'RELAY_'+prefix+'_CANCEL',id:message.id}).catch(()=>{});
            Object.assign(job,{status:'error',error:'Stopped by coordinator; existing website generation may continue in its tab'});await browser.storage.local.set({[jobsKey]:jobs});
          }
          return {ok:true};
        }
        return await grokRequest(message,sender,{provider});
      }catch(error){return {ok:false,error:provider==='gemini'?error.message.replaceAll('Grok','Gemini').replaceAll('grok.com','gemini.google.com'):error.message};}
    });
  }
  if(['RELAY_NATIVE_CONNECT','RELAY_QUICK_START'].includes(message?.type)){
    if(!sender.url?.startsWith('moz-extension://'))return {ok:false,error:'Unauthorized popup'};
    try{
      if(message.type==='RELAY_NATIVE_CONNECT')return await connectNativeBridge();
      if(!Number.isInteger(message.tabId))throw new Error('A ChatGPT tab is required');
      if(!quickStarts.has(message.tabId))quickStarts.set(message.tabId,quickStart(message.tabId).finally(()=>quickStarts.delete(message.tabId)));
      return await quickStarts.get(message.tabId);
    }catch(error){return {ok:false,error:error.message,watchStartFailed:error.watchStartFailed===true,startup:error.startup};}
  }
  if (["RELAY_TARGET","RELAY_CONNECT"].includes(message?.type)) {
    if (!sender.url?.startsWith("moz-extension://")) return {ok:false,error:"Unauthorized popup"};
    try {
      const saved=(await browser.storage.local.get("relayConnectedTab")).relayConnectedTab;
      const tab=await browser.tabs.get(message.type === "RELAY_CONNECT" ? message.tabId : saved?.tabId);
      if (!/^https:\/\/(chatgpt\.com|chat\.openai\.com|grok\.com)\//.test(tab.url || "")) throw new Error("The connected tab is no longer a ChatGPT conversation");
      const url=new URL(tab.url),chat=url.origin+url.pathname;
      if (message.type === "RELAY_TARGET" && saved?.chat !== chat) throw new Error("The connected ChatGPT tab changed conversation. Select the intended chat and reconnect Watch.");
      const target={tabId:tab.id,chat};
      if(message.type === "RELAY_CONNECT") await browser.storage.local.set({relayConnectedTab:target,...(isGrok(chat)?{relayGrokTarget:target}:{})});
      return {ok:true,...target};
    } catch(err) {
      return {ok:false,error:err.message || "Connected ChatGPT tab is unavailable",unbound:!(await browser.storage.local.get("relayConnectedTab")).relayConnectedTab};
    }
  }
  if (["WATCH_CLAIM","WATCH_RELEASE"].includes(message?.type)) {
    if (!sender.tab?.id || (sender.frameId ?? 0)!==0 || !supportedChat(sender.url)) return {ok:false,error:"Unauthorized watcher"};
    return ownerWrites = ownerWrites.catch(()=>{}).then(async()=>{
    await loadOwners();
    if (message.type === "WATCH_RELEASE") {
      // Keep a reported error visible; stopped/finished runs report idle first.
      if(toolbarStates.get(sender.tab.id)!=='error'){toolbarStates.delete(sender.tab.id);await updateToolbar();}
      const size=watchers.size;
      for (const [key,id] of watchers) if (id === sender.tab.id) watchers.delete(key);
      if(watchers.size!==size)await writeOwners();
      return {ok:true};
    }
    let key;try{key=await senderConversation(sender);}catch(error){return {ok:false,error:error.message};}
    if (message.chat && message.chat !== key) return {ok:false,error:"Watcher conversation does not match the sending tab"};
    const owner = watchers.get(key);
    if (owner && owner !== sender.tab.id) {
      let tab;try {tab=await browser.tabs.get(owner);} catch {}
      if (tab && (!tab.url || tab.url.split(/[?#]/)[0] === key)) {
        // A tab can survive a stopped/failed watcher. A positive idle status
        // releases that stale owner; a live or unverified owner still blocks.
        let live;try{live=await browser.tabs.sendMessage(owner,{type:'RELAY_STATUS'});}catch{}
        if(live?.ok!==true || live?.status?.running!==false || live?.diagnostics?.grokWorker?.active)
          return {ok:false,error:"This conversation is already watched in another tab"};
      }
    }
    let changed=owner!==sender.tab.id;
    for(const [old,id] of watchers)if(id===sender.tab.id && old!==key){watchers.delete(old);changed=true;}
    if(changed){
      watchers.set(key,sender.tab.id);
      await writeOwners();
    }
    if(browser.storage?.local){
      const target=(await browser.storage.local.get("relayConnectedTab")).relayConnectedTab;
      if(!target || target.tabId===sender.tab.id && target.chat!==key) await browser.storage.local.set({relayConnectedTab:{tabId:sender.tab.id,chat:key}});
    }
    return {ok:true,tabId:sender.tab.id,conversationVerified:true,conversationSource:'live-tab',
      senderPathChanged:new URL(sender.url).pathname!==new URL(key).pathname};
    });
  }
  if (message?.type === "RELAY_EVENT" && sender.tab?.id &&
      (sender.frameId ?? 0)===0 &&
      /^https:\/\/(chatgpt\.com|chat\.openai\.com|grok\.com)\//.test(sender.url || "")) {
    // Keep a visible indicator even when the popup is closed. This handler
    // updates only the originating ChatGPT tab's extension badge.
    const state = message.status || {};
    let chat;try{chat=await senderConversation(sender);}catch{return {ok:false,error:'Tab status unavailable'};}
    await outputServices?.alerts.observe(chat,state).catch(()=>{});
    toolbarRevision++;toolbarStates.set(sender.tab.id,toolbarState(state));await updateToolbar();
    const label = ({watching:"ON",running:"RUN",success:"OK",failed:"FAIL",reconnecting:"WAIT",stopped:""})[state.phase] ??
      (state.running ? "RUN" : state.phase === "done" ? "OK" : state.phase === "error" ? "ERR" : "");
    const color=["error","failed"].includes(state.phase) ? "#c33737" : state.phase === "reconnecting" ? "#996600" : "#26764b";
    if(badges.get(sender.tab.id)!==label+color){
      await browser.action.setBadgeBackgroundColor({tabId:sender.tab.id,color});
      await browser.action.setBadgeText({tabId:sender.tab.id,text:label});
      badges.set(sender.tab.id,label+color);
    }
    return {ok: true};
  }
  if (!message || message.type !== "BRIDGE_REQUEST") return undefined;
  if (!sender.url?.startsWith("moz-extension://") &&
      !/^https:\/\/(chatgpt\.com|chat\.openai\.com|grok\.com)\//.test(sender.url || "")) {
    return {ok: false, error: "Unauthorized sender"};
  }
  const {route, method = "GET", token = "", data = null} = message;
  const pathname = String(route || "").split("?")[0];
  if (!ALLOWED.has(pathname) || !["GET", "POST"].includes(method)) {
    return {ok: false, error: "Unsupported bridge request"};
  }
  if (typeof token !== "string" || !/^[0-9a-f]{48}$/.test(token)) {
    return {ok: false, error: "Enter the 48-character token from the bridge terminal"};
  }
  try {
    if(pathname==="/settings" && !sender.url?.startsWith("moz-extension://")){
      await ownerWrites;
      const target=(await browser.storage?.local?.get("relayConnectedTab"))?.relayConnectedTab;
      let chat;try{chat=await senderConversation(sender);}catch(error){return {ok:false,error:error.message,httpStatus:403};}
      if(!target || target.tabId!==sender.tab?.id || target.chat!==chat || watchers.get(chat)!==sender.tab.id)
        return {ok:false,error:"Settings commands require the explicitly connected, watching ChatGPT conversation",httpStatus:403};
    }
    const payload = data;
    let requestToken=token;
    const options = () => ({
      method,
      headers: {"X-Relay-Token": requestToken, "Content-Type": "application/json"},
      ...(method === "POST" ? {body: JSON.stringify(payload || {})} : {}),
      signal: AbortSignal.timeout(12000),
      redirect: "error"
    });
    let response;
    try{response=await fetch(BASE+route,options());}
    catch(error){
      if(!(await browser.storage?.local?.get('relayNativeEnabled'))?.relayNativeEnabled)throw error;
      requestToken=(await connectNativeBridge()).token;
      response=await fetch(BASE+route,options());
    }
    const value = await response.json();
    if (!response.ok) return {ok: false, error: value.error || `HTTP ${response.status}`,httpStatus:response.status,retryable:response.status >= 500};
    if(pathname==="/health" && value.settingsCommandsVersion===1 && !value.initialized){
      const legacy=(await browser.storage?.local?.get("executionSettings"))?.executionSettings;
      if(legacy){
        const migrated=await fetch(BASE+"/settings",{method:"POST",headers:{"X-Relay-Token":requestToken,"Content-Type":"application/json"},
          body:JSON.stringify({action:"set_defaults",...legacy,initializeOnly:true,commandId:crypto.randomUUID(),issuedAt:Date.now()}),signal:AbortSignal.timeout(12000),redirect:"error"});
        const result=await migrated.json();if(!migrated.ok)return {ok:false,error:result.error || "Could not migrate saved defaults",httpStatus:migrated.status};
        Object.assign(value,result,{defaultExecution:result.defaults});
      }
    }
    if(value.defaults && browser.storage?.local){
      const saved=await browser.storage.local.get({executionDefaultsRevision:0,executionSettings:null});
      if((saved.executionDefaultsRevision || 0)<=(value.revision || 0) &&
        (saved.executionDefaultsRevision!==(value.revision || 0) || JSON.stringify(saved.executionSettings)!==JSON.stringify(value.defaults)))
        await browser.storage.local.set({executionSettings:value.defaults,executionDefaultsRevision:value.revision || 0});
    }
    return {ok: true, ...value};
  } catch (err) {
    return {ok: false, error: `Bridge unavailable: ${err.message}`,retryable:true};
  }
});
outputServices=globalThis.RelayOutputs?.create({
  browser,
  verifyCoordinator:async(sender,allowStopped=false)=>{const chat=await senderConversation(sender);if(!/^https:\/\/(?:chatgpt\.com|chat\.openai\.com)\//.test(chat))throw Error('Only the coordinating ChatGPT conversation can archive or read queued outputs');await ownerWrites;await loadOwners();if(!allowStopped&&watchers.get(chat)!==sender.tab.id)throw Error('This conversation no longer owns Watch');return chat;},
  readArtifact:async id=>{if(!/^[a-f0-9-]{36}$/.test(id))throw Error('Invalid output artifact ID');const {bridgeToken}=await browser.storage.local.get('bridgeToken');const response=await fetch(BASE+'/artifact?id='+encodeURIComponent(id),{headers:{'X-Relay-Token':bridgeToken},redirect:'error',signal:AbortSignal.timeout(20000)});const result=await response.json();if(!response.ok)throw Error(result.error || 'Local file output could not be read');return result;},
  releaseArtifact:async id=>{const {bridgeToken}=await browser.storage.local.get('bridgeToken');await fetch(BASE+'/artifact-release',{method:'POST',headers:{'X-Relay-Token':bridgeToken,'Content-Type':'application/json'},body:JSON.stringify({id}),redirect:'error',signal:AbortSignal.timeout(12000)});},
  queueJob:async(target,job)=>{const tab=await browser.tabs.get(target.tabId);if(tab.url?.split(/[?#]/)[0]!==target.chat)throw Error('The connected ChatGPT tab changed conversation');return browser.tabs.sendMessage(target.tabId,{type:'RELAY_LIBRARY_QUEUE',job});},
  checkQueue:async(target,id)=>{const tab=await browser.tabs.get(target.tabId);if(tab.url?.split(/[?#]/)[0]!==target.chat)throw Error('The connected ChatGPT tab changed conversation');const result=await browser.tabs.sendMessage(target.tabId,{type:'RELAY_LIBRARY_RECEIPT',id});if(!result?.ok)throw Error(result?.error || 'Queue state could not be checked');return result;},
  capabilities:async agent=>{const key=agent==='chatgpt'?'relayConnectedTab':agent==='gemini'?'relayGeminiTarget':'relayGrokTarget',target=(await browser.storage.local.get(key))[key];if(!target)throw Error('Pair '+agent+' before attaching files');const tab=await browser.tabs.get(target.tabId);if(tab.url?.split(/[?#]/)[0]!==target.chat)throw Error('The paired agent changed conversation; pair its intended tab again');const result=await browser.tabs.sendMessage(target.tabId,{type:'RELAY_ATTACHMENT_CAPABILITIES'});if(!result?.ok)throw Error(result?.error || 'File support could not be checked');return result;}
});

const coordinatorWake=browser.alarms&&globalThis.RelayCoordinatorWake?.create({browser,owns:async target=>{await ownerWrites;await loadOwners();return watchers.get(target.chat)===target.tabId;}});
let recovery=globalThis.RelayRecovery?.create({browser,inspect:id=>inspectChat(id,{repairMissing:false}),repair:repairPageListener,alerts:outputServices?.alerts,
  localHealth:async deliberate=>{let {bridgeToken,relayNativeEnabled}=await browser.storage.local.get(['bridgeToken','relayNativeEnabled']);if(deliberate&&relayNativeEnabled)bridgeToken=(await connectNativeBridge()).token;if(!/^[a-f0-9]{48}$/.test(bridgeToken || '')){if(!deliberate)return {configured:false};throw Error('Connect the configured local bridge');}const response=await fetch(BASE+'/health',{headers:{'X-Relay-Token':bridgeToken},redirect:'error',signal:AbortSignal.timeout(6000)});if(!response.ok)throw Error('Local bridge is unavailable');return response.json();},
  resume:async target=>{const state=await browser.tabs.sendMessage(target.tabId,{type:'RELAY_STATUS'});if(state?.status?.running)return {ok:true};const saved=await browser.storage.local.get(['relayWatchIntent','aiBridgeWatch:'+target.chat,'bridgeToken']);const wanted=saved.relayWatchIntent?.[target.chat] ?? saved['aiBridgeWatch:'+target.chat]?.watchIntended;if(!wanted)return {ok:true,stopped:true};return browser.tabs.sendMessage(target.tabId,{type:'RELAY_WATCH_START',token:saved.bridgeToken,recover:true});},
  transfer:async(provider,before,after)=>{await (ownerWrites=ownerWrites.catch(()=>{}).then(async()=>{await loadOwners();const key=provider==='chatgpt'?'relayConnectedTab':provider==='gemini'?'relayGeminiTarget':'relayGrokTarget';const saved=(await browser.storage.local.get(key))[key];if(JSON.stringify(saved)!==JSON.stringify(before))throw Error('Connection changed during recovery');
    if(provider==='chatgpt'){const owner=watchers.get(before.chat);if(owner&&owner!==after.tabId){let tab;try{tab=await browser.tabs.get(owner);}catch{}if(tab?.url?.split(/[?#]/)[0]===before.chat){let page;try{page=await browser.tabs.sendMessage(owner,{type:'RELAY_STATUS'});}catch{}if(page?.status?.running!==false)throw Error('Another live or unverified watcher owns this conversation');}}watchers.set(before.chat,after.tabId);await writeOwners();}
    await browser.storage.local.set({[key]:after});for(const jobsKey of ['relayGrokJobs','relayGeminiJobs']){const jobs=(await browser.storage.local.get(jobsKey))[jobsKey] || {};let changed=false;for(const job of Object.values(jobs)){if(provider==='chatgpt'&&job.source===before.chat&&job.sourceTab===before.tabId){job.sourceTab=after.tabId;changed=true;}else if(provider!=='chatgpt'&&job.target.chat===before.chat&&job.target.tabId===before.tabId){job.target=after;changed=true;}}if(changed)await browser.storage.local.set({[jobsKey]:jobs});}
  }));}
});
