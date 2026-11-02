"use strict";
((root)=>{
  const secrets=value=>/\b(?:sk-[a-zA-Z0-9_-]{20,}|gh[pousr]_[a-zA-Z0-9]{20,}|AKIA[A-Z0-9]{16})\b|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:password|api[_ -]?key|access[_ -]?token)\s*[:=]\s*\S+/i.test(value);
  function create({browser,verifyCoordinator,readArtifact,releaseArtifact,queueJob,checkQueue,capabilities}){
    const store=root.RelayLibrary.create(),alerts=root.RelayAlerts.create(browser),files=root.RelayFiles;
    const privileged=sender=>sender?.url?.startsWith(browser.runtime.getURL(''))||!!browser.runtime.id&&sender?.id===browser.runtime.id&&!sender.tab;
    const containsSecrets=async text=>{const token=(await browser.storage.local.get('bridgeToken')).bridgeToken;return secrets(text)||!!token&&text.includes(token);};
    const textFile=(name,text)=>({name,type:files.mime(name)==='application/octet-stream'?'text/plain':files.mime(name),data:files.encode(new TextEncoder().encode(text),files.mime(name)==='application/octet-stream'?'text/plain':files.mime(name))});
    const outputId=(chat,jobId,kind,index)=>root.RelayLibrary.sha(new TextEncoder().encode(JSON.stringify([chat,jobId,kind,index])));
    async function archive(chat,job,{backfill=false}={}){
      const produced=[],pin=job.dependencyResult?{id:await root.RelayLibrary.sha(new TextEncoder().encode('plan-result|'+chat+'|'+job.planInstanceId+'|'+job.planJobId+'|'+(job.attempt || 0))),kind:'plan-result',chat,planInstanceId:job.planInstanceId,planJobId:job.planJobId,taskId:job.id,createdAt:Date.now()}:null;
      if(pin){const prior=await store.metadata(pin.id);if(prior?.ready)return {warnings:[],bundle:{id:pin.id,ready:true,outputs:prior.outputs || []}};}
      const metadata={chat,jobId:job.id,title:String(job.title || 'Agent output').slice(0,120),agent:job.agent,createdAt:job.createdAt || Date.now(),outcome:job.outcome || 'SUCCESS'},warnings=[];const priorWarning=(await browser.storage.local.get('relayOutputsWarning')).relayOutputsWarning;let savingPaused=priorWarning?.paused===true;
      const save=async(kind,index,name,file,error)=>{
        const id=await outputId(chat,job.id,kind,index);
        if(savingPaused&&file){error='Automatic saving is paused. Delete saved outputs to make room.';file=null;}
        try{if(file&&await containsSecrets(new TextDecoder().decode(files.bytes(file))))throw Error('Output contains credentials and was not archived');const saved=await store.put({...metadata,id,kind,name,error:error || null},file,pin);produced.push(saved);if(error&&!backfill&&!savingPaused&&!saved.available&&!saved.deleted)warnings.push(error);return saved.available || saved.deleted;}
        catch(failure){if(failure.name==='QuotaExceededError'||/library is full|storage.*full|quota/i.test(failure.message))savingPaused=true;warnings.push(failure.message);const row=await store.put({...metadata,id,kind,name,error:failure.message},null,pin).catch(()=>({...metadata,id,kind,name,available:false,error:failure.message}));produced.push(row);return false;}
      };
      if(job.replyError)await save('reply',0,'reply.txt',null,job.replyError);else if(job.reply)await save('reply',0,'reply.txt',textFile('reply.txt',job.reply));
      const blocks=Array.isArray(job.code)&&job.code.length?job.code:[...String(job.reply || '').matchAll(/```([a-zA-Z0-9_-]*)[^\n]*\n([\s\S]*?)```/g)].map(match=>({language:match[1],text:match[2]}));
      for(const [index,block] of blocks.entries()){if(typeof block.text!=='string')continue;const language=String(block.language || 'txt').toLowerCase(),ext=({javascript:'js',typescript:'ts',python:'py',bash:'sh',markdown:'md',csharp:'cs','c++':'cpp'})[language] || (/^[a-z0-9]{1,8}$/.test(language)?language:'txt');await save('code',index,'code-'+(index+1)+'.'+ext,textFile('code.'+ext,block.text));}
      for(const [index,image] of (job.images || []).entries())try{await save('image',index,image.name || 'image-'+(index+1)+'.png',root.RelayMedia.validate([image])[0]);}catch(error){await save('image',index,'image-'+(index+1),null,image.error || error.message);}
      for(const [index,item] of (job.files || []).entries()){
        try{let file;if(savingPaused)throw Error('Automatic saving is paused. Delete saved outputs to make room.');
          if(item.data)file=files.validate([item])[0];
          else if(item.artifactId)file=files.validate([await readArtifact(item.artifactId)])[0];
          else if(item.url){if(!root.RelayMedia.allowedURL(item.url,item.origin || ''))throw Error('File host is outside its producing provider');const response=await fetch(item.url,{credentials:'include',redirect:'follow',signal:AbortSignal.timeout(20000)});if(!root.RelayMedia.allowedURL(response.url || item.url,item.origin))throw Error('File download redirected outside its provider');file=await files.readResponse(response,item.name);}
          else throw Error(item.error || 'Output file bytes are unavailable');
          if(item.hash&&await root.RelayLibrary.sha(files.bytes(file))!==item.hash)throw Error('Exported file integrity check failed');
          await save('file',index,file.name || item.name,file);if(item.artifactId)await releaseArtifact?.(item.artifactId).catch(()=>{});
        }catch(error){await save('file',index,item.name || 'output-'+(index+1),null,error.message);if(item.artifactId)await releaseArtifact?.(item.artifactId).catch(()=>{});}
      }
      if(backfill&&job.outputImages)for(let i=0;i<job.outputImages;i++)await save('image',i,'Earlier image '+(i+1),null,'Image bytes were released before the library was installed');
      if(warnings.length){const prior=(await browser.storage.local.get('relayOutputsWarning')).relayOutputsWarning;const warning={message:warnings[0],paused:savingPaused,id:prior?.id || crypto.randomUUID()};await browser.storage.local.set({relayOutputsWarning:warning});await alerts.problem(chat,{id:'library-'+warning.id},'Outputs library could not save every output');}
      if(!backfill&&!job.isConversationReply)await alerts.job(chat,job);
      let bundle;if(pin){const outputs=produced.map(({id,name,kind,type,size,available,error})=>({id,name,kind,type,size,available,error}));await store.updateSnapshot(pin.id,{...pin,outputs,ready:true});bundle={id:pin.id,ready:true,outputs};}
      return {warnings,...(bundle?{bundle}:{})};
    }
    async function backfill(){const saved=await browser.storage.local.get(null);for(const snapshot of await store.snapshots())if(snapshot.kind!=='plan-result'&&snapshot.createdAt<Date.now()-600000&&!Object.values(saved).some(state=>state?.tasks?.some(task=>task.librarySnapshot===snapshot.id&&!task.outcome)))await store.release(snapshot.id);for(const [key,state] of Object.entries(saved))if(key.startsWith('aiBridgeWatch:'))for(const job of state.agentHistory || [])if(job.reply)await archive(key.slice('aiBridgeWatch:'.length),{...job,createdAt:job.endedAt || job.startedAt,outcome:job.status},{backfill:true});}
    async function queue(message){
      if(!['codex','grok','gemini'].includes(message.target)||typeof message.prompt!=='string'||!message.prompt.trim()||!Array.isArray(message.items)||!message.items.length||message.items.length>4||!/^[-a-zA-Z0-9]{16,80}$/.test(message.commandId || ''))throw Error('Choose up to four outputs, an agent and instructions');
      const connected=(await browser.storage.local.get('relayConnectedTab')).relayConnectedTab;if(!connected)throw Error('Connect ChatGPT Watch before queuing a job');
      const id=await root.RelayLibrary.sha(new TextEncoder().encode('library|'+connected.chat+'|'+message.commandId));
      const inputHash=await root.RelayLibrary.sha(new TextEncoder().encode(JSON.stringify([connected.chat,message.target,message.prompt,message.items])));
      const receipts=(await browser.storage.local.get('relayOutputQueueReceipts')).relayOutputQueueReceipts || {};if(receipts[id]){if(receipts[id]!==inputHash)throw Error('Queue request changed; start a new job');return {ok:true,id,duplicate:true};}
      const accepted=await checkQueue?.(connected,id);if(accepted?.queueHash){if(accepted.queueHash!==inputHash)throw Error('Queue request identity conflict');return {ok:true,id,duplicate:true};}
      let snapshot=await store.snapshot(id);const hadSnapshot=!!snapshot;
      if(snapshot&&snapshot.inputHash!==inputHash)throw Error('Queue request changed; start a new job');
      if(!snapshot){let prompt=message.prompt;const ids=[];
        for(const item of message.items){const row=await store.read(item.id);if(item.as==='text'){if(!files.isText(row))throw Error('This output cannot be inserted as readable text');prompt+='\n\n--- '+row.name+' ---\n'+new TextDecoder('utf-8',{fatal:true}).decode(files.bytes(row));}else if(item.as==='attachment')ids.push(row.id);else throw Error('Unknown output reuse mode');}
        if(prompt.length>(message.target==='codex'?128000:16000))throw Error('Instructions and selected text exceed this agent’s prompt limit; nothing was truncated');if(await containsSecrets(prompt))throw Error('Remove credentials from the instructions before sending');
        await store.freeze(id,ids,{inputHash,prompt,target:message.target,chat:connected.chat,createdAt:Date.now()});snapshot=await store.snapshot(id);
      }
      let attempted=false;try{const images=root.RelayMedia.validate(snapshot.assets.filter(row=>/^image\/(?:png|jpeg|webp|gif)$/.test(row.type))),attachments=files.validate(snapshot.assets.filter(row=>!/^image\/(?:png|jpeg|webp|gif)$/.test(row.type)));files.combined(images,attachments);
      if(message.target==='codex'&&accepted&&(attachments.length&&!accepted.supportsFiles||images.length&&!accepted.supportsImages))throw Error('Restart the updated local bridge and reconnect Watch to use these attachments; nothing was queued');
      if(snapshot.assets.length&&message.target!=='codex'){const support=await capabilities(message.target);if(support?.composerReady===false||attachments.length&&(!support?.fileInput||support.multiple===false&&snapshot.assets.length>1||[...images,...attachments].some(file=>!files.accepts({accept:support.accept},file))))throw Error('The paired agent does not currently accept one of these file types. Use readable text instead or choose another agent.');}
      attempted=true;const result=await queueJob(connected,{id,prompt:snapshot.prompt,target:snapshot.target,librarySnapshot:id,queueHash:inputHash,inputImageCount:images.length,inputFileCount:attachments.length});
      if(!result?.ok){if(!hadSnapshot)await store.release(id);throw Error(result?.error || 'The job could not be queued');}receipts[id]=inputHash;await browser.storage.local.set({relayOutputQueueReceipts:receipts});return result;
      }catch(error){/* A lost acknowledgement may already have queued the job. Retain its immutable snapshot for an idempotent retry. */if(!hadSnapshot&&!attempted)await store.release(id);throw error;}
    }
    async function prepare(chat,message){
      const saved=(await browser.storage.local.get('aiBridgeWatch:'+chat))['aiBridgeWatch:'+chat],plan=saved?.plan,job=plan?.jobs.find(item=>item.id===message.jobId);
      if(plan?.mode!=='dependencies'||plan.instanceId!==message.planInstanceId||!job||job.state!=='queued'||plan.paused||plan.cancelled)throw Error('The dependency plan changed before input preparation');
      const parents=(job.dependsOn || []).map(id=>plan.jobs.find(item=>item.id===id));if(parents.some(item=>!item||item.state!=='done'))throw Error('Prerequisites have not completed successfully');
      const selection=job.inputs || 'all',selected=new Set(job.outputIds || []),availableIds=new Set(),parts=[],attachments=[];
      if(selection!=='none')for(const parent of parents){const bundle=await store.metadata(parent.bundle?.id);if(!bundle||bundle.chat!==chat||bundle.planInstanceId!==plan.instanceId||bundle.planJobId!==parent.id||!bundle.ready)throw Error('Required outputs were not retained for '+parent.id+'; replace the prerequisite or choose other inputs');
        const outputs=bundle.outputs || [];outputs.forEach(row=>availableIds.add(row.id));const chosen=outputs.filter(row=>selection==='selected'?selected.has(row.id):selection==='all'?row.kind!=='code':selection==='text'?row.kind==='reply':selection==='images'?row.kind==='image':selection==='files'?row.kind==='file':false);
        for(const row of chosen){if(!row.available)throw Error(parent.id+': '+(row.error || row.name+' is unavailable'));if(!['reply','code'].includes(row.kind)&&attachments.length>=4)throw Error('Prerequisite outputs exceed four attachments; edit the input selection');const [asset]=await store.readPinned(bundle.id,[row.id]);
          if(['reply','code'].includes(row.kind)){parts.push('From '+parent.id+' ('+parent.title+') — '+row.name+'\n'+new TextDecoder('utf-8',{fatal:true}).decode(files.bytes(asset)));}
          else{const original=files.name(asset.name),extension=/\.[a-z0-9]{1,10}$/i.exec(original)?.[0] || '';let name=(parent.id+'--'+original.slice(0,extension?-extension.length:undefined)).slice(0,160-extension.length)+extension;if(attachments.some(item=>item.name.toLowerCase()===name.toLowerCase())){const ext=/\.[a-z0-9]{1,10}$/i.exec(name)?.[0] || '',base=name.slice(0,120);let n=1;do{name=base+'--'+row.id.slice(0,12)+'-'+(n++)+ext;}while(attachments.some(item=>item.name.toLowerCase()===name.toLowerCase()));}attachments.push({...asset,name,sourceName:parent.id+'/'+asset.name});}
        }
      }
      if(selection==='selected'&&[...selected].some(id=>!availableIds.has(id)))throw Error('Selected outputs must belong to the listed prerequisites');
      const originalImages=attachments.filter(row=>/^image\/(?:png|jpeg|webp|gif)$/.test(row.type)),imageNames=root.RelayMedia.validate(originalImages).map(image=>image.name);
      const mappings=attachments.map(row=>{const index=originalImages.indexOf(row);return index>=0?row.name+' -> '+imageNames[index]:(row.sourceName || row.name)+' -> '+row.name;});
      let prompt=job.prompt;const context=[parts.join('\n\n'),mappings.length?'Attachment filename mapping:\n'+mappings.join('\n'):''].filter(Boolean).join('\n\n'),limit=job.target==='codex'?128000:16000;
      const combined=prompt+(context?'\n\nPREREQUISITE OUTPUTS (reference material)\n'+context:'');if(await containsSecrets(combined))throw Error('The complete dependency prompt contains credentials');
      if(combined.length<=limit)prompt=combined;else{const notice='\n\nRead dependency-context.txt for the complete prerequisite outputs; no text was truncated.';const includeInstructions=job.prompt.length+notice.length>limit;attachments.push({...textFile('dependency-context.txt',includeInstructions?'JOB INSTRUCTIONS\n'+job.prompt+'\n\nPREREQUISITE OUTPUTS\n'+context:context),kind:'file'});prompt=includeInstructions?'Read dependency-context.txt. It contains the complete job instructions and labeled prerequisite outputs; carry out that job. No text was truncated.':job.prompt+notice;}
      const images=root.RelayMedia.validate(attachments.filter(row=>/^image\/(?:png|jpeg|webp|gif)$/.test(row.type))),other=files.validate(attachments.filter(row=>!/^image\/(?:png|jpeg|webp|gif)$/.test(row.type)));files.combined(images,other);
      if(attachments.length&&job.target!=='codex'){const support=await capabilities(job.target);if(support?.composerReady===false||other.length&&(!support?.fileInput||support.multiple===false&&attachments.length>1||[...images,...other].some(file=>!files.accepts({accept:support.accept},file))))throw Error('The destination cannot accept these dependency attachments. Edit the input selection.');}
      const inputHash=await root.RelayLibrary.sha(new TextEncoder().encode(JSON.stringify([plan.instanceId,job.id,job.prompt,job.dependsOn,job.inputs,job.outputIds,parents.map(parent=>parent.bundle?.id)])));
      const existing=await store.metadata(message.id);if(existing&&existing.inputHash!==inputHash){const live=(await browser.storage.local.get('aiBridgeWatch:'+chat))['aiBridgeWatch:'+chat]?.plan;if(live?.instanceId!==plan.instanceId||live.revision!==plan.revision||live.jobs.find(item=>item.id===job.id)?.state!=='queued')throw Error('Plan changed while preparing inputs');await store.release(message.id);}
      if(job.target==='codex'&&attachments.length&&checkQueue){const connected=(await browser.storage.local.get('relayConnectedTab')).relayConnectedTab;if(!connected||connected.chat!==chat)throw Error('Reconnect the coordinating conversation before preparing inputs');const support=await checkQueue(connected,message.id);if(other.length&&!support.supportsFiles||images.length&&!support.supportsImages)throw Error('The configured local bridge cannot receive these dependency attachments. Update it or edit the inputs.');}
      await store.freezeData(message.id,[...images,...other],{kind:'plan-input',chat,planInstanceId:plan.instanceId,planJobId:job.id,inputHash,prompt,createdAt:Date.now()});return {ok:true,id:message.id,prompt,inputHash,images:images.length,files:other.length,preview:[...images,...other].map(({name,type,size})=>({name,type,size}))};
    }
    void backfill().catch(()=>{});
    return {
      store,alerts,archive,
      handle:async(message,sender)=>{
        if(message.type==='OUTPUTS_GOAL_EVIDENCE'){
          const chat=await verifyCoordinator(sender),row=await store.read(message.id);
          if(row.chat!==chat||row.jobId!==message.taskId)throw Error('Evidence belongs to another job or conversation');
          if(!files.isText(row)||row.size>2000000)throw Error('Review requires a readable output of at most 2 MB');
          const text=new TextDecoder('utf-8',{fatal:true}).decode(files.bytes(row));
          return {ok:true,output:{id:row.id,jobId:row.jobId,hash:row.hash,name:row.name,kind:row.kind,text}};
        }
        if(message.type==='OUTPUTS_PLAN_PREPARE'){const chat=await verifyCoordinator(sender);if(!/^[a-f0-9]{64}$/.test(message.id || ''))throw Error('Invalid dependency input identity');return prepare(chat,message);}
        if(message.type==='OUTPUTS_PLAN_RELEASE'){const chat=await verifyCoordinator(sender,true);for(const snapshot of await store.snapshots())if(snapshot.chat===chat&&snapshot.planInstanceId===message.planInstanceId)await store.release(snapshot.id);return {ok:true};}
        if(message.type==='OUTPUTS_ARCHIVE'){const chat=await verifyCoordinator(sender);if(!message.job||!/^[a-f0-9]{64}$/.test(message.job.id || '')||!['codex','grok','gemini','chatgpt'].includes(message.job.agent))throw Error('Invalid archived job');const job={...message.job};if(job.dependencyResult){const saved=(await browser.storage.local.get('aiBridgeWatch:'+chat))['aiBridgeWatch:'+chat],plan=saved?.plan;if(plan?.mode!=='dependencies'||plan.instanceId!==job.planInstanceId||!plan.jobs.some(item=>item.id===job.planJobId&&item.taskId===job.id))throw Error('Result bundle does not belong to this plan execution');let context=job.reply || '';for(const block of job.code || [])if(!context.includes(block.text))context+='\n\nCode ('+(block.language || 'text')+'):\n'+block.text;job.reply=context;}if(await containsSecrets(job.title || ''))job.title='Agent output';if(await containsSecrets(job.reply || '')){if(job.dependencyResult)job.replyError='The complete prerequisite reply contains credentials and could not be retained';job.reply='[Output contains credentials and was not archived]';}return {ok:true,...await archive(chat,job)};}
        if(message.type==='OUTPUTS_SNAPSHOT'){const chat=await verifyCoordinator(sender);const snapshot=await store.snapshot(message.id);if(!snapshot||snapshot.chat!==chat)throw Error('Queued output snapshot is unavailable');return {ok:true,prompt:snapshot.prompt,inputHash:snapshot.inputHash,images:root.RelayMedia.validate(snapshot.assets.filter(row=>/^image\/(?:png|jpeg|webp|gif)$/.test(row.type))),files:files.validate(snapshot.assets.filter(row=>!/^image\/(?:png|jpeg|webp|gif)$/.test(row.type)))};}
        if(message.type==='OUTPUTS_RELEASE'){const chat=await verifyCoordinator(sender,true);const snapshot=await store.snapshot(message.id);if(snapshot&&snapshot.chat!==chat)throw Error('Queued output belongs to another conversation');const before=await store.stats();await store.release(message.id);if((await store.stats()).bytes<before.bytes)await browser.storage.local.set({relayOutputsWarning:null});return {ok:true};}
        if(!privileged(sender))throw Error('Outputs controls require the extension library page');
        if(message.type==='OUTPUTS_PLAN_PREVIEW'){const connected=(await browser.storage.local.get('relayConnectedTab')).relayConnectedTab;if(!connected)throw Error('Connect the intended conversation first');const plan=(await browser.storage.local.get('aiBridgeWatch:'+connected.chat))['aiBridgeWatch:'+connected.chat]?.plan,parent=plan?.jobs.find(job=>job.id===message.parentId);if(plan?.mode!=='dependencies'||plan.instanceId!==message.planInstanceId||!parent)throw Error('Dependency plan changed; refresh job details');const bundle=await store.metadata(parent.bundle?.id);if(!bundle||bundle.chat!==connected.chat||bundle.planInstanceId!==plan.instanceId||!bundle.outputs?.some(row=>row.id===message.outputId))throw Error('Output does not belong to this prerequisite');const [output]=await store.readPinned(bundle.id,[message.outputId]);return {ok:true,output};}
        if(message.type==='OUTPUTS_LIST')return {ok:true,rows:await store.list(),stats:await store.stats(),warning:(await browser.storage.local.get('relayOutputsWarning')).relayOutputsWarning || null};
        if(message.type==='OUTPUTS_READ')return {ok:true,output:await store.read(message.id)};
        if(message.type==='OUTPUTS_DELETE'){if(!Array.isArray(message.ids))throw Error('Select outputs to delete');const before=await store.stats();await store.remove(message.ids);const after=await store.stats(),warning=(await browser.storage.local.get('relayOutputsWarning')).relayOutputsWarning;if(!warning?.paused||after.bytes<before.bytes||after.bytes===0)await browser.storage.local.set({relayOutputsWarning:null});return {ok:true};}
        if(message.type==='OUTPUTS_BACKFILL'){await backfill();return {ok:true};}
        if(message.type==='OUTPUTS_QUEUE')return {ok:true,...await queue(message)};
        if(message.type==='OUTPUTS_JOB'){const chat=message.chat,jobId=message.id;if(!/^https:\/\/(?:chatgpt\.com|chat\.openai\.com)\//.test(chat || ''))throw Error('Invalid job conversation');const saved=(await browser.storage.local.get('aiBridgeWatch:'+chat))['aiBridgeWatch:'+chat] || {};return {ok:true,plan:saved.plan || null,job:(saved.agentHistory || []).find(row=>row.id===jobId) || (saved.tasks || []).find(row=>row.id===jobId) || null};}
        if(message.type==='ALERTS_SETTINGS'){if(message.mode)await alerts.setMode(message.mode);return {ok:true,...await alerts.settings()};}
        throw Error('Unknown outputs command');
      }
    };
  }
  root.RelayOutputs={create};
})(globalThis);
