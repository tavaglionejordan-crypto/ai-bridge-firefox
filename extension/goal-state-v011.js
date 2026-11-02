"use strict";
// Durable goal ledger and conservative watchdog policy shared by the page and tests.
(() => {
  const VERSION = 1, MAX_EVENTS = 500;
  const clone = value => JSON.parse(JSON.stringify(value));
  const clean = value => typeof value === "string" ? value.slice(0, 20000) : "";
  function create(input = {}) {
    const now = new Date().toISOString();
    const criteria = (Array.isArray(input.acceptanceCriteria) ? input.acceptanceCriteria : []).slice(0, 100)
      .map((item, i) => ({id: clean(item.id) || "criterion-" + (i + 1), text: clean(typeof item === "string" ? item : item.text),
        status: "unverified", evidence: []}));
    return {schemaVersion: VERSION, id: clean(input.id) || (globalThis.crypto?.randomUUID?.() || "goal-" + Date.now()),
      originalGoal: clean(input.originalGoal), constraints: (input.constraints || []).map(clean).filter(Boolean).slice(0, 100),
      acceptanceCriteria: criteria, phase: clean(input.phase) || "planning", decisions: [], outstandingIssues: [],
      jobIds: [], artifactReferences: [], executionBudgets: {maxContinuations: 8, maxElapsedMs: 86400000, maxJobs: 100, maxRepairs: 5, ...(input.executionBudgets || {})},
      continuationIntent: null, stopped: false, paused: false, createdAt: now, updatedAt: now, events: []};
  }
  function event(goal, type, data = {}) {
    if (!goal || goal.schemaVersion !== VERSION) throw Error("Unsupported goal record");
    goal.events.push({at: new Date().toISOString(), type: clean(type), ...clone(data)});
    goal.events = goal.events.slice(-MAX_EVENTS); goal.updatedAt = new Date().toISOString(); return goal;
  }
  function transition(goal, phase, reason) {
    const from = goal.phase; goal.phase = clean(phase);
    return event(goal, "transition", {from, to: goal.phase, reason: clean(reason)});
  }
  function criterion(goal, id, status, evidence) {
    if (!["passed", "failed", "unverified", "blocked"].includes(status)) throw Error("Invalid criterion state");
    if (status === 'passed') throw Error('Use evidence-backed review to pass criteria');
    const item = goal.acceptanceCriteria.find(entry => entry.id === id);
    if (!item) throw Error("Unknown acceptance criterion");
    item.status = status; if (evidence) item.evidence.push(clean(evidence));
    return event(goal, "verification", {criterionId: id, status, evidence: clean(evidence)});
  }
  function recover(value) {
    if (!value) return null;
    if (value.schemaVersion !== VERSION) throw Error("Unsupported goal schema version");
    const goal = clone(value);
    if (!Array.isArray(goal.events) || !Array.isArray(goal.acceptanceCriteria)) throw Error("Invalid goal record");
    goal.events = goal.events.slice(-MAX_EVENTS); initialize(goal);
    return goal;
  }
  // Never infer a stall from generic idleness: only an explicit actionable intent advances.
  function watchdog(goal, context = {}) {
    if (!goal || goal.stopped || goal.paused || context.stopped || context.paused) return {action:"none",reason:"stopped-or-paused"};
    if (context.runningJob || context.uploading || context.generating || context.geminiCooldown || context.dependencyWait ||
        context.chatgptGenerating || context.uncertainSubmission || context.captureBusy || context.draft || context.delivering)
      return {action:"wait",reason:"legitimate-wait"};
    if (!goal.continuationIntent || !goal.continuationIntent.actionable) return {action:"none",reason:"no-actionable-intent"};
    if (budgetReason(goal,'turn',goal.continuationIntent.id,context)) return {action:'none',reason:'goal-budget-or-control'};
    if (goal.continuationIntent.issued) return {action:"none",reason:"intent-already-issued"};
    goal.continuationIntent.issued = true;
    event(goal, "continuation-issued", {intentId: goal.continuationIntent.id});
    return {action:"continue",intent:clone(goal.continuationIntent)};
  }
  const budgetDefaults={maxContinuations:8,maxElapsedMs:86400000,maxJobs:100,maxRepairs:5};
  const requireThat=(ok,message)=>{if(!ok)throw Error(message);};
  const identity=value=>typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}$/.test(value);
  function initialize(goal){
    goal.executionBudgets={...budgetDefaults,...goal.executionBudgets};
    goal.usage ||= {jobs:[],turns:[],repairs:{}};
    goal.reviewPolicy ||= {allowAIReview:false,allowRepairs:false,repairTargets:['codex']};
    goal.evidenceRecords ||= [];goal.reviewCommands ||= [];goal.phaseSummaries ||= [];goal.escalations ||= [];goal.receipts ||= [];goal.repairRecords ||= [];
    return goal;
  }
  function escalate(goal,reason,detail=''){
    initialize(goal);
    if(!goal.escalations.some(row=>row.reason===reason&&row.detail===detail)){
      goal.escalations.push({at:new Date().toISOString(),reason,detail:clean(detail)});
      event(goal,'escalation',{reason,detail:clean(detail)});
    }
    return reason;
  }
  // Only the privileged popup receiver calls configure, never a chat command.
  function configure(goal,input){
    initialize(goal);requireThat(input&&typeof input==='object'&&!Array.isArray(input),'Goal configuration requires an object');
    requireThat(Object.keys(input).every(key=>['executionBudgets','reviewPolicy'].includes(key)),'Unknown goal configuration');
    const budgets={...goal.executionBudgets,...input.executionBudgets},policy={...goal.reviewPolicy,...input.reviewPolicy};
    requireThat(Object.keys(budgets).every(key=>Object.hasOwn(budgetDefaults,key)),'Unknown execution budget');
    for(const [key,value] of Object.entries(budgets))requireThat(Number.isSafeInteger(value)&&value>=1&&value<=({maxContinuations:1000,maxElapsedMs:604800000,maxJobs:1000,maxRepairs:100})[key],'Invalid budget: '+key);
    requireThat(Object.keys(policy).every(key=>['allowAIReview','allowRepairs','repairTargets'].includes(key))&&typeof policy.allowAIReview==='boolean'&&typeof policy.allowRepairs==='boolean','Invalid review authority');
    requireThat(Array.isArray(policy.repairTargets)&&policy.repairTargets.length>0&&policy.repairTargets.every(target=>['codex','grok','gemini'].includes(target)),'Invalid repair targets');
    goal.executionBudgets=budgets;goal.reviewPolicy=policy;event(goal,'human-configuration',{budgets,policy});return goal;
  }
  function budgetReason(goal,kind,id,context={},now=Date.now()){
    initialize(goal);
    if(goal.stopped||goal.paused||context.stopped||context.paused||context.cancelled)return 'stopped-paused-or-cancelled';
    if(['complete','completed','cancelled'].includes(goal.phase))return 'goal-finished';
    if(context.authentication)return 'authentication-required';
    if(context.uncertain)return 'uncertain-external-submission';
    if(now-Date.parse(goal.createdAt)>=goal.executionBudgets.maxElapsedMs)return 'elapsed-time-budget';
    const list=kind==='job'?goal.usage.jobs:goal.usage.turns,limit=kind==='job'?goal.executionBudgets.maxJobs:goal.executionBudgets.maxContinuations;
    if(!list.includes(id)&&list.length>=limit)return kind==='job'?'job-count-budget':'coordinator-turn-budget';
    return null;
  }
  function admit(goal,kind,id,context={},now=Date.now()){
    requireThat(identity(id),'Invalid budget admission id');
    const reason=budgetReason(goal,kind,id,context,now);
    if(reason){escalate(goal,reason);return false;}
    const list=kind==='job'?goal.usage.jobs:goal.usage.turns;
    if(!list.includes(id)){list.push(id);event(goal,'budget-admission',{kind,id});}
    return true;
  }
  function inspect(goal,compact=false){
    initialize(goal);if(!compact)return clone(goal);
    return clone({id:goal.id,phase:goal.phase,originalGoal:goal.originalGoal.slice(0,2000),
      acceptanceCriteria:goal.acceptanceCriteria.map(row=>({...row,text:row.text.slice(0,400),review:row.review?{...row.review,reason:row.review.reason.slice(0,400)}:null})),
      executionBudgets:goal.executionBudgets,reviewPolicy:goal.reviewPolicy,
      usage:{jobs:goal.usage.jobs.length,turns:goal.usage.turns.length,repairs:goal.usage.repairs},
      evidenceRecords:goal.evidenceRecords.slice(-20).map(row=>({...row,excerpt:row.excerpt.slice(0,400)})),
      receipts:goal.receipts.slice(-20),repairRecords:goal.repairRecords.slice(-20),phaseSummaries:goal.phaseSummaries.slice(-5).map(row=>({...row,summary:row.summary.slice(0,800)})),
      escalations:goal.escalations.slice(-10).map(row=>({...row,detail:row.detail.slice(0,400)})),counts:{evidence:goal.evidenceRecords.length,receipts:goal.receipts.length,summaries:goal.phaseSummaries.length},inspection:'Recent records; full ledger in privileged goal diagnostics'});
  }
  // Resolved outputs come from the scoped library receiver, never command data.
  // Hashes prove byte identity. Explicit authorised review assesses their meaning.
  function operation(goal,plan,cmd,context={}){
    initialize(goal);const {operation:op,data={}}=cmd;
    requireThat(identity(cmd.id),'Invalid goal command id');
    const hash=JSON.stringify(cmd),prior=goal.reviewCommands.find(row=>row.id===cmd.id);
    if(prior){requireThat(prior.hash===hash,'Goal command id reused with different contents');return {goal,plan,duplicate:true};}
    requireThat(goal.reviewCommands.length<2000,'Goal review command ledger full');
    requireThat(data&&typeof data==='object'&&!Array.isArray(data),'Goal data must be an object');
    const fields={inspect:[],criteria:['criteria'],evidence:['id','taskId','outputId','excerpt','kind'],review:['criterionId','status','evidenceIds','reason'],complete:['summary'],summary:['summary','evidenceIds'],repair:['criterionId','reason','job','rewire'],checkpoint:['reason']};
    requireThat(Object.hasOwn(fields,op),'Unknown goal operation');
    requireThat(Object.keys(data).every(key=>fields[op].includes(key)),'Unknown goal operation field');
    if(!['inspect','summary'].includes(op))requireThat(!goal.stopped&&!goal.paused&&!context.cancelled,'Goal stopped, paused or cancelled');
    if(op==='criteria'){
      requireThat(goal.phase!=='complete','Completed goal is immutable');
      requireThat(Array.isArray(data.criteria)&&data.criteria.length>0&&goal.acceptanceCriteria.length+data.criteria.length<=100,'Supply 1-100 criteria');
      for(const item of data.criteria){requireThat(identity(item.id)&&typeof item.text==='string'&&item.text.trim()&&item.text.length<=2000,'Invalid criterion');requireThat(!goal.acceptanceCriteria.some(row=>row.id===item.id),'Criterion id already exists');goal.acceptanceCriteria.push({id:item.id,text:item.text,status:'unverified',evidence:[]});}
    }
    if(op==='evidence'){
      requireThat(identity(data.id)&&!goal.evidenceRecords.some(row=>row.id===data.id),'Evidence id must be new');
      requireThat(goal.evidenceRecords.length<500,'Evidence ledger full');
      const output=context.output,receipt=goal.receipts.find(row=>row.taskId===data.taskId);
      requireThat(receipt&&receipt.verified&&receipt.jobId,'Verified completed job receipt required');
      requireThat(output?.id===data.outputId&&output.jobId===data.taskId&&/^[a-f0-9]{64}$/.test(output.hash),'Output does not match receipt');
      requireThat(typeof data.excerpt==='string'&&data.excerpt.trim()&&data.excerpt.length<=12000&&typeof output.text==='string'&&output.text.includes(data.excerpt),'Exact output excerpt required');
      requireThat(['artifact','test-output'].includes(data.kind),'Evidence kind must be artifact or test-output');
      requireThat(!['reply','code'].includes(output.kind),'Agent replies and generated code are not verification outputs');
      let tests=null;
      if(data.kind==='test-output'){
        const count=key=>{const matches=[...output.text.matchAll(new RegExp('^# '+key+' (\\d+)\\s*$','gm'))];return matches.length===1?Number(matches[0][1]):null;};
        tests={total:count('tests'),passed:count('pass'),failed:count('fail'),cancelled:count('cancelled'),skipped:count('skipped'),todo:count('todo')};
        requireThat(Object.values(tests).every(value=>Number.isSafeInteger(value)&&value>=0)&&tests.total>0&&tests.total===tests.passed+tests.failed+tests.cancelled+tests.skipped+tests.todo,'Test output requires one complete TAP summary');
      }
      const record={id:data.id,taskId:receipt.taskId,jobId:receipt.jobId,outputId:output.id,hash:output.hash,name:output.name,kind:data.kind,tests,excerpt:data.excerpt,at:new Date().toISOString(),provenance:'archived-output; requires authorised AI review'};
      goal.evidenceRecords.push(record);goal.artifactReferences.push({outputId:record.outputId,hash:record.hash,jobId:record.jobId});
    }
    if(op==='review'){
      requireThat(goal.reviewPolicy.allowAIReview,'Insufficient authority: AI review is disabled');
      requireThat(!context.authentication&&!context.uncertain,'Authentication or uncertain submission requires escalation');
      const item=goal.acceptanceCriteria.find(row=>row.id===data.criterionId);
      requireThat(item,'Unknown criterion');requireThat(['passed','failed','unverified','blocked'].includes(data.status),'Invalid criterion state');
      requireThat(typeof data.reason==='string'&&data.reason.trim(),'Review reason required');
      const ids=data.evidenceIds || [];requireThat(Array.isArray(ids)&&ids.length<=20&&new Set(ids).size===ids.length&&ids.every(id=>goal.evidenceRecords.some(row=>row.id===id)),'Unknown evidence reference');
      requireThat(data.status!=='passed'||ids.length>0,'Passing requires actual output evidence');
      requireThat(data.status!=='passed'||ids.every(id=>{const row=goal.evidenceRecords.find(entry=>entry.id===id);return row.kind!=='test-output'||row.tests?.passed>0&&row.tests.failed===0&&row.tests.cancelled===0&&row.tests.skipped===0&&row.tests.todo===0;}),'Failed, cancelled, skipped or incomplete test evidence cannot pass');
      item.status=data.status;item.evidence=clone(ids);item.review={at:new Date().toISOString(),commandId:cmd.id,reviewer:'authorised-ai',reason:clean(data.reason)};
      event(goal,'criterion-review',{criterionId:item.id,...item.review,status:item.status,evidenceIds:ids});
    }
    if(op==='summary'||op==='complete'){
      requireThat(typeof data.summary==='string'&&data.summary.trim()&&data.summary.length<=12000,'Phase summary required');
      const ids=data.evidenceIds || goal.acceptanceCriteria.flatMap(row=>row.evidence);
      requireThat(Array.isArray(ids)&&ids.length<=100&&ids.every(id=>goal.evidenceRecords.some(row=>row.id===id)),'Unknown summary evidence');
      if(op==='complete'){
        requireThat(goal.reviewPolicy.allowAIReview,'Insufficient authority: AI completion is disabled');
        requireThat(goal.acceptanceCriteria.length>0&&goal.acceptanceCriteria.every(row=>row.status==='passed'&&row.review&&row.evidence.length>0),'All criteria must pass evidence-backed review');
        requireThat(!context.authentication&&!context.uncertain&&!context.activeJobs&&!plan?.jobs.some(row=>['running','queued'].includes(row.state)),'Unsettled work or external submission blocks completion');
        transition(goal,'complete','All criteria passed authorised evidence-backed review');goal.continuationIntent=null;
      }
      requireThat(goal.phaseSummaries.length<200,'Phase summary ledger full');
      goal.phaseSummaries.push({commandId:cmd.id,phase:goal.phase,planId:plan?.id,planInstanceId:plan?.instanceId,summary:data.summary,evidenceIds:clone(ids),at:new Date().toISOString()});
    }
    if(op==='repair'){
      requireThat(goal.reviewPolicy.allowRepairs&&goal.reviewPolicy.allowAIReview,'Insufficient authority: automatic repairs disabled');
      const item=goal.acceptanceCriteria.find(row=>row.id===data.criterionId);
      requireThat(item&&['failed','blocked'].includes(item.status),'Repair requires a failed or blocked criterion');
      requireThat(typeof data.reason==='string'&&data.reason.trim(),'Repair reason required');
      requireThat(plan&&!plan.cancelled,'Active plan required for repair');
      requireThat(goal.reviewPolicy.repairTargets.includes(data.job?.target),'Repair target outside authority');
      const reason=budgetReason(goal,'job','repair:'+cmd.id,context);requireThat(!reason,reason || '');
      requireThat(admit(goal,'turn','repair:'+cmd.id,context),'Coordinator repair turn budget exhausted');
      requireThat((goal.usage.repairs[item.id] || 0)<goal.executionBudgets.maxRepairs,'Per-issue repair budget exhausted');
      requireThat(!goal.repairRecords.some(row=>row.criterionId===item.id&&row.planInstanceId===plan.instanceId&&plan.jobs.some(job=>job.id===row.jobId&&['queued','running'].includes(job.state))),'A corrective job for this issue is already pending');
      let next=context.Plan.apply(plan,{id:cmd.id+'-add',action:'add',jobs:[data.job]}).plan;
      requireThat(Array.isArray(data.rewire || []),'rewire must be an array');
      for(const id of data.rewire || []){
        const child=next.jobs.find(row=>row.id===id);requireThat(next.mode==='dependencies'&&child,'Rewiring requires a dependency job');
        const failedParents=(child.dependsOn || []).filter(parent=>['failed','cancelled'].includes(next.jobs.find(row=>row.id===parent)?.state));
        requireThat(failedParents.length>0,'Rewire requires failed prerequisites');
        next=context.Plan.apply(next,{id:cmd.id+'-wire-'+id,action:'update',jobId:id,job:{dependsOn:[...child.dependsOn.filter(parent=>!failedParents.includes(parent)),data.job.id]}}).plan;
      }
      plan=next;goal.usage.repairs[item.id]=(goal.usage.repairs[item.id] || 0)+1;
      goal.repairRecords.push({commandId:cmd.id,criterionId:item.id,jobId:data.job.id,planInstanceId:plan.instanceId,reason:clean(data.reason),attempt:goal.usage.repairs[item.id]});
      item.status='unverified';item.evidence=[];delete item.review;
      event(goal,'corrective-job-scheduled',{criterionId:item.id,jobId:data.job.id,planInstanceId:plan.instanceId,reason:clean(data.reason),attempt:goal.usage.repairs[item.id]});
    }
    if(op==='checkpoint'){
      requireThat(goal.reviewPolicy.allowAIReview,'Insufficient authority: AI checkpoints disabled');
      requireThat(plan?.reviewGate&&plan.paused&&plan.reason.startsWith('Review required after '),'Only an AI review checkpoint can be released');
      requireThat(admit(goal,'turn','checkpoint:'+cmd.id,{...context,paused:false}),'Coordinator checkpoint budget exhausted');
      requireThat(!context.paused&&!context.authentication&&!context.uncertain,'Checkpoint held by external controls');
      requireThat(goal.acceptanceCriteria.length>0&&goal.acceptanceCriteria.every(row=>row.status==='passed'&&row.review),'Checkpoint criteria must be reviewed');
      requireThat(typeof data.reason==='string'&&data.reason.trim(),'Checkpoint reason required');
      plan=context.Plan.apply(plan,{id:cmd.id+'-resume',action:'resume'}).plan;
      event(goal,'ai-checkpoint-released',{reason:clean(data.reason)});
    }
    goal.reviewCommands.push({id:cmd.id,hash});event(goal,'goal-operation',{operation:op,commandId:cmd.id});
    return {goal,plan,duplicate:false};
  }
  function receipt(goal,task,replyHash){
    initialize(goal);
    if(goal.receipts.some(row=>row.taskId===task.id))return;
    goal.receipts.push({taskId:task.id,jobId:task.jobId,planJobId:task.planJobId || null,planInstanceId:task.planInstanceId || null,
      outcome:task.outcome,replyHash,verified:!!task.jobId&&!!task.trace?.cliTaskHash&&task.trace.cliTaskHash===task.trace.executionTaskHash,
      at:new Date().toISOString()});
  }
  // Page-owned registration: the background alarm only reads it and asks the
  // existing queue to accept a request. No second queue or send transaction.
  const wakeDefaults={enabled:true,checkInMs:300000,idleMs:90000,maxAttempts:8,maxNoProgress:3,maxElapsedMs:86400000};
  function wakeConfigure(wake,input={}) {
    if(!input||typeof input!=='object'||Array.isArray(input))throw Error('Wake configuration must be an object');
    const config={...wakeDefaults,...wake?.config};
    for(const [key,value] of Object.entries(input)){
      if(key==='enabled'){if(typeof value!=='boolean')throw Error('enabled must be boolean');}
      else {const ranges={checkInMs:[60000,3600000],idleMs:[60000,3600000],maxAttempts:[1,50],maxNoProgress:[1,20],maxElapsedMs:[60000,86400000]};
        if(!Object.hasOwn(ranges,key)||!Number.isInteger(value)||value<ranges[key][0]||value>ranges[key][1])throw Error('Invalid wake setting: '+key);}
      config[key]=value;
    }
    return config;
  }
  function wakeRegistration(goal,now=Date.now()) {
    return goal.wake ||= {id:'wake:'+goal.id,config:wakeConfigure(),createdAt:now,lastProgressAt:now,lastProgressEvent:'registered',
      attempts:0,noProgress:0,sequence:0,nextDueAt:now+90000,pending:null,lastWake:null,lastAcknowledgment:null,suppressed:[]};
  }
  function wakeObserve(wake,context,now=Date.now()) {
    if(context.manualReview)wake.exhausted ||= context.manualReview;
    if(wake.progressKey!==context.progressKey){
      if(wake.progressKey!==undefined){wake.lastProgressAt=now;wake.lastProgressEvent=context.progressEvent || 'job-or-phase-change';wake.noProgress=0;}
      wake.progressKey=context.progressKey;
    }
    const pending=wake.pending;
    if(pending){
      const receipt=context.acknowledgments?.find(item=>item.acknowledgedTaskId===pending.id);
      if(receipt){wake.lastAcknowledgment={id:pending.id,at:Date.parse(receipt.readAt)||now};wake.pending=null;}
      else if(context.failedIds?.includes(pending.id)){wake.exhausted='uncertain-delivery; inspect conversation before any new request';}
    }
    const interval=context.running?wake.config.checkInMs:wake.config.idleMs;
    wake.nextDueAt=Math.max(wake.lastProgressAt,wake.lastWake?.at || wake.createdAt)+interval;
  }
  function wakePolicy(goal,context={},now=Date.now()) {
    const w=wakeRegistration(goal,now);wakeObserve(w,context,now);
    const suppressed=[];
    for(const key of ['stopped','paused','cancelled','disconnected','authentication','uploading','generating','cooldown','draft','uncertain','delivering','captureBusy','unread','dependencyWait','queued'])if(context[key])suppressed.push(key);
    if(goal.stopped||goal.paused)suppressed.push('goal-stopped-or-paused');
    if(!w.config.enabled)suppressed.push('disabled');
    if(['complete','completed','cancelled'].includes(goal.phase))suppressed.push('goal-finished');
    if(now-w.createdAt>=Math.min(w.config.maxElapsedMs,goal.executionBudgets?.maxElapsedMs || Infinity))w.exhausted ||= 'elapsed-time-limit';
    if(!w.pending&&w.attempts>=w.config.maxAttempts)w.exhausted ||= 'wake-count-limit';
    if(!w.pending&&w.noProgress>=w.config.maxNoProgress)w.exhausted ||= 'consecutive-no-progress-limit';
    if(w.exhausted)suppressed.push(w.exhausted);
    if(w.pending)suppressed.push('pending-acknowledgment');
    w.suppressed=suppressed;
    return {due:!suppressed.length&&now>=w.nextDueAt,id:w.id+':'+(w.sequence+1),kind:context.running?'progress-check-in':'idle-review'};
  }
  function wakeMessage(goal,context,request){
    return `AI Bridge coordinator wake-up ${request.id}\nGoal: ${clean(goal.originalGoal).slice(0,500)}\nPhase: ${clean(goal.phase)}\n`+
      `Jobs: ${JSON.stringify(context.jobs || {}).slice(0,1500)}\nLast receipt: ${JSON.stringify(context.lastReceipt || null).slice(0,500)}\n`+
      `Waiting: ${(context.waitingReasons || []).join('; ').slice(0,800) || 'none'}\n`+
      (request.kind==='progress-check-in'?'Requested action: Review progress and acknowledge. Accepted jobs continue; do not restart or duplicate them.':
        'Requested action: Review the unfinished goal and receipts; provide the next explicit action or explain the blocker. Do not repeat accepted or uncertain submissions.')+
      '\nRespect Stop, Pause and Cancel. Agent claims are unverified; inspect evidence before declaring completion.';
  }
  globalThis.RelayGoalState = {VERSION, create, event, transition, criterion, recover, watchdog,initialize,configure,budgetReason,admit,escalate,inspect,operation,receipt,wakeConfigure,wakeRegistration,wakeObserve,wakePolicy,wakeMessage};
  if (typeof module !== "undefined" && module.exports) module.exports = globalThis.RelayGoalState;
})();
