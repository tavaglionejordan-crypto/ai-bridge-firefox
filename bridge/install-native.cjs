"use strict";
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const {EXTENSION_ID,HOST_NAME}=require('./native-host.cjs');
const KEY='HKCU\\Software\\Mozilla\\NativeMessagingHosts\\'+HOST_NAME;
function register(manifest){
  if(process.platform!=='win32')throw new Error('This installer registers the Windows Firefox helper');
  const prior=spawnSync('reg.exe',['query',KEY,'/ve'],{encoding:'utf8',windowsHide:true});
  if(prior.status===0){
    const value=prior.stdout.match(/REG_SZ\s+([^\r\n]+)/)?.[1].trim();
    if(!value || path.resolve(value).toLowerCase()!==manifest.toLowerCase())throw new Error('A different AI Bridge helper is already registered; its registration was preserved');
  }
  const result=spawnSync('reg.exe',['add',KEY,'/ve','/t','REG_SZ','/d',manifest,'/f'],{encoding:'utf8',windowsHide:true});
  if(result.error || result.status!==0)throw new Error('Could not register the Firefox helper for this Windows account');
}
function installNative({root=path.resolve(__dirname,'..'),node=process.execPath,registerHost=register}={}){
  const script=path.join(root,'bridge','native-host.cjs');
  if(!fs.statSync(node).isFile() || !fs.statSync(script).isFile())throw new Error('Node or native host is missing');
  if(/["\r\n]/.test(node+script))throw new Error('Unsupported installer path');
  const folder=path.join(root,'native');fs.mkdirSync(folder,{recursive:true});
  const batch=path.join(folder,'native-host.cmd'),manifest=path.join(folder,HOST_NAME+'.json');
  fs.writeFileSync(batch,'@echo off\r\nsetlocal DisableDelayedExpansion\r\n"'+node.replaceAll('%','%%')+'" "'+script.replaceAll('%','%%')+'" %*\r\n');
  fs.writeFileSync(manifest,JSON.stringify({name:HOST_NAME,description:'AI Bridge local authenticated connection',path:batch,type:'stdio',allowed_extensions:[EXTENSION_ID]},null,2));
  registerHost(manifest);return {manifest,batch,key:KEY};
}
if(require.main===module){
  try{installNative();console.log('One-click connection installed for your Windows account. Reload the AI Bridge add-on once, then click its icon on a ChatGPT tab.');}
  catch(error){console.error('Setup failed: '+error.message);process.exitCode=1;}
}
module.exports={installNative,KEY};
