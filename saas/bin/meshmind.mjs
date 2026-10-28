#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

const usage = `MeshMind CLI — JSON output for people and Agents

Usage: meshmind [--hub URL] [--token-file PATH] <command>

  discover                         Public API and MCP entry points
  whoami                           Show the current principal
  devices list                     List devices visible to this credential
  devices status DEVICE_ID         Read status (printer, ADB, ESP32 or HA)
  devices ui DEVICE_ID             Read Android UI XML
  actions list                     List this credential's action records
  actions printer DEVICE_ID ACTION [--idempotency-key KEY]
                                   Request pause, resume or stop; owner approval required
  actions device DEVICE_ID ACTION [--idempotency-key KEY]
                                   Request a locally predeclared USB or LAN action
  actions adb DEVICE_ID --input-json JSON --execute [--idempotency-key KEY]
                                   Execute granted Android input immediately
  api METHOD /api/v1/PATH [--data JSON]
                                   Call a versioned Hub API endpoint

Environment: MESHMIND_HUB, MESHMIND_TOKEN_FILE, MESHMIND_TOKEN.
Prefer a 0600 token file. Never put a token in a command-line argument.
All results are JSON on stdout; errors are JSON on stderr.`;

export class CliError extends Error {
  constructor(message, exitCode = 2, status) { super(message); this.exitCode = exitCode; this.status = status; }
}

function parse(argv, env) {
  const args = [];
  const options = { hub: env.MESHMIND_HUB ?? "http://localhost:8788", tokenFile: env.MESHMIND_TOKEN_FILE,
    token: env.MESHMIND_TOKEN, data: undefined, inputJson: undefined, execute: false, idempotencyKey: undefined };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--execute") { options.execute = true; continue; }
    if (arg === "--help") { args.push("help"); continue; }
    const key = { "--hub": "hub", "--token-file": "tokenFile", "--data": "data", "--input-json": "inputJson", "--idempotency-key": "idempotencyKey" }[arg];
    if (key) {
      if (!argv[i + 1] || argv[i + 1].startsWith("--")) throw new CliError(`${arg} needs a value`);
      options[key] = argv[++i]; continue;
    }
    if (arg.startsWith("--")) throw new CliError(`Unknown option: ${arg}`);
    args.push(arg);
  }
  let hub;
  try { hub = new URL(options.hub); } catch { throw new CliError("Invalid Hub URL"); }
  if (!(["https:", "http:"].includes(hub.protocol)) || hub.username || hub.password || hub.search || hub.hash || hub.pathname !== "/")
    throw new CliError("Hub must be an HTTP(S) origin without credentials, path or query");
  if (hub.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(hub.hostname))
    throw new CliError("Remote Hubs require HTTPS");
  options.hub = hub.origin;
  return { args, options };
}

function deviceId(value) {
  if (!/^dev_[a-f0-9]{24}$/.test(value ?? "")) throw new CliError("Expected a device ID such as dev_...");
  return value;
}
function jsonValue(value, option) {
  try { return JSON.parse(value); } catch { throw new CliError(`${option} must contain valid JSON`); }
}
function pathOnly(value) {
  if (!/^\/api\/v1(?:\/|$)/.test(value ?? "")) throw new CliError("api path must begin with /api/v1/");
  const parsed = new URL(value, "https://meshmind.invalid");
  if (parsed.origin !== "https://meshmind.invalid" || !/^\/api\/v1(?:\/|$)/.test(parsed.pathname) || parsed.hash || parsed.username || parsed.password || value.startsWith("//"))
    throw new CliError("api path must be relative to the Hub");
  return parsed.pathname + parsed.search;
}
function apiError(status, payload) {
  const message = typeof payload?.error === "string" ? payload.error : `Hub returned HTTP ${status}`;
  return new CliError(message, status === 401 ? 3 : status === 403 || status === 404 ? 4 : 5, status);
}

