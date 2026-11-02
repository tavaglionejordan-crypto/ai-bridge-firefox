"use strict";
// Pure, atomic plan edits. Browser execution and website receipts stay in the
// existing relay; this module never executes prompts or evaluates JSON as code.
(function(root){
  const clone=value=>JSON.parse(JSON.stringify(value));
  const requireThat=(ok,message)=>{if(!ok)throw Error(message);};
  const identifier=value=>typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(value);
  function fingerprint(value){let a=2166136261,b=3339675911;for(let i=0;i<value.length;i++){a=Math.imul(a^value.charCodeAt(i),16777619);b=Math.imul(b^value.charCodeAt(i),2246822519);}return (a>>>0).toString(16)+':'+(b>>>0).toString(16);}
  function job(value){
    requireThat(value&&typeof value==='object'&&!Array.isArray(value),'Each job must be an object');
    requireThat(Object.keys(value).every(key=>['id','target','prompt','title','review','depends_on','dependsOn','inputs','output_ids','outputIds'].includes(key)),'Unknown job field');
    requireThat(identifier(value.id),'Job id must use 1–64 letters, numbers, dots, underscores or hyphens');
    requireThat(['codex','grok','gemini','chatgpt'].includes(value.target),'Job target must be codex, grok, gemini or chatgpt');
    const limit=value.target==='chatgpt'?4000:['grok','gemini'].includes(value.target)?16000:100000;
    requireThat(typeof value.prompt==='string'&&value.prompt.trim()&&value.prompt.length<=limit,`${value.target} prompt must contain 1–${limit} characters`);
    requireThat(value.review===undefined||typeof value.review==='boolean','review must be true or false');
    requireThat(value.title===undefined||typeof value.title==='string'&&value.title.length<=100,'Job title must be at most 100 characters');
    requireThat(!(value.depends_on!==undefined&&value.dependsOn!==undefined)&&!(value.output_ids!==undefined&&value.outputIds!==undefined),'Duplicate dependency field aliases');
    const extra={};if(value.depends_on!==undefined||value.dependsOn!==undefined)extra.dependsOn=value.depends_on ?? value.dependsOn;if(value.inputs!==undefined)extra.inputs=value.inputs;if(value.output_ids!==undefined||value.outputIds!==undefined)extra.outputIds=value.output_ids ?? value.outputIds;
    return {id:value.id,target:value.target,prompt:value.prompt,title:value.title || value.id,review:value.review===true,state:'queued',attempt:0,...extra};
  }
  function valid(state){
    requireThat(state.jobs.length<=100,'A plan can contain at most 100 jobs, including completed jobs');
    requireThat(new Set(state.jobs.map(item=>item.id)).size===state.jobs.length,'Job ids must be unique');
    requireThat(state.jobs.reduce((sum,item)=>sum+item.prompt.length,0)<=100000,'Combined plan prompts exceed 100,000 characters');
    requireThat(JSON.stringify(state.jobs.map(({id,target,prompt,title,review,dependsOn,inputs,outputIds})=>({id,target,prompt,title,review,dependsOn,inputs,outputIds}))).length<=128000,'Encoded plan exceeds the safe command-result size');
    if(state.mode==='dependencies'){
      const byId=new Map(state.jobs.map(item=>[item.id,item]));
      for(const item of state.jobs){item.dependsOn ??=[];item.inputs ??='all';item.outputIds ??=[];
        requireThat(Array.isArray(item.dependsOn)&&item.dependsOn.every(identifier)&&new Set(item.dependsOn).size===item.dependsOn.length,'depends_on requires unique job ids');
        requireThat(item.dependsOn.every(id=>id!==item.id&&byId.has(id)),'Dependencies must refer to other jobs in this plan');
        requireThat(['all','text','images','files','none','selected'].includes(item.inputs),'Unknown dependency inputs mode');
        requireThat(Array.isArray(item.outputIds)&&item.outputIds.every(id=>/^[a-f0-9]{64}$/.test(id))&&new Set(item.outputIds).size===item.outputIds.length,'output_ids requires unique output ids');
        requireThat(item.inputs==='selected'?item.outputIds.length>0:item.outputIds.length===0,'output_ids is only used with inputs: selected');
      }
      const visited=new Set(),visiting=new Set();const visit=id=>{requireThat(!visiting.has(id),'Dependency cycle detected');if(visited.has(id))return;visiting.add(id);byId.get(id).dependsOn.forEach(visit);visiting.delete(id);visited.add(id);};state.jobs.forEach(item=>visit(item.id));
    }else requireThat(state.jobs.every(item=>!['dependsOn','inputs','outputIds'].some(key=>Object.hasOwn(item,key))),'Dependency fields require mode: dependencies on plan creation');
    return state;
  }
  function readiness(plan,item){
    if(item.state!=='queued')return {state:item.state,reason:''};
    if(item.runtimeBlock)return {state:'blocked',reason:item.runtimeBlock,root:item.id};
    const parents=(item.dependsOn || []).map(id=>plan.jobs.find(job=>job.id===id));
    for(const parent of parents)if(parent?.state==='queued'){const upstream=readiness(plan,parent);if(upstream.state==='blocked')return upstream;}
    const failed=parents.find(parent=>!parent||['failed','cancelled'].includes(parent.state));if(failed)return {state:'blocked',reason:'Blocked by '+(failed?.state || 'missing')+' '+(failed?.id || 'prerequisite'),root:failed?.id};
    const waiting=parents.filter(parent=>parent.state!=='done');if(waiting.length)return {state:'waiting',reason:'Waiting for '+waiting.map(parent=>parent.id).join(', ')};
    if(item.inputs!=='none'){const missing=parents.find(parent=>!parent.bundle?.ready);if(missing)return {state:missing.bundle?.error?'blocked':'waiting',reason:missing.bundle?.error || 'Waiting for outputs from '+missing.id,root:missing.id};}
    return {state:'ready',reason:item.destinationWait || 'Ready'};
  }
  function compactLines(text){
    const output=[];let inPrompt=false,inlinePrompt=false;
    const promptPart=(line,inline)=>{
      const end=inline?line.match(/(?:^|[ \t]+)END_PROMPT[ \t]*$/i):/^\s*END_PROMPT\s*$/i.test(line)?{index:0}:null;
      if(end){const body=line.slice(0,end.index);if(body)output.push(body);output.push('END_PROMPT');inPrompt=false;}
      else{output.push(line);inPrompt=true;inlinePrompt=inline;}
    };
    for(const original of text.split('\n')){
      if(inPrompt){promptPart(original,inlinePrompt);continue;}
      let line=original.trim();if(!line){output.push(original);continue;}
      const heading=line.match(/^JOB\s+([1-9]\d*)(?:[ \t]+|$)/i);
      if(heading){output.push('JOB '+heading[1]);line=line.slice(heading[0].length);if(!line)continue;}
      // A standalone title line remains literal, preserving the old format.
      const fields=[...line.matchAll(/(?:^|[ \t]+)(action|id|plan|planid|mode|depends_on|output_ids|inputs|revision|paused|before|job|jobs|order|target|title|review|prompt):[ \t]*/gi)];
      if(!fields.length||fields[0].index!==0){output.push(line);continue;}
      if(!heading&&fields[0][1].toLowerCase()==='title'){output.push(line);continue;}
      for(let n=0;n<fields.length;n++){
        const field=fields[n],key=field[1],start=field.index+field[0].length;
        if(key.toLowerCase()==='prompt'){
          output.push('prompt:');const body=line.slice(start);
          if(body)promptPart(body,true);else{inPrompt=true;inlinePrompt=false;}
          break;
        }
        output.push(key+': '+line.slice(start,fields[n+1]?.index ?? line.length).trim());
      }
    }
    return output;
  }
  function parse(input){
    if(typeof input!=='string')return input;
    requireThat(input.length<=128000,'Plan command exceeds 128,000 characters');
    let text=input.replace(/\r\n?/g,'\n').trim();
    if(/^BRIDGE_PLAN\s*\n/i.test(text)){
      requireThat(/\nEND_BRIDGE_PLAN\s*$/i.test(text),'Plan command requires END_BRIDGE_PLAN');
      text=text.replace(/^BRIDGE_PLAN\s*\n/i,'').replace(/\nEND_BRIDGE_PLAN\s*$/i,'');
    }
    if(text.startsWith('{')||text.startsWith('['))return JSON.parse(text);
    const command={},sections=[],patch={},lines=compactLines(text);let section=null;
    const put=(object,key,value)=>{requireThat(!Object.hasOwn(object,key),`Duplicate plan field: ${key}`);object[key]=value;};
    const boolean=(value,key)=>{requireThat(/^(true|false)$/i.test(value),`${key} must be true or false`);return value.toLowerCase()==='true';};
    const ids=value=>{const list=value.trim()?value.split(',').map(id=>id.trim()):[];requireThat(list.every(identifier)&&new Set(list).size===list.length,'Job lists require unique comma-separated job ids');return list;};
    for(let i=0;i<lines.length;i++){
      const line=lines[i].trim();if(!line)continue;
      const heading=line.match(/^JOB\s+([1-9]\d*)$/i);
      if(heading){
        requireThat(Number(heading[1])===sections.length+1,'Number JOB sections consecutively, starting at JOB 1');
        requireThat(sections.length<100,'A command can contain at most 100 jobs');section={};sections.push(section);continue;
      }
      const field=line.match(/^([a-z][a-z0-9_]*):[ \t]*(.*)$/i);
      requireThat(field,`Invalid plan syntax on line ${i+1}; use field: value or JOB 1`);
      const key=field[1].toLowerCase();let value=field[2];
      if(key==='prompt'){
        requireThat(!value,'Put the prompt on the following lines, then END_PROMPT');
        const body=[];let closed=false;
        while(++i<lines.length){if(lines[i].trim().toUpperCase()==='END_PROMPT'){closed=true;break;}body.push(lines[i]);}
        requireThat(closed,'Prompt requires END_PROMPT');put(section || patch,'prompt',body.join('\n'));continue;
      }
      if(section){
        requireThat(['id','target','title','review','depends_on','inputs','output_ids'].includes(key),`Unknown job field: ${key}`);
        if(['target','inputs'].includes(key))value=value.toLowerCase();if(key==='review')value=boolean(value,key);if(['depends_on','output_ids'].includes(key))value=ids(value);put(section,key==='depends_on'?'dependsOn':key==='output_ids'?'outputIds':key,value);continue;
      }
      if(['target','title','review','depends_on','inputs','output_ids'].includes(key)){
        put(patch,key==='depends_on'?'dependsOn':key==='output_ids'?'outputIds':key,['target','inputs'].includes(key)?value.toLowerCase():key==='review'?boolean(value,key):['depends_on','output_ids'].includes(key)?ids(value):value);continue;
      }
      const mapping={mode:'mode',id:'id',action:'action',plan:'planId',planid:'planId',revision:'revision',paused:'paused',before:'before',job:'jobId',jobs:'jobIds',order:'jobIds'};
      requireThat(Object.hasOwn(mapping,key),`Unknown command field: ${key}`);
      if(key==='action')value=value.toLowerCase();
      if(key==='paused')value=boolean(value,key);
      if(key==='revision'){requireThat(/^\d+$/.test(value)&&Number.isSafeInteger(Number(value)),'revision must be a nonnegative integer');value=Number(value);}
      if(key==='jobs'||key==='order')value=ids(value);
      put(command,mapping[key],value);
    }
    if(sections.length){requireThat(['create','add','replace'].includes(command.action),'JOB sections are only for create, add or replace');put(command,'jobs',sections);}
    else if(command.action==='replace')command.jobs=[];
    if(Object.keys(patch).length){requireThat(command.action==='update','Replacement fields outside JOB sections require action: update');command.job=patch;}
    const sort=object=>Object.fromEntries(Object.keys(object).sort().map(key=>[key,Array.isArray(object[key])?object[key].map(item=>item&&typeof item==='object'?sort(item):item):object[key]&&typeof object[key]==='object'?sort(object[key]):object[key]]));
    return sort(command);
  }
  function apply(previous,input){
    const cmd=parse(input);
    requireThat(cmd&&typeof cmd==='object'&&!Array.isArray(cmd),'Plan command must be an object');
    requireThat(identifier(cmd.id),'Each command requires a unique id (1–64 safe characters)');
    requireThat(['create','add','update','replace','remove','reorder','pause','resume','cancel','status','goal'].includes(cmd.action),'Unknown plan action');
    const fields={create:['planId','jobs','paused','mode'],add:['jobs','before'],update:['jobId','job'],replace:['jobs'],remove:['jobIds'],reorder:['jobIds'],pause:[],resume:[],cancel:[],status:['jobId'],goal:['operation','data']};
    requireThat(Object.keys(cmd).every(key=>['id','action','revision','planId',...fields[cmd.action]].includes(key)),'Unknown command field; use one action per command');
    const hash=fingerprint(JSON.stringify(cmd)),receipt=previous?.commands?.find(item=>item.id===cmd.id);
    if(receipt){requireThat(receipt.hash===hash,'Command id was already used for different contents');return {plan:clone(previous),duplicate:true};}
    if(cmd.revision!==undefined)requireThat(cmd.revision===previous?.revision,'Stale plan revision; request status before editing');
    let state=clone(previous || {id:'',revision:0,paused:true,cancelled:false,jobs:[],commands:[],reason:''});
    const active=()=>state.jobs.find(item=>item.state==='running');
    const find=id=>{const found=state.jobs.find(item=>item.id===id);requireThat(found,`Unknown job: ${id}`);return found;};
    const queued=id=>{const found=find(id);requireThat(found.state==='queued',`Only queued jobs can be edited or removed: ${id}`);return found;};
    if(cmd.action==='goal'){
      requireThat(state.id,'Create a plan first');
      requireThat(cmd.planId===undefined||cmd.planId===state.id,'Command planId does not match the current plan');
    }else if(cmd.action==='create'){
      requireThat(!active(),'An active plan job must finish before creating another plan');
      requireThat(identifier(cmd.planId),'create requires a planId');
      requireThat(Array.isArray(cmd.jobs)&&cmd.jobs.length>0,'create requires a nonempty jobs array');
      requireThat(cmd.paused===undefined||typeof cmd.paused==='boolean','paused must be true or false');
      requireThat(cmd.mode===undefined||['sequential','dependencies'].includes(cmd.mode),'Unknown plan mode');
      state={...(cmd.mode==='dependencies'?{mode:cmd.mode}:{}),id:cmd.planId,instanceId:cmd.id,revision:state.revision,paused:cmd.paused===true,cancelled:false,jobs:cmd.jobs.map(job),commands:state.commands,reason:cmd.paused?'Paused on creation':''};
    }else{
      requireThat(state.id,'Create a plan first');
      requireThat(cmd.planId===undefined||cmd.planId===state.id,'Command planId does not match the current plan');
      requireThat(!state.cancelled||['status','cancel'].includes(cmd.action),'A cancelled plan cannot be edited or resumed; create a new plan');
      if(cmd.action==='add'){
        requireThat(!state.cancelled,'Create a new plan after cancellation');
        requireThat(Array.isArray(cmd.jobs)&&cmd.jobs.length>0,'add requires a nonempty jobs array');
        const additions=cmd.jobs.map(job),index=cmd.before===undefined?state.jobs.length:state.jobs.indexOf(queued(cmd.before));
        state.jobs.splice(index,0,...additions);
      }else if(cmd.action==='update'){
        requireThat(cmd.job&&typeof cmd.job==='object'&&!Array.isArray(cmd.job)&&Object.keys(cmd.job).length>0&&Object.keys(cmd.job).every(key=>['target','prompt','title','review','depends_on','dependsOn','inputs','output_ids','outputIds'].includes(key)),'update requires known job fields; job ids cannot change');
        const old=queued(cmd.jobId),updated=job({id:old.id,target:old.target,prompt:old.prompt,title:old.title,review:old.review,...(state.mode==='dependencies'?{dependsOn:old.dependsOn,inputs:old.inputs,outputIds:old.outputIds}:{}),...Object.fromEntries(Object.entries(cmd.job).map(([key,value])=>[key==='depends_on'?'dependsOn':key==='output_ids'?'outputIds':key,value]))});
        state.jobs[state.jobs.indexOf(old)]={...updated,attempt:old.attempt};
      }else if(cmd.action==='replace'){
        requireThat(Array.isArray(cmd.jobs),'replace requires a jobs array');
        state.jobs=[...state.jobs.filter(item=>item.state!=='queued'),...cmd.jobs.map(job)];
      }else if(cmd.action==='remove'){
        requireThat(Array.isArray(cmd.jobIds)&&cmd.jobIds.length>0,'remove requires jobIds');
        for(const id of cmd.jobIds)queued(id);
        state.jobs=state.jobs.filter(item=>!cmd.jobIds.includes(item.id));
      }else if(cmd.action==='reorder'){
        const pending=state.jobs.filter(item=>item.state==='queued');
        requireThat(Array.isArray(cmd.jobIds)&&cmd.jobIds.length===pending.length&&new Set(cmd.jobIds).size===pending.length&&cmd.jobIds.every(id=>pending.some(item=>item.id===id)),'reorder must list every queued job id exactly once');
        state.jobs=[...state.jobs.filter(item=>item.state!=='queued'),...cmd.jobIds.map(find)];
      }else if(cmd.action==='pause'){state.paused=true;state.reason='Paused by command';}
      else if(cmd.action==='resume'){
        requireThat(!state.cancelled,'A cancelled plan cannot resume; create a new plan');
        requireThat(!state.reviewGate||!state.jobs.some(item=>item.id===state.reviewGate&&item.state==='running'),'Wait for the review job to finish');delete state.reviewGate;state.paused=false;state.reason='';
      }else if(cmd.action==='cancel'){
        state.cancelled=true;state.paused=true;state.reason='Cancelled; any active job may finish';
        for(const item of state.jobs)if(item.state==='queued')item.state='cancelled';
      }
    }
    if(['create','add','update','replace','remove','reorder'].includes(cmd.action))valid(state);
    if(cmd.action==='status'&&cmd.jobId)find(cmd.jobId);
    state.revision++;state.commands=[...state.commands,{id:cmd.id,hash}].slice(-200);
    return {plan:state,duplicate:false};
  }
  function summary(plan,{titles=false,prompts=false,jobId=null}={}){
    if(!plan)return null;
    return {...(plan.mode?{mode:plan.mode}:{}),id:plan.id,...(plan.instanceId?{instanceId:plan.instanceId}:{}),revision:plan.revision,paused:plan.paused,cancelled:plan.cancelled,reason:plan.reason,
      queued:plan.jobs.filter(item=>item.state==='queued').length,
      jobs:plan.jobs.filter(item=>!jobId||item.id===jobId).map(item=>{const {id,target,state,review,taskId,outcome,title,prompt}=item;return {id,target,state,review,...(plan.mode==='dependencies'?{dependsOn:item.dependsOn,inputs:item.inputs,outputIds:item.outputIds,dependency:readiness(plan,item),...(jobId?{outputs:item.bundle?.outputs || [],inputPreview:item.inputPreview || [],inputBlock:item.runtimeBlock || null}:{outputCount:item.bundle?.outputs?.length || 0})}:{}),...(taskId?{taskId}:{}),...(outcome?{outcome}:{}),...(titles?{title}:{}),...(prompts?{prompt}:{})};})};
  }
  const api={apply,summary,parse,readiness};if(typeof module!=='undefined'&&module.exports)module.exports=api;root.RelayPlan=api;
})(typeof globalThis==='undefined'?this:globalThis);
