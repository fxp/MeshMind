// A2A (Agent2Agent) 协议适配 —— Hub 当网关，把每台设备表达成一个 A2A Agent。
// 设备能力清单 → A2A Agent Card(skills)；A2A message/send → 设备任务。
// 聚焦合规子集：Agent Card + message/send(非流式) + Task 结果。
import type { DeviceInfo, TaskRequest } from "./planner.ts";

const PROTOCOL_VERSION = "0.3.0";

export interface A2ASkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
  examples?: string[];
  inputModes?: string[];
  outputModes?: string[];
}

/** 从设备能力清单推导 A2A skills。 */
export function skillsFromDevice(d: DeviceInfo): A2ASkill[] {
  const skills: A2ASkill[] = [];
  const llm = d.capabilities.llm;
  if (llm?.available) {
    skills.push({
      id: "llm-inference",
      name: "Token 推理 (Local LLM)",
      description: `本地 OpenAI 兼容推理（${llm.models.slice(0, 5).join(", ")}）`,
      tags: ["llm", "inference", "ollama", "tokens"],
      examples: ["用一句话解释边缘计算", "把这段话翻译成英文"],
      inputModes: ["text/plain"],
      outputModes: ["text/plain"],
    });
  }
  if ((d.capabilities.shell?.allow?.length ?? 0) > 0) {
    skills.push({
      id: "shell-exec",
      name: "命令执行 (Shell)",
      description: `在该设备执行白名单命令（${d.capabilities.shell.allow.slice(0, 6).join(", ")}…）`,
      tags: ["shell", "exec", "ops"],
      examples: ["uname -a", "du -sh ."],
      inputModes: ["text/plain"],
      outputModes: ["text/plain"],
    });
  }
  return skills;
}

interface CardOpts {
  baseUrl: string; // https://hub.xiaopingfeng.com
}

/** 单设备 Agent Card。 */
export function deviceCard(d: DeviceInfo, opts: CardOpts) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    name: `meshmind/${d.deviceId}`,
    description: `MeshMind 设备 ${d.deviceId}（${d.os}/${d.arch}，${d.status}）`,
    url: `${opts.baseUrl}/a2a/${encodeURIComponent(d.deviceId)}`,
    version: "0.1.0",
    preferredTransport: "JSONRPC",
    provider: { organization: "MeshMind", url: opts.baseUrl },
    capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
    security: [{ bearer: [] }],
    skills: skillsFromDevice(d),
  };
}

/** 聚合 Card：把所有设备的 skill 汇总（id 带 @device 后缀），便于一站发现。 */
export function aggregateCard(devices: DeviceInfo[], opts: CardOpts) {
  const skills: A2ASkill[] = [];
  for (const d of devices) {
    for (const s of skillsFromDevice(d)) {
      skills.push({ ...s, id: `${s.id}@${d.deviceId}`, name: `${s.name} @ ${d.deviceId}` });
    }
  }
  return {
    protocolVersion: PROTOCOL_VERSION,
    name: "MeshMind",
    description: "个人设备网格 · 分层 AI 多智能体。各设备能力以 A2A skill 形式暴露。",
    url: `${opts.baseUrl}/a2a`,
    version: "0.1.0",
    preferredTransport: "JSONRPC",
    provider: { organization: "MeshMind", url: opts.baseUrl },
    capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
    security: [{ bearer: [] }],
    skills,
  };
}

// ---- message/send 处理 ----

interface JsonRpcReq {
  jsonrpc: "2.0";
  id: string | number | null;
  method: string;
  params: any;
}

function rpcError(id: any, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
function rpcOk(id: any, result: any) {
  return { jsonrpc: "2.0", id, result };
}

/** 从 A2A message 取纯文本。 */
function messageText(msg: any): string {
  const parts = msg?.parts ?? [];
  return parts
    .filter((p: any) => (p.kind ?? p.type) === "text")
    .map((p: any) => p.text ?? "")
    .join("\n");
}

/** 选定 skill → 构造 MeshMind 任务。返回 null 表示该 skill 不支持。 */
export function taskFromMessage(
  device: DeviceInfo,
  skillId: string | undefined,
  text: string,
  newId: () => string,
): TaskRequest | null {
  const skills = skillsFromDevice(device).map((s) => s.id);
  const skill = skillId ?? (skills.includes("llm-inference") ? "llm-inference" : skills[0]);

  if (skill === "llm-inference" && device.capabilities.llm?.available) {
    return {
      task_id: newId(),
      type: "llm.infer",
      payload: { prompt: text },
      granted_capabilities: ["llm.infer"],
      deadline_sec: 120,
    };
  }
  if (skill === "shell-exec") {
    const [cmd, ...args] = text.trim().split(/\s+/);
    return {
      task_id: newId(),
      type: "shell.run",
      payload: { cmd, args },
      granted_capabilities: ["shell.run"],
      deadline_sec: 30,
    };
  }
  return null;
}

/** 把设备任务结果包装成 A2A Task 对象。 */
export function taskResultToA2A(
  rpcId: any,
  contextId: string,
  taskId: string,
  outcome: { ok: boolean; result?: Record<string, unknown>; error: string | null },
) {
  const text = outcome.ok
    ? String((outcome.result?.content ?? outcome.result?.stdout ?? outcome.result?.text ?? "") || "")
    : "";
  return rpcOk(rpcId, {
    id: taskId,
    contextId,
    kind: "task",
    status: {
      state: outcome.ok ? "completed" : "failed",
      timestamp: new Date().toISOString(),
      ...(outcome.ok ? {} : { message: { role: "agent", parts: [{ kind: "text", text: outcome.error ?? "failed" }] } }),
    },
    artifacts: outcome.ok
      ? [{ artifactId: taskId + "-out", parts: [{ kind: "text", text }] }]
      : [],
  });
}

export { rpcError, rpcOk, messageText, type JsonRpcReq };