export async function runCli(argv = process.argv.slice(2), env = process.env, fetcher = fetch) {
  const { args, options } = parse(argv, env);
  if (args.length === 0 || args[0] === "help" || args[0] === "--help") return { help: usage };
  let path, method = "GET", input;
  const [command, subcommand, id, extra] = args;
  if (command === "discover" && args.length === 1) path = "/.well-known/meshmind.json";
  else if (command === "whoami" && args.length === 1) path = "/api/v1/session";
  else if (command === "devices" && subcommand === "list" && args.length === 2) path = "/api/v1/devices";
  else if (command === "devices" && subcommand === "status" && args.length === 3) {
    path = `/api/v1/devices/${deviceId(id)}/state`;
  } else if (command === "devices" && subcommand === "ui" && args.length === 3) path = `/api/v1/devices/${deviceId(id)}/adb-ui`;
  else if (command === "actions" && subcommand === "list" && args.length === 2) path = "/api/v1/approvals";
  else if (command === "actions" && subcommand === "printer" && args.length === 4) {
    deviceId(id);
    if (!["pause", "resume", "stop"].includes(extra)) throw new CliError("Printer action must be pause, resume or stop");
    method = "POST"; path = `/api/v1/devices/${id}/actions`;
    input = { action: extra, idempotencyKey: options.idempotencyKey ?? randomUUID() };
  } else if (command === "actions" && subcommand === "device" && args.length === 4) {
    deviceId(id);
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(extra ?? "")) throw new CliError("Device action must be a name returned by devices list");
    method = "POST"; path = `/api/v1/devices/${id}/device-actions`;
    input = { action: extra, idempotencyKey: options.idempotencyKey ?? randomUUID() };
  } else if (command === "actions" && subcommand === "adb" && args.length === 3) {
    deviceId(id);
    if (!options.execute) throw new CliError("ADB input executes immediately. Add --execute to authorize this invocation");
    if (!options.inputJson) throw new CliError("ADB input requires --input-json");
    method = "POST"; path = `/api/v1/devices/${id}/adb-actions`;
    input = { input: jsonValue(options.inputJson, "--input-json"), idempotencyKey: options.idempotencyKey ?? randomUUID() };
  } else if (command === "api" && args.length === 3) {
    method = subcommand.toUpperCase();
    if (!["GET", "POST", "DELETE"].includes(method)) throw new CliError("api method must be GET, POST or DELETE");
    path = pathOnly(id);
    if (options.data !== undefined) {
      if (method !== "POST") throw new CliError("--data is supported only for POST");
      input = jsonValue(options.data, "--data");
    }
  } else throw new CliError("Unknown command. Run meshmind help for usage");

  if (options.idempotencyKey && !/^[A-Za-z0-9_-]{8,100}$/.test(options.idempotencyKey)) throw new CliError("Invalid idempotency key");
  if (options.execute && !(command === "actions" && subcommand === "adb")) throw new CliError("--execute is only for actions adb");
  if (options.idempotencyKey && command !== "actions") throw new CliError("--idempotency-key is only for actions");
  if (options.inputJson !== undefined && !(command === "actions" && subcommand === "adb")) throw new CliError("--input-json is only for actions adb");
  if (options.data !== undefined && command !== "api") throw new CliError("--data is only for api");

  let token = path === "/.well-known/meshmind.json" ? undefined : options.token;
  if (options.tokenFile && path !== "/.well-known/meshmind.json") {
    try { token = (await readFile(options.tokenFile, "utf8")).trim(); }
    catch { throw new CliError("Cannot read token file", 3); }
  }
  if (path !== "/.well-known/meshmind.json" && !token) throw new CliError("Set MESHMIND_TOKEN_FILE to an Agent credential file", 3);
  let response;
  try {
    response = await fetcher(options.hub + path, { method, redirect: "error", headers: {
      ...(token && path !== "/.well-known/meshmind.json" ? { authorization: `Bearer ${token}` } : {}),
      ...(input !== undefined ? { "content-type": "application/json" } : {}),
      accept: "application/json",
    }, body: input === undefined ? undefined : JSON.stringify(input), signal: AbortSignal.timeout(15_000) });
  } catch { throw new CliError("Could not reach the Hub", 6); }
  let payload;
  try { payload = await response.json(); } catch { throw new CliError("Hub returned invalid JSON", 5, response.status); }
  if (!response.ok) throw apiError(response.status, payload);
  return payload;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  runCli().then(value => {
    if ("help" in value) process.stdout.write(value.help + "\n");
    else process.stdout.write(JSON.stringify(value) + "\n");
  }).catch(error => {
    const err = error instanceof CliError ? error : new CliError("Unexpected CLI failure", 5);
    process.stderr.write(JSON.stringify({ error: { message: err.message, status: err.status ?? null } }) + "\n");
    process.exitCode = err.exitCode;
  });
}
