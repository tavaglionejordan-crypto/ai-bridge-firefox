"use strict";
((root)=>{
  const LIMIT=500_000_000;
  const sha=async bytes=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(v=>v.toString(16).padStart(2,'0')).join('');
  const request=value=>new Promise((resolve,reject)=>{value.onsuccess=()=>resolve(value.result);value.onerror=()=>reject(value.error);});
  function create({dbName='ai-bridge-outputs',limit=LIMIT}={}){
    let opening,chain=Promise.resolve();
    const db=()=>opening ||= new Promise((resolve,reject)=>{const open=indexedDB.open(dbName,2);open.onupgradeneeded=()=>{for(const [name,keyPath] of [['outputs','id'],['blobs','hash'],['snapshots','id'],['deleted','id']])if(!open.result.objectStoreNames.contains(name))open.result.createObjectStore(name,{keyPath});};open.onsuccess=()=>{open.result.onversionchange=()=>open.result.close();resolve(open.result);};open.onblocked=()=>reject(Error('Close older Outputs tabs and reload the extension to upgrade local storage'));open.onerror=()=>reject(open.error);});
    const all=async store=>request((await db()).transaction(store).objectStore(store).getAll());
    const serial=work=>{const next=chain.catch(()=>{}).then(work);chain=next;return next;};
    const commit=async work=>{const tx=(await db()).transaction(['outputs','blobs','snapshots','deleted'],'readwrite');const done=new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error || Error('Library write failed'));});work(tx);await done;};
    const readRow=async row=>{if(!row?.available)throw Error(row?.error || 'Output bytes are unavailable');const blob=await request((await db()).transaction('blobs').objectStore('blobs').get(row.hash));if(!blob)throw Error('Output bytes were not retained');const bytes=new Uint8Array(await blob.data.arrayBuffer());if(await sha(bytes)!==row.hash)throw Error('Output integrity check failed');return {...row,data:root.RelayFiles.encode(bytes,row.type)};};
    const clean=async(removedOutputs=[],removedSnapshot=null)=>{const rows=await all('outputs'),snapshots=await all('snapshots'),blobs=await all('blobs'),refs=new Set([...rows.filter(row=>!removedOutputs.includes(row.id)),...snapshots.filter(row=>row.id!==removedSnapshot).flatMap(row=>row.assets)].map(row=>row.hash));await commit(tx=>{for(const id of removedOutputs){tx.objectStore('outputs').delete(id);tx.objectStore('deleted').put({id});}if(removedSnapshot)tx.objectStore('snapshots').delete(removedSnapshot);for(const blob of blobs)if(!refs.has(blob.hash))tx.objectStore('blobs').delete(blob.hash);});};
    return {
      list:async()=>{await chain.catch(()=>{});return (await all('outputs')).sort((a,b)=>b.createdAt-a.createdAt);},
      stats:async()=>{await chain.catch(()=>{});const blobs=await all('blobs');return {bytes:blobs.reduce((sum,row)=>sum+row.size,0),limit};},
      put:(metadata,file,pin=null)=>serial(async()=>{
        if(await request((await db()).transaction('deleted').objectStore('deleted').get(metadata.id)))return {...metadata,available:false,deleted:true,error:'Output was deleted before capture'};
        const bytes=file?root.RelayFiles.bytes(file):null,hash=bytes?await sha(bytes):null,rows=await all('outputs'),blobs=await all('blobs'),snapshots=await all('snapshots');
        const existing=rows.find(row=>row.id===metadata.id);if(existing?.available&&!file&&!pin)return existing;
        const used=blobs.reduce((sum,row)=>sum+row.size,0),extra=hash&&!blobs.some(row=>row.hash===hash)?bytes.length:0;if(used+extra>limit)throw Error('Outputs library is full. Delete outputs to resume automatic saving.');
        const row=existing?.available&&!file?existing:{...metadata,name:root.RelayFiles.name(metadata.name || file?.name),type:file?.type || metadata.type || '',size:bytes?.length || 0,hash,available:!!bytes,createdAt:metadata.createdAt || Date.now()};
        await commit(tx=>{if(hash)tx.objectStore('blobs').put({hash,size:bytes.length,data:new Blob([bytes],{type:file.type})});tx.objectStore('outputs').put(row);
          if(pin){const prior=snapshots.find(item=>item.id===pin.id);tx.objectStore('snapshots').put({...prior,...pin,assets:[...(prior?.assets || []).filter(asset=>asset.id!==row.id),...(row.available?[row]:[])]});}
          if(existing?.hash&&existing.hash!==row.hash&&!rows.some(other=>other.id!==row.id&&other.hash===existing.hash)&&!snapshots.some(item=>item.assets.some(asset=>asset.hash===existing.hash)))tx.objectStore('blobs').delete(existing.hash);});return row;
      }),
      metadata:async id=>{await chain.catch(()=>{});return request((await db()).transaction('snapshots').objectStore('snapshots').get(id));},
      readPinned:async(id,ids)=>{await chain.catch(()=>{});const snapshot=await request((await db()).transaction('snapshots').objectStore('snapshots').get(id));if(!snapshot)throw Error('Result bundle is unavailable');return Promise.all(ids.map(key=>readRow(snapshot.assets.find(row=>row.id===key))));},
      updateSnapshot:(id,metadata)=>serial(async()=>{const prior=await request((await db()).transaction('snapshots').objectStore('snapshots').get(id));await commit(tx=>tx.objectStore('snapshots').put({assets:[],...prior,...metadata,id}));}),
      freezeData:(id,inputs,metadata)=>serial(async()=>{const previous=await request((await db()).transaction('snapshots').objectStore('snapshots').get(id));if(previous){if(previous.inputHash!==metadata.inputHash)throw Error('Prepared input identity conflict');return previous;}
        const blobs=await all('blobs'),known=new Set(blobs.map(row=>row.hash)),added=[],assets=[];let used=blobs.reduce((sum,row)=>sum+row.size,0);
        for(const input of inputs){const bytes=root.RelayFiles.bytes(input),hash=await sha(bytes);if(!known.has(hash)){used+=bytes.length;if(used>limit)throw Error('Dependency inputs exceed the library storage budget');known.add(hash);added.push({hash,size:bytes.length,data:new Blob([bytes],{type:input.type})});}assets.push({...input,data:undefined,hash,size:bytes.length,available:true,id:input.id || hash});}
        const snapshot={...metadata,id,assets};await commit(tx=>{for(const blob of added)tx.objectStore('blobs').put(blob);tx.objectStore('snapshots').put(snapshot);});return snapshot;
      }),
      read:async id=>{await chain.catch(()=>{});return readRow(await request((await db()).transaction('outputs').objectStore('outputs').get(id)));},
      remove:ids=>serial(()=>clean(ids)),
      freeze:(id,ids,metadata)=>serial(async()=>{const existing=await request((await db()).transaction('snapshots').objectStore('snapshots').get(id));if(existing){if(existing.inputHash!==metadata.inputHash)throw Error('Queue request ID conflicts with another selection');return existing;}const rows=await all('outputs'),assets=ids.map(key=>{const row=rows.find(value=>value.id===key);if(!row?.available)throw Error('A selected output is unavailable or was deleted');return row;});const snapshot={...metadata,id,assets};await commit(tx=>tx.objectStore('snapshots').put(snapshot));return snapshot;}),
      snapshots:()=>all('snapshots'),
      snapshot:async id=>{await chain.catch(()=>{});const row=await request((await db()).transaction('snapshots').objectStore('snapshots').get(id));return row?{...row,assets:await Promise.all(row.assets.map(readRow))}:null;},
      release:id=>serial(()=>clean([],id)),
      close:async()=>{(await db()).close();}
    };
  }
  root.RelayLibrary={create,LIMIT,sha};
})(globalThis);
