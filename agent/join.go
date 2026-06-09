package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"time"

	"github.com/xiaopingfeng/meshmind/agent/internal/capability"
	"github.com/xiaopingfeng/meshmind/agent/internal/identity"
)

// enrollToken 是一次性令牌解码后的内容。
// 兼容两种形态：v1 Mesh 版用 control_addr（内网 host:port）；CF 版用 enroll_url（完整 URL）。
type enrollToken struct {
	TSAuthKey    string   `json:"ts_authkey"`
	ControlAddr  string   `json:"control_addr"`
	EnrollURL    string   `json:"enroll_url"`
	EnrollSecret string   `json:"enroll_secret"`
	GrantedCaps  []string `json:"granted_caps"`
	NameHint     string   `json:"name_hint"`
	ExpiresAt    string   `json:"expires_at"`
}

type enrollRequest struct {
	EnrollSecret string             `json:"enroll_secret"`
	PublicKey    string             `json:"public_key"`
	Manifest     capability.Manifest `json:"manifest"`
}

type enrollResponse struct {
	OK          bool     `json:"ok"`
	DeviceID    string   `json:"device_id"`
	NatsURL     string   `json:"nats_url"`
	MeshName    string   `json:"mesh_name"`
	WSURL       string   `json:"ws_url"`  // Cloudflare 版
	Bearer      string   `json:"bearer"`  // Cloudflare 版
	GrantedCaps []string `json:"granted_caps"`
	Error       string   `json:"error"`
}

// joinCmd 执行一次性入网仪式。
func joinCmd(args []string) {
	fs := flag.NewFlagSet("join", flag.ExitOnError)
	token := fs.String("token", "", "一次性入网令牌（base64）")
	skipNet := fs.Bool("skip-network", false, "跳过 tailscale up（本机联调用）")
	useHTTPS := fs.Bool("https", false, "用 https 访问注册端点（部署默认应为 true）")
	_ = fs.Parse(args)

	if *token == "" {
		log.Fatal("用法: meshmind-agent join --token <令牌> [--skip-network]")
	}

	tok, err := decodeToken(*token)
	if err != nil {
		log.Fatalf("解析令牌失败: %v", err)
	}
	if tok.ExpiresAt != "" {
		if exp, e := time.Parse(time.RFC3339, tok.ExpiresAt); e == nil && time.Now().After(exp) {
			log.Fatalf("令牌已过期 (%s)", tok.ExpiresAt)
		}
	}

	deviceName := tok.NameHint
	if deviceName == "" {
		deviceName = defaultDeviceID()
	}

	// 步骤 1：生成设备根身份
	id, _, err := identity.Generate(deviceName)
	if err != nil {
		log.Fatalf("生成密钥对失败: %v", err)
	}
	log.Printf("[join] 已生成设备身份 device=%s", deviceName)

	// 步骤 2：入 mesh（Tailscale）
	if tok.TSAuthKey != "" && !*skipNet {
		log.Printf("[join] tailscale up ...")
		cmd := exec.Command("tailscale", "up", "--authkey", tok.TSAuthKey)
		cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
		if err := cmd.Run(); err != nil {
			log.Fatalf("tailscale up 失败: %v（如需本机联调加 --skip-network）", err)
		}
	} else {
		log.Printf("[join] 跳过 tailscale up（skip-network 或令牌无 ts_authkey）")
	}

	// 步骤 3：调注册端点（CF 版用完整 enroll_url；Mesh 版用 control_addr 拼）
	manifest := capability.Detect(deviceName, agentVersion)
	url := tok.EnrollURL
	if url == "" {
		scheme := "http"
		if *useHTTPS {
			scheme = "https"
		}
		url = fmt.Sprintf("%s://%s/enroll", scheme, tok.ControlAddr)
	}
	reqBody, _ := json.Marshal(enrollRequest{
		EnrollSecret: tok.EnrollSecret,
		PublicKey:    id.PublicKey,
		Manifest:     manifest,
	})
	resp, err := http.Post(url, "application/json", bytes.NewReader(reqBody))
	if err != nil {
		log.Fatalf("访问注册端点 %s 失败: %v", url, err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	var er enrollResponse
	if err := json.Unmarshal(raw, &er); err != nil {
		log.Fatalf("注册端点返回非法响应: %s", string(raw))
	}
	if !er.OK {
		log.Fatalf("注册被拒: %s", er.Error)
	}

	// 步骤 4/7：落盘身份与配置
	id.DeviceID = er.DeviceID
	cfg := identity.Config{
		ControlAddr: tok.ControlAddr,
		NatsURL:     er.NatsURL,
		MeshName:    er.MeshName,
		WSURL:       er.WSURL,
		Bearer:      er.Bearer,
	}
	if err := identity.Save(id, cfg); err != nil {
		log.Fatalf("落盘失败: %v", err)
	}

	log.Printf("[join] ✅ 入网成功 device_id=%s caps=%v", er.DeviceID, er.GrantedCaps)
	log.Printf("[join] 凭证已存至 %s — 之后运行: meshmind-agent run", identity.Home())
	fmt.Printf("\n设备已加入 MeshMind。运行 `meshmind-agent run`（或 go run . run）开始工作。\n")
}

func decodeToken(s string) (enrollToken, error) {
	var tok enrollToken
	b, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		// 容错：也接受 base64url
		b, err = base64.RawURLEncoding.DecodeString(s)
		if err != nil {
			return tok, fmt.Errorf("base64 解码失败")
		}
	}
	if err := json.Unmarshal(b, &tok); err != nil {
		return tok, err
	}
	if tok.EnrollSecret == "" || (tok.ControlAddr == "" && tok.EnrollURL == "") {
		return tok, fmt.Errorf("令牌缺少 enroll_secret 或 control_addr/enroll_url")
	}
	return tok, nil
}
