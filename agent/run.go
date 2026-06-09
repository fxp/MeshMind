package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"os/exec"
	"os/signal"
	"runtime"
	"strings"
	"syscall"
	"time"

	"github.com/nats-io/nats.go"
	"github.com/xiaopingfeng/meshmind/agent/internal/capability"
	"github.com/xiaopingfeng/meshmind/agent/internal/identity"
)

// runCmd 是正常运行态：加载已入网身份（或本机 dev 回退）→ 连 NATS →
// 签名注册 → 心跳 → 监听任务。
func runCmd(_ []string) {
	id, cfg, err := identity.Load()
	signed := true
	if err != nil {
		// 尚未入网 —— dev 回退：用 hostname + 环境变量，注册不签名。
		if !os.IsNotExist(err) {
			log.Printf("[agent] 读取身份失败: %v（回退 dev 模式）", err)
		}
		signed = false
		id = identity.Identity{DeviceID: envOr("DEVICE_ID", defaultDeviceID())}
		cfg = identity.Config{NatsURL: envOr("NATS_URL", nats.DefaultURL)}
		log.Printf("[agent] dev 模式（未入网）device_id=%s — 注册不签名", id.DeviceID)
	}
	manifest := capability.Detect(id.DeviceID, agentVersion)

	// Cloudflare 版：有 ws_url 则走 WebSocket 传输。
	if cfg.WSURL != "" {
		runWS(id, cfg, manifest)
		return
	}

	natsURL := envOr("NATS_URL", cfg.NatsURL)
	if natsURL == "" {
		natsURL = nats.DefaultURL
	}

	nc, err := nats.Connect(natsURL,
		nats.Name("meshmind-agent/"+id.DeviceID),
		nats.MaxReconnects(-1),
		nats.ReconnectWait(2*time.Second),
		nats.DisconnectErrHandler(func(_ *nats.Conn, e error) { log.Printf("[nats] disconnected: %v", e) }),
		nats.ReconnectHandler(func(_ *nats.Conn) { log.Printf("[nats] reconnected") }),
	)
	if err != nil {
		log.Fatalf("connect NATS %s: %v", natsURL, err)
	}
	defer nc.Drain()
	log.Printf("[agent] %s connected to %s (%s/%s)", id.DeviceID, natsURL, runtime.GOOS, runtime.GOARCH)

	if err := register(nc, id, manifest, signed); err != nil {
		log.Fatalf("register: %v", err)
	}

	if _, err := nc.Subscribe("device."+id.DeviceID+".task", taskHandler(manifest)); err != nil {
		log.Fatalf("subscribe task: %v", err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go heartbeatLoop(ctx, nc, id.DeviceID)

	log.Printf("[agent] %s ready — listening for tasks", id.DeviceID)
	<-ctx.Done()
	log.Printf("[agent] %s shutting down", id.DeviceID)
}

// registerEnvelope 携带能力清单的原始字节 + 设备签名（防冒充）。
type registerEnvelope struct {
	ManifestJSON string `json:"manifest_json"`
	Sig          string `json:"sig"` // base64(ed25519)，dev 模式为空
}

func register(nc *nats.Conn, id identity.Identity, m capability.Manifest, signed bool) error {
	body, _ := json.Marshal(m) // 这串就是被签名的确切字节
	env := registerEnvelope{ManifestJSON: string(body)}
	if signed {
		sig, err := id.Sign(body)
		if err != nil {
			return fmt.Errorf("sign manifest: %w", err)
		}
		env.Sig = sig
	}
	envBytes, _ := json.Marshal(env)

	msg, err := nc.Request("device."+id.DeviceID+".register", envBytes, 5*time.Second)
	if err != nil {
		return fmt.Errorf("no ack from master (is master running?): %w", err)
	}
	var ack struct {
		OK       bool   `json:"ok"`
		Verified bool   `json:"verified"`
		Error    string `json:"error"`
	}
	_ = json.Unmarshal(msg.Data, &ack)
	if !ack.OK {
		return fmt.Errorf("master rejected registration: %s", ack.Error)
	}
	log.Printf("[agent] registered (verified=%v), %d shell cmds allowed", ack.Verified, len(m.Capabilities.Shell.Allow))
	return nil
}

type heartbeat struct {
	DeviceID string         `json:"device_id"`
	TS       string         `json:"ts"`
	Status   string         `json:"status"`
	Load     map[string]any `json:"load"`
}

func heartbeatLoop(ctx context.Context, nc *nats.Conn, deviceID string) {
	t := time.NewTicker(5 * time.Second)
	defer t.Stop()
	subj := "device." + deviceID + ".heartbeat"
	send := func() {
		hb := heartbeat{
			DeviceID: deviceID,
			TS:       time.Now().UTC().Format(time.RFC3339),
			Status:   "online",
			Load:     map[string]any{"goroutines": runtime.NumGoroutine()},
		}
		b, _ := json.Marshal(hb)
		_ = nc.Publish(subj, b)
	}
	send()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			send()
		}
	}
}

