import { readFile, writeFile } from "node:fs/promises";

const source = new URL("../bin/meshmind.mjs", import.meta.url);
const target = new URL("../public/meshmind-cli.mjs", import.meta.url);
await writeFile(target, await readFile(source));
