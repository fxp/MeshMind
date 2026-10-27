import assert from "node:assert/strict";
import { parseArgs } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startGateway, localConfig, validateHub } from "../src/gateway.ts";

const {values}=parseArgs({options:{hub:{type:"string"},"owner-cookie-file":{type:"string"}}});
if(!values.hub) throw new Error("Specify --hub and optionally --owner-cookie-file for an existing owner");
const hub=validateHub(values.hub), dir=await mkdtemp(join(tmpdir(),"meshmind-cloudflare-smoke-"));
let cookie=values["owner-cookie-file"] ? (await readFile(values["owner-cookie-file"],"utf8")).trim() : undefined;
let gateway:Awaited<ReturnType<typeof startGateway>>|undefined, gatewayId:string|undefined, principalId:string|undefined;
const client=new Client({name:"meshmind-deployment-check",version:"1.0.0"});
const api=async(path:string,value?:unknown,auth=cookie,method?:string)=>{
 const r=await fetch(hub+path,{method:method??(value===undefined?"GET":"POST"),redirect:"error",
 headers:{origin:hub,"content-type":"application/json",...(auth?.startsWith("meshmind_session=")?{cookie:auth}:auth?{authorization:`Bearer ${auth}`}:{})},
 body:value===undefined?undefined:JSON.stringify(value),signal:AbortSignal.timeout(20000)});
 return {status:r.status,value:await r.json() as any,cookie:r.headers.get("set-cookie")?.split(";")[0]};
};
const unpack=(r:any)=>JSON.parse(r.content[0].text);
let checks=0;
const checked=(name:string)=>{checks++;console.log(`PASS ${name}`);};
try {
 assert.equal((await api("/health")).status,200);checked("HTTPS / HTTP health endpoint");
 if(!cookie){
  assert.ok(new URL(hub).hostname==="localhost"||new URL(hub).hostname==="127.0.0.1","Public checks require an existing owner's cookie file");
  const owner=await api("/api/register",{email:`cf-${crypto.randomUUID()}@example.test`,password:crypto.randomUUID()+crypto.randomUUID()},undefined);
  assert.equal(owner.status,201);cookie=owner.cookie!;
 }
 assert.equal((await api("/api/session")).value.owner,true);checked("owner session and persistent account storage");
 const created=await api("/api/gateways",{name:"部署验证 · 模拟网关"});assert.equal(created.status,201);gatewayId=created.value.gatewayId;
 gateway=await startGateway({stateFile:join(dir,"gateway.json"),enrollment:created.value.enrollment,
 config:localConfig.parse({devices:[{localId:"deploy-simulator",name:"部署验证 · 模拟 X1C",model:"Simulated X1C",connector:"simulator",allowControl:true}]})});
 const deadline=Date.now()+15000;
 let device:any;
 while(Date.now()<deadline){device=(await api("/api/devices")).value.devices.find((d:any)=>d.gatewayId===gatewayId&&d.online);if(device)break;await new Promise(r=>setTimeout(r,100));}
 assert.ok(device,"Gateway WebSocket did not authenticate");checked("outbound gateway WebSocket challenge and registration");
 const grant=await api("/api/principals",{name:"部署验证 · MCP",kind:"agent",devices:[device.id],permissions:["status","pause"],expiresInHours:1});
 assert.equal(grant.status,201);principalId=grant.value.id;
 await client.connect(new StreamableHTTPClientTransport(new URL(hub+"/mcp"),{requestInit:{headers:{authorization:`Bearer ${grant.value.token}`}}}));
 assert.equal((await client.listTools()).tools.length,8);
 for(let i=0;i<20;i++) assert.equal((await client.listTools()).tools.length,8);
 checked("official MCP HTTP client initialize, repeated requests and tools listing");
 const status=unpack(await client.callTool({name:"printer_status",arguments:{deviceId:device.id}}));
 assert.equal(status.status.progress,42);assert.equal(status.stale,false);checked("MCP reads state through the authenticated gateway");
 assert.equal((await api("/api/gateways",undefined,grant.value.token)).status,403);checked("agent cannot administer gateways");
 const pending=unpack(await client.callTool({name:"request_printer_action",arguments:{deviceId:device.id,action:"pause",idempotencyKey:crypto.randomUUID()}})).approval;
 assert.equal(pending.state,"pending");assert.equal((await api(`/api/devices/${device.id}/status`)).value.status.state,"RUNNING");
 assert.equal((await api(`/api/approvals/${pending.id}/approve`,{})).value.state,"completed");
 assert.equal(unpack(await client.callTool({name:"printer_status",arguments:{deviceId:device.id}})).status.state,"PAUSE");checked("physical action policy requires approval; simulator only");
 assert.equal((await api(`/api/principals/${principalId}`,undefined,cookie,"DELETE")).status,200);
 await assert.rejects(client.callTool({name:"list_devices"}));checked("revocation invalidates an initialized MCP client");
 assert.equal((await api(`/api/gateways/${gatewayId}`,undefined,cookie,"DELETE")).status,200);
 assert.equal((await api("/api/devices")).value.devices.some((d:any)=>d.id===device.id),false);checked("gateway revocation removes simulated devices");
 console.log(JSON.stringify({ok:true,checks,hub,realHardwareUsed:false}));
} finally {
 await client.close(); gateway?.stop();
 if(principalId) await api(`/api/principals/${principalId}`,undefined,cookie,"DELETE").catch(()=>{});
 if(gatewayId) await api(`/api/gateways/${gatewayId}`,undefined,cookie,"DELETE").catch(()=>{});
 await rm(dir,{recursive:true,force:true});
}
