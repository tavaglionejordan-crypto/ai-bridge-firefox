"use strict";
const byId = id => document.getElementById(id);
const Execution = globalThis.RelayExecution;
let modelCatalog = null;
let savedExecution = {...Execution.DEFAULTS};
let previousHelpPanel='main';
let jobsSnapshot=null,jobsMode='live',jobsFilter='all',selectedJobKey=null;
let jobsDragging=null,jobsClearKey=null,jobsHidden=new Set(),jobControlBusy=false;
const finishedJob=row=>['passed','failed','cancelled'].includes(row.state);
const jobVisibilityKey=row=>row.key+':'+(row.taskId || row.historyId || row.instanceId || 'legacy');
async function loadJobsVisibility(){
  const target=(await browser.storage.local.get('relayConnectedTab')).relayConnectedTab,key=target?.chat?'relayHiddenJobs:'+target.chat:null;
  jobsClearKey=key;jobsHidden=new Set(key?(await browser.storage.local.get(key))[key] || []:[]);
}
let selectedDetailsAgent='codex',selectedDetailsJob=null,agentSnapshot=null,detailsFilter='all',selectedPlanJob=null,planSnapshot=null,planControlBusy=false;
function showPanel(name){
  for(const tab of ['main','jobs','advanced','agent','help']){
    if(name==='help' && tab!=='help' && !byId(`${tab}Panel`).hidden)previousHelpPanel=tab;
    byId(`${tab}Panel`).hidden=tab!==name;byId(`${tab}Tab`).setAttribute('aria-selected',String(tab===name));
  }
  if(name==='agent')renderAgentDetails();
  if(name==='jobs')renderJobs();
}
for(const name of ['main','jobs','advanced','agent','help'])byId(`${name}Tab`).addEventListener('click',()=>showPanel(name));
function openAgentDetails(agent){selectedDetailsAgent=agent;detailsFilter='all';selectedDetailsJob=null;showPanel('agent');byId('agentTab').focus();}
for(const agent of ['codex','grok','gemini']){
  const card=byId(agent+'Card');card.addEventListener('click',()=>openAgentDetails(agent));
  card.addEventListener('keydown',event=>{if(['Enter',' '].includes(event.key)){event.preventDefault();openAgentDetails(agent);}});
  byId('details'+(agent==='codex'?'Codex':agent==='gemini'?'Gemini':'Grok')).addEventListener('click',()=>{selectedDetailsAgent=agent;selectedDetailsJob=null;renderAgentDetails();});
}
byId('detailsAll').addEventListener('click',()=>{selectedDetailsAgent='all';selectedDetailsJob=null;renderAgentDetails();});
byId('agentStatusFilter').addEventListener('change',()=>{detailsFilter=byId('agentStatusFilter').value;selectedDetailsJob=null;renderAgentDetails();});
byId('agentJobSelect').addEventListener('change',()=>{selectedDetailsJob=byId('agentJobSelect').value;renderAgentDetails();});
byId('agentBack').addEventListener('click',()=>{showPanel('main');byId('mainTab').focus();});
function jobState(value){
  const state=String(value || '').toLowerCase();
  return ['success','done','completed'].includes(state)?'passed':['executing','running','stopping','dispatching'].includes(state)?'running':['error','failed','timeout'].includes(state)?'failed':state==='cancelled'?'cancelled':state==='queued'?'queued':'unknown';
}
function jobsRows(){
  const snapshot=jobsSnapshot || {},plan=snapshot.planDetails || snapshot.plan,history=snapshot.agentDetails?.jobs || [],rows=[];
  const matched=new Set();
  for(const job of plan?.jobs || []){
    const agent=history.find(item=>job.taskId&&item.id===job.taskId || item.planJobId===job.id&&item.planId===plan.id);
    if(agent)matched.add(agent.id);
    rows.push({...agent,...job,key:'plan:'+plan.id+':'+job.id,planJobId:job.id,instanceId:plan.instanceId,agent:job.target,state:jobState(job.state),prompt:job.prompt??agent?.prompt,reply:agent?.reply,historyId:agent?.id,plan:true});
  }
  for(const job of history)if(!matched.has(job.id))rows.push({...job,key:'agent:'+job.id,historyId:job.id,state:jobState(job.status),plan:false});
  // Queue positions come from the live execution order, not history timestamps.
  for(const agent of ['codex','grok','gemini']){
    const queued=rows.filter(row=>!row.plan&&row.state==='queued'&&row.agent===agent).sort((a,b)=>(a.queuePosition ?? a.startedAt ?? 0)-(b.queuePosition ?? b.startedAt ?? 0));let index=0;
    for(let i=0;i<rows.length;i++)if(!rows[i].plan&&rows[i].state==='queued'&&rows[i].agent===agent)rows[i]=queued[index++];
  }
  for(const row of rows){
    const activity=(snapshot.activity || []).filter(item=>item.id===row.historyId);
    if(row.prompt===undefined)row.prompt=activity.find(item=>typeof item.taskText==='string')?.taskText;
    if(!row.reply)row.activityExcerpt=activity.filter(item=>['success','failed','cancelled'].includes(item.phase)).at(-1)?.message;
  }
  return rows.filter(row=>!finishedJob(row)||!jobsHidden.has(jobVisibilityKey(row)));
}
function openJobs(filter='all'){
  byId('jobsOtherFilters').open=!['queued','running'].includes(filter);
  jobsFilter=filter;selectedJobKey=null;showPanel('jobs');byId('jobsTab').focus();
}
async function restoreSavedJobs(){
  const target=(await browser.storage.local.get('relayConnectedTab')).relayConnectedTab;
  if(!target?.chat){jobsSnapshot=null;jobsMode='unavailable';renderJobs();return;}
  const key='aiBridgeWatch:'+target.chat,saved=(await browser.storage.local.get(key))[key];
  if(!saved){jobsSnapshot=null;jobsMode='unavailable';renderJobs();return;}
  const history=[...(saved.agentHistory || [])],ids=new Set(history.map(job=>job.id));
  for(const task of saved.tasks || [])if(['task','grok','gemini'].includes(task.kind)&&!ids.has(task.id))history.push({id:task.id,agent:task.kind==='task'?'codex':task.kind,title:task.prompt?.split('\n')[0],status:task.outcome || task.stage,prompt:task.prompt,reply:task.reply,planJobId:task.planJobId,planId:task.planId});
  jobsSnapshot={running:false,planDetails:globalThis.RelayPlan.summary(saved.plan,{titles:true,prompts:true}),agentDetails:{jobs:history.reverse()},activity:saved.activity || []};jobsMode='saved';renderJobs();
}
function renderJobs(){
  const rows=jobsRows(),plan=jobsSnapshot?.planDetails || jobsSnapshot?.plan;
  for(const button of byId('jobsFilters').querySelectorAll('button')){const value=button.dataset.filter,n=value==='all'?rows.length:rows.filter(row=>row.state===value).length;button.querySelector('span').textContent=n;button.dataset.populated=String(n>0);button.setAttribute('aria-pressed',String(jobsFilter===value));}
  byId('jobsOthersLabel').textContent=['queued','running'].includes(jobsFilter)?'Others':'Others · '+({all:'All jobs',passed:'Passed',failed:'Failed',cancelled:'Cancelled'}[jobsFilter] || 'All jobs');
  byId('clearFinishedJobs').disabled=!jobsClearKey||!rows.some(finishedJob)||jobControlBusy;
  byId('jobsSource').textContent=jobsMode==='live'&&jobsSnapshot?.running?'Live':jobsMode==='saved'?'Saved snapshot':jobsSnapshot?'Watch stopped':'Unavailable';
  const counts=Object.fromEntries(['queued','running','passed','failed','cancelled'].map(state=>[state,rows.filter(row=>row.state===state).length]));
  byId('jobsOverview').textContent=rows.length?counts.running+' working · '+counts.queued+' queued · '+counts.passed+' passed · '+counts.failed+' failed'+(counts.cancelled?' · '+counts.cancelled+' cancelled':''):jobsHidden.size?'No visible jobs · finished entries cleared.':'No jobs registered in this conversation.';
  byId('jobsScope').textContent=jobsMode==='saved'?'Saved jobs for the connected ChatGPT conversation. Live status is unavailable.':plan?(plan.cancelled?'Plan cancelled':plan.paused?'Plan paused':'Plan active')+(plan.reason?' · '+plan.reason:''):'Connected ChatGPT conversation · latest 100 agent jobs';
  const lastControl=(jobsSnapshot?.activity || []).filter(item=>item.phase==='control').at(-1),decision=jobsSnapshot?.diagnostics?.watcher?.lastIgnored?.reason || (lastControl?.message?.includes('rejected')?lastControl.message:'');
  byId('jobsDecision').hidden=!decision;byId('jobsDecision').textContent=decision?'Last listener decision: '+decision:'';
  if(!rows.length){const reason=jobsSnapshot?.diagnostics?.watcher?.lastIgnored?.reason || jobsSnapshot?.activity?.filter(item=>item.phase==='control'&&item.message?.includes('rejected')).at(-1)?.message;byId('jobsScope').textContent=jobsHidden.size?'Finished entries cleared from this list. New jobs will appear here.':reason?'Last listener decision: '+reason:'Jobs appear here once the listener accepts a task or plan. Check Watch and Diagnostics if you expected a job.';}
  const filtered=rows.filter(row=>jobsFilter==='all'||row.state===jobsFilter);
  byId('jobsEmpty').hidden=filtered.length>0;byId('jobsEmpty').textContent=rows.length?'No jobs match this filter.':jobsHidden.size?'Finished history cleared.':'No jobs registered yet.';
  const key=JSON.stringify([jobsMode,jobsSnapshot?.running,plan?.revision,planControlBusy,jobControlBusy,filtered.map(row=>[row.key,row.title,row.agent,row.state,row.delivery,row.dependency?.reason,selectedJobKey===row.key])]);
  if(renderJobs.listKey!==key){renderJobs.listKey=key;byId('jobsList').replaceChildren(...filtered.map(row=>{
    const li=document.createElement('li'),button=document.createElement('button'),title=document.createElement('strong'),meta=document.createElement('span');
    button.className='jobs-row';button.dataset.blocked=String(row.dependency?.state==='blocked');button.dataset.state=row.state;button.setAttribute('aria-pressed',String(row.key===selectedJobKey));title.textContent=row.title || row.prompt?.split('\n')[0]?.slice(0,100) || row.id;meta.textContent=(row.agent==='codex'?'Codex':row.agent==='chatgpt'?'ChatGPT':remoteName(row.agent))+' · '+(row.state==='running'?'Working':row.state[0].toUpperCase()+row.state.slice(1))+(row.delivery==='delivery-error'?' · delivery needs attention':['ready','sending'].includes(row.delivery)?' · result waiting':'')+(row.dependency?.reason&&row.state==='queued'?' · '+row.dependency.reason:'');button.append(title,meta);button.addEventListener('click',()=>{selectedJobKey=row.key;renderJobs();});li.append(button);
    if(editableJob(row)){
      li.draggable=true;li.title='Drag to reorder queued jobs';
      li.addEventListener('dragstart',event=>{jobsDragging=row.key;event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('text/plain','ai-bridge-job:'+row.key);li.classList.add('dragging');});
      li.addEventListener('dragend',()=>{jobsDragging=null;for(const item of byId('jobsList').children)item.classList.remove('dragging','drop-before','drop-after');});
      li.addEventListener('dragover',event=>{const source=jobsRows().find(item=>item.key===jobsDragging);if(!sameJobQueue(source,row))return;event.preventDefault();event.dataTransfer.dropEffect='move';const after=event.clientY>li.getBoundingClientRect().top+li.offsetHeight/2;li.classList.toggle('drop-after',after);li.classList.toggle('drop-before',!after);});
      li.addEventListener('dragleave',()=>li.classList.remove('drop-before','drop-after'));
      li.addEventListener('drop',event=>{event.preventDefault();const source=jobsRows().find(item=>item.key===jobsDragging),after=event.clientY>li.getBoundingClientRect().top+li.offsetHeight/2;jobsDragging=null;li.classList.remove('drop-before','drop-after');if(sameJobQueue(source,row))void moveJob(source,row,after);});
      const remove=document.createElement('button');remove.className='job-delete';remove.textContent='×';remove.setAttribute('aria-label','Delete queued job '+(row.title || row.id));remove.addEventListener('click',()=>void removeJob(row));li.append(remove);
    }
    return li;
  }));}
  const job=filtered.find(row=>row.key===selectedJobKey);byId('jobView').hidden=!job;byId('dependencyEditor').hidden=!job?.plan||plan?.mode!=='dependencies';if(!job)return;
  if(job.plan&&plan?.mode==='dependencies')void loadDependencyEditor(job,plan);
  byId('jobViewTitle').textContent=job.title || job.id;byId('jobViewState').textContent=(job.agent==='codex'?'Codex':job.agent==='chatgpt'?'ChatGPT':remoteName(job.agent))+' · '+job.state+(job.plan?' · planned job':'');
  byId('jobViewPrompt').textContent=typeof job.prompt==='string'?job.prompt:'Full instructions were not retained for this older job.';
  byId('jobViewReply').textContent=job.reply || (job.activityExcerpt?'Saved activity excerpt (may be abbreviated):\n'+job.activityExcerpt:['passed','failed','cancelled'].includes(job.state)?'Full result was not retained for this older job.':'Waiting for a result.');
  byId('jobViewError').hidden=!(job.error || job.deliveryError);byId('jobViewError').textContent=job.error || job.deliveryError || '';
  byId('jobViewMetrics').hidden=!job.historyId;
  byId('jobViewPlanActions').hidden=job.state!=='queued'&&!job.plan;
  const pending=jobQueue(job),index=pending.findIndex(row=>row.key===job.key),editable=editableJob(job);
  byId('jobViewRemove').disabled=!editable;byId('jobViewUp').disabled=!editable||index<=0;byId('jobViewDown').disabled=!editable||index<0||index===pending.length-1;
}
function editableJob(row){return !!row&&row.state==='queued'&&jobsMode==='live'&&jobsSnapshot?.running&&!planControlBusy&&!jobControlBusy&&(row.plan?!(jobsSnapshot.planDetails || jobsSnapshot.plan)?.cancelled:row.delivery==='queued'&&row.queueEditable!==false);}
function sameJobQueue(a,b){return editableJob(a)&&editableJob(b)&&a.key!==b.key&&a.plan===b.plan&&(a.plan||a.agent===b.agent);}
function jobQueue(row){return jobsRows().filter(item=>item.state==='queued'&&item.plan===row.plan&&(row.plan||item.agent===row.agent));}
async function queueJobControl(row,action,ids){
  if(!editableJob(row))return;
  if(row.plan){renderPlan(jobsSnapshot.planDetails || jobsSnapshot.plan);await changePlan(action,{jobIds:ids});return;}
  const expected=jobQueue(row).map(item=>item.id);jobControlBusy=true;renderJobs();
  try{const tabId=await locateTab(),result=await browser.tabs.sendMessage(tabId,{type:'RELAY_JOB_CONTROL',action,agent:row.agent,jobIds:ids,expected});if(!result?.ok)throw Error(result?.error || 'Queue changed; refresh and try again');byId('jobsActionResult').textContent=action==='remove'?'Queued job deleted.':'Queue order updated.';}
  catch(error){byId('jobsActionResult').textContent=error.message;}
  finally{jobControlBusy=false;await refresh();}
}
async function removeJob(row){if(row)await queueJobControl(row,'remove',[row.plan?row.planJobId:row.id]);}
async function moveJob(source,target,after=false){
  if(!sameJobQueue(source,target))return;
  const ids=jobQueue(source).map(row=>row.plan?row.planJobId:row.id),id=source.plan?source.planJobId:source.id,targetId=target.plan?target.planJobId:target.id;
  ids.splice(ids.indexOf(id),1);ids.splice(ids.indexOf(targetId)+(after?1:0),0,id);await queueJobControl(source,'reorder',ids);
}
for(const button of byId('jobsFilters').querySelectorAll('button'))button.addEventListener('click',()=>{jobsFilter=button.dataset.filter;if(['queued','running'].includes(jobsFilter))byId('jobsOtherFilters').open=false;selectedJobKey=null;renderJobs();});
byId('clearFinishedJobs').addEventListener('click',async()=>{
  if(!jobsClearKey||jobControlBusy)return;const key=jobsClearKey,rows=jobsRows().filter(finishedJob),hidden=new Set(jobsHidden);for(const row of rows)hidden.add(jobVisibilityKey(row));jobControlBusy=true;
  try{await browser.storage.local.set({[key]:[...hidden].slice(-2000)});if(jobsClearKey===key)jobsHidden=hidden;selectedJobKey=null;byId('jobsActionResult').textContent=rows.length+' finished jobs cleared. Queued and working jobs kept.';}
  catch(error){byId('jobsActionResult').textContent='Could not clear jobs: '+error.message;}
  finally{jobControlBusy=false;renderJobs();}
});
byId('jobViewRemove').addEventListener('click',()=>void removeJob(jobsRows().find(row=>row.key===selectedJobKey)));
for(const [id,direction] of [['jobViewUp',-1],['jobViewDown',1]])byId(id).addEventListener('click',()=>{const row=jobsRows().find(row=>row.key===selectedJobKey);if(!row)return;const queue=jobQueue(row),index=queue.findIndex(item=>item.key===row.key),target=queue[index+direction];if(target)void moveJob(row,target,direction>0);});
byId('jobViewMetrics').addEventListener('click',()=>{const row=jobsRows().find(row=>row.key===selectedJobKey);if(!row?.historyId)return;selectedDetailsAgent=row.agent;detailsFilter='all';selectedDetailsJob=row.historyId;showPanel('agent');});
function renderAgentDetails(){
  const agent=selectedDetailsAgent,name=agent==='all'?'All agents':agent==='codex'?'Codex':agent==='gemini'?'Gemini':'Grok',details=agentSnapshot?.agentDetails;
  const latestCodex=details?.jobs?.find(row=>row.agent==='codex'),latestUsage=latestCodex?.usage?.source==='codex-cli'?latestCodex.usage:null;
  const validTokens=value=>Number.isSafeInteger(value)&&value>=0;
  const latestTotal=validTokens(latestUsage?.inputTokens)&&validTokens(latestUsage?.outputTokens)?latestUsage.inputTokens+latestUsage.outputTokens:null;
  byId('codexUsageSummary').textContent=Number.isSafeInteger(latestTotal)?`Latest job · ${latestTotal.toLocaleString('en-GB')} tokens`:latestCodex?'Usage not reported · details':'Click for job details';
  byId('grokUsageSummary').textContent='Tokens not reported · details';
  const matchesState=row=>detailsFilter==='all'||(detailsFilter==='passed'?['SUCCESS','DONE','COMPLETED']:detailsFilter==='failed'?['FAILED','ERROR','TIMEOUT']:['CANCELLED']).includes(String(row.status).toUpperCase());
  const rows=(details?.jobs || []).filter(row=>(agent==='all'||row.agent===agent)&&matchesState(row)),select=byId('agentJobSelect');
  byId('agentStatusFilter').value=detailsFilter;
  byId('agentJobList').replaceChildren(...rows.map(row=>{const li=document.createElement('li'),button=document.createElement('button');button.className='history-job';button.dataset.state=String(row.status).toLowerCase();button.textContent=(row.agent==='codex'?'Codex':remoteName(row.agent))+' · '+(row.title || row.id)+' · '+(row.status || 'Unknown');button.setAttribute('aria-pressed',String(row.id===selectedDetailsJob));button.addEventListener('click',()=>{selectedDetailsJob=row.id;renderAgentDetails();});li.append(button);return li;}));
  if(!rows.some(row=>row.id===selectedDetailsJob))selectedDetailsJob=rows[0]?.id || null;
  select.replaceChildren(...(rows.length?rows.map(row=>{const option=document.createElement('option');option.value=row.id;option.textContent=`${row.title || row.id} · ${row.status || 'Unknown'}`;return option;}):[new Option('No recorded '+name+' jobs','')]));
  select.disabled=!rows.length;if(selectedDetailsJob)select.value=selectedDetailsJob;
  byId('agentDetailHeading').textContent=detailsFilter==='all'?name+' job details':(detailsFilter==='passed'?'Passed':detailsFilter==='failed'?'Failed':'Cancelled')+' jobs'+(agent==='all'?'':' · '+name);
  byId('detailsAll').setAttribute('aria-pressed',String(agent==='all'));byId('detailsCodex').setAttribute('aria-pressed',String(agent==='codex'));byId('detailsGrok').setAttribute('aria-pressed',String(agent==='grok'));byId('detailsGemini').setAttribute('aria-pressed',String(agent==='gemini'));
  const job=rows.find(row=>row.id===selectedDetailsJob),valid=value=>Number.isSafeInteger(value)&&value>=0?value:null;
  const jobAgent=job?.agent || agent,jobName=jobAgent==='codex'?'Codex':remoteName(jobAgent);
  const usage=jobAgent==='codex'&&job?.usage?.source==='codex-cli'?job.usage:null;
  const input=valid(usage?.inputTokens),output=valid(usage?.outputTokens);
  let cached=valid(usage?.cachedInputTokens);if(input!==null&&cached!==null&&cached>input)cached=null;
  const total=input!==null&&output!==null&&Number.isSafeInteger(input+output)?input+output:null;
  for(const [id,value] of [['agentInputTokens',input],['agentCachedTokens',cached],['agentOutputTokens',output],['agentTotalTokens',total]])byId(id).textContent=value===null?'—':value.toLocaleString('en-GB');
  byId('agentUsageNote').textContent=jobAgent!=='codex'?`Not reported: this website relay has no measured ${jobName} token or billing feed. Hidden context, reasoning and image processing cannot be counted from displayed text.`:usage?
    `${total===null?'Partial usage reported':'Usage reported'} by Codex CLI. Cached input is included in input; total = input + output. These figures are not a monetary charge.`:
    details?.codexUsageSupported===false?'Restart the updated local bridge after any active Codex job finishes to collect usage for new jobs. Earlier jobs cannot be backfilled.':
    job&&!job.endedAt?'Waiting for CLI-reported usage. Missing counts are not zero.':'Usage was not reported for this job. Earlier jobs cannot be backfilled; missing counts are not zero.';
  byId('agentDetailStatus').textContent=!agentSnapshot?'Live details unavailable. Open the connected ChatGPT conversation.':!job?'No matching retained jobs. History keeps the latest 100 agent jobs; totals may include older jobs.':
    `${job.status || 'Unknown'} · ${rows.length} retained ${name} jobs${agentSnapshot.running?'':' · Watch stopped; showing last observed state'}`;
  const facts=byId('agentJobFacts');facts.replaceChildren();if(!job)return;
  const display=value=>valid(value)===null?'Not reported':value.toLocaleString('en-GB');
  const when=value=>Number.isFinite(value)?new Date(value).toLocaleString('en-GB',{timeZone:'Europe/London'}):'Not reported';
  const active=agentSnapshot.running&&['running','executing','queued'].includes(job.status);
  const elapsed=active&&Number.isFinite(job.startedAt)?Math.max(0,Date.now()-job.startedAt):job.elapsedMs;
  const e=job.execution?.effective;
  const pairs=[['Job',job.title || job.id],['Task ID',job.id],['CLI job ID',job.jobId || 'Not applicable / not reported'],['Status',job.status || 'Unknown'],['Delivery',job.delivery || 'Not reported'],
    ['Model',e?`${e.modelName || e.model}${e.modelName?' ('+e.model+')':''}`:jobAgent!=='codex'?'Website-selected; exact model not reported':'Not reported'],['Thinking',e?.reasoning || 'Not reported'],
    ['Started',when(job.startedAt)],['Ended',when(job.endedAt)],[job.status==='queued'?'Queued for':'Elapsed',Number.isFinite(elapsed)?(elapsed/1000).toFixed(1)+' seconds':'Not reported'],
    ['Task text chars',display(job.inputChars)],['Reply text chars',display(job.outputChars)],['Input images',display(job.inputImages)],['Output images',display(job.outputImages)],
    ['Plan job',job.planJobId || 'None'],['Submission',job.submission || job.terminationReason || 'Not reported'],['Last observed',when(job.observedAt)]];
  if(job.error)pairs.push(['Error',job.error]);
  if(job.deliveryError)pairs.push(['Delivery issue',job.deliveryError]);
  for(const [label,value] of pairs){const row=document.createElement('div'),dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=label;dd.textContent=value;row.append(dt,dd);facts.append(row);}
}
function showAdvanced(name){
  for(const tab of ['testing','diagnostics']){byId(`${tab}Panel`).hidden=tab!==name;byId(`${tab}Tab`).setAttribute('aria-selected',String(tab===name));}
  if(name==='diagnostics')void refresh();
}
for(const name of ['testing','diagnostics']){
  byId(`${name}Tab`).addEventListener('click',()=>showAdvanced(name));
  byId(`${name}Tab`).addEventListener('keydown',event=>{
    if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
    event.preventDefault();const target=event.key==='Home'?'testing':event.key==='End'?'diagnostics':name==='testing'?'diagnostics':'testing';
    showAdvanced(target);byId(`${target}Tab`).focus();
  });
}
function closeHelp(){showPanel(previousHelpPanel);byId(`${previousHelpPanel}Tab`).focus();}
byId('closeHelp').addEventListener('click',closeHelp);
document.addEventListener('keydown',event=>{
  if(event.key==='Escape' && !byId('helpPanel').hidden){event.preventDefault();closeHelp();}
});
byId('copyChatgptInstructions').addEventListener('click',async()=>{
  const instructions=byId('chatgptInstructions'),output=byId('helpCopyStatus');
  try{await navigator.clipboard.writeText(instructions.value);output.textContent='Copied. Paste into your ChatGPT chat and send it.';}
  catch{instructions.focus();instructions.select();output.textContent='Clipboard unavailable. Instructions selected: press Ctrl+C to copy.';}
});
let errorNoticeKey='',errorNoticeTimer=null,errorNoticeTab=null,errorNoticeStarted=0;
let errorNoticeRelatedKeys=[];
const dismissedErrors=new Set();
const dismissalReady=browser.storage.local.get('relayDismissedErrors').then(state=>{
  for(const key of (Array.isArray(state.relayDismissedErrors)?state.relayDismissedErrors:[]).slice(-100))if(typeof key==='string')dismissedErrors.add(key);
}).catch(()=>{});
let dismissalWrite=Promise.resolve();
function persistDismissedErrors(){
  while(dismissedErrors.size>100)dismissedErrors.delete(dismissedErrors.values().next().value);
  const snapshot=[...dismissedErrors];
  dismissalWrite=dismissalWrite.catch(()=>{}).then(()=>browser.storage.local.set({relayDismissedErrors:snapshot}));
  return dismissalWrite;
}
// Persist opaque identities, not error text, prompts or credentials.
function errorIdentity(value){let a=2166136261,b=3339675911;for(const ch of value){a=Math.imul(a^ch.charCodeAt(0),16777619);b=Math.imul(b^ch.charCodeAt(0),2246822519);}return (a>>>0).toString(16)+(b>>>0).toString(16);}
async function dismissErrorNotice(){
  const keys=[errorNoticeKey,...errorNoticeRelatedKeys],tabId=errorNoticeTab;
  for(const key of keys)if(key)dismissedErrors.add(key);
  byId('errorNotice').hidden=true;clearTimeout(errorNoticeTimer);
  try{await persistDismissedErrors();}
  catch(error){byId('diagnosticAdvice').textContent='Dismissed for this popup, but could not save the dismissal: '+error.message;}
  if(tabId!==null){
    try{const result=await browser.tabs.sendMessage(tabId,{type:'RELAY_CLEAR_ERRORS'});if(!result?.ok)throw new Error(result?.error || 'Could not clear delivery errors');}
    catch(error){byId('diagnosticAdvice').textContent='Notice dismissed. Active delivery clearance was not confirmed: '+error.message;}
  }
}
function renderErrorNotice(status={},d={},tabId=null,error=''){
  const pending=d.errors?.pending || [],lastFailure=[...(status.activity || [])].reverse().find(item=>item.phase==='failed'),fault=error || (['error','failed'].includes(status.phase)?status.message:'') || lastFailure?.message;
  const scope=String(tabId??currentTabId??selectedPopupTab?.id??'unbound');
  const identity=raw=>scope+':'+errorIdentity(raw);
  // Historical task errors remain dismissed, but a recovered connection can
  // legitimately produce a new occurrence with the same wording later.
  if(!error&&!['error','failed'].includes(status.phase)&&[...dismissedErrors].some(key=>key.startsWith(scope+':connection:'))){
    for(const key of [...dismissedErrors])if(key.startsWith(scope+':connection:'))dismissedErrors.delete(key);
    void persistDismissedErrors().catch(()=>{});
  }
  if(!pending.length&&!fault){
    byId('errorNotice').hidden=true;clearTimeout(errorNoticeTimer);errorNoticeKey='';errorNoticeRelatedKeys=[];
    return;
  }
  const activityKey=lastFailure?identity('activity:'+lastFailure.time+':'+lastFailure.id):null;
  const key=pending.length?identity('delivery:'+pending.map(item=>item.id).sort().join(',')):lastFailure&&!error?activityKey:scope+':connection:'+errorIdentity(fault);
  errorNoticeRelatedKeys=pending.length?[
    ...(lastFailure&&pending.some(item=>item.id===lastFailure.id)?[activityKey]:[]),
    ...(['error','failed'].includes(status.phase)&&status.message?[scope+':connection:'+errorIdentity(status.message)]:[])
  ]:[];
  if(errorNoticeKey!==key){errorNoticeKey=key;errorNoticeStarted=pending[0]?.time || (!error&&lastFailure?Date.parse(lastFailure.time):0) || Date.now();clearTimeout(errorNoticeTimer);}
  errorNoticeTab=pending.length?tabId:null;
  byId('errorNotice').hidden=dismissedErrors.has(key);byId('errorNoticeTitle').textContent=pending.length?`${pending.length} failed ${pending.length===1?'delivery':'deliveries'}`:'Relay needs attention';
  byId('errorNoticeText').textContent=pending.length?pending.map(item=>item.message).join('\n'):fault;
  const manual=byId('manualErrorClear').checked;
  byId('errorClearMode').textContent=manual?'Manual clear · × removes the error from the active queue':'Auto-clear after 10 seconds · details remain in Activity';
  clearTimeout(errorNoticeTimer);
  if(!manual&&!dismissedErrors.has(key))errorNoticeTimer=setTimeout(()=>void dismissErrorNotice(),Math.max(0,10000-(Date.now()-errorNoticeStarted)));
}
byId('dismissError').addEventListener('click',()=>void dismissErrorNotice());
byId('manualErrorClear').addEventListener('change',async()=>{
  clearTimeout(errorNoticeTimer);const manualClear=byId('manualErrorClear').checked;
  try{
    await browser.storage.local.set({relayManualErrorClear:manualClear});
    const tabId=await locateTab();const result=await browser.tabs.sendMessage(tabId,{type:'RELAY_ERROR_POLICY',manualClear});
    if(result?.ok===false)throw new Error(result.error || 'Could not update error policy');
    await refresh();
  }catch(error){byId('diagnosticAdvice').textContent='Policy saved locally. The connected chat will load it when available. '+error.message;}
});
browser.storage.onChanged?.addListener((changes,area)=>{
  if(area==='local'&&(changes.relayConnectedTab||changes.relayGrokTarget||changes.relayGeminiTarget))diagnosticCheckedAt=0;
  if(area==='local'&&changes.relayManualErrorClear)byId('manualErrorClear').checked=changes.relayManualErrorClear.newValue===true;
  if(area==="local" && changes.executionSettings){
    try{savedExecution=Execution.validate(changes.executionSettings.newValue);showExecutionControls(savedExecution);}catch{}
  }
});
function showCustomFields(){
  for(const [id,show] of [["customModel",byId("model").value==="custom"],["customTimeout",byId("timeout").value==="custom"]]){
    byId(id).hidden=!show;document.querySelector(`label[for="${id}"]`).hidden=!show;
  }
}
byId("model").addEventListener("change",showCustomFields);
byId('quickModel').addEventListener('change',()=>{
  const show=byId('quickModel').value==='custom';byId('quickCustomModel').hidden=!show;document.querySelector('label[for="quickCustomModel"]').hidden=!show;
});
byId("timeout").addEventListener("change",showCustomFields);
const readExecution = () => Execution.validate({model:byId("model").value==="custom" ? byId("customModel").value.trim() : byId("model").value,
  reasoning:byId("reasoning").value,timeout_minutes:Number(byId("timeout").value==="custom" ? byId("customTimeout").value : byId("timeout").value)});
