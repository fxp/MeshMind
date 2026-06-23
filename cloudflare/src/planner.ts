// 规则规划器（从 master/orchestrator.ts 移植）。Planner 可插拔；GLM 版将来实现同一接口。

export interface DeviceInfo {
  deviceId: string;
  os: string;
  arch: string;
  status: "online" | "offline";
  capabilities: {
    shell: { allow: string[]; deny_destructive: boolean };
    fs: { read: string[]; write: string[] };
    gpu: { available: boolean };
    llm?: { available: boolean; endpoint: string; models: string[] };
    sensors: string[];
  };
}

export interface TaskRequest {
  task_id: string;
  type: "echo" | "shell.run" | "llm.infer";
  payload: Record<string, unknown>;
  granted_capabilities: string[];
  deadline_sec: number;
}

export interface PlannedTask {
  deviceId: string;
  task: TaskRequest;
  rationale?: string;
}

function taskId(): string {
  return "t_" + Math.random().toString(36).slice(2, 10);
}

function shellTask(cmd: string, args: string[]): TaskRequest {
  return {
    task_id: taskId(),
    type: "shell.run",
    payload: { cmd, args },
    granted_capabilities: ["shell.run"],
    deadline_sec: 30,
  };
}

function inferTask(prompt: string): TaskRequest {
  return {
    task_id: taskId(),
    type: "llm.infer",
    payload: { prompt }, // 不指定 model → 设备用本地首个模型
    granted_capabilities: ["llm.infer"],
    deadline_sec: 120,
  };
}

/**
 * 规则规划：
 *   shell-all <cmd> [args...]      → 所有在线、有 shell 能力的设备
 *   echo-all  <text...>            → 所有在线设备
 *   shell-on  <deviceId> <cmd> ... → 指定单设备
 */
export function rulePlan(goal: string, devices: DeviceInfo[]): PlannedTask[] {
  const online = devices.filter((d) => d.status === "online");
  const [verb, ...rest] = goal.trim().split(/\s+/);

  switch (verb) {
    case "echo-all": {
      const text = rest.join(" ");
      return online.map((d) => ({
        deviceId: d.deviceId,
        rationale: "fanout echo",
        task: {
          task_id: taskId(),
          type: "echo",
          payload: { text },
          granted_capabilities: [],
          deadline_sec: 10,
        },
      }));
    }
    case "shell-all": {
      const [cmd, ...args] = rest;
      return online
        .filter((d) => (d.capabilities.shell?.allow?.length ?? 0) > 0)
        .map((d) => ({
          deviceId: d.deviceId,
          rationale: "device declares shell capability",
          task: shellTask(cmd, args),
        }));
    }
    case "shell-on": {
      const [deviceId, cmd, ...args] = rest;
      const d = online.find((x) => x.deviceId === deviceId);
      if (!d) return [];
      return [{ deviceId, rationale: "explicit target", task: shellTask(cmd, args) }];
    }
    case "infer-on": {
      const [deviceId, ...promptParts] = rest;
      const d = online.find((x) => x.deviceId === deviceId);
      if (!d) return [];
      return [{ deviceId, rationale: "explicit LLM target", task: inferTask(promptParts.join(" ")) }];
    }
    case "infer": {
      // 路由到任意有本地 LLM 的在线设备
      const prompt = rest.join(" ");
      const d = online.find((x) => x.capabilities.llm?.available);
      if (!d) throw new Error("没有在线的本地 LLM 设备");
      return [{ deviceId: d.deviceId, rationale: "local LLM device", task: inferTask(prompt) }];
    }
    default:
      throw new Error(`规则规划器不认识的目标: "${verb}"（支持 shell-all / echo-all / shell-on）`);
  }
}
