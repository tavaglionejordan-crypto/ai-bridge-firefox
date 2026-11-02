"use strict";
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {createRelayServer,DEFAULT_PROJECT_DIR}=require('./server.cjs');
const EXTENSION_ID='codex-relay-local@example.invalid';
const HOST_NAME='ai_bridge_firefox';
function savedToken(stateDir){
  fs.mkdirSync(stateDir,{recursive:true});const file=path.join(stateDir,'token');
  if(!fs.existsSync(file))try{fs.writeFileSync(file,crypto.randomBytes(24).toString('hex'),{mode:0o600,flag:'wx'});}catch(error){if(error.code!=='EEXIST')throw error;}
  const token=fs.readFileSync(file,'utf8').trim();
  if(!/^[a-f0-9]{48}$/.test(token))throw new Error('Invalid saved bridge token');
  return token;
}
function frame(value){const bytes=Buffer.from(JSON.stringify(value)),header=Buffer.alloc(4);header.writeUInt32LE(bytes.length);return Buffer.concat([header,bytes]);}
function createNativeHost({input,output,port=37987,projectDir=DEFAULT_PROJECT_DIR,stateDir=path.join(__dirname,'.state'),createServer=createRelayServer}={}){
  let buffer=Buffer.alloc(0),queue=Promise.resolve(),relay=null,ended=false;
  const reply=value=>{if(!ended)output.write(frame(value));};
  const probe=async token=>{
    let response;
    try{response=await fetch(`http://127.0.0.1:${port}/health`,{headers:{'X-Relay-Token':token},signal:AbortSignal.timeout(2500),redirect:'error'});}
    catch(error){if(error.cause?.code==='ECONNREFUSED')return null;throw new Error('Local bridge did not answer; check the existing bridge process');}
    if(!response.ok)throw new Error('Another bridge is using this port with different credentials. Close that bridge before reconnecting.');
    const health=await response.json();
    if(health.integrityVersion!==1 || health.settingsCommandsVersion!==1)throw new Error('Restart the older bridge once to load the updated relay');
    return health;
  };
  const connect=async()=>{
    const token=savedToken(stateDir);let health=await probe(token);
    if(!health){
      const candidate=createServer({projectDir,stateDir,token});
      try{
        await new Promise((resolve,reject)=>{candidate.server.once('error',reject);candidate.server.listen(port,'127.0.0.1',resolve);});
        relay=candidate;
      }catch(error){
        if(error.code!=='EADDRINUSE')throw error;
        health=await probe(token);if(!health)throw new Error('Could not start the local bridge');
      }
      health=health || await probe(token);
    }
    return {ok:true,token,health,managed:!!relay};
  };
  const close=async()=>{
    if(ended)return;ended=true;
    if(relay){
      for(const job of relay.jobs.values())if(job.status==='running')relay.cancelJob(job,'Firefox native connection closed');
      relay.server.closeAllConnections();await new Promise(resolve=>relay.server.close(resolve));
    }
  };
  input.on('data',chunk=>{
    buffer=Buffer.concat([buffer,chunk]);
    while(buffer.length>=4){
      const size=buffer.readUInt32LE(0);
      if(size>32768){reply({ok:false,error:'Native message exceeds limit'});void close();input.destroy();return;}
      if(buffer.length<size+4)break;
      const bytes=buffer.subarray(4,size+4);buffer=buffer.subarray(size+4);
      queue=queue.then(async()=>{
        let message;
        try{
          message=JSON.parse(bytes.toString('utf8'));
          if(!message || message.action!=='connect' || typeof message.id!=='string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(message.id) || Object.keys(message).some(key=>!['id','action'].includes(key)))throw new Error('Only the connect action is supported');
          reply({id:message.id,...await connect()});
        }catch(error){reply({id:typeof message?.id==='string'?message.id:null,ok:false,error:error.message});}
      });
    }
  });
  input.on('end',()=>{void queue.finally(close);});input.on('error',()=>{void close();});
  output.on('error',()=>{void close();});
  return {close,get relay(){return relay;}};
}
if(require.main===module){
  // Firefox supplies the manifest path and allowed extension ID. stdout must
  // contain framed messages only; normal bridge logs belong on stderr.
  if(process.argv[3]!==EXTENSION_ID){process.stderr.write('Unauthorized native caller\n');process.exitCode=1;}
  else{
    console.log=(...values)=>console.error(...values);
    createNativeHost({input:process.stdin,output:process.stdout});
  }
}
module.exports={createNativeHost,savedToken,frame,EXTENSION_ID,HOST_NAME};