function showExecutionControls(settings) {
  const known=[...byId("model").options].some(o=>o.value===settings.model);
  byId("model").value=known?settings.model:"custom";
  byId("customModel").value=settings.model==="default"?"":settings.model;
  byId("reasoning").value=settings.reasoning;
  const preset=[5,10,20,30,60,120].includes(settings.timeout_minutes);
  byId("timeout").value=preset?String(settings.timeout_minutes):"custom";
  byId("customTimeout").value=settings.timeout_minutes;
  showCustomFields();
  byId("configuredExecution").textContent="Saved defaults — "+Execution.describe(settings);
  showQuickControls(settings);
}
function showQuickControls(settings) {
  byId('quickModel').replaceChildren(...[...byId('model').options].map(option=>option.cloneNode(true)));
  const known=[...byId('quickModel').options].some(option=>option.value===settings.model);
  byId('quickModel').value=known?settings.model:'custom';byId('quickCustomModel').value=settings.model==='default'?'':settings.model;
  byId('quickReasoning').value=settings.reasoning;
  const custom=byId('quickModel').value==='custom';byId('quickCustomModel').hidden=!custom;document.querySelector('label[for="quickCustomModel"]').hidden=!custom;
  const name=modelCatalog?.models.find(model=>model.id===settings.model)?.name || (settings.model==='default'?'Codex default':settings.model);
  byId('quickExecutionSummary').textContent=`${name} · ${settings.reasoning==='default'?'Default':Execution.LABELS[settings.reasoning] || settings.reasoning}`;
  byId('quickExecutionSummary').title=byId('quickExecutionSummary').textContent;
}
async function refreshModels(force=false) {
  const result=await browser.runtime.sendMessage({type:"BRIDGE_REQUEST",route:force?"/models?refresh=1":"/models",token:byId("token").value.trim()});
  if(!result?.ok || !Array.isArray(result.models)) throw new Error(result?.error || "Model catalog unavailable. Restart the updated bridge.");
  const selected=readExecution();
  modelCatalog=result;
  const picker=byId("model");
  picker.replaceChildren();
  for(const [value,label] of [["default","Codex default"],...result.models.filter(m=>!m.hidden).map(m=>[m.id,`${m.name} (${m.id})`]),["custom","Manual model ID…"]]){
    const option=document.createElement("option");option.value=value;option.textContent=label;picker.append(option);
  }
  showExecutionControls(selected);
  showQuickControls(savedExecution);
  byId("configuredExecution").textContent="Saved defaults — "+Execution.describe(savedExecution);
  byId("executionMessage").textContent=`Loaded ${result.models.length} models. Codex default: ${result.defaultModel}; thinking: ${result.defaultReasoning || "model default"}.`;
}
byId("refreshModels").addEventListener("click",async()=>{try{await refreshModels(true);}catch(error){byId("executionMessage").textContent=error.message;}});
byId("saveExecution").addEventListener("click",async()=>{
  try {await saveDefaults(readExecution(),'executionMessage');}catch(error){byId('executionMessage').textContent=error.message;}
});
async function saveDefaults(settings,output) {
    if(modelCatalog) Execution.resolve({...savedExecution,...settings},{},modelCatalog);
    const result=await browser.runtime.sendMessage({type:"BRIDGE_REQUEST",route:"/settings",method:"POST",token:byId("token").value.trim(),
      data:{action:"set_defaults",...settings,commandId:crypto.randomUUID(),issuedAt:Date.now()}});
    if(!result?.ok)throw new Error(result?.error || "Could not save bridge defaults");
    savedExecution=result.defaults;await browser.storage.local.set({executionSettings:savedExecution});
    byId("configuredExecution").textContent="Saved defaults — "+Execution.describe(savedExecution);
    showExecutionControls(savedExecution);
    byId(output).textContent="Saved for the next Codex job. Task headers take priority.";
}
byId('saveQuickExecution').addEventListener('click',async()=>{
  const button=byId('saveQuickExecution');button.disabled=true;
  try {
    const settings={model:byId('quickModel').value==='custom'?byId('quickCustomModel').value.trim():byId('quickModel').value,reasoning:byId('quickReasoning').value};
    Execution.validate({...savedExecution,...settings});await saveDefaults(settings,'quickExecutionMessage');
  }catch(error){byId('quickExecutionMessage').textContent=error.message;}
  finally{button.disabled=false;}
});
let currentTabId = null;
let remotePopupTabId=null,selectedPopupTab=null,pairingError='',remoteReadiness='ready',remotePopupProvider='grok',pairedGemini=null;
const remoteProviderFor=url=>/^https:\/\/gemini\.google\.com\//.test(url || '')?'gemini':'grok';
const remoteName=provider=>provider==='gemini'?'Gemini':'Grok';
const isRemoteURL=url=>/^https:\/\/(?:grok\.com|gemini\.google\.com)\//.test(url || '');
const remoteOrigin=provider=>provider==='gemini'?'https://gemini.google.com/*':'https://grok.com/*';
const chatURL = url => /^https:\/\/(chatgpt\.com|chat\.openai\.com|grok\.com|gemini\.google\.com)\//.test(url || "");
async function locateTab({connect=false} = {}) {
  if(!connect){
    const target=await browser.runtime.sendMessage({type:"RELAY_TARGET"});
    if(target?.ok){currentTabId=target.tabId;return target.tabId;}
    if(target && !target.unbound) throw new Error(target.error || "Connected ChatGPT tab unavailable");
  }
  const tabs = await browser.tabs.query({active: true, currentWindow: true});
  const tab = tabs[0];
  if (!tab || !chatURL(tab.url)) throw new Error("Select an open ChatGPT or Grok conversation tab first");
  currentTabId = tab.id;
  if(connect){
    const connected=await browser.runtime.sendMessage({type:"RELAY_CONNECT",tabId:tab.id});
    if(!connected?.ok) throw new Error(connected?.error || "Could not connect this ChatGPT tab");
  }
  return tab.id;
}
const setStatus = (message, state = "") => {
  byId("status").textContent = message;
  byId("dot").className = state;
};
const save = async () => {
  await browser.storage.local.set({bridgeToken: byId("token").value.trim(), initial: byId("initial").value, count: byId("count").value});
};
async function checkBridge({quiet = false} = {}) {
  try {
    if(!/^[a-f0-9]{48}$/.test(byId('token').value.trim()) && browser.runtime.connectNative){
      const connection=await browser.runtime.sendMessage({type:'RELAY_NATIVE_CONNECT'});
      if(!connection?.ok)throw new Error(connection?.error || 'Could not start the local bridge');
      byId('token').value=connection.token;
    }
    await save();
    const result = await browser.runtime.sendMessage({type: "BRIDGE_REQUEST", route: "/health", token: byId("token").value.trim()});
    if (!result.ok) throw new Error(result.error);
    byId("connection").textContent = `Connected · Working folder: ${result.projectDir}${result.imageInputVersion===1?'':' · Restart bridge to enable Codex images'}`;
    byId('bridgeConnection').textContent='Local connected';byId('bridgeConnection').dataset.tone='good';
    byId("accessMode").textContent = result.fullAccess ? "FULL PC ACCESS ENABLED · no CLI approval prompts" : "RESTRICTED · workspace-write";
    byId("accessMode").className = result.fullAccess ? "full-access" : "minor";
    if(result.executionSettingsVersion!==1) throw new Error("Restart the updated bridge (v0.10.2) to enable execution settings.");
    if(result.settingsCommandsVersion!==1) throw new Error("Restart the v0.10.2 Node bridge to enable persistent CODEX_SETTINGS commands.");
    if(result.defaults){savedExecution=Execution.validate(result.defaults);showExecutionControls(savedExecution);}
    if(!modelCatalog)void refreshModels().catch(error=>{byId("executionMessage").textContent=error.message;});
    if (!quiet) await refresh();
    return true;
  } catch (err) {
    byId("connection").textContent = err.message;
    byId('bridgeConnection').textContent='Local unavailable';byId('bridgeConnection').dataset.tone='error';
    if (!quiet) setStatus("Bridge disconnected", "error");
    return false;
  }
}
byId("check").addEventListener("click", () => checkBridge());
async function controlWake(save=false){
  try{
    const config=save?JSON.parse(byId('wakeConfig').value):undefined;
    const result=await browser.runtime.sendMessage({type:'RELAY_WAKE_CONTROL',...(save?{config}:{})});
    if(!result?.ok)throw Error(result?.error || 'Wake inspection unavailable');
    if(result.wake){byId('wakeConfig').value=JSON.stringify(result.wake.config,null,2);byId('wakeDiagnostics').textContent=JSON.stringify({wake:result.wake,transport:result.transport},null,2);}
  }catch(error){byId('wakeDiagnostics').textContent=error.message;}
}
async function controlGoal(save=false){
  try{
    const config=save?JSON.parse(byId('goalConfig').value):undefined;
    const result=await browser.runtime.sendMessage({type:'RELAY_GOAL_CONTROL',...(save?{config}:{})});
    if(!result?.ok)throw Error(result?.error || 'Goal inspection unavailable');
    byId('goalConfig').value=JSON.stringify({executionBudgets:result.goal.executionBudgets,reviewPolicy:result.goal.reviewPolicy},null,2);
    byId('goalDiagnostics').textContent=JSON.stringify({goal:result.goal,history:result.history || []},null,2);
  }catch(error){byId('goalDiagnostics').textContent=error.message;}
}
byId('newGoal').addEventListener('click',async()=>{
  try{const result=await browser.runtime.sendMessage({type:'RELAY_GOAL_CONTROL',newGoal:byId('newGoalText').value});if(!result?.ok)throw Error(result?.error || 'New goal unavailable');await controlGoal();}
  catch(error){byId('goalDiagnostics').textContent=error.message;}
});
byId('inspectGoal').addEventListener('click',()=>controlGoal());
byId('saveGoal').addEventListener('click',()=>controlGoal(true));
byId('inspectWake').addEventListener('click',()=>controlWake());
byId('saveWake').addEventListener('click',()=>controlWake(true));
byId("copyDiagnostics").addEventListener("click", async () => {
  const output = byId("diagnosticsResult");
  try {
    const tab=(await browser.tabs.query({active:true,currentWindow:true}))[0];
    if(!tab || !chatURL(tab.url))throw new Error('Open the ChatGPT or Grok tab you want to inspect first');
    const result = await browser.runtime.sendMessage({type:'RELAY_INSPECT_TAB',tabId:tab.id});
    if (!result?.ok) throw new Error(result?.error || "No page diagnostics returned");
    const content = JSON.stringify(result.snapshot, null, 2);
    await navigator.clipboard.writeText(content);
    output.textContent = `${['grok','gemini'].includes(result.snapshot.inspection.provider)?remoteName(result.snapshot.inspection.provider):'ChatGPT'} diagnostics copied from the selected tab. No message text or bridge token included.`;
  } catch (err) {
    output.textContent = `Copy failed: ${err.message}`;
  }
});
// Verify the actual Codex CLI invocation before attempting browser automation.
byId("testCodex").addEventListener("click", async () => {
  const output = byId("codexTestResult");
  const button = byId("testCodex");
  button.disabled = true;
  output.textContent = "Starting a real Codex CLI job…";
  try {
    const token = byId("token").value.trim();
    const request = (route, method = "GET", data = null) => browser.runtime.sendMessage({type: "BRIDGE_REQUEST", route, method, data, token});
    const started = await request("/run", "POST", {prompt: "Diagnostic only. Do not edit any files. Reply with CODEX RELAY READY."});
    if (!started?.ok) throw new Error(started?.error || "Could not start Codex");
    if (started.status === "error") throw new Error("Codex reported a startup error");
    const jobId = started.id;
    for (let elapsed = 0; ; elapsed += 2) {
      const result = await request(`/status?id=${encodeURIComponent(jobId)}&wait_ms=10000`);
      if (!result?.ok) throw new Error(result?.error || "Cannot retrieve Codex result");
      if (result.status === "done") {
        output.textContent = `Codex CLI OK: ${result.reply}`;
        return;
      }
      if (["error","cancelled","timeout"].includes(result.status)) throw new Error(result.error || `Codex ${result.status}`);
      byId("activeExecution").textContent=jobDescription(result);
      output.textContent = `Codex is working… ${Math.floor((result.elapsedMs || 0)/1000)}s`;
      await new Promise(resolve=>setTimeout(resolve,100));
    }
  } catch (error) {
    output.textContent = `Codex CLI FAILED: ${error.message}`;
  } finally {
    button.disabled = false;
  }
});
// Explicit diagnostic: asks Codex to create a unique file, independently
// of the ChatGPT chat watcher. Keep popup open while this button runs.
byId("testFile").addEventListener("click", async () => {
  const output = byId("fileTestResult"), button = byId("testFile");
  button.disabled = true;
  const filename = `relay-direct-test-${Date.now()}.txt`;
  output.textContent = `Creating ${filename}… keep popup open.`;
  try {
    const token = byId("token").value.trim();
    const request = (route, method = "GET", data = null) =>
      browser.runtime.sendMessage({type: "BRIDGE_REQUEST", route, method, data, token});
    const started = await request("/run", "POST", {prompt:
      `Create a new file named ${filename} in the current project folder. ` +
      `Write exactly: ChatGPT and Codex are connected. ` +
      `Read back the file and reply with its absolute path, contents and SUCCESS only if verified.`});
    if (!started?.ok) throw new Error(started?.error || "Could not start Codex");
    if (started.status === "error") throw new Error("Codex reported a startup error");
    for (let elapsed = 0; ; elapsed += 2) {
      const result = await request(`/status?id=${encodeURIComponent(started.id)}&wait_ms=10000`);
      if (!result?.ok) throw new Error(result?.error || "Cannot retrieve Codex result");
      if (result.status === "done") {
        output.textContent = `Codex result for ${filename}: ${result.reply}`;
        return;
      }
      byId("activeExecution").textContent=jobDescription(result);
      if (["error","cancelled","timeout"].includes(result.status))
        throw new Error(result.error || `Codex ${result.status}`);
      await new Promise(resolve=>setTimeout(resolve,100));
    }
  } catch (err) { output.textContent = `File test FAILED: ${err.message}`; }
  finally { button.disabled = false; }
});

