"use strict";
// Firefox event-page alarm, recreated on every background load (alarms are not
// durable across browser restarts). Durable request identity belongs to goal.wake.
(() => {
  function create({browser,owns}){
    const alarmName='relay-coordinator-wake';let flight;
    async function tick(){
      const saved=await browser.storage.local.get(['relayConnectedTab','relayWatchIntent','relayWakeDiagnostics']);
      const target=saved.relayConnectedTab;if(!target)return;
      const watch=(await browser.storage.local.get('aiBridgeWatch:'+target.chat))['aiBridgeWatch:'+target.chat],wake=watch?.goal?.wake;
      if(!wake)return;
      let outcome;
      try{
        if(saved.relayWatchIntent?.[target.chat]===false||!watch.watchIntended||watch.goal.stopped)outcome={suppressed:['stopped']};
        else if(!await owns(target))outcome={suppressed:['disconnected-or-unpaired']};
        else {
          const tab=await browser.tabs.get(target.tabId);
          if(tab.url?.split(/[?#]/)[0]!==target.chat)throw Error('conversation-changed');
          // Even when a request response is lost, retrying this event is safe:
          // the receiver reconciles the saved queue before considering a new ID.
          outcome=await browser.tabs.sendMessage(target.tabId,{type:'RELAY_COORDINATOR_WAKE',registrationId:wake.id,chat:target.chat});
          if(!outcome?.ok)outcome={suppressed:[outcome?.error || 'watch-unavailable']};
        }
      }catch(error){outcome={suppressed:['tab-or-listener-unavailable'],detail:error.message};}
      // Transport diagnostics are separate from page-owned watch checkpoints.
      await browser.storage.local.set({relayWakeDiagnostics:{chat:target.chat,checkedAt:Date.now(),...outcome}});
    }
    const run=()=>flight || (flight=tick().finally(()=>{flight=null;}));
    browser.alarms.onAlarm.addListener(alarm=>{if(alarm.name===alarmName)return run().catch(()=>{});});
    browser.alarms.create(alarmName,{periodInMinutes:0.5});
    void run().catch(()=>{});
    return {run};
  }
  globalThis.RelayCoordinatorWake={create};
  if(typeof module!=='undefined')module.exports=globalThis.RelayCoordinatorWake;
})();
