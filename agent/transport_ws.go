package main

import (
	"context"
	"encoding/json"
	"log"
	"os"
	"os/signal"
	"runtime"
	"strings"
	"syscall"
	"time"

	"github.com/coder/websocket"
	"github.com/xiaopingfeng/meshmind/agent/internal/capability"
	"github.com/xiaopingfeng/meshmind/agent/internal/identity"
)

// runWS 是 Cloudflare 版传输：wss 连 Hub Durable Object，签名注册 → 心跳 → 任务。
func runWS(id identity.Identity, cfg identity.Config, m capability.Manifest) {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	for {
		if err := wsSession(ctx, id, cfg, m); err != nil {
			if ctx.Err() != nil {
				log.Printf("[agent] %s shutting down", id.DeviceID)
				return
			}
			log.Printf("[ws] 连接断开: %v — 2s 后重连", err)
			select {
			case <-ctx.Done():
				return
			case <-time.After(2 * time.Second):
			}
		}
	}
}

func wsSession(ctx context.Context, id identity.Identity, cfg identity.Config, m capability.Manifest) error {
	url := cfg.WSURL
	sep := "?"
	if strings.Contains(url, "?") {
		sep = "&"
	}
	url += sep + "token=" + cfg.Bearer

	c, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		return err
	}
	defer c.Close(websocket.StatusNormalClosure, "bye")
	c.SetReadLimit(8 << 20)
	log.Printf("[agent] %s connected (ws) to %s (%s/%s)", id.DeviceID, cfg.WSURL, runtime.GOOS, runtime.GOARCH)

	// 签名注册
	body, _ := json.Marshal(m)
	sig, err := id.Sign(body)
	if err != nil {
		return err
	}
	if err := wsSend(ctx, c, map[string]any{
		"kind":          "register",
		"manifest_json": string(body),
		"sig":           sig,
	}); err != nil {
		return err
	}

	// 心跳
	hbCtx, hbCancel := context.WithCancel(ctx)
	defer hbCancel()
	go func() {
		t := time.NewTicker(5 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-hbCtx.Done():
				return
			case <-t.C:
				_ = wsSend(hbCtx, c, map[string]any{
					"kind": "heartbeat",
					"ts":   time.Now().UTC().Format(time.RFC3339),
					"load": map[string]any{"goroutines": runtime.NumGoroutine()},
				})
			}
		}
	}()

	// 接收循环
	for {
		_, data, err := c.Read(ctx)
		if err != nil {
			return err
		}
		var frame struct {
			Kind string `json:"kind"`
		}
		if json.Unmarshal(data, &frame); frame.Kind == "" {
			continue
		}
		switch frame.Kind {
		case "register_ack":
			var ack struct {
				OK       bool   `json:"ok"`
				Verified bool   `json:"verified"`
				Error    string `json:"error"`
			}
			_ = json.Unmarshal(data, &ack)
			if !ack.OK {
				return logFatalErr(ack.Error)
			}
			log.Printf("[agent] registered (ws, verified=%v), %d shell cmds allowed", ack.Verified, len(m.Capabilities.Shell.Allow))
		case "task":
			var req taskRequest
			_ = json.Unmarshal(data, &req)
			res := executeTask(req, m)
			out := map[string]any{
				"kind":    "result",
				"task_id": res.TaskID,
				"ok":      res.OK,
				"result":  res.Result,
				"error":   res.Error,
				"took_ms": res.TookMs,
			}
			if err := wsSend(ctx, c, out); err != nil {
				return err
			}
		case "kill":
			log.Printf("[agent] 收到 kill — 退出")
			return nil
		}
	}
}

func wsSend(ctx context.Context, c *websocket.Conn, v any) error {
	b, _ := json.Marshal(v)
	wctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	return c.Write(wctx, websocket.MessageText, b)
}

func logFatalErr(msg string) error {
	log.Printf("[agent] 注册被拒: %s", msg)
	return &registerError{msg}
}

type registerError struct{ s string }

func (e *registerError) Error() string { return e.s }
