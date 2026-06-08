// 设备注册表 — P0 用内存版；P2 起换 Postgres 持久化 + 审计。
export interface Manifest {
  device_id: string;
  hostname: string;
  os: string;
  arch: string;
  agent_version: string;
  capabilities: {
    shell: { allow: string[]; deny_destructive: boolean };
    fs: { read: string[]; write: string[] };
    gpu: { available: boolean };
    sensors: string[];
  };
}

export interface DeviceState {
  manifest: Manifest;
  registeredAt: Date;
  lastSeen: Date;
  status: "online" | "stale" | "offline";
}

const STALE_MS = 12_000; // 超过两个心跳周期未见即视为 stale

export class Registry {
  private devices = new Map<string, DeviceState>();

  register(m: Manifest): DeviceState {
    const now = new Date();
    const existing = this.devices.get(m.device_id);
    const state: DeviceState = {
      manifest: m,
      registeredAt: existing?.registeredAt ?? now,
      lastSeen: now,
      status: "online",
    };
    this.devices.set(m.device_id, state);
    return state;
  }

  heartbeat(deviceId: string): void {
    const d = this.devices.get(deviceId);
    if (d) {
      d.lastSeen = new Date();
      d.status = "online";
    }
  }

  /** 刷新 stale/offline 状态并返回当前快照。 */
  snapshot(): DeviceState[] {
    const now = Date.now();
    for (const d of this.devices.values()) {
      const age = now - d.lastSeen.getTime();
      d.status = age < STALE_MS ? "online" : age < STALE_MS * 3 ? "stale" : "offline";
    }
    return [...this.devices.values()].sort((a, b) =>
      a.manifest.device_id.localeCompare(b.manifest.device_id),
    );
  }

  /** 按能力匹配设备（P2 调度器用）。 */
  withCapability(pred: (m: Manifest) => boolean): DeviceState[] {
    return this.snapshot().filter((d) => pred(d.manifest));
  }
}