// ---- 任务处理 ----

type taskRequest struct {
	TaskID              string          `json:"task_id"`
	Type                string          `json:"type"`
	Payload             json.RawMessage `json:"payload"`
	GrantedCapabilities []string        `json:"granted_capabilities"`
	DeadlineSec         int             `json:"deadline_sec"`
}

type taskResult struct {
	TaskID string         `json:"task_id"`
	OK     bool           `json:"ok"`
	Result map[string]any `json:"result,omitempty"`
	Error  *string        `json:"error"`
	TookMs int64          `json:"took_ms"`
}

// executeTask 是传输无关的任务执行核心（NATS 与 WS 两条路径共用）。
func executeTask(req taskRequest, m capability.Manifest) taskResult {
	start := time.Now()
	switch req.Type {
	case "echo":
		var p struct {
			Text string `json:"text"`
		}
		_ = json.Unmarshal(req.Payload, &p)
		return taskResult{
			TaskID: req.TaskID, OK: true,
			Result: map[string]any{"text": p.Text},
			TookMs: time.Since(start).Milliseconds(),
		}
	case "shell.run":
		return execShell(req, m, start)
	default:
		return errResult(req.TaskID, "unknown task type: "+req.Type, start)
	}
}

func execShell(req taskRequest, m capability.Manifest, start time.Time) taskResult {
	var p struct {
		Cmd  string   `json:"cmd"`
		Args []string `json:"args"`
		Cwd  string   `json:"cwd"`
	}
	if err := json.Unmarshal(req.Payload, &p); err != nil {
		return errResult(req.TaskID, "bad payload: "+err.Error(), start)
	}
	base := p.Cmd
	if i := strings.LastIndexByte(base, '/'); i >= 0 {
		base = base[i+1:]
	}
	if capability.DestructiveCommands[base] && m.Capabilities.Shell.DenyDestructive {
		return errResult(req.TaskID, "refused: destructive command '"+base+"'", start)
	}
	if !m.Capabilities.Shell.AllowsCommand(base) {
		return errResult(req.TaskID, "refused: '"+base+"' not in shell allowlist", start)
	}

	timeout := time.Duration(req.DeadlineSec) * time.Second
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, p.Cmd, p.Args...)
	if p.Cwd != "" {
		cmd.Dir = p.Cwd
	}
	var stdout, stderr strings.Builder
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	err := cmd.Run()
	exitCode := 0
	if ee, ok := err.(*exec.ExitError); ok {
		exitCode = ee.ExitCode()
	}
	return taskResult{
		TaskID: req.TaskID, OK: err == nil,
		Result: map[string]any{
			"stdout":    stdout.String(),
			"stderr":    stderr.String(),
			"exit_code": exitCode,
		},
		TookMs: time.Since(start).Milliseconds(),
	}
}

func errResult(taskID, errMsg string, start time.Time) taskResult {
	s := errMsg
	return taskResult{TaskID: taskID, OK: false, Error: &s, TookMs: time.Since(start).Milliseconds()}
}

// NATS 适配器
func taskHandler(m capability.Manifest) nats.MsgHandler {
	return func(msg *nats.Msg) {
		var req taskRequest
		if err := json.Unmarshal(msg.Data, &req); err != nil {
			b, _ := json.Marshal(errResult("", "bad task json: "+err.Error(), time.Now()))
			_ = msg.Respond(b)
			return
		}
		b, _ := json.Marshal(executeTask(req, m))
		_ = msg.Respond(b)
	}
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func defaultDeviceID() string {
	h, err := os.Hostname()
	if err != nil || h == "" {
		return "device-unknown"
	}
	h = strings.ToLower(h)
	h = strings.TrimSuffix(h, ".local")
	return strings.NewReplacer(" ", "-", ".", "-").Replace(h)
}
