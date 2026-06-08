// MeshMind 子 Agent — P0/P1
//
// 职责（P0）：连 NATS → 注册并上报能力 → 周期心跳。
// 职责（P1 桥接）：响应 device.{id}.task 的 echo / shell.run 任务，本地强制能力作用域。
//
// 运行: NATS_URL=nats://localhost:4222 DEVICE_ID=mac-studio go run .
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
)

const agentVersion = "0.0.1"

func main() {
	deviceID := envOr("DEVICE_ID", defaultDeviceID())
	natsURL := envOr("NATS_URL", nats.DefaultURL)

	manifest := capability.Detect(deviceID, agentVersion)

	nc, err := nats.Connect(natsURL,
		nats.Name("meshmind-agent/"+deviceID),
		nats.MaxReconnects(-1),
		nats.ReconnectWait(2*time.Second),
		nats.DisconnectErrHandler(func(_ *nats.Conn, e error) { log.Printf("[nats] disconnected: %v", e) }),
		nats.ReconnectHandler(func(_ *nats.Conn) { log.Printf("[nats] reconnected") }),
	)
	if err != nil {
		log.Fatalf("connect NATS %s: %v", natsURL, err)
	}
	defer nc.Drain()
	log.Printf("[agent] %s connected to %s (%s/%s)", deviceID, natsURL, runtime.GOOS, runtime.GOARCH)

	if err := register(nc, deviceID, manifest); err != nil {
		log.Fatalf("register: %v", err)
	}

	// 订阅本设备任务
	if _, err := nc.Subscribe("device."+deviceID+".task", taskHandler(manifest)); err != nil {
		log.Fatalf("subscribe task: %v", err)
	}

	// 心跳
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go heartbeatLoop(ctx, nc, deviceID)

	log.Printf("[agent] %s ready — listening for tasks", deviceID)
	<-ctx.Done()
	log.Printf("[agent] %s shutting down", deviceID)
}

// register: 子→主 request-reply，上报能力清单，等主机 ack。
func register(nc *nats.Conn, deviceID string, m capability.Manifest) error {
	body, _ := json.Marshal(m)
	msg, err := nc.Request("device."+deviceID+".register", body, 5*time.Second)
	if err != nil {
		return fmt.Errorf("no ack from master (is master running?): %w", err)
	}
	var ack struct {
		OK           bool   `json:"ok"`
		RegisteredAt string `json:"registered_at"`
	}
	_ = json.Unmarshal(msg.Data, &ack)
	if !ack.OK {
		return fmt.Errorf("master rejected registration")
	}
	log.Printf("[agent] registered, %d shell cmds allowed", len(m.Capabilities.Shell.Allow))
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
	send() // 立即发一次
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			send()
		}
	}
}

// ---- 任务处理（P1 桥接）----

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

func taskHandler(m capability.Manifest) nats.MsgHandler {
	return func(msg *nats.Msg) {
		start := time.Now()
		var req taskRequest
		if err := json.Unmarshal(msg.Data, &req); err != nil {
			replyErr(msg, "", "bad task json: "+err.Error(), start)
			return
		}
		switch req.Type {
		case "echo":
			var p struct {
				Text string `json:"text"`
			}
			_ = json.Unmarshal(req.Payload, &p)
			reply(msg, taskResult{
				TaskID: req.TaskID, OK: true,
				Result: map[string]any{"text": p.Text},
				TookMs: time.Since(start).Milliseconds(),
			})
		case "shell.run":
			runShell(msg, req, m, start)
		default:
			replyErr(msg, req.TaskID, "unknown task type: "+req.Type, start)
		}
	}
}

func runShell(msg *nats.Msg, req taskRequest, m capability.Manifest, start time.Time) {
	var p struct {
		Cmd  string   `json:"cmd"`
		Args []string `json:"args"`
		Cwd  string   `json:"cwd"`
	}
	if err := json.Unmarshal(req.Payload, &p); err != nil {
		replyErr(msg, req.TaskID, "bad payload: "+err.Error(), start)
		return
	}
	base := p.Cmd
	if i := strings.LastIndexByte(base, '/'); i >= 0 {
		base = base[i+1:]
	}
	// 本地强制能力作用域 —— 安全模型 §8 工具层
	if capability.DestructiveCommands[base] && m.Capabilities.Shell.DenyDestructive {
		replyErr(msg, req.TaskID, "refused: destructive command '"+base+"'", start)
		return
	}
	if !m.Capabilities.Shell.AllowsCommand(base) {
		replyErr(msg, req.TaskID, "refused: '"+base+"' not in shell allowlist", start)
		return
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
	reply(msg, taskResult{
		TaskID: req.TaskID, OK: err == nil,
		Result: map[string]any{
			"stdout":    stdout.String(),
			"stderr":    stderr.String(),
			"exit_code": exitCode,
		},
		TookMs: time.Since(start).Milliseconds(),
	})
}

func reply(msg *nats.Msg, r taskResult) {
	b, _ := json.Marshal(r)
	_ = msg.Respond(b)
}

func replyErr(msg *nats.Msg, taskID, errMsg string, start time.Time) {
	s := errMsg
	reply(msg, taskResult{TaskID: taskID, OK: false, Error: &s, TookMs: time.Since(start).Milliseconds()})
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
