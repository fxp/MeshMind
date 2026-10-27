import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { request as httpRequest } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../src/server.ts";
import { startGateway, localConfig } from "../src/gateway.ts";

const unpack = (reply: any) => JSON.parse(reply.content[0].text);

test("remote MCP uses the same scoped device and approval boundaries", async t => {
  const dir = await mkdtemp(join(tmpdir(), "meshmind-http-mcp-"));
  const reservation = createServer(); reservation.listen(0,"127.0.0.1"); await once(reservation,"listening");
  const port = (reservation.address() as {port:number}).port;
  await new Promise<void>(resolve=>reservation.close(()=>resolve()));
  const base = `http://127.0.0.1:${port}`;
  const app = createApp({ database: join(dir, "hub.sqlite"), publicUrl: base, allowSignup: true });
  app.server.listen(port, "127.0.0.1"); await once(app.server, "listening");
  const api = async (path: string, value?: unknown, auth?: string, method?: string) => {
    const response = await fetch(base + path, { method: method ?? (value === undefined ? "GET" : "POST"),
      headers: { origin: base, "content-type": "application/json", ...(auth?.startsWith("meshmind_session=") ? {cookie:auth} : auth ? {authorization:`Bearer ${auth}`} : {}) },
      body: value === undefined ? undefined : JSON.stringify(value) });
    return { status: response.status, value: await response.json() as any, cookie: response.headers.get("set-cookie")?.split(";")[0] };
  };
  const mcpClients: Client[] = [];
  const gateways: Awaited<ReturnType<typeof startGateway>>[] = [];
  const connect = async (token: string) => {
    const client = new Client({ name: "remote-agent-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(base + "/mcp"), { requestInit: {headers: {authorization:`Bearer ${token}`}} });
    mcpClients.push(client); await client.connect(transport); return client;
  };
  try {
    const owner = (await api("/api/register", { email:"http-mcp@example.test", password:"a-long-test-password" })).cookie!;
    const other = (await api("/api/register", { email:"http-mcp-other@example.test", password:"a-long-test-password" })).cookie!;
    const grant = (await api("/api/gateways", {name:"MCP test gateway"}, owner)).value;
    gateways.push(await startGateway({ stateFile:join(dir,"gateway.json"), enrollment:{...grant.enrollment,hub:base},
      config:localConfig.parse({devices:[{localId:"x1c",name:"Remote MCP simulator",model:"X1C",connector:"simulator",allowControl:true}]}) }));
    const deadline = Date.now()+5000;
    while (!app.broker.online(grant.gatewayId)) { if(Date.now()>deadline) throw new Error("Gateway did not connect"); await new Promise(r=>setTimeout(r,20)); }
    const device = (await api("/api/devices",undefined,owner)).value.devices[0];
    const otherGrant = (await api("/api/gateways",{name:"Other tenant gateway"},other)).value;
    gateways.push(await startGateway({stateFile:join(dir,"other-gateway.json"),enrollment:{...otherGrant.enrollment,hub:base},
      config:localConfig.parse({devices:[{localId:"x1c",name:"Other tenant X1C",model:"X1C",connector:"simulator"}]})}));
    const otherDeadline=Date.now()+5000;
    while(!app.broker.online(otherGrant.gatewayId)){if(Date.now()>otherDeadline)throw new Error("Other gateway did not connect");await new Promise(r=>setTimeout(r,20));}
    const otherDevice=(await api("/api/devices",undefined,other)).value.devices[0];
    const otherGrantToken=(await api("/api/principals",{name:"Other reader",kind:"agent",devices:[otherDevice.id],permissions:["status"]},other)).value;
    const otherReader=await connect(otherGrantToken.token);
    const mint = async (name:string, permissions:string[], cookie=owner) => (await api("/api/principals",{name,kind:"agent",devices:[device.id],permissions},cookie)).value;
    const read = await mint("Read-only remote",["status"]);
    const control = await mint("Control remote",["status","pause"]);
    const reader = await connect(read.token), controller = await connect(control.token);

    await t.test("SDK HTTP initialize, tool discovery, listing and real gateway status",async()=>{
      assert.deepEqual((await reader.listTools()).tools.map(x=>x.name).sort(),["adb_status","adb_ui","device_status","list_action_requests","list_devices","printer_status","request_adb_input","request_printer_action"]);
      assert.equal(unpack(await reader.callTool({name:"list_devices"})).devices[0].id,device.id);
      const status = await reader.callTool({name:"printer_status",arguments:{deviceId:device.id}});
      assert.equal(status.isError,false); assert.equal(unpack(status).status.progress,42);
    });
    await t.test("HTTP MCP cannot turn a read token into control or cross tenant access",async()=>{
      const denied = await reader.callTool({name:"request_printer_action",arguments:{deviceId:device.id,action:"pause"}});
      assert.equal(denied.isError,true);
      const foreignId = otherDevice.id;
      assert.equal((await reader.callTool({name:"printer_status",arguments:{deviceId:foreignId}})).isError,true);
      assert.equal((await api(`/api/devices/${device.id}/status`,undefined,other)).status,404);
      assert.equal(unpack(await otherReader.callTool({name:"list_devices"})).devices[0].id,otherDevice.id);
      assert.equal(unpack(await reader.callTool({name:"list_devices"})).devices.length,1);
      assert.equal((await otherReader.callTool({name:"printer_status",arguments:{deviceId:device.id}})).isError,true);
      assert.equal((await api("/api/approvals",undefined,owner)).value.approvals.length,0);
    });
    await t.test("HTTP control only creates an idempotent request and owner approval performs it",async()=>{
      const args={deviceId:device.id,action:"pause",idempotencyKey:"http-mcp-pause-001"};
      const result = await controller.callTool({name:"request_printer_action",arguments:args});
      assert.equal(result.isError,false); const request=unpack(result).approval;
      assert.equal(request.state,"pending");
      assert.equal(unpack(await controller.callTool({name:"request_printer_action",arguments:args})).approval.id,request.id);
      assert.equal(unpack(await reader.callTool({name:"printer_status",arguments:{deviceId:device.id}})).status.state,"RUNNING");
      assert.equal(unpack(await reader.callTool({name:"list_action_requests"})).approvals.length,0);
      assert.equal(unpack(await controller.callTool({name:"list_action_requests"})).approvals.length,1);
      assert.equal((await api(`/api/approvals/${request.id}/approve`,{},other)).status,404);
      assert.equal((await api(`/api/approvals/${request.id}/approve`,{},owner)).value.state,"completed");
      assert.equal(unpack(await reader.callTool({name:"printer_status",arguments:{deviceId:device.id}})).status.state,"PAUSE");
    });
    const raw = (headers:Record<string,string>, body:unknown={jsonrpc:"2.0",id:1,method:"tools/list"}, method="POST", path="/mcp") => fetch(base+path,{
      method,headers:{"content-type":"application/json",accept:"application/json, text/event-stream",...headers},body:method==="POST"?JSON.stringify(body):undefined });
    await t.test("MCP rejects cookies, query credentials, hostile Origin and hostile Host",async()=>{
      assert.equal((await raw({cookie:owner})).status,401);
      assert.equal((await raw({cookie:owner,authorization:"Bearer invalid"})).status,401);
      assert.equal((await raw({},undefined,"POST","/mcp?token="+read.token)).status,401);
      assert.equal((await raw({authorization:`Bearer ${read.token}`,origin:"https://evil.example"})).status,403);
      const badHost = await new Promise<number>(resolve=>{
        const req=httpRequest(base+"/mcp",{method:"POST",headers:{host:"evil.example",authorization:`Bearer ${read.token}`}},res=>{res.resume();resolve(res.statusCode!);});
        req.end();
      });
      assert.equal(badHost,403);
      assert.equal((await raw({authorization:`Bearer ${read.token}`},undefined,"GET")).status,405);
      assert.equal((await raw({authorization:`Bearer ${read.token}`},undefined,"DELETE")).status,405);
    });
    await t.test("malformed and oversized MCP requests are bounded and cannot execute batches",async()=>{
      assert.equal((await raw({authorization:`Bearer ${read.token}`},[{jsonrpc:"2.0",id:1,method:"tools/list"}])).status,400);
      assert.equal((await raw({authorization:`Bearer ${read.token}`},{padding:"x".repeat(70000)})).status,413);
      assert.ok((await reader.listTools()).tools.length===8);
    });
    await t.test("revocation and expiry apply on an already initialized HTTP client",async()=>{
      await api(`/api/principals/${control.id}`,undefined,owner,"DELETE");
      await assert.rejects(controller.callTool({name:"list_devices"}));
      app.store.db.prepare("UPDATE principals SET expires_at=? WHERE id=?").run(Date.now()-1,read.id);
      await assert.rejects(reader.callTool({name:"list_devices"}));
      const audit = JSON.stringify((await api("/api/audit",undefined,owner)).value);
      assert.equal(audit.includes(read.token),false); assert.equal(audit.includes(control.token),false);
    });
  } finally {
    for(const client of mcpClients) await client.close();
    for(const gateway of gateways) gateway.stop(); await app.close(); await rm(dir,{recursive:true,force:true});
  }
});
