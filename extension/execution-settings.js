"use strict";
// Shared by the popup/background and Node bridge. No YAML evaluation or coercion.
((root, factory) => {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.RelayExecution = api;
})(globalThis, () => {
  const DEFAULTS = Object.freeze({model:"default", reasoning:"default", timeout_minutes:30});
  const EFFORTS = ["none","minimal","low","medium","high","xhigh","max","ultra"];
  const LABELS = {default:"Codex default",none:"None",minimal:"Minimal",low:"Low",medium:"Medium",high:"High",xhigh:"Extra High",max:"Max",ultra:"Ultra"};
  function validate(value = {}) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Execution settings must be an object");
    for (const key of Object.keys(value)) if (!Object.hasOwn(DEFAULTS,key)) throw new Error(`Unknown execution setting: ${key}`);
    const result = {...DEFAULTS,...value};
    if(typeof result.reasoning==="string") result.reasoning=result.reasoning.trim().toLowerCase().replace(/^extra[ _-]*high$/,"xhigh");
    if (typeof result.model !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(result.model)) throw new Error("Invalid model ID: use 1-128 letters, numbers, dots, slashes, colons, underscores or hyphens");
    if (typeof result.reasoning !== "string" || !["default",...EFFORTS].includes(result.reasoning)) throw new Error(`Unsupported reasoning level: ${String(result.reasoning)}. Use default, ${EFFORTS.join(", ")}`);
    if (typeof result.timeout_minutes !== "number" || !Number.isFinite(result.timeout_minutes) || result.timeout_minutes < 0.01 || result.timeout_minutes > 1440) throw new Error("Timeout must be a number from 0.01 to 1440 minutes");
    return result;
  }
  function parseTask(raw) {
    // Only a consecutive header at the very beginning is metadata. Everything
    // after it, including Windows paths, indentation and code fences, is sliced
    // directly from the original string without normalizing its bytes.
    const lines = [...raw.matchAll(/[^\r\n]*(?:\r\n|\n|\r|$)/g)].filter(m=>m[0]);
    let i=0, wrapped=false, delimiter=null;
    while (i<lines.length && !lines[i][0].trim()) i++;
    if (/^CODEX_TASK:?\s*$/i.test(lines[i]?.[0].trim() || "")) {wrapped=true;i++;}
    while (i<lines.length && !lines[i][0].trim()) i++;
    const bodyIndex=lines[i]?.index ?? raw.length;
    if (["---","```yaml","```yml"].includes(lines[i]?.[0].trim())) {delimiter=lines[i][0].trim()==="---"?"---":"```";i++;}
    const unwrapped = () => raw.slice(bodyIndex).replace(/(?:^|\r\n|\n|\r)END_CODEX_TASK\s*$/i,"");
    if (!/^\s*(model|reasoning|timeout_minutes)\s*:/i.test(lines[i]?.[0] || "")) {
      const prompt=wrapped ? unwrapped() : raw;
      if(!prompt.trim())throw new Error("Task prompt is empty after execution metadata");
      return {prompt,overrides:{}};
    }
    const overrides={};
    for (;i<lines.length;i++) {
      const line=lines[i][0].trim();
      if (delimiter && line===delimiter) {i++;delimiter=null;break;}
      if (!line) {if (delimiter) continue;i++;break;}
      const match=line.match(/^(model|reasoning|timeout_minutes)\s*:\s*(.*?)\s*$/i);
      if (!match) {
        if (delimiter || /^[a-z_]+\s*:/.test(line)) throw new Error(`Invalid execution metadata line: ${line}`);
        break;
      }
      const key=match[1].toLowerCase(),scalar=match[2];
      if (Object.hasOwn(overrides,key)) throw new Error(`Duplicate execution setting: ${key}`);
      const value=scalar.replace(/^(?:"([^"\r\n]*)"|'([^'\r\n]*)')$/,(_,a,b)=>a??b);
      overrides[key]=key==="timeout_minutes" && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : value;
    }
    if (delimiter) throw new Error("Unclosed execution metadata header");
    const normalized=validate(overrides);
    if(Object.hasOwn(overrides,"reasoning"))overrides.reasoning=normalized.reasoning;
    let prompt=raw.slice(lines[i]?.index ?? raw.length);
    if (wrapped) prompt=prompt.replace(/(?:\r\n|\n|\r)END_CODEX_TASK\s*$/i,"");
    if (!prompt.trim()) throw new Error("Task prompt is empty after execution metadata");
    return {prompt,overrides};
  }
  function resolve(defaults, overrides, catalog) {
    // Validate after merging: a task override can repair an obsolete saved ID.
    const settings=validate({...DEFAULTS,...defaults,...overrides});
    const modelId=settings.model==="default" ? catalog.defaultModel : settings.model;
    const model=catalog.models.find(m=>m.id===modelId);
    if (!modelId) throw new Error("Codex did not report a default model; specify an exact model ID");
    const reasoning=settings.reasoning==="default" ? (catalog.defaultReasoning || model?.defaultReasoning) : settings.reasoning;
    if (model && reasoning && !model.efforts.includes(reasoning)) throw new Error(`Model '${modelId}' does not support reasoning '${reasoning}'. Supported: ${model.efforts.join(", ") || "none"}`);
    // model/list is discovery, not an allowlist. New/custom IDs go unchanged to
    // exec; only Codex can decide whether this account/provider supports them.
    return {settings,effective:{model:modelId,modelName:model?.name || modelId,reasoning:reasoning || null,timeout_minutes:settings.timeout_minutes}};
  }
  function validateCommand(value) {
    if(!value || typeof value!=="object" || Array.isArray(value)) throw new Error("Settings command must be an object");
    const {action,...settings}=value;
    if(!["set_defaults","get_defaults"].includes(action)) throw new Error("Settings action must be set_defaults or get_defaults");
    if(action==="get_defaults" && Object.keys(settings).length) throw new Error("get_defaults does not accept settings");
    if(action==="set_defaults" && !Object.keys(settings).length) throw new Error("set_defaults requires at least one setting");
    const normalized=validate(settings);
    return {action,...Object.fromEntries(Object.keys(settings).map(key=>[key,normalized[key]]))};
  }
  function parseSettings(raw) {
    if(typeof raw!=="string") throw new Error("Settings command must be text");
    const lines=raw.trim().split(/\r\n|\n|\r/);
    if(!/^CODEX_SETTINGS:?$/i.test(lines.shift()?.trim() || "") || !/^END_CODEX_SETTINGS$/i.test(lines.pop()?.trim() || "")) throw new Error("Settings command requires complete CODEX_SETTINGS / END_CODEX_SETTINGS markers");
    const value={};
    for(const line of lines){
      if(!line.trim())continue;
      const match=line.match(/^\s*(action|model|reasoning|timeout_minutes)\s*:\s*(.*?)\s*$/i);
      if(!match)throw new Error("Invalid settings command line (expected action, model, reasoning or timeout_minutes)");
      const key=match[1].toLowerCase();if(Object.hasOwn(value,key))throw new Error(`Duplicate settings key: ${key}`);
      const scalar=match[2].replace(/^(?:"([^"\r\n]*)"|'([^'\r\n]*)')$/,(_,a,b)=>a??b);
      value[key]=key==="timeout_minutes" && /^\d+(?:\.\d+)?$/.test(scalar)?Number(scalar):scalar;
    }
    return validateCommand(value);
  }
  function describe(execution) {
    if (!execution) return "Execution settings unavailable";
    const e=execution.effective || execution;
    return `Model: ${e.modelName || (e.model==="default" ? "Codex default" : e.model)} | Thinking: ${LABELS[e.reasoning] || e.reasoning || "Codex default"} | Timeout: ${e.timeout_minutes} minutes`;
  }
  return {DEFAULTS,EFFORTS,LABELS,validate,parseTask,resolve,describe,parseSettings,validateCommand};
});
