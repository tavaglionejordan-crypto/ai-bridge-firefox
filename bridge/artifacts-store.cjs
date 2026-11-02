"use strict";
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const Files=require('../extension/relay-files-v0102.js');
module.exports=function({stateDir,root,fullAccess,hasCredentials}){
  let directory=null;const owned=new Set();
  const dir=()=>{if(!directory){directory=stateDir?path.join(stateDir,'outputs'):fs.mkdtempSync(path.join(os.tmpdir(),'ai-bridge-outputs-'));fs.mkdirSync(directory,{recursive:true});}return directory;};
  const snapshot=(manifest,job)=>{
    if(manifest===undefined)return [];
    if(!Array.isArray(manifest))return [{name:'Output manifest',error:'Codex returned an invalid output-file manifest'}];
    let total=0;
    const result=manifest.slice(0,100).map(item=>{
      const filename=Files.name(typeof item==='string'?item:item?.path),source=typeof item==='string'?item:item?.path;
      try{
        if(typeof source!=='string'||!source.trim())throw Error('Output file path is missing');
        const requested=path.resolve(root,source),real=fs.realpathSync(requested),relative=path.relative(root,real),stat=fs.lstatSync(requested);
        if(!stat.isFile()||stat.isSymbolicLink())throw Error('Only regular output files can be archived');
        if(!fullAccess&&(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative)))throw Error('Output is outside the job workspace');
        if(stat.mtimeMs<job.createdAt-2000)throw Error('File was not created or modified during this job');
        if(stat.size>Files.MAX_FILE||total+stat.size>500_000_000)throw Error('Output exceeds the file export limit');
        const bytes=fs.readFileSync(real);if(bytes.length!==stat.size)throw Error('Output changed while it was being captured');
        if(hasCredentials(bytes.toString('utf8')))throw Error('Output contains credentials and was not exported');
        const artifactId=crypto.randomUUID(),hash=crypto.createHash('sha256').update(bytes).digest('hex');fs.writeFileSync(path.join(dir(),artifactId+'.bin'),bytes,{mode:0o600,flag:'wx'});owned.add(artifactId);total+=bytes.length;
        return {artifactId,name:filename,type:Files.mime(filename),size:bytes.length,hash};
      }catch(error){return {name:filename,error:error.message};}
    });if(manifest.length>100)result.push({name:'Additional outputs',error:'Manifest exceeds the 100-file export limit'});return result;
  };
  const read=(id,metadata)=>{
    if(!/^[a-f0-9-]{36}$/.test(id || ''))throw Error('Unknown output artifact');
    const row=metadata.find(item=>item.artifactId===id);if(!row)throw Error('Unknown output artifact');
    const bytes=fs.readFileSync(path.join(dir(),id+'.bin'));
    if(bytes.length>Files.MAX_FILE||crypto.createHash('sha256').update(bytes).digest('hex')!==row.hash)throw Error('Saved output integrity check failed');
    return {name:row.name,type:row.type,size:bytes.length,hash:row.hash,data:Files.encode(bytes,row.type)};
  };
  const release=(id,metadata)=>{if(!/^[a-f0-9-]{36}$/.test(id || '')||!metadata.some(row=>row.artifactId===id))throw Error('Unknown output artifact');try{fs.unlinkSync(path.join(dir(),id+'.bin'));}catch(error){if(error.code!=='ENOENT')throw error;}owned.delete(id);};
  return {snapshot,read,release,close(){if(stateDir||!directory)return;for(const id of owned)try{fs.unlinkSync(path.join(directory,id+'.bin'));}catch{}try{fs.rmdirSync(directory);}catch{}}};
};
