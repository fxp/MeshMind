// 主/子 Agent 共享的任务线缆类型（对应 proto/messages.md §3）。

export interface TaskRequest {
  task_id: string;
  type: "echo" | "shell.run";
  payload: Record<string, unknown>;
  granted_capabilities: string[];
  deadline_sec: number;
}

export interface TaskResult {
  task_id: string;
  ok: boolean;
  result?: Record<string, unknown>;
  error: string | null;
  took_ms: number;
}

export function newTaskId(): string {
  return "t_" + Math.random().toString(36).slice(2, 10);
}
