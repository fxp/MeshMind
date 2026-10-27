import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { adbInput, adbStatus, adbUi, MAX_ADB_UI_XML_BYTES, type AdbInput } from "./schema.ts";
import { toManifest, type Connector, type ConnectorConfig } from "./connectors.ts";

const runFile = promisify(execFile);
const uiAttributes = new Set(["text", "resource-id", "class", "content-desc", "clickable", "enabled", "scrollable", "bounds"]);

function compactUiXml(xml: string, includeClass: boolean): string {
  return xml.replace(/<node\b([^>]*)>/g, (_tag, attributes: string) => {
    const selfClosing = /\/\s*$/.test(attributes);
    const kept: string[] = [];
    for (const match of attributes.matchAll(/([A-Za-z0-9:_-]+)="([^"]*)"/g)) {
      const [, key, rawValue] = match;
      if (!uiAttributes.has(key) || (!includeClass && key === "class") || rawValue === "") continue;
      if (rawValue === "false" && key !== "enabled") continue;
      if (key === "enabled" && rawValue === "true") continue;
      const value = key === "class" ? rawValue.replace(/^android\.(?:widget|view)\./, "") : rawValue;
      kept.push(`${key}="${value}"`);
    }
    return `<node${kept.length ? " " + kept.join(" ") : ""}${selfClosing ? " /" : ""}>`;
  });
}

/** ADB runs only on the gateway host. The remote actor never supplies a shell command. */
export function adbDevice(config: ConnectorConfig): Connector {
  if (!config.adbSerial) throw new Error("缺少本机 ADB 设备序列号");
  const serial = config.adbSerial;
  const executable = config.adbPath ?? "adb";
  const env = { ...process.env };
  for (const key of ["ADB_SERVER_SOCKET", "ADB_SERVER_HOST", "ADB_SERVER_PORT"]) delete env[key];
  let closed = false;
  const run = async (args: string[], maxBuffer = 4096) => {
    if (closed) throw new Error("ADB 连接器已关闭");
    // Force the local ADB server and a single configured device. No shell option is used.
    const result = await runFile(executable, ["-H", "127.0.0.1", "-P", "5037", "-s", serial, ...args],
      { env, timeout: 5000, maxBuffer, windowsHide: true });
    return result.stdout.trim();
  };
  return {
    manifest: toManifest(config),
    async status() {
      if (await run(["get-state"]) !== "device") throw new Error("指定的 ADB 设备未授权或未连接");
      const model = (await run(["shell", "getprop", "ro.product.model"])).slice(0, 80);
      const androidVersion = (await run(["shell", "getprop", "ro.build.version.release"])).slice(0, 40);
      return adbStatus.parse({ state: "device", model, androidVersion, observedAt: Date.now() });
    },
    async ui() {
      if (!config.allowUiDump) throw new Error("本地策略禁止读取界面");
      if (await run(["get-state"]) !== "device") throw new Error("指定的 ADB 设备未授权或未连接");
      const output = await run(["exec-out", "uiautomator", "dump", "/dev/tty"], MAX_ADB_UI_XML_BYTES * 16 + 8192);
      const start = output.indexOf("<?xml"), end = output.lastIndexOf("</hierarchy>");
      if (start < 0 || end < start) throw new Error("未取得 Android 界面结构");
      const rawXml = output.slice(start, end + "</hierarchy>".length);
      let xml = compactUiXml(rawXml, true);
      if (Buffer.byteLength(xml) > MAX_ADB_UI_XML_BYTES) xml = compactUiXml(rawXml, false);
      if (Buffer.byteLength(xml) > MAX_ADB_UI_XML_BYTES) throw new Error("Android 界面结构过大");
      return adbUi.parse({ xml, observedAt: Date.now() });
    },
    async control(action, raw) {
      if (action !== "adb_input" || !config.allowControl) throw new Error("本地策略禁止 ADB 控制");
      const input: AdbInput = adbInput.parse(raw);
      if (await run(["get-state"]) !== "device") throw new Error("指定的 ADB 设备未授权或未连接");
      const args = input.kind === "tap" ? ["tap", String(input.x), String(input.y)]
        : input.kind === "swipe" ? ["swipe", String(input.x1), String(input.y1), String(input.x2), String(input.y2), String(input.durationMs)]
        : input.kind === "keyevent" ? ["keyevent", input.key]
        : ["text", input.text.replace(/ /g, "%s")];
      await run(["shell", "input", ...args]);
      return { delivery: "executed", deviceAcknowledged: true };
    },
    close() { closed = true; },
  };
}
