"use strict";
const fs=require("node:fs"), path=require("node:path"), {spawn}=require("node:child_process");
const {createRequire}=require("node:module");

function npmNativeSpec(entry,arch=process.arch){
  const target=arch==="x64"?"x86_64-pc-windows-msvc":arch==="arm64"?"aarch64-pc-windows-msvc":null;
  if(!target)return null;
  try{
    const root=path.resolve(entry,"..","..");
    // Other package managers may supply their own wrapper behavior. Preserve
    // that entrypoint, and fall back to it for unfamiliar installation layouts.
    if(fs.realpathSync(root)!==root || /[\\/](?:\.pnpm|\.bun|\.vite-plus)[\\/]/i.test(root) || /bun|pnpm|vite-plus/i.test(process.env.npm_config_user_agent || ""))return null;
    let vendor;
    try{vendor=path.join(path.dirname(createRequire(entry).resolve(`@openai/codex-win32-${arch}/package.json`)),"vendor");}
    catch{vendor=path.join(root,"vendor");}
    const command=path.join(vendor,target,"bin","codex.exe");
    return fs.existsSync(command)?{command,prefix:[],managedRoot:root}:null;
  }catch{return null;}
}
let cachedSpec=null,cachedPath=null;
const remember=spec=>{cachedPath=process.env.PATH;cachedSpec=spec;return spec;};

function launchSpec() {
  if (process.platform!=="win32") return {command:"codex",prefix:[]};
  if(cachedSpec && cachedPath===process.env.PATH && fs.existsSync(cachedSpec.prefix[0] || cachedSpec.command))return cachedSpec;
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    const base=dir.replace(/^"|"$/g,"");
    const exe=path.join(base,"codex.exe");
    if(fs.existsSync(exe)) return remember({command:exe,prefix:[]});
    // Execute the official npm entrypoint with Node, avoiding cmd.exe entirely.
    const entry=path.join(base,"node_modules","@openai","codex","bin","codex.js");
    if(fs.existsSync(entry)) return remember(npmNativeSpec(entry) || {command:process.execPath,prefix:[entry]});
  }
  throw new Error("Codex CLI not found on PATH. Install the official @openai/codex package or provide codex.exe on PATH.");
}
function startCommand(args, options, spawnProcess=spawn) {
  const {command,prefix,managedRoot}=launchSpec();
  const env=managedRoot?{...process.env}:process.env;
  if(managedRoot){
    for(const key of ["CODEX_MANAGED_BY_NPM","CODEX_MANAGED_BY_BUN","CODEX_MANAGED_BY_PNPM","CODEX_MANAGED_BY_VITE_PLUS"])delete env[key];
    env.CODEX_MANAGED_BY_NPM="1";env.CODEX_MANAGED_PACKAGE_ROOT=managedRoot;
  }
  return spawnProcess(command,[...prefix,...args],{cwd:options.cwd,shell:false,windowsHide:true,
    detached:process.platform!=="win32",stdio:["pipe","pipe","pipe"],env});
}
function stopProcess(child) {
  if(!child?.pid) return;
  if(process.platform==="win32") {
    // Only this owned PID and its descendants. First request ordinary tree
    // termination; console processes may require the forced fallback.
    const kill=force=>spawn("taskkill.exe",["/PID",String(child.pid),"/T",...(force?["/F"]:[])],{windowsHide:true,stdio:"ignore"});
    const first=kill(false);
    first.on("error",()=>kill(true).on("error",()=>{}));
    first.on("close",code=>{if(code!==0)kill(true).on("error",()=>{});});
  } else {
    try {process.kill(-child.pid,"SIGTERM");} catch {child.kill("SIGTERM");}
    const force=setTimeout(()=>{try{process.kill(-child.pid,"SIGKILL");}catch{}},1500);
    force.unref();
  }
}
function readCapabilities(cwd, launch=startCommand) {
  return new Promise((resolve,reject)=>{
    let child,buffer="",models=[],config=null,listed=false,ended=false;
    const finish=(error)=>{
      if(ended)return;ended=true;clearTimeout(timer);
      child?.stdin.destroy();stopProcess(child);
      if(error)return reject(new Error(`Cannot load Codex models: ${error.message}`));
      const defaultModel=config?.model || models.find(m=>m.isDefault)?.id;
      resolve({models,defaultModel,defaultReasoning:config?.model_reasoning_effort || models.find(m=>m.id===defaultModel)?.defaultReasoning || null});
    };
    const timer=setTimeout(()=>finish(new Error("model discovery timed out after 10 seconds")),10000);
    try {child=launch(["app-server","--stdio"],{cwd});}catch(error){finish(error);return;}
    const send=value=>child.stdin.write(JSON.stringify(value)+"\n");
    child.stdin.on("error",error=>finish(error));
    child.stderr.resume();
    child.on("error",finish);
    child.on("close",()=>{if(!ended)finish(new Error("app-server closed before returning models"));});
    child.stdout.setEncoding("utf8");
    child.stdout.on("data",chunk=>{
      buffer+=chunk;
      if(buffer.length>4_000_000)return finish(new Error("model response too large"));
      let at;
      while((at=buffer.indexOf("\n"))>=0){
        const line=buffer.slice(0,at);buffer=buffer.slice(at+1);
        let message;try{message=JSON.parse(line);}catch{continue;}
        if(message.error)return finish(new Error(message.error.message || "CLI request failed"));
        if(message.id===1){
          send({method:"initialized"});
          send({id:2,method:"model/list",params:{limit:100,includeHidden:true}});
          send({id:3,method:"config/read",params:{includeLayers:false,cwd}});
        }
        if(message.id===2){
          for(const m of message.result?.data || []) models.push({id:m.model || m.id,name:m.displayName || m.model || m.id,
            efforts:(m.supportedReasoningEfforts || []).map(e=>e.reasoningEffort),defaultReasoning:m.defaultReasoningEffort,isDefault:m.isDefault,hidden:m.hidden});
          if(message.result?.nextCursor)send({id:2,method:"model/list",params:{limit:100,includeHidden:true,cursor:message.result.nextCursor}});
          else listed=true;
        }
        if(message.id===3)config=message.result?.config || {};
        if(listed && config){finish(models.length?null:new Error("CLI returned no available models"));return;}
      }
    });
    send({id:1,method:"initialize",params:{clientInfo:{name:"firefox_relay",version:"0.10.2"}}});
  });
}
module.exports={launchSpec,startCommand,stopProcess,readCapabilities,npmNativeSpec};
