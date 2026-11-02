"use strict";
((root)=>{
  function create(browser){
    let chain=Promise.resolve(),clickRegistered=false;
    const ensureClick=()=>{if(!clickRegistered&&browser.notifications?.onClicked){clickRegistered=true;browser.notifications.onClicked.addListener(async id=>{const rows=(await browser.storage.local.get('relayAlertReceipts')).relayAlertReceipts || {};const item=Object.values(rows).find(row=>row.id===id);if(item)await browser.tabs.create({url:browser.runtime.getURL('outputs.html')+(item.jobId.startsWith('library-')?'':'?view=job&chat='+encodeURIComponent(item.chat)+'&job='+encodeURIComponent(item.jobId))});});}};
    const serial=work=>{const next=chain.catch(()=>{}).then(work);chain=next;return next;};
    const settings=async()=>{ensureClick();let granted=false;try{granted=await browser.permissions.contains({permissions:['notifications']});}catch{}return {mode:(await browser.storage.local.get('relayAlertMode')).relayAlertMode || 'plans-problems',granted};};
    const notify=async(key,{title,chat,jobId='',status})=>{
      const preferences=await settings();if(preferences.mode==='off'||!preferences.granted||!browser.notifications?.create)return;
      const receipts=(await browser.storage.local.get('relayAlertReceipts')).relayAlertReceipts || {};if(receipts[key])return;
      const id='ai-bridge-'+await root.RelayLibrary.sha(new TextEncoder().encode(key));
      receipts[key]={id,chat,jobId,title:String(title || 'Open details').slice(0,100),status,time:Date.now()};
      // Retain receipts: reopening and restarting never repeats an old alert.
      await browser.storage.local.set({relayAlertReceipts:receipts});
      try{await browser.notifications.create(id,{type:'basic',iconUrl:browser.runtime.getURL('icons/idle.svg'),title:'AI Bridge · '+status,message:receipts[key].title});}catch{}
    };
    ensureClick();
    const issueKey=(chat,job)=>chat+'|'+(job.planInstanceId || job.planId || '')+'|'+(job.planJobId || job.id || 'connection');
    return {
      settings,
      setMode:async mode=>{if(!['off','plans-problems','all-jobs'].includes(mode))throw Error('Unknown notification preference');await browser.storage.local.set({relayAlertMode:mode});return settings();},
      problem:(chat,job,title)=>serial(()=>notify('attention|'+issueKey(chat,job),{title,chat,jobId:job.id,status:'Needs attention'})),
      job:(chat,job)=>serial(async()=>{if(job.outcome&&job.outcome!=='SUCCESS'&&job.outcome!=='CANCELLED')await notify('attention|'+issueKey(chat,job),{title:job.title || 'Agent job failed',chat,jobId:job.id,status:'Needs attention'});else if(job.outcome==='SUCCESS'&&(await settings()).mode==='all-jobs')await notify('job|'+chat+'|'+job.id,{title:job.title,chat,jobId:job.id,status:'Job completed'});}),
      observe:(chat,state)=>serial(async()=>{
        const saved=await browser.storage.local.get(['relayAlertPlanStates','relayAlertConnections']);
        const seen=saved.relayAlertPlanStates || {},connections=saved.relayAlertConnections || {},plan=state.plan,key=plan?chat+'|'+(plan.instanceId || plan.id):'';
        if(plan){
          if(plan.mode==='dependencies')for(const blocked of plan.jobs?.filter(job=>job.dependency?.state==='blocked') || []){const source=plan.jobs.find(job=>job.id===blocked.dependency.root) || blocked;await notify('attention|'+issueKey(chat,{id:source.taskId || source.id,planInstanceId:plan.instanceId,planJobId:source.id}),{title:source.title || plan.id,chat,jobId:source.taskId || '',status:'Needs attention'});}
          const previous=seen[key],active=plan.jobs?.some(job=>['queued','running'].includes(job.state));if(active)seen[key]='active';
          const reviewing=plan.paused&&(!plan.reason||/^Review required/i.test(plan.reason)),failed=plan.paused&&!reviewing&&plan.jobs?.find(job=>job.state==='failed'),delivery=state.workers?.attention>0;
          if(failed||delivery){const job=failed || plan.jobs?.find(job=>job.taskId===state.activity?.at(-1)?.id) || {};await notify('attention|'+issueKey(chat,{id:job.taskId,planId:plan.id,planInstanceId:plan.instanceId,planJobId:job.id}),{title:job.title || plan.id,chat,jobId:job.taskId || '',status:'Needs attention'});}
          else if(reviewing&&state.ready&&!plan.cancelled){const job=plan.jobs?.filter(job=>job.state==='done').at(-1) || {};await notify('review|'+key+'|'+job.id,{title:job.title || plan.id,chat,jobId:job.taskId || '',status:'Review needed'});}
          else if(!plan.paused&&!plan.cancelled&&state.ready&&plan.jobs?.length&&plan.jobs.every(job=>!['queued','running'].includes(job.state))){if(previous==='active')await notify('plan|'+key,{title:plan.id,chat,status:'Plan completed'});seen[key]='complete';}
          await browser.storage.local.set({relayAlertPlanStates:seen});
        }
        if(!plan&&state.workers?.attention>0){const job=state.agentDetails?.jobs?.find(row=>row.delivery==='delivery-error');await notify('attention|'+issueKey(chat,{id:job?.id || 'delivery'}),{title:job?.title || 'Result delivery blocked',chat,jobId:job?.id || '',status:'Needs attention'});}
        if(state.phase==='delivery-blocked'&&state.blockedJob)await notify('attention|'+issueKey(chat,state.blockedJob),{title:state.blockedJob.title || 'Result delivery blocked',chat,jobId:state.blockedJob.id,status:'Needs attention'});
        if(['error','reconnecting'].includes(state.phase)){
          const item=connections[chat] ||= {since:Date.now(),id:crypto.randomUUID()};
          if(state.phase==='error'||Date.now()-item.since>=30000)await notify('connection|'+chat+'|'+item.id,{title:'Relay connection',chat,status:'Needs attention'});
        }else delete connections[chat];
        await browser.storage.local.set({relayAlertConnections:connections});
      })
    };
  }
  root.RelayAlerts={create};
})(globalThis);
