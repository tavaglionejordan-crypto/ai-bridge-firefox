"use strict";
// Raster files only. No HTML/SVG, remote URLs or filenames supplied to uploads.
((root,factory)=>{const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.RelayMedia=api;})(globalThis,()=>{
  const MAX_FILES=4,MAX_FILE=8*1024*1024,MAX_TOTAL=24*1024*1024;
  const types={'image/png':['png','iVBORw0KGgo'],'image/jpeg':['jpg','/9j/'],'image/webp':['webp','UklGR'],'image/gif':['gif','R0lGOD']};
  const validate=images=>{
    if(!Array.isArray(images)||images.length>MAX_FILES)throw new Error('Image relay supports up to 4 images per message');
    let total=0;
    return images.map((image,index)=>{
      const match=typeof image?.data==='string'&&/^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/.exec(image.data);
      if(!match || match[2].length%4 || !match[2].startsWith(types[match[1]][1]))throw new Error('Image relay received an invalid or unsupported image file');
      const size=match[2].length*3/4-(match[2].endsWith('==')?2:match[2].endsWith('=')?1:0);
      total+=size;if(!size||size>MAX_FILE||total>MAX_TOTAL)throw new Error('Image relay limit: 8 MiB per image, 24 MiB per message');
      return {name:`relay-image-${index+1}.${types[match[1]][0]}`,type:match[1],size,data:image.data};
    });
  };
  const allowedURL=(value,origin)=>{
    try{
      const url=new URL(value),source=new URL(origin);
      if(url.username||url.password||url.protocol!=='https:'||url.port)return false;
      if(source.hostname==='grok.com')return ['grok.com','assets.grok.com','imagine-public.x.ai'].includes(url.hostname);
      if(source.hostname==='gemini.google.com')return ['gemini.google.com','lh3.googleusercontent.com','lh3.google.com'].includes(url.hostname);
      if(['chatgpt.com','chat.openai.com'].includes(source.hostname))return url.origin===source.origin || /(?:^|\.)oaiusercontent\.com$/.test(url.hostname);
    }catch{}
    return false;
  };
  const readResponse=async response=>{
    const type=response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    if(!response.ok)throw new Error(`Image request returned HTTP ${response.status}; the authenticated resource may be unavailable or denied`);
    if(!types[type])throw new Error(`Image response is ${type || 'missing a content type'}, not a supported raster file; a login or download page is not image data`);
    if(Number(response.headers.get('content-length'))>MAX_FILE)throw new Error('Image exceeds 8 MiB');
    const reader=response.body?.getReader();let parts=[],size=0;
    if(!reader)throw new Error('Image download stream is unavailable');
    try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>MAX_FILE)throw new Error('Image exceeds 8 MiB');parts.push(value);}}
    finally{await reader.cancel().catch(()=>{});}
    const bytes=new Uint8Array(size);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}
    let binary='';for(let i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode(...bytes.subarray(i,i+32768));
    return validate([{data:`data:${type};base64,${btoa(binary)}`}])[0];
  };
  return {validate,allowedURL,readResponse,MAX_FILES,MAX_FILE,MAX_TOTAL};
});
