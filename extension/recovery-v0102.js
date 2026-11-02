"use strict";
((root)=>{
  // Background-only health and deliberate recovery. This module never clicks Send.
  function create({browser,inspect,repair,transfer,resume,localHealth,alerts}){
    const keys={chatgpt:'relayConnectedTab',grok:'relayGrokTarget',gemini:'relayGeminiTarget'},flights=new Map(),repairs=new Set(),epochs=new Map(),reconnectFlights=new Map();let writes=Promise.resolve();
    const address=value=>{try{const u=new URL(value);return u.protocol==='https:'?u.origin+u.pathname:null;}catch{return null;}};
    const verified=(provider,url)=>provider==='chatgpt'?/^https:\/\/(?:chatgpt\.com|chat\.openai\.com)\/(?:c\/[^/]+|g\/[^/]+\/c\/[^/]+)\/?$/.test(url || ''):provider==='grok'?/^https:\/\/grok\.com\/(?:c|chat)\/[^/]+\/?$/.test(url || ''):/^https:\/\/gemini\.google\.com\/app\/[^/]+\/?$/.test(url || '');
    const missing=error=>/receiving end|no receiver|no handler|listener.*unavailable/i.test(error?.message || '');
    const timed=promise=>Promise.race([promise,new Promise((_,reject)=>{const t=setTimeout(()=>reject(Error('Connection check timed out')),6000);t.unref?.();promise.finally(()=>clearTimeout(t)).catch(()=>{});})]);
    function save(provider,binding,value){const work=async()=>{const saved=await browser.storage.local.get([keys[provider],'relayConnectionHealth'].filter(Boolean));if(provider!=='codex'&&JSON.stringify(saved[keys[provider]])!==JSON.stringify(binding))return value;const all=saved.relayConnectionHealth || {},prior=all[provider] || {};value={...prior,...value,checkedAt:Date.now(),chat:binding?.chat,tabId:binding?.tabId};if(value.state==='ready'){value.lastSuccess=Date.now();delete value.troubleSince;}else if(['unpaired','stopped','not-configured'].includes(value.state))delete value.troubleSince;else value.troubleSince=prior.chat===binding?.chat?prior.troubleSince || Date.now():Date.now();all[provider]=value;await browser.storage.local.set({relayConnectionHealth:all});if(value.troubleSince&&Date.now()-value.troubleSince>=30000)await alerts?.problem(binding?.chat || '',{id:'connection-'+provider+'-'+value.troubleSince},provider+' connection needs attention');return value;};const next=writes.catch(()=>{}).then(work);writes=next;return next;}
    async function check(provider,{allowRepair=false}={}){
      if(flights.has(provider))return flights.get(provider);
      const flight=(async()=>{
        if(provider==='codex'){const binding=(await browser.storage.local.get('relayConnectedTab')).relayConnectedTab;try{const local=await localHealth(false);return save(provider,binding,local?.configured===false?{state:'not-configured',reason:'Local bridge not configured'}:{state:'ready',reason:'Local bridge available'});}catch(error){return save(provider,binding,{state:'local-bridge-unavailable',reason:'Local bridge unavailable',detail:error.message});}}
        const binding=(await browser.storage.local.get(keys[provider]))[keys[provider]];if(!binding)return save(provider,binding,{state:'unpaired',reason:'Not connected'});
        let tab;try{tab=await browser.tabs.get(binding.tabId);}catch{return save(provider,binding,{state:'tab-closed',reason:'Saved tab is closed'});}
        if(address(tab.url)!==binding.chat)return save(provider,binding,{state:'conversation-changed',reason:'Tab changed conversation'});
        try{if(browser.permissions?.contains&&!await browser.permissions.contains({origins:[new URL(binding.chat).origin+'/*']}))return save(provider,binding,{state:'permission-missing',reason:'Site permission is missing'});}catch{}
        try{
          let page;try{page=await timed(browser.tabs.sendMessage(tab.id,{type:'RELAY_STATUS'}));}catch(error){
            if(!missing(error))throw error;
            const stamp=tab.id+':'+(epochs.get(tab.id) || 0);
            if(!allowRepair||!verified(provider,binding.chat)||repairs.has(stamp))return save(provider,binding,{state:'listener-missing',reason:'Page listener unavailable'});
            repairs.add(stamp);page=await repair(tab.id,binding.chat);await save(provider,binding,{recoveryOutcome:'Listener repaired once in the saved conversation',recoveredAt:Date.now()});
          }
          if(page?.version!=='0.11.0')return save(provider,binding,{state:'refresh-required',reason:'Refresh this tab after active work finishes'});
          if(provider==='chatgpt'&&!page.status?.running){const intent=(await browser.storage.local.get(['relayWatchIntent','aiBridgeWatch:'+binding.chat]));const wanted=intent.relayWatchIntent?.[binding.chat] ?? intent['aiBridgeWatch:'+binding.chat]?.watchIntended;
            if(wanted&&allowRepair){const restored=await resume(binding);if(restored?.ok===false)return save(provider,binding,{state:'watch-unavailable',reason:restored.error,recoveryOutcome:'Watch remains stopped; checkpoints retained'});}
            else if(!wanted)return save(provider,binding,{state:'stopped',reason:'Watch stopped by user'});else return save(provider,binding,{state:'watch-unavailable',reason:'Watch needs reconnection; saved checkpoint retained'});
          }
          return save(provider,binding,{state:'ready',reason:provider==='chatgpt'?'Connected':'Paired'});
        }catch(error){return save(provider,binding,{state:missing(error)?'listener-missing':'connection-unavailable',reason:missing(error)?'Page listener unavailable':error.message,recoveryOutcome:'Recovery did not send or repeat any job'});}
      })();flights.set(provider,flight);try{return await flight;}finally{flights.delete(provider);}
    }
    async function reconnect(provider,tabId){
      if(provider==='codex'){try{await localHealth(true);return {ok:true,health:await check('codex')};}catch(error){return {ok:false,error:error.message};}}
      if(!Object.hasOwn(keys,provider))throw Error('Unknown connection');
      const binding=(await browser.storage.local.get(keys[provider]))[keys[provider]];if(!binding||!verified(provider,binding.chat))throw Error('Open the intended conversation and pair it manually; no verified saved conversation address exists');
      // Reuse the original tab first. Never navigate it away from another conversation.
      let original;try{original=await browser.tabs.get(binding.tabId);}catch{}
      let selected=original&&address(original.url)===binding.chat?original:null;
      if(!selected){const matches=(await browser.tabs.query({})).filter(tab=>address(tab.url)===binding.chat);
        if(tabId!==undefined){selected=matches.find(tab=>tab.id===tabId);if(!selected)throw Error('Selected replacement no longer matches the saved conversation');}
        else if(matches.length>1)return {ok:true,choose:matches.map(tab=>({id:tab.id,title:tab.title || 'Saved conversation',url:binding.chat}))};
        else if(matches.length===1)selected=matches[0];
        else{const lock=(await browser.storage.local.get('relayRecoveryOpened')).relayRecoveryOpened || {};const prior=lock[provider];if(prior?.chat===binding.chat){try{const opened=await browser.tabs.get(prior.tabId);if(address(opened.url)===binding.chat)selected=opened;}catch{}if(!selected)delete lock[provider];}if(!selected){selected=await browser.tabs.create({url:binding.chat});lock[provider]={chat:binding.chat,tabId:selected.id};await browser.storage.local.set({relayRecoveryOpened:lock});}}
      }
      const replacement={tabId:selected.id,chat:binding.chat};await transfer(provider,binding,replacement);
      if(selected.status==='loading'){await save(provider,replacement,{state:'loading',reason:'Saved conversation is opening',recoveryOutcome:'Opened the exact saved address; waiting for its listener'});return {ok:true,opening:true};}
      // Explicit action may retry a listener repair, but still cannot change pages or permission.
      if(browser.permissions?.contains&&!await browser.permissions.contains({origins:[new URL(binding.chat).origin+'/*']}))throw Error('Allow this site in Firefox extension permissions, then reconnect');
      let page;try{page=await inspect(selected.id);}catch(error){if(!missing(error))throw error;await repair(selected.id,binding.chat);page=await inspect(selected.id);}
      if(provider==='chatgpt'){const wanted=(await browser.storage.local.get('relayWatchIntent')).relayWatchIntent?.[binding.chat];if(wanted!==false){const result=await resume(replacement);if(result?.ok===false)throw Error(result.error);}}
      await save(provider,replacement,{state:'ready',reason:'Connected',recoveryOutcome:'Reconnected to the saved conversation; recorded jobs reconciled without repeating Send',recoveredAt:Date.now()});return {ok:true,tabId:selected.id};
    }
    const all=()=>Promise.all(['chatgpt','grok','gemini','codex'].map(provider=>check(provider).catch(()=>{})));
    browser.tabs.onUpdated?.addListener((id,change)=>{if(change.status==='loading'){epochs.set(id,(epochs.get(id) || 0)+1);for(const stamp of repairs)if(stamp.startsWith(id+':'))repairs.delete(stamp);}if(change.status==='complete'||change.url)void (async()=>{for(const provider of Object.keys(keys)){const binding=(await browser.storage.local.get(keys[provider]))[keys[provider]];if(binding?.tabId===id)await check(provider,{allowRepair:change.status==='complete'});}})().catch(()=>{});});
    browser.tabs.onRemoved?.addListener(()=>{void all();});
    browser.alarms?.create('relay-connection-health',{periodInMinutes:1});browser.alarms?.onAlarm.addListener(alarm=>{if(alarm.name==='relay-connection-health')void all();});
    void all();
    return {check,all,verified,reconnect:(provider,tabId)=>{if(reconnectFlights.has(provider))return reconnectFlights.get(provider);const flight=reconnect(provider,tabId).catch(async error=>{const binding=(await browser.storage.local.get(keys[provider] || 'relayConnectedTab'))[keys[provider] || 'relayConnectedTab'];await save(provider,binding,{recoveryOutcome:'Reconnect failed: '+error.message,recoveredAt:Date.now()});throw error;}).finally(()=>reconnectFlights.delete(provider));reconnectFlights.set(provider,flight);return flight;}};
  }
  root.RelayRecovery={create};
})(globalThis);
