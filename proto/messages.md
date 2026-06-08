# MeshMind 消息 Schema（P0 / P1）

主 Agent (TS) 与子 Agent (Go) 共享的线缆格式。统一 JSON。
权威 subject 设计见 `DESIGN.md` §5；本文给出 P0/P1 用到的消息体。

## 1. 注册 — `device.{id}.register`（子→主 request-reply）

请求体（子 Agent 发出）= Capability Manifest：

```jsonc
{
  "device_id": "mac-studio",
  "hostname": "Mac-Studio.local",
  "os": "darwin",
  "arch": "arm64",
  "agent_version": "0.0.1",
  "capabilities": {
    "shell": { "allow": ["ls","stat","du","git","python3"], "deny_destructive": true },
    "fs":    { "read": ["/Users/me","/data"], "write": ["/data/out"] },
    "gpu":   { "available": false },
    "sensors": []
  }
}
```

回复体（主 Agent 应答）：

```jsonc
{ "ok": true, "registered_at": "2026-06-08T09:00:00Z", "server_time": "..." }
```

## 2. 心跳 — `device.{id}.heartbeat`（子→主 pub）

```jsonc
{
  "device_id": "mac-studio",
  "ts": "2026-06-08T09:00:05Z",
  "status": "online",
  "load": { "cpu_pct": 12.3, "mem_pct": 41.0 }
}
```

## 3. 任务 — `device.{id}.task`（主→子 request-reply）

P0/P1 只实现 `echo` 与 `shell.run` 两种：

```jsonc
{
  "task_id": "t_01H...",
  "type": "echo",                  // "echo" | "shell.run"
  "payload": { "text": "hello" },  // echo: {text}; shell.run: {cmd, args, cwd}
  "granted_capabilities": ["shell.run"],
  "deadline_sec": 30
  // P4 起追加 "signature": "ed25519:..."
}
```

回复体：

```jsonc
{
  "task_id": "t_01H...",
  "ok": true,
  "result": { "stdout": "...", "stderr": "", "exit_code": 0 },
  "error": null,
  "took_ms": 42
}
```
