// 入网（Enrollment）— 一次性令牌签发 + 校验 + 设备公钥登记 + 签名验证。
// P0 用内存存储；P2+ 持久化到 Postgres。
import { randomBytes, createPublicKey, verify as edVerify } from "node:crypto";

const CONTROL_ADDR = process.env.CONTROL_ADDR ?? "localhost:7700";
const PUBLIC_NATS_URL = process.env.PUBLIC_NATS_URL ?? "nats://localhost:4222";
const MESH_NAME = process.env.MESH_NAME ?? "ctrl.mesh";
const TOKEN_TTL_MS = 60 * 60 * 1000; // 1h

export interface EnrollToken {
  ts_authkey: string; // 部署层由 Tailscale/Headscale 签发；本机联调留空
  control_addr: string;
  enroll_secret: string;
  granted_caps: string[];
  name_hint: string;
  expires_at: string;
}

interface PendingEnroll {
  granted_caps: string[];
  name_hint: string;
  expiresAt: number;
  used: boolean;
}

export interface EnrolledDevice {
  deviceId: string;
  publicKey: string; // base64 raw ed25519
  grantedCaps: string[];
  enrolledAt: Date;
}

export class Enrollment {
  private pending = new Map<string, PendingEnroll>(); // enroll_secret → 状态
  private enrolled = new Map<string, EnrolledDevice>(); // device_id → 设备

  /** 签发一次性入网令牌。tsAuthKey 由调用方（部署层）注入，本机联调可空。 */
  mint(opts: { name: string; caps: string[]; tsAuthKey?: string }): EnrollToken {
    const secret = randomBytes(24).toString("base64url");
    const expiresAt = Date.now() + TOKEN_TTL_MS;
    this.pending.set(secret, {
      granted_caps: opts.caps,
      name_hint: opts.name,
      expiresAt,
      used: false,
    });
    return {
      ts_authkey: opts.tsAuthKey ?? "",
      control_addr: CONTROL_ADDR,
      enroll_secret: secret,
      granted_caps: opts.caps,
      name_hint: opts.name,
      expires_at: new Date(expiresAt).toISOString(),
    };
  }

  /** 设备调用注册端点时校验令牌并登记公钥。 */
  redeem(input: {
    enroll_secret: string;
    public_key: string;
    deviceId: string;
  }): { ok: boolean; device_id?: string; nats_url?: string; mesh_name?: string; granted_caps?: string[]; error?: string } {
    const p = this.pending.get(input.enroll_secret);
    if (!p) return { ok: false, error: "未知或已失效的 enroll_secret" };
    if (p.used) return { ok: false, error: "令牌已被使用" };
    if (Date.now() > p.expiresAt) return { ok: false, error: "令牌已过期" };

    p.used = true;
    const deviceId = p.name_hint || input.deviceId;
    this.enrolled.set(deviceId, {
      deviceId,
      publicKey: input.public_key,
      grantedCaps: p.granted_caps,
      enrolledAt: new Date(),
    });
    return {
      ok: true,
      device_id: deviceId,
      nats_url: PUBLIC_NATS_URL,
      mesh_name: MESH_NAME,
      granted_caps: p.granted_caps,
    };
  }

  isEnrolled(deviceId: string): boolean {
    return this.enrolled.has(deviceId);
  }

  /** 验证注册消息的签名是否出自登记过的设备公钥。 */
  verifyRegister(deviceId: string, manifestJson: string, sigB64: string): boolean {
    const dev = this.enrolled.get(deviceId);
    if (!dev || !sigB64) return false;
    try {
      const raw = Buffer.from(dev.publicKey, "base64"); // 32B
      const der = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]);
      const key = createPublicKey({ key: der, format: "der", type: "spki" });
      return edVerify(null, Buffer.from(manifestJson), key, Buffer.from(sigB64, "base64"));
    } catch {
      return false;
    }
  }

  revoke(deviceId: string): boolean {
    return this.enrolled.delete(deviceId);
    // 部署层补充：作废 NATS 凭证 + 删 Tailscale/Headscale 节点
  }

  list(): EnrolledDevice[] {
    return [...this.enrolled.values()];
  }
}
