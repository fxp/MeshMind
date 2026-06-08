// 编排器 — P2 骨架
//
// 职责：目标 → 规划（Planner）→ 多设备并行调度 → 结果汇聚 → 综合报告。
// 关键设计：Planner 是可插拔接口。当前是规则规划器；将来换成 GLM 规划器
// 只需实现同一接口，编排/调度/汇聚逻辑完全不动。
import type { NatsConnection } from "nats";
import { JSONCodec } from "nats";
import type { Registry, DeviceState, Manifest } from "./registry.ts";
import { type TaskRequest, type TaskResult, newTaskId } from "./types.ts";

const jc = JSONCodec();

// ---- 规划器接口（LLM 版将来实现同一个接口）----
export interface PlannedTask {
  deviceId: string;
  task: TaskRequest;
  rationale?: string;
}

export interface Planner {
  readonly name: string;
  plan(goal: string, devices: DeviceState[]): Promise<PlannedTask[]>;
}

// ---- 规则规划器 ----
// 支持的目标语法（P2 骨架）：
//   shell-all <cmd> [args...]      → 所有有 shell 能力的设备并行执行
//   echo-all  <text...>            → 所有设备回显
//   shell-on <deviceId> <cmd> ...  → 指定单设备执行
export class RulePlanner implements Planner {
  readonly name = "rule";

  async plan(goal: string, devices: DeviceState[]): Promise<PlannedTask[]> {
    const online = devices.filter((d) => d.status === "online");
    const [verb, ...rest] = goal.trim().split(/\s+/);

    switch (verb) {
      case "echo-all": {
        const text = rest.join(" ");
        return online.map((d) => ({
          deviceId: d.manifest.device_id,
          rationale: "fanout echo",
          task: {
            task_id: newTaskId(),
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
          .filter((d) => hasShell(d.manifest))
          .map((d) => ({
            deviceId: d.manifest.device_id,
            rationale: `device declares shell capability`,
            task: shellTask(cmd, args),
          }));
      }
      case "shell-on": {
        const [deviceId, cmd, ...args] = rest;
        const d = online.find((x) => x.manifest.device_id === deviceId);
        if (!d) return [];
        return [{ deviceId, rationale: "explicit target", task: shellTask(cmd, args) }];
      }
      default:
        throw new Error(
          `规则规划器不认识的目标: "${verb}"。支持: shell-all / echo-all / shell-on`,
        );
    }
  }
}

function hasShell(m: Manifest): boolean {
  return (m.capabilities.shell?.allow?.length ?? 0) > 0;
}

function shellTask(cmd: string, args: string[]): TaskRequest {
  return {
    task_id: newTaskId(),
    type: "shell.run",
    payload: { cmd, args },
    granted_capabilities: ["shell.run"],
    deadline_sec: 30,
  };
}

// ---- 编排结果 ----
export interface DeviceOutcome {
  deviceId: string;
  rationale?: string;
  ok: boolean;
  result?: Record<string, unknown>;
  error: string | null;
  took_ms: number;
}

export interface GoalReport {
  goal: string;
  planner: string;
  dispatched: number;
  succeeded: number;
  failed: number;
  outcomes: DeviceOutcome[];
}

// ---- 编排器 ----
export class Orchestrator {
  constructor(
    private nc: NatsConnection,
    private registry: Registry,
    private planner: Planner = new RulePlanner(),
  ) {}

  async run(goal: string): Promise<GoalReport> {
    const devices = this.registry.snapshot();
    const plan = await this.planner.plan(goal, devices);

    // 并行下发，结果汇聚
    const outcomes: DeviceOutcome[] = await Promise.all(
      plan.map((p) => this.dispatch(p)),
    );

    const succeeded = outcomes.filter((o) => o.ok).length;
    return {
      goal,
      planner: this.planner.name,
      dispatched: outcomes.length,
      succeeded,
      failed: outcomes.length - succeeded,
      outcomes,
    };
  }

  private async dispatch(p: PlannedTask): Promise<DeviceOutcome> {
    const subject = `device.${p.deviceId}.task`;
    const timeout = (p.task.deadline_sec + 5) * 1000;
    try {
      const reply = await this.nc.request(subject, jc.encode(p.task), { timeout });
      const r = jc.decode(reply.data) as TaskResult;
      return {
        deviceId: p.deviceId,
        rationale: p.rationale,
        ok: r.ok,
        result: r.result,
        error: r.error,
        took_ms: r.took_ms,
      };
    } catch (e) {
      return {
        deviceId: p.deviceId,
        rationale: p.rationale,
        ok: false,
        error: `no response: ${(e as Error).message}`,
        took_ms: timeout,
      };
    }
  }
}