// Watch mode attaches to the current conversation. Closing the popup does not
// stop it: the content script owns the job loop and keeps running in the tab.
async function startWatching({requestPermission=false}={}){
  diagnosticCheckedAt=0;
  try {
    if(requestPermission && isRemoteURL(selectedPopupTab?.url) && browser.permissions?.request){
      const provider=remoteProviderFor(selectedPopupTab.url),granted=await browser.permissions.request({origins:[remoteOrigin(provider)]});
      if(!granted)throw new Error(remoteName(provider)+' access was not granted. Click Allow & pair to retry.');
    }
    const active=(await browser.tabs.query({active:true,currentWindow:true}))[0];selectedPopupTab=active;
    if(isRemoteURL(active?.url)){
      remotePopupTabId=active.id;remotePopupProvider=remoteProviderFor(active.url);
      const name=remoteName(remotePopupProvider),prefix=remotePopupProvider.toUpperCase();
      byId('watch').textContent='Pair '+name;byId('stop').textContent='Unpair '+name;byId('setupCoordinator').disabled=true;byId('testGrok').disabled=true;
      if(browser.permissions?.contains && !await browser.permissions.contains({origins:[remoteOrigin(remotePopupProvider)]})){
        byId('watch').textContent='Allow & pair '+name;throw new Error('Firefox has not granted '+name+' site access. Click Allow & pair.');
      }
      pairingError='';setStatus('Pairing this '+name+' conversation…','active');
      const result=await browser.runtime.sendMessage({type:'RELAY_PAIR_'+prefix,tabId:active.id});
      if(!result?.ok)throw new Error(result?.error || 'Could not pair '+name);
      remoteReadiness=result.readiness || 'ready';
      byId('connection').textContent=name+' destination paired. The local Codex bridge connects from ChatGPT.';
      await refresh();return true;
    }
    if(browser.runtime.connectNative){
      const tabs=await browser.tabs.query({active:true,currentWindow:true});
      if(!chatURL(tabs[0]?.url))throw new Error('Select an open ChatGPT or Grok conversation tab first');
      setStatus('Starting local bridge…','active');
      const quick=await browser.runtime.sendMessage({type:'RELAY_QUICK_START',tabId:tabs[0].id});
      if(quick?.ok){
        byId('token').value=quick.token;
        if(!await checkBridge({quiet:true}))throw new Error(byId('connection').textContent);
        await refresh();return quick.ready===true;
      }
      // A valid token cannot fix a conversation claim/protocol/storage error.
      // Do not silently retry startup and replace the original failure.
      if(quick?.watchStartFailed)throw new Error(quick.error);
      if(!/^[a-f0-9]{48}$/.test(byId('token').value.trim()))throw new Error(quick?.error || 'Run Install One Click.cmd once, then reload the add-on.');
    }
    const tabId = await locateTab({connect:true});
    if (!(await checkBridge({quiet: true}))) throw new Error("Local bridge is not connected");
    const token = byId("token").value.trim();
    const maxExchanges = Number(byId("count").value);
    const result = await browser.tabs.sendMessage(tabId, {type: "RELAY_WATCH_START", token, maxExchanges});
    if (!result?.ok) throw new Error(result?.error || "Watch could not start");
    await refresh();
    return result.ready===true;
  } catch (err) { if(remotePopupTabId!==null)pairingError=err.message;setStatus(err.message, "error");byId('details').textContent=err.message;return false; }
}
byId("watch").addEventListener("click",()=>startWatching({requestPermission:true}));
byId('testGrok').addEventListener('click',async()=>{
  const button=byId('testGrok'),output=byId('grokTestResult');button.disabled=true;
  try{
    const active=(await browser.tabs.query({active:true,currentWindow:true}))[0];
    if(!/^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(active?.url || ''))throw new Error('Open the intended ChatGPT conversation to run the round-trip test');
    output.textContent='Connecting this ChatGPT conversation…';
    if(!await startWatching())throw new Error(byId('status').textContent);
    const check=await browser.runtime.sendMessage({type:'RELAY_CONNECTIONS'});
    if(!check?.ok)throw new Error(check?.error || 'Could not check both connections');
    if(check.connections.grok.state!=='paired')throw new Error('Grok is '+check.connections.grok.state+'. Pair the intended Grok conversation first.');
    const result=await browser.tabs.sendMessage(active.id,{type:'RELAY_GROK_TEST'});
    if(!result?.ok)throw new Error(result?.error || 'Could not queue the Grok test');
    output.textContent='Test queued: ChatGPT → Grok → ChatGPT. Expect GROK_RESULT with GROK BRIDGE TEST OK. No Codex job is started; you can close this popup.';
  }catch(error){output.textContent='Test could not start: '+error.message;}
  finally{button.disabled=false;}
});
byId('setupCoordinator').addEventListener('click',async()=>{
  const button=byId('setupCoordinator'),output=byId('coordinatorSetupResult');button.disabled=true;
  try{
    const tabId=await locateTab();output.textContent='Sending coordination instructions…';
    const result=await browser.tabs.sendMessage(tabId,{type:'RELAY_COORDINATOR_SETUP'});
    if(!result?.ok)throw new Error(result?.error || 'Could not send coordination instructions');
    output.textContent='ChatGPT is ready to coordinate. Ask it for your task normally.';
  }catch(error){output.textContent=error.message;}
  finally{button.disabled=false;}
});
byId("start").addEventListener("click", async () => {
  try {
    const tabId = await locateTab({connect:true});
    if (!(await checkBridge({quiet: true}))) throw new Error("Local bridge is not connected");
    const maxExchanges = Number(byId("count").value);
    const initial = byId("initial").value;
    const token = byId("token").value.trim();
    const result = await browser.tabs.sendMessage(tabId, {type: "RELAY_START", token, initial, maxExchanges});
    if (!result?.ok) throw new Error(result?.error || "Start failed");
    await refresh();
  } catch (err) { setStatus(err.message, "error"); }
});
byId("stop").addEventListener("click", async () => {
  try {
    if(remotePopupTabId!==null){
      const result=await browser.runtime.sendMessage({type:'RELAY_UNPAIR_'+remotePopupProvider.toUpperCase(),tabId:remotePopupTabId});
      if(!result?.ok)throw new Error(result?.error || 'Could not unpair '+remoteName(remotePopupProvider));
      pairingError='';await refresh();return;
    }
    const tabId = await locateTab();
    await browser.tabs.sendMessage(tabId, {type: "RELAY_STOP"});
    setStatus("Stopped");
  } catch (err) { setStatus(err.message, "error"); }
});
const count = value => Number.isInteger(value)&&value>=0?value:null;
const numberLabel = value => value===null?'—':String(value);
function renderGeminiBar(target,lane,unavailable=false){
  const queued=count(lane?.queued) || 0,working=['running','stopping'].includes(lane?.state);
  const cooling=!!target&&Number.isFinite(lane?.cooldownUntil)&&lane.cooldownUntil>Date.now();
  const state=unavailable?'error':cooling?'cooldown':working?'running':queued?'queued':target?'idle':'unpaired';
  byId('geminiBar').dataset.state=state;
  byId('geminiState').textContent=unavailable?'Unavailable':(cooling?'Cooling down · '+Math.ceil((lane.cooldownUntil-Date.now())/1000)+'s':working?lane.state==='stopping'?'Stopping':'Working':target?'Idle':'Not paired')+(queued?' · '+queued+' queued':'');
  byId('pairGemini').textContent=target?'Unpair':'Pair';
  byId('pairGemini').title=target?'Disconnect the paired Gemini conversation':'Pair an open Gemini conversation';
}
byId('pairGemini').addEventListener('click',async()=>{
  const button=byId('pairGemini'),output=byId('geminiPairResult');button.disabled=true;output.hidden=false;
  try{
    const target=(await browser.storage.local.get('relayGeminiTarget')).relayGeminiTarget;
    if(target){
      const result=await browser.runtime.sendMessage({type:'RELAY_UNPAIR_GEMINI',tabId:target.tabId});
      if(!result?.ok)throw Error(result?.error || 'Could not unpair Gemini');
      output.textContent='Gemini unpaired.';
    }else{
      if(browser.permissions?.request&&!await browser.permissions.request({origins:[remoteOrigin('gemini')]}))throw Error('Allow Gemini site access to pair it.');
      const tabs=(await browser.tabs.query({url:'https://gemini.google.com/*'})).filter(tab=>remoteProviderFor(tab.url)==='gemini'&&isRemoteURL(tab.url));
      if(!tabs.length){await browser.tabs.create({url:'https://gemini.google.com/app'});output.textContent='Sign in or open your Gemini conversation, then click the extension there to pair it.';return;}
      if(tabs.length>1){output.textContent='Open the Gemini conversation you want, then click the extension there to pair it.';return;}
      const result=await browser.runtime.sendMessage({type:'RELAY_PAIR_GEMINI',tabId:tabs[0].id});
      if(!result?.ok)throw Error(result?.error || 'Could not pair Gemini');
      output.textContent='Gemini paired. Ask ChatGPT to send a GEMINI_TASK.';
    }
    diagnosticCheckedAt=0;await refresh();output.hidden=true;
  }catch(error){output.textContent=error.message;}
  finally{button.disabled=false;}
});
function elapsedLabel(startedAt,job) {
  if(!Number.isFinite(startedAt)&&!Number.isFinite(job?.elapsedMs))return '';
  const ms=Math.max(0,job?.elapsedMs || 0,Number.isFinite(startedAt)?Date.now()-startedAt:0),seconds=Math.floor(ms/1000);
  return `${Math.floor(seconds/60)}m ${seconds%60}s elapsed`;
}
function renderWorkers(workers,{paired=false,unavailable=false}={}) {
  let queued=0,working=0,known=true,workingKnown=true;
  for(const name of ['codex','grok']){
    const lane=workers?.[name],waiting=count(lane?.queued);
    const raw=lane?.state;
    const state=unavailable?'error':raw==='running'||raw==='stopping'?raw:raw==='idle'?(waiting>0?'queued':name==='grok'&&!paired?'unpaired':'idle'):'unknown';
    const labels={running:'Working',stopping:'Stopping',queued:'Queued',idle:'Idle',unpaired:'Not paired',unknown:'Unavailable',error:'Unavailable'};
    const card=byId(name+'Card');card.dataset.state=state;
    byId(name+'State').textContent=labels[state];
    byId(name+'Queued').textContent=unavailable?'—':numberLabel(waiting);
    if(waiting===null||unavailable)known=false;else queued+=waiting;
    if(!['idle','running','stopping'].includes(raw)||unavailable)workingKnown=false;
    if(state==='running'||state==='stopping')working++;
    const job=lane?.jobExecution,e=job?.execution?.effective || job?.execution;
    const info=state==='running'||state==='stopping'?
      lane.kind==='settings'?'Updating defaults':name==='grok'?'Awaiting full response':e?`${e.modelName || e.model} · ${Execution.LABELS[e.reasoning] || e.reasoning || 'Default'}`:'Starting task':
      state==='queued'?'Waiting to start':state==='idle'?'Ready for a task':state==='unpaired'?'Pair from a Grok tab':'Waiting for live status';
    byId(name+'Info').textContent=info;byId(name+'Info').title=info;
    byId(name+'Elapsed').textContent=['running','stopping'].includes(state)?elapsedLabel(job?.startedAt || lane?.startedAt,job):'';
  }
  if(workers?.gemini){
    const waiting=count(workers.gemini.queued);if(waiting===null)known=false;else queued+=waiting;
    if(['running','stopping'].includes(workers.gemini.state))working++;
    if(!['idle','running','stopping'].includes(workers.gemini.state))workingKnown=false;
  }
  byId('queuedCount').textContent=known?String(count(workers?.queued) ?? queued):'—';
  byId('workingCount').textContent=workingKnown?String(working):'—';
  byId('resultsCount').textContent=unavailable?'—':numberLabel(count(workers?.results));
  const attention=count(workers?.attention) || 0;
  byId('deliveryAttention').hidden=!attention||unavailable;
  byId('deliveryAttention').textContent=`${attention} ${attention===1?'delivery needs':'deliveries need'} attention. See Advanced activity.`;
}
function renderPlan(plan){
  planSnapshot=plan;byId('jobPlan').hidden=!plan;
  if(!plan){renderPlan.lastKey=null;return;}
  const key=JSON.stringify([plan,selectedPlanJob,planControlBusy]);
  if(renderPlan.lastKey===key)return;
  renderPlan.lastKey=key;
  byId('planSummary').textContent=(plan.cancelled?'Cancelled':plan.paused?'Paused':plan.jobs.some(job=>job.state==='running')?'Working':plan.queued?'Ready':'Complete')+' · '+plan.queued+' queued';
  byId('planReason').textContent=plan.reason || plan.id+' · revision '+plan.revision;
  byId('pausePlan').disabled=planControlBusy||plan.paused||plan.cancelled;byId('resumePlan').disabled=planControlBusy||!plan.paused||plan.cancelled;byId('cancelPlan').disabled=planControlBusy||plan.cancelled||!plan.jobs.some(job=>['queued','running'].includes(job.state));
  byId('planJobs').replaceChildren(...plan.jobs.map(job=>{const row=document.createElement('li'),button=document.createElement('button');row.dataset.state=job.state;button.className='plan-job';button.textContent=(job.title || job.id)+' · '+job.target+' · '+job.state+(job.review?' · review':'');button.setAttribute('aria-pressed',String(selectedPlanJob===job.id));button.addEventListener('click',()=>{selectedPlanJob=job.id;renderPlan(planSnapshot);});row.append(button);return row;}));
  const job=plan.jobs.find(job=>job.id===selectedPlanJob);byId('planJobDetail').hidden=!job;
  if(!job)return;
  byId('planJobTitle').textContent=job.title || job.id;byId('planJobMeta').textContent=job.target+' · '+job.state+(job.review?' · review checkpoint':'');
  byId('planJobPrompt').textContent=job.prompt || 'Prompt details unavailable. Refresh the updated ChatGPT tab.';
  const queued=plan.jobs.filter(item=>item.state==='queued'),index=queued.findIndex(item=>item.id===job.id),editable=job.state==='queued'&&!plan.cancelled&&!planControlBusy;
  byId('planRemoveJob').disabled=!editable;byId('planMoveUp').disabled=!editable||index<=0;byId('planMoveDown').disabled=!editable||index<0||index===queued.length-1;
}
async function changePlan(action,extra={}){
  if(planControlBusy)return;
  const snapshot=planSnapshot;if(!snapshot)return;
  planControlBusy=true;renderPlan(snapshot);
  try{
    const tabId=await locateTab(),result=await browser.tabs.sendMessage(tabId,{type:'RELAY_PLAN_CONTROL',action,planId:snapshot.id,revision:snapshot.revision,...extra});
    if(!result?.ok)throw Error(result?.error || 'Plan control failed');byId('planControlResult').textContent='';byId('jobsActionResult').textContent=action==='remove'?'Queued job deleted.':action==='reorder'?'Queue order updated.':'';await refresh();
  }catch(error){byId('planControlResult').textContent=error.message;byId('jobsActionResult').textContent=error.message;await refresh();}
  finally{planControlBusy=false;renderPlan(planSnapshot);renderJobs();}
}
for(const action of ['pause','resume','cancel'])byId(action+'Plan').addEventListener('click',()=>changePlan(action));
byId('planRemoveJob').addEventListener('click',()=>changePlan('remove',{jobIds:[selectedPlanJob]}));
for(const [id,direction] of [['planMoveUp',-1],['planMoveDown',1]])byId(id).addEventListener('click',()=>{
  const ids=(planSnapshot?.jobs || []).filter(job=>job.state==='queued').map(job=>job.id),index=ids.indexOf(selectedPlanJob),next=index+direction;
  if(index<0||next<0||next>=ids.length)return;
  [ids[index],ids[next]]=[ids[next],ids[index]];void changePlan('reorder',{jobIds:ids});
});
function renderTotals(status) {
  byId('totals').replaceChildren(...['completed','failed','cancelled'].filter(name=>name!=='cancelled'||status.cancelled).map(name=>{
    const item=document.createElement('button');item.type='button';item.className=name;item.textContent=(count(status[name]) || 0)+' '+name;item.title='Show '+(name==='completed'?'passed':name)+' jobs';item.addEventListener('click',()=>{openJobs(name==='completed'?'passed':name);});return item;
  }));
}
function renderListener(d,running) {
  const badge=byId('listenerBadge');
  badge.textContent=!running?'Listener idle':d.generating?'Reply streaming':d.listener?.unread?'Reading reply':'Listening';
  badge.dataset.tone=!running?'':d.listener?.unread||d.generating?'warning':'good';
}
let diagnosticConnections=null,diagnosticConnectionError='',diagnosticCheckedAt=0,diagnosticFlight=null;
const readable=value=>value===null||value===undefined||value===''?'Not reported':String(value).replace(/[-_]/g,' ').replace(/^\w/,c=>c.toUpperCase());
const yesNo=value=>value===true?'Yes':value===false?'No':'Not reported';
function diagnosticTime(value){const date=new Date(value);return value && Number.isFinite(date.getTime())?new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/London',timeStyle:'medium'}).format(date):'Not reported';}
function diagnosticCard(title,rows){
  const card=document.createElement('section');card.className='diagnostic-card';
  const heading=document.createElement('h3');heading.textContent=title;const list=document.createElement('dl');
  for(const [label,value,tone] of rows){const row=document.createElement('div'),term=document.createElement('dt'),detail=document.createElement('dd');term.textContent=label;detail.textContent=value??'Not reported';if(tone)detail.dataset.tone=tone;row.append(term,detail);list.append(row);}
  card.append(heading,list);return card;
}
function diagnosticExplanation(status,d,unavailable){
  const reason=d.watcher?.reason || d.responseCompletion?.reason,workers=status.workers || d.workers;
  if(unavailable)return ['Live status unavailable',unavailable+' Reopen the intended conversation, refresh it and check the local bridge.','error'];
  if(['error','failed'].includes(status.phase))return ['Relay needs attention',status.message || 'Inspect connection status and the activity timeline below.','error'];
  if(['grok','gemini'].includes(d.provider))return [remoteName(d.provider)+' destination status',d.grokWorker?.active?'Handling a delegated request. The full response must finish before return.':'Use the connected ChatGPT tab to issue tasks and inspect its queues.','good'];
  if(status.phase==='reconnecting')return ['Reconnecting to the local bridge','Keep the connected chat open. Check the helper and connection details if recovery does not complete.','warning'];
  if(d.blockers?.authentication)return ['Codex authentication needs attention','The Codex queue is paused until the bridge token is corrected. Use Testing → Check local bridge, or update the token fallback in Diagnostics. Dismissing an error cannot repair authentication.','error'];
  if(!status.running)return ['Watch is not running','Select the intended ChatGPT conversation and click Connect & watch.','warning'];
  if(d.generating)return ['Waiting for ChatGPT to finish','The response is still generating. Nothing is dispatched until completion and the settling interval.','warning'];
  if(reason==='completion-unconfirmed')return ['Response completion not confirmed','Text is present, but the listener has not confirmed a finished response. Check completion evidence below; do not resend the task while it may still be generating.','warning'];
  if((workers?.results>0 || d.continuation?.some(item=>item.stage==='ready')) && d.composer?.hasDraft)return ['Outgoing message held by your draft','A result or listener message is ready. Send or clear your draft and attachments; the relay will preserve them.','warning'];
  if(workers?.attention>0)return ['A delivery needs attention','Check Send, image transfer and the activity timeline. An uncertain send is not repeated automatically.','error'];
  if(d.plan?.paused&&!d.plan.cancelled)return ['Job plan paused',d.plan.reason || 'Future plan jobs are held. Inspect or edit the remaining list, then resume when ready.','warning'];
  if(d.blockers?.codexDraining)return ['Waiting for Codex to stop','The previous Codex process is still finishing. Its next queued job starts after the bridge confirms the process has stopped.','warning'];
  if(d.listener?.unread)return ['Reading the latest reply','The listener has detected a reply that has not yet been acknowledged by its read checkpoint.','warning'];
  if(d.imageResolution?.state==='WAITING_FOR_SELECTED_IMAGE')return ['Waiting for the selected ChatGPT image','The generation card exists, but its image resource has not appeared yet. The relay is waiting on that same message; it will not substitute an older image.','warning'];
  if(/sett|quiet/.test(reason || ''))return ['Waiting for the reply to settle','The completion quiet interval must finish without new output before a task can be sent.','warning'];
  if(workers?.results>0)return ['Results waiting to return','The shared ChatGPT sender returns one result at a time when the composer is free. Check the Send and completion fields below.','warning'];
  if(['codex','grok'].some(name=>workers?.[name]?.state==='running'))return ['Agents are working','Codex and Grok have independent queues. New explicit tasks can queue while work continues.','good'];
  const explanations={
    'stale-plan-followup-ignored':['Old plan result kept separate','The result belongs to an earlier plan. It cannot automatically edit or resume the current plan.'],
    'cancelled-plan-followup-ignored':['Cancelled plan kept stopped','The listener ignored an automatic follow-up to cancelled plan work. Send a new human request to authorize a new plan.'],
    'listener-message-invalid-or-example':['Listener message ignored','Use one complete BRIDGE_MESSAGE block with 1–4,000 characters, outside the closed agent task. Quotes, examples and incomplete or mixed controls do not send a message.'],
    'no-explicit-codex-instruction':['Reply read — no task command','The reply was ordinary conversation. To run work, ask ChatGPT for a complete CODEX_TASK or GROK_TASK block.'],
    'no-new-human-message':['Waiting for the next eligible reply','The current reply has already been considered. Send a new request or use an explicit follow-up after an owned result.'],
    'already-processed-message':['Reply already handled','Duplicate prevention is working. This reply will not create another job.'],
    'coordination-limit-reached':['Human input needed','The eight-step linked-task limit has been reached. Send a new human request to continue.'],
    'cancelled-task-followup-ignored':['Cancelled task kept stopped','The listener ignored a follow-up to cancelled work. Send a new human request if you want new work.'],
    'relay-result-not-owned':['Result could not be matched','The result does not belong to this Watch session. Inspect the connected tab and activity before retrying.'],
    'uncertain-grok-submission-followup-ignored':['Check the Grok submission before retrying','The previous request may already have reached Grok. Automatic follow-ups were ignored to prevent duplicates. Inspect the paired conversation, then send a new human request.']
  };
  if(explanations[reason])return [...explanations[reason],['coordination-limit-reached','uncertain-grok-submission-followup-ignored'].includes(reason)?'warning':'good'];
  return ['Listening for the next command','No blocking condition is reported. Completed explicit task blocks are dispatched once.','good'];
}
async function renderDiagnosticStatus(status={},d={},tabId=null,unavailable=''){
  await dismissalReady;
  renderErrorNotice(status,d,tabId,unavailable);
  if(byId('advancedPanel').hidden || byId('diagnosticsPanel').hidden)return;
  if(!byId('advancedPanel').hidden && !byId('diagnosticsPanel').hidden && Date.now()-diagnosticCheckedAt>5000){
    if(!diagnosticFlight)diagnosticFlight=(async()=>{
      try{const result=await browser.runtime.sendMessage({type:'RELAY_CONNECTIONS'});if(!result?.ok)throw new Error(result?.error || 'Connection check unavailable');diagnosticConnections=result.connections;diagnosticConnectionError='';}
      catch(error){diagnosticConnections=null;diagnosticConnectionError=error.message;}
      finally{diagnosticCheckedAt=Date.now();diagnosticFlight=null;}
    })();
    await diagnosticFlight;
  }
  const [headline,advice,tone]=diagnosticExplanation(status,d,unavailable);
  byId('diagnosticHeadline').textContent=headline;byId('diagnosticAdvice').textContent=advice;byId('diagnosticSummary').dataset.tone=tone;
  byId('diagnosticUpdated').textContent=unavailable?'Live snapshot unavailable · previous technical details may be stale':`Updated ${diagnosticTime(Date.now())} London · live page status`;
  const host=byId('diagnosticCards');host.replaceChildren();
  const connectionRows=[['Inspecting',tabId===null?'No live tab':`${['grok','gemini'].includes(d.provider)?remoteName(d.provider)+' destination':'ChatGPT coordinator'} · tab ${tabId}`]];
  for(const [name,label] of [['chatgpt','ChatGPT'],['grok','Grok'],['gemini','Gemini']]){
    const info=diagnosticConnections?.[name];
    const state=info?.state,good=['watching','paired'].includes(state);
    connectionRows.push([label,info?`${readable(state)}${info.tabId!==undefined?' · tab '+info.tabId:''}\nEditor: ${yesNo(info.composerReady)}${info.phase?' · '+readable(info.phase):''}`:diagnosticConnectionError || 'Not checked; open Diagnostics to check both tabs',good?'good':state?'warning':'']);
  }
  connectionRows.push(['Checked',diagnosticCheckedAt?diagnosticTime(diagnosticCheckedAt)+' London · every 5 seconds while open':'Not checked'],['Last bridge check',byId('connection').textContent],['Access mode',byId('accessMode').textContent]);
  host.append(diagnosticCard('Connections & scope',connectionRows));
  if(unavailable){host.append(diagnosticCard('Live data',['Listener','Agent queues','Send state'].map(name=>[name,'Unavailable — do not assume the agents stopped','warning'])));return;}
  const completion=d.responseCompletion || d.grokCompletion || {},read=d.listener?.lastRead,composer=d.composer || {},workers=status.workers || d.workers;
  host.append(diagnosticCard('Listener & last reply',[
    ['Watch',`${readable(status.phase)}${d.startup?' · '+readable(d.startup.state)+' / '+readable(d.startup.stage):''}`],
    ['Detected',`${d.userCount??'—'} user · ${d.assistantCount??'—'} assistant messages\nLatest reply: ${d.lastAssistantChars??'—'} characters`],
    ['Last decision',readable(d.watcher?.reason)],['Last skipped',readable(d.watcher?.lastIgnored?.reason)],
    ['Unread reply',yesNo(d.listener?.unread),d.listener?.unread?'warning':''],
    ['Last read',read?`${diagnosticTime(read.readAt)} · ${readable(read.disposition)}\n${read.assistantKey || 'No fingerprint'}`:'No saved read checkpoint reported'],
    ['Recovered replies',d.listener?.recoveries??'Not reported'],['Tab ownership',d.attachment?`Tab ${d.attachment.tabId??'—'} · conversation verified: ${yesNo(d.attachment.conversationVerified)}`:'Not reported']
  ]));
  host.append(diagnosticCard('Response completion',[
    ['Generating',yesNo(d.generating),d.generating?'warning':''],['Finished proof',yesNo(completion.completionConfirmed)],
    ['Evidence',readable(completion.completionSource)],['Completion gate',readable(completion.reason)],
    ['Stop control',`Previously seen: ${yesNo(completion.stopSeen)}\nCurrent signal: ${readable(completion.generationSignal)}`],
    ['Quiet interval',`${completion.quietMs??'—'} / ${completion.requiredQuietMs??'—'} ms`],
    ['Page state',d.pageState?`${readable(d.pageState.visibility)} · focused: ${yesNo(d.pageState.focused)}`:'Not reported']
  ]));
  host.append(diagnosticCard('Composer & outgoing delivery',[
    ['Editor',`${yesNo(d.editorFound)}${composer.tag?' · '+composer.tag+' / '+(composer.kind || 'unknown'):''}`],
    ['Draft',`${yesNo(composer.hasDraft)} · ${composer.textLength??'—'} characters\n${readable(composer.reason)}`,composer.hasDraft?'warning':''],
    ['Send check',d.composerSend?`${readable(d.composerSend.stage)} · ${readable(d.composerSend.reason)}\nExpected ${d.composerSend.expectedChars??'—'} / actual ${d.composerSend.actualChars??'—'} characters`:'No send check reported yet'],
    ['Returning',numberLabel(count(workers?.results))],['Needs attention',numberLabel(count(workers?.attention)),workers?.attention?'error':''],
    ['Listener messages',d.continuation?.length?d.continuation.map(item=>`${readable(item.stage)} · linked step ${item.chainDepth??'—'}`).join('\n'):'No pending listener message reported'],
    ['Images',d.mediaTransfer?`${readable(d.mediaTransfer.stage)} · ${d.mediaTransfer.count??'—'} files`:'No image transfer reported'],
    ['Grok receipt',d.grokReceipt?`${readable(d.grokReceipt.stage)} · ${readable(d.grokReceipt.reason)}`:'No page receipt reported']
  ]));
  const submission=d.grokSubmission || d.taskTrace?.grokSubmission;
  const resolution=d.imageResolution || d.taskTrace?.imageResolution;
  if(resolution)host.append(diagnosticCard('ChatGPT reference image',[
    ['Task',resolution.taskId || 'Not reported'],['State',resolution.state],['Selection',readable(resolution.reason)],['Candidates',resolution.candidateCount??0],['Selected',resolution.selectedCount??0],
    ['Source type',(resolution.provenance || resolution.origins || []).map(readable).join(', ') || 'Not reported'],['Representation',(resolution.kinds || []).map(readable).join(', ') || 'Not reported'],
    ['Message keys',(resolution.messageKeys || []).join('\n') || 'Not reported'],['Read method',(resolution.methods || []).map(readable).join(', ') || 'Not read'],
    ['Bytes',resolution.bytes??'Not retrieved'],['Error',resolution.error || 'None reported'],['Stages',(resolution.events || []).map(event=>`${diagnosticTime(event.time)} · ${event.stage}`).join('\n') || 'No image requested']
  ]));
  if(submission)host.append(diagnosticCard((d.provider==='gemini'?'Gemini':d.taskTrace?.stage?.startsWith('gemini')?'Gemini':'Grok')+' combined submission',[
    ['Task ID',submission.id],['State',submission.status],['Current stage',submission.stage],
    ['Reference images',submission.inputImageCount??'Not reported'],['Posted images',submission.submittedImageCount??'Not verified'],
    ['Prompt length',`${submission.promptChars??'—'} characters`],['Send actions',submission.sendActions??0],
    ['Composer remounts',submission.composerReplacements??0],['Early sends blocked',submission.blockedEarlySubmissions??0],
    ['Stage log',(submission.events || []).map(event=>`${diagnosticTime(event.time)} · ${event.stage}`).join('\n')]
  ]));
  const agentRows=[];
  for(const name of ['codex','grok','gemini']){const lane=workers?.[name],job=lane?.jobExecution,e=job?.execution?.effective || job?.execution;
    agentRows.push([name==='codex'?'Codex':remoteName(name),lane?`${readable(lane.state)} · ${numberLabel(count(lane.queued))} queued${lane.kind?' · '+readable(lane.kind):''}${elapsedLabel(job?.startedAt || lane.startedAt,job)?'\n'+elapsedLabel(job?.startedAt || lane.startedAt,job):''}`:'No live queue data',lane?.state==='running'?'good':'']);
    if(e)agentRows.push(['Job settings',Execution.describe(e)]);
  }
  agentRows.push(['Job totals',`${status.completed??'—'} completed · ${status.failed??'—'} failed · ${status.cancelled??'—'} cancelled`]);
  if(d.taskTrace)agentRows.push(['Task integrity',`${d.taskTrace.taskChars??'—'} characters · ${readable(d.taskTrace.stage)}\nSHA-256: ${d.taskTrace.taskHash || 'Not reported'}`],['Timings',d.taskTrace.durations?Object.entries(d.taskTrace.durations).map(([key,value])=>`${readable(key)}: ${value} ms`).join('\n'):'Not reported']);
  if(d.taskTrace?.receivedImageCount)agentRows.push(['Codex images',`${d.taskTrace.cliImageCount??'—'} / ${d.taskTrace.receivedImageCount} attached to CLI\nSHA-256: ${d.taskTrace.cliImageHash || 'Not verified'}`]);
  host.append(diagnosticCard('Agents & task verification',agentRows));
  if(d.plan)host.append(diagnosticCard('Saved job plan',[
    ['Plan',`${d.plan.id} · revision ${d.plan.revision}`],['State',d.plan.cancelled?'Cancelled':d.plan.paused?'Paused':'Running in order'],
    ['Queued',String(d.plan.queued)],['Active jobs',d.plan.jobs.filter(job=>job.state==='running').map(job=>`${job.id} · ${job.target}`).join('\n') || 'None'],
    ['Hold reason',d.plan.reason || 'No plan hold'],['Next jobs',d.plan.jobs.filter(job=>job.state==='queued').slice(0,10).map(job=>`${job.id} · ${job.target}${job.review?' · review checkpoint':''}`).join('\n') || 'None']
  ]));
}
async function refresh() {
  try {
    void refreshRecovery();
    await loadJobsVisibility();
    const pairings=await browser.storage.local.get(['relayGrokTarget','relayGeminiTarget']),paired=pairings.relayGrokTarget;
    pairedGemini=pairings.relayGeminiTarget;renderGeminiBar(pairedGemini,agentSnapshot?.workers?.gemini);
    byId('grokConnection').textContent=paired ? 'Grok paired' : 'Grok not paired';
    byId('grokConnection').dataset.tone=paired?'good':'';
    byId('grokConnection').title=paired?'Keep the paired Grok conversation tab open':'Open the intended Grok conversation and click the extension to pair';
    byId('workers').hidden=remotePopupTabId!==null;
    byId('dashboard').hidden=remotePopupTabId!==null;
    byId('listenerBadge').hidden=remotePopupTabId!==null;
    byId('bridgeConnection').hidden=remotePopupTabId!==null;
    if(remotePopupTabId!==null){
      await restoreSavedJobs();
      const tab=await browser.tabs.get(remotePopupTabId),provider=remotePopupProvider,name=remoteName(provider),prefix=provider.toUpperCase();
      const target=provider==='gemini'?pairedGemini:paired,matches=target?.tabId===remotePopupTabId && target.chat===tab.url?.split(/[?#]/)[0];
      let receipt=null,remotePage=null;
      if(matches){
        try{remotePage=await browser.tabs.sendMessage(remotePopupTabId,{type:'RELAY_STATUS'});remoteReadiness=remotePage?.diagnostics?.editorFound?'ready':'waiting-for-editor';receipt=remotePage?.diagnostics?.grokReceipt;}
        catch{remoteReadiness='waiting-for-editor';}
      }
      setStatus(pairingError || (matches?prefix+' PAIRED':prefix+' NOT PAIRED'),pairingError?'error':matches?'active':'');
      byId('details').textContent=pairingError || (matches?remoteReadiness==='waiting-for-editor'?name+' is still paired. Waiting for its editor to return.':'This '+name+' conversation is paired. Keep it open, switch to ChatGPT and ask it for a task.':'Click Pair '+name+' to use this conversation.');
      if(matches && !pairingError)byId('details').textContent+=receipt?' Last relay request: '+receipt.stage+(receipt.reason?' ('+receipt.reason+')':'')+'.':' No relay request has reached this '+name+' page session yet. ChatGPT must be WATCHING and issue a '+prefix+'_TASK block.';
      await renderDiagnosticStatus(remotePage?.status || {},{...remotePage?.diagnostics,provider},remotePopupTabId,pairingError || (!remotePage?name+' page status is unavailable.':''));
      return;
    }
    const tabId = await locateTab();
    const result = await browser.tabs.sendMessage(tabId, {type: "RELAY_STATUS"});
    if (!result?.status) throw new Error('The connected tab did not return live relay status');
    const {phase, message, running} = result.status;
    agentSnapshot=result.status;jobsSnapshot={...result.status,diagnostics:result.diagnostics};jobsMode='live';renderJobs();renderAgentDetails();
    setStatus(phase.toUpperCase(), ["error","failed"].includes(phase) ? "error" : running ? "active" : "");
    byId('watchDetails').textContent=message || '';
    const workers=result.status.workers || result.diagnostics?.workers;
    renderWorkers(workers,{paired:!!paired});renderGeminiBar(pairedGemini,workers?.gemini);renderTotals(result.status);renderPlan(result.status.planDetails || result.status.plan || result.diagnostics?.plan);
    const isError=['error','failed','reconnecting','starting'].includes(phase);
    byId('details').textContent=isError?message || phase:!running?'Connect to start listening':result.diagnostics?.generating?'Waiting for the complete ChatGPT reply':
      result.diagnostics?.listener?.unread?'Checking the latest reply':
      (workers?.results || 0)>0?'Results waiting for ChatGPT':(workers?.codex?.queued || 0)+(workers?.grok?.queued || 0)+(workers?.gemini?.queued || 0)>0?'Queued tasks start as agents become available':'Ready for the next task';
    if(phase==='reconnecting'){byId('bridgeConnection').textContent='Reconnecting';byId('bridgeConnection').dataset.tone='warning';}
    byId("activeExecution").textContent=result.status.jobExecution?jobDescription(result.status.jobExecution):'No job settings reported yet';
    const lastResult=[...(result.status.activity || [])].reverse().find(item=>["success","failed","cancelled","control"].includes(item.phase));
    const outcome=lastResult?.controlStatus || lastResult?.phase.toUpperCase();
    byId('resultOutcome').hidden=!lastResult;byId('resultOutcome').textContent=outcome || '';
    byId('resultOutcome').dataset.tone=outcome==='SUCCESS'?'good':outcome==='FAILED'?'error':'warning';
    byId("lastResult").textContent=lastResult ? String(lastResult.message || '').slice(0,240) : "No task result yet";
    byId('lastResult').title=lastResult?.message || '';
    const log = byId("activity");
    log.replaceChildren();
    for (const item of [...(result.status.activity || [])].reverse()) {
      const li = document.createElement("li");
      const time = new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/London',dateStyle:'short',timeStyle:'medium'}).format(new Date(item.time));
      li.textContent = `${time} · ${item.phase.toUpperCase()} · ${item.task || item.id || 'Watcher'} — ${item.message}`;
      if(item.jobExecution) li.textContent += "\n"+jobDescription(item.jobExecution);
      if(item.taskText){const details=document.createElement("details"),summary=document.createElement("summary"),pre=document.createElement("pre");summary.textContent="Complete forwarded task (private local activity)";pre.textContent=item.taskText;pre.style.whiteSpace="pre-wrap";details.append(summary,pre);li.append(details);}
      log.append(li);
    }
    const d = result.diagnostics || {};
    renderListener(d,running);
    byId('diagnostics').textContent = `Detected messages — user: ${d.userCount ?? '?'}, assistant: ${d.assistantCount ?? '?'}; latest assistant: ${d.lastAssistantChars ?? '?'} characters; turns: ${d.turns ?? '?'}; rendered blocks: ${d.markdown ?? '?'}; editor: ${d.editorFound ? 'yes' : 'no'}; generating: ${d.generating ? 'yes' : 'no'}`;
    if(d.startup)byId('diagnostics').textContent+=`; Watch state: ${d.startup.state} / ${d.startup.stage}${d.startup.httpStatus?' (HTTP '+d.startup.httpStatus+')':''}${d.startup.error?' — '+d.startup.error:''}`;
    if(d.composerSend)byId('diagnostics').textContent+=`; Send check: ${d.composerSend.reason} / ${d.composerSend.stage}; expected ${d.composerSend.expectedChars}, actual ${d.composerSend.actualChars} characters`;
    if(d.taskTrace) byId("diagnostics").textContent += `; task integrity: ${d.taskTrace.taskChars} characters; SHA-256 ${d.taskTrace.taskHash}; stage ${d.taskTrace.stage}`;
    if(d.taskTrace?.durations)byId("diagnostics").textContent += `; timings (ms): ${JSON.stringify(d.taskTrace.durations)}`;
    if (d.watcher) byId('diagnostics').textContent += `; watcher: ${d.watcher.reason}; user identity: ${d.watcher.userIdentity}; assistant identity: ${d.watcher.assistantIdentity}`;
    if(d.listener)byId('diagnostics').textContent+=`; listener: ${d.listener.state}; last read: ${d.listener.lastRead?.assistantKey || 'none'} / ${d.listener.lastRead?.disposition || 'none'}; recovered: ${d.listener.recoveries || 0}`;
    if (d.watcher?.lastIgnored) {
      const why = d.watcher.lastIgnored.reason;
      byId('watchDetails').textContent += why === "no-explicit-codex-instruction" ?
        " Last reply skipped: no recognised relay command. Use CODEX_TASK for work, GROK_TASK / END_GROK_TASK for Grok, GEMINI_TASK / END_GEMINI_TASK for Gemini, or CODEX_SETTINGS for defaults." :
        ` Last reply skipped: ${why}.`;
    }
    if (d.attachment) byId('diagnostics').textContent += `; tab: ${d.attachment.tabId ?? 'unknown'}; conversation verified: ${d.attachment.conversationVerified ? 'yes' : 'unknown'}`;
    if (d.mediaTransfer) byId('diagnostics').textContent += `; images: ${d.mediaTransfer.count} (${d.mediaTransfer.stage})`;
    if (d.responseCompletion) byId('diagnostics').textContent += `; ${d.responseCompletion.provider} completion: ${d.responseCompletion.reason}; quiet: ${d.responseCompletion.quietMs}/${d.responseCompletion.requiredQuietMs} ms`;
    else if (d.grokCompletion) byId('diagnostics').textContent += `; Grok completion: ${d.grokCompletion.reason}; quiet: ${d.grokCompletion.quietMs}/${d.grokCompletion.requiredQuietMs} ms`;
    if (d.composer) {
      const c = d.composer;
      byId('diagnostics').textContent += `; composer: ${c.tag || 'none'} / ${c.kind || 'none'}; draft characters: ${c.textLength ?? 'unknown'}; draft: ${c.hasDraft === null ? 'unknown' : c.hasDraft ? 'yes' : 'no'} (${c.reason})`;
      if (c.selector) byId('diagnostics').textContent += `; selector: ${c.selector}`;
      if (c.hierarchy) byId('diagnostics').textContent += `; hierarchy: ${c.hierarchy.map(n => n.tag + (n.contenteditable !== 'absent' ? '[editable=' + n.contenteditable + ']' : '')).join(' ← ')}`;
      if (!c.found) byId('diagnostics').textContent += '; editor selection unresolved; see copied diagnostics';
    }
    await renderDiagnosticStatus(result.status,d,tabId);
  } catch (err) {await restoreSavedJobs();agentSnapshot=null;renderAgentDetails();setStatus("Connection needs attention","error");byId("details").textContent=err.message;renderWorkers(null,{unavailable:true});renderGeminiBar(pairedGemini,null,true);renderPlan(null);renderListener({},false);await renderDiagnosticStatus({}, {},null,err.message);}
}
function jobDescription(job) {
  const elapsed=Math.max(0,job.elapsedMs || (Date.now()-(job.startedAt || Date.now())));
  return Execution.describe(job.execution)+` | Elapsed: ${Math.floor(elapsed/60000)}m ${Math.floor(elapsed/1000)%60}s | Status: ${job.status || "running"}`+
    (job.terminationReason?` | Termination: ${job.terminationReason}`:"");
}
(async () => {
  const state = await browser.storage.local.get({bridgeToken: "", initial: byId("initial").value, count: "3",executionSettings:Execution.DEFAULTS,relayManualErrorClear:false,relayConnectedTab:null});
  currentTabId=state.relayConnectedTab?.tabId??null;
  byId('manualErrorClear').checked=state.relayManualErrorClear===true;
  try {savedExecution=Execution.validate(state.executionSettings);}catch(error){byId("executionMessage").textContent=error.message;}
  showExecutionControls(savedExecution);
  byId("token").value = state.bridgeToken;
  byId("initial").value = state.initial;
  byId("count").value = state.count;
  // Restore live status and automatically check reachability. A popup opening
  // again must never show stale "Bridge not checked" after an active run.
  const active=(await browser.tabs.query({active:true,currentWindow:true}))[0];
  selectedPopupTab=active;
  if(chatURL(active?.url) && (browser.runtime.connectNative || isRemoteURL(active?.url)))await startWatching();
  else{
    await refresh();
    if (state.bridgeToken) await checkBridge({quiet: true});
    else byId("connection").textContent = "Open a ChatGPT or Grok tab and click the AI Bridge icon to connect automatically.";
  }
  setInterval(refresh, 1200);
})();

byId('openOutputs').addEventListener('click',()=>browser.tabs.create({url:browser.runtime.getURL('outputs.html')}));
async function refreshAlerts(){try{const result=await browser.runtime.sendMessage({type:'ALERTS_SETTINGS'});if(!result?.ok)throw Error(result?.error || 'Reload the updated extension');byId('alertMode').value=result.mode;byId('alertPermission').textContent=result.granted?'Desktop notification permission granted.':'Permission absent. Use Enable alerts to allow desktop notifications.';byId('enableAlerts').hidden=result.granted;}catch(error){byId('alertPermission').textContent=error.message;}}
byId('alertMode').addEventListener('change',async()=>{await browser.runtime.sendMessage({type:'ALERTS_SETTINGS',mode:byId('alertMode').value});await refreshAlerts();});
byId('enableAlerts').addEventListener('click',async()=>{try{const granted=await browser.permissions.request({permissions:['notifications']});await refreshAlerts();if(!granted)byId('alertPermission').textContent='Permission denied. Alerts remain unavailable; you can enable them later.';}catch(error){byId('alertPermission').textContent=error.message;}});
void refreshAlerts();

async function showOutputsWarning(){const warning=(await browser.storage.local.get('relayOutputsWarning')).relayOutputsWarning;byId('outputsWarning').hidden=!warning;byId('outputsWarning').textContent=warning?.message || '';}
browser.storage.onChanged.addListener((changes,area)=>{if(area==='local'&&changes.relayOutputsWarning)void showOutputsWarning();});
void showOutputsWarning();

let dependencyEditKey='',dependencyEditJob=null;
async function loadDependencyEditor(job,plan){
  const key=job.key+':'+plan.revision;if(key===dependencyEditKey)return;dependencyEditKey=key;dependencyEditJob={id:job.id,revision:plan.revision,planId:plan.id};byId('dependencyAssetPreview').hidden=true;
  byId('dependencyReason').textContent=job.dependency?.reason || '';byId('jobDependencies').value=(job.dependsOn || []).join(', ');byId('jobInputs').value=job.inputs || 'all';byId('saveDependencies').disabled=!editableJob(job);byId('dependencyEditResult').textContent='';
  try{const tabId=await locateTab(),details=await browser.tabs.sendMessage(tabId,{type:'RELAY_PLAN_DETAILS',jobId:job.id});if(key!==dependencyEditKey)return;if(!details?.ok)throw Error(details?.error || 'Input details unavailable');const selected=new Set(job.outputIds || []),rows=(details.parents || []).flatMap(parent=>(parent.outputs || []).map(output=>({...output,parent:parent.id})));
    byId('dependencyOutputs').replaceChildren(...rows.map(row=>{const label=document.createElement('label'),check=document.createElement('input');check.type='checkbox';check.value=row.id;check.checked=selected.has(row.id);check.disabled=!editableJob(job)||!row.available;label.append(check,document.createTextNode(row.parent+' / '+row.name+' · '+(row.available?String(row.size)+' bytes':row.error || 'Unavailable')));if(row.available){const preview=document.createElement('button');preview.type='button';preview.className='dependency-preview';preview.textContent='Preview';preview.addEventListener('click',event=>{event.preventDefault();void previewDependencyOutput(plan.instanceId,row.parent,row.id);});label.append(preview);}return label;}));
    const detail=details.plan?.jobs[0];byId('dependencyPreview').textContent=(detail?.inputPreview || []).map(row=>row.name+' · '+row.type+' · '+row.size+' bytes').join('\n') || 'Inputs are frozen before dispatch. Text includes each prerequisite’s complete reply and code. All outputs excludes duplicate extracted code files.';
  }catch(error){byId('dependencyPreview').textContent=error.message;}
}
byId('saveDependencies').addEventListener('click',async()=>{
  const selected=dependencyEditJob;if(!selected)return;byId('saveDependencies').disabled=true;
  try{const inputs=byId('jobInputs').value,dependsOn=byId('jobDependencies').value.split(',').map(value=>value.trim()).filter(Boolean),outputIds=inputs==='selected'?[...byId('dependencyOutputs').querySelectorAll('input:checked')].map(input=>input.value):[],tabId=await locateTab();const result=await browser.tabs.sendMessage(tabId,{type:'RELAY_PLAN_CONTROL',action:'update',...selected,jobId:selected.id,job:{dependsOn,inputs,outputIds}});if(!result?.ok)throw Error(result?.error || 'Plan update failed');dependencyEditKey='';await refresh();byId('dependencyEditResult').textContent='Inputs updated. Accepted jobs are unchanged.';}
  catch(error){byId('dependencyEditResult').textContent=error.message;}finally{byId('saveDependencies').disabled=false;}
});
async function refreshRecovery(){
  try{const result=await browser.runtime.sendMessage({type:'RELAY_RECOVERY_STATUS'});if(!result?.ok)return;
    for(const provider of ['chatgpt','codex','grok','gemini']){const health=result.health?.[provider],bad=!!health&&!['ready','stopped','unpaired','not-configured'].includes(health.state),row=byId(provider+'Recovery');if(provider==='gemini'){row.hidden=!bad;row.textContent=health?.reason || '';byId('reconnectGemini').hidden=!bad;}else{row.hidden=!bad;row.querySelector('span').textContent=(provider==='chatgpt'?'ChatGPT':provider==='codex'?'Codex':'Grok')+': '+(health?.reason || '');}}
    byId('recoveryDiagnostics').textContent=Object.entries(result.health || {}).map(([provider,h])=>provider+': '+h.state+' — '+h.reason+'\nLast success: '+(h.lastSuccess?new Date(h.lastSuccess).toLocaleString():'None recorded')+'\nRecovery: '+(h.recoveryOutcome || 'None')+'\nLast check: '+new Date(h.checkedAt).toLocaleString()).join('\n\n');
  }catch{}
}
async function reconnectConnection(provider,tabId){
  byId('recoveryResult').textContent='Checking the saved conversation…';
  try{const result=await browser.runtime.sendMessage({type:'RELAY_RECONNECT',provider,...(tabId!==undefined?{tabId}:{})});if(!result?.ok)throw Error(result?.error || 'Reconnect failed');byId('recoveryChoices').replaceChildren();if(result.choose){byId('recoveryResult').textContent='Choose the saved conversation tab:';for(const tab of result.choose){const button=document.createElement('button');button.textContent=tab.title+' (tab '+tab.id+')';button.addEventListener('click',()=>void reconnectConnection(provider,tab.id));byId('recoveryChoices').append(button);}}else byId('recoveryResult').textContent=result.opening?'Saved conversation opened. Waiting for its listener.':'Connection recovered. Explicit Stop is preserved.';await refreshRecovery();await refresh();}
  catch(error){byId('recoveryResult').textContent=error.message;}
}
for(const button of document.querySelectorAll('[data-provider]'))button.addEventListener('click',()=>void reconnectConnection(button.dataset.provider));

async function previewDependencyOutput(planInstanceId,parentId,outputId){
  const key=dependencyEditKey,panel=byId('dependencyAssetPreview');panel.hidden=false;panel.textContent='Loading pinned output…';
  try{const result=await browser.runtime.sendMessage({type:'OUTPUTS_PLAN_PREVIEW',planInstanceId,parentId,outputId});if(key!==dependencyEditKey)return;if(!result?.ok)throw Error(result?.error || 'Preview unavailable');const row=result.output;panel.replaceChildren();const title=document.createElement('strong');title.textContent=parentId+' / '+row.name;panel.append(title);
    if(/^image\/(?:png|jpeg|webp|gif)$/.test(row.type)){const image=document.createElement('img');image.src=row.data;image.alt=row.name;image.style.maxWidth='100%';panel.append(image);}else if(RelayFiles.isText(row)){const pre=document.createElement('pre');pre.textContent=new TextDecoder().decode(RelayFiles.bytes(row));panel.append(pre);}else{const text=document.createElement('p');text.textContent=row.type+' · '+row.size+' bytes';panel.append(text);}
  }catch(error){panel.textContent=error.message;}
}
