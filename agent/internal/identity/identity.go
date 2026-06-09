// Package identity 管理设备的根身份：ed25519 密钥对 + device_id，
// 持久化到 ~/.meshmind/。私钥永不离开设备。
package identity

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// Identity 落盘在 ~/.meshmind/identity.json。
type Identity struct {
	DeviceID   string `json:"device_id"`
	PublicKey  string `json:"public_key"`  // base64(raw 32B)
	PrivateKey string `json:"private_key"` // base64(raw 64B)，chmod 600
}

// Config 落盘在 ~/.meshmind/config.json。
type Config struct {
	ControlAddr string `json:"control_addr"`
	NatsURL     string `json:"nats_url"`
	MeshName    string `json:"mesh_name"`
	// Cloudflare 版传输
	WSURL  string `json:"ws_url"`
	Bearer string `json:"bearer"`
}

func Home() string {
	if h := os.Getenv("MESHMIND_HOME"); h != "" {
		return h
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".meshmind")
}

// Generate 新建一对密钥并赋予 device_id。
func Generate(deviceID string) (Identity, ed25519.PrivateKey, error) {
	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		return Identity{}, nil, err
	}
	return Identity{
		DeviceID:   deviceID,
		PublicKey:  base64.StdEncoding.EncodeToString(pub),
		PrivateKey: base64.StdEncoding.EncodeToString(priv),
	}, priv, nil
}

func (id Identity) Private() (ed25519.PrivateKey, error) {
	b, err := base64.StdEncoding.DecodeString(id.PrivateKey)
	if err != nil {
		return nil, err
	}
	if len(b) != ed25519.PrivateKeySize {
		return nil, fmt.Errorf("bad private key size %d", len(b))
	}
	return ed25519.PrivateKey(b), nil
}

// Sign 用设备私钥对消息签名，返回 base64。
func (id Identity) Sign(msg []byte) (string, error) {
	priv, err := id.Private()
	if err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(ed25519.Sign(priv, msg)), nil
}

func Save(id Identity, cfg Config) error {
	dir := Home()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	idBytes, _ := json.MarshalIndent(id, "", "  ")
	if err := os.WriteFile(filepath.Join(dir, "identity.json"), idBytes, 0o600); err != nil {
		return err
	}
	cfgBytes, _ := json.MarshalIndent(cfg, "", "  ")
	return os.WriteFile(filepath.Join(dir, "config.json"), cfgBytes, 0o600)
}

// Load 读取已落盘身份；err 为 os.IsNotExist 时表示尚未入网。
func Load() (Identity, Config, error) {
	dir := Home()
	var id Identity
	var cfg Config
	idBytes, err := os.ReadFile(filepath.Join(dir, "identity.json"))
	if err != nil {
		return id, cfg, err
	}
	if err := json.Unmarshal(idBytes, &id); err != nil {
		return id, cfg, err
	}
	cfgBytes, err := os.ReadFile(filepath.Join(dir, "config.json"))
	if err != nil {
		return id, cfg, err
	}
	_ = json.Unmarshal(cfgBytes, &cfg)
	return id, cfg, nil
}
