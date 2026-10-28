import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { localConfig, startGateway } from "../src/gateway.ts";

async function main() {
  const { values } = parseArgs({ options: { config: { type: "string" }, state: { type: "string" }, enroll: { type: "string" } } });
  if (!values.config || !values.state) throw new Error("Missing gateway config or state path");
  const configFile = resolve(values.config);
  const config = localConfig.parse(JSON.parse(await readFile(configFile, "utf8")));
  for (const device of config.devices) if (device.caFile) device.caFile = resolve(dirname(configFile), device.caFile);
  const enrollment = values.enroll ? JSON.parse(await readFile(resolve(values.enroll), "utf8")) : undefined;
  const gateway = await startGateway({ config, stateFile: resolve(values.state), enrollment,
    log: message => console.log(message) });
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { gateway.stop(); process.exit(0); });
}
main().catch(error => {
  console.error("网关启动失败，请检查设备配置或入网文件。不会输出密钥。");
  if (process.env.MESHMIND_DIAGNOSTICS === "1") console.error(error instanceof Error ? error.stack : "UnknownError");
  process.exitCode = 1;
});
