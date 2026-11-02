"use strict";
const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto");
const Execution=require("../extension/execution-settings.js");
// One atomic file contains both defaults and command receipts, so a retry after
// a lost response/restart cannot reapply an older command over newer defaults.
module.exports=function defaultsStore(stateDir){
  const file=stateDir && path.join(stateDir,"execution-defaults.json");
  let state={settings:{...Execution.DEFAULTS},revision:0,initialized:false,receipts:{}};
  if(file && fs.existsSync(file)){
    state=JSON.parse(fs.readFileSync(file,"utf8"));Execution.validate(state.settings);
    if(!Number.isSafeInteger(state.revision) || !state.receipts)throw new Error("Invalid saved execution defaults");
  }
  const snapshot=()=>({defaults:{...state.settings},revision:state.revision,initialized:state.initialized});
  return {snapshot,apply(input,validate){
    const {commandId,issuedAt,initializeOnly=false,...raw}=input;
    const command=Execution.validateCommand(raw);
    if(typeof initializeOnly!=="boolean")throw new Error("Invalid defaults migration flag");
    if(!/^[a-zA-Z0-9_-]{16,128}$/.test(commandId || "") || !Number.isFinite(issuedAt))throw new Error("Settings command requires an identity and timestamp");
    const hash=crypto.createHash("sha256").update(JSON.stringify({command,initializeOnly})).digest("hex");
    const previous=state.receipts[commandId];
    if(previous){if(previous.hash!==hash)throw new Error("Settings command ID already belongs to another command");return {...previous.result,duplicate:true,...snapshot()};}
    if(Date.now()-issuedAt>300000 || issuedAt>Date.now()+30000)throw new Error("Stale settings command; send a new explicit command");
    const {action,...updates}=command;
    let next={...state,receipts:{...state.receipts}};
    if(action==="set_defaults" && !(initializeOnly && state.initialized)){
      next.settings=Execution.validate({...state.settings,...updates});
      validate(next.settings);next.initialized=true;next.revision++;
    }
    const result={action,commandId,applied:next.revision!==state.revision,defaults:{...next.settings},revision:next.revision,initialized:next.initialized,
      validation:"Syntax and known model capabilities checked. Codex validates model availability when a task executes; no model substitution."};
    next.receipts[commandId]={hash,result};
    const keys=Object.keys(next.receipts);for(const key of keys.slice(0,-1000))delete next.receipts[key];
    if(file){fs.mkdirSync(stateDir,{recursive:true});fs.writeFileSync(file+".tmp",JSON.stringify(next),{mode:0o600});fs.renameSync(file+".tmp",file);}
    state=next;return result;
  }};
};
