// Package capability 描述本设备能力，主 Agent 据此调度，子 Agent 据此强制作用域。
package capability

import (
	"encoding/json"
	"net/http"
	"os"
	"runtime"
	"time"
)

// Manifest 是设备注册时上报的能力清单（见 proto/messages.md §1）。
type Manifest struct {
	DeviceID     string       `json:"device_id"`
	Hostname     string       `json:"hostname"`
	OS           string       `json:"os"`
	Arch         string       `json:"arch"`
	AgentVersion string       `json:"agent_version"`
	Capabilities Capabilities `json:"capabilities"`
}

type Capabilities struct {
	Shell   ShellCap `json:"shell"`
	FS      FSCap    `json:"fs"`
	GPU     GPUCap   `json:"gpu"`
	LLM     LLMCap   `json:"llm"`
	Sensors []string `json:"sensors"`
}

// LLMCap: 本地 OpenAI 兼容推理端点（如 Ollama）。设备据此声明「本地 LLM」能力。
type LLMCap struct {
	Available bool     `json:"available"`
	Endpoint  string   `json:"endpoint"` // OpenAI 兼容 base，如 http://localhost:11434/v1
	Models    []string `json:"models"`
}

// ShellCap: 命令白名单 + 拒绝破坏性操作。
type ShellCap struct {
	Allow           []string `json:"allow"`
	DenyDestructive bool     `json:"deny_destructive"`
}

// FSCap: 只读/可写路径白名单。
type FSCap struct {
	Read  []string `json:"read"`
	Write []string `json:"write"`
}

type GPUCap struct {
	Available bool `json:"available"`
}

// Detect 构建本机的默认能力清单。P0 用安全的保守默认值，
// 真实部署应由设备本地的策略文件覆盖（P4）。
func Detect(deviceID, version string) Manifest {
	host, _ := os.Hostname()
	home, _ := os.UserHomeDir()

	return Manifest{
		DeviceID:     deviceID,
		Hostname:     host,
		OS:           runtime.GOOS,
		Arch:         runtime.GOARCH,
		AgentVersion: version,
		Capabilities: Capabilities{
			Shell: ShellCap{
				Allow:           []string{"ls", "stat", "du", "pwd", "echo", "uname", "git", "python3"},
				DenyDestructive: true,
			},
			FS: FSCap{
				Read:  []string{home},
				Write: []string{},
			},
			GPU:     GPUCap{Available: false},
			LLM:     detectLLM(),
			Sensors: []string{},
		},
	}
}

// detectLLM 探测本地 OpenAI 兼容推理端点（默认 Ollama :11434）。
// 端点可用 MESHMIND_LLM_ENDPOINT 覆盖。不可达则 Available=false。
func detectLLM() LLMCap {
	endpoint := os.Getenv("MESHMIND_LLM_ENDPOINT")
	if endpoint == "" {
		endpoint = "http://localhost:11434/v1"
	}
	client := &http.Client{Timeout: 3 * time.Second}
	resp, err := client.Get(endpoint + "/models")
	if err != nil || resp.StatusCode != 200 {
		if resp != nil {
			resp.Body.Close()
		}
		return LLMCap{Available: false}
	}
	defer resp.Body.Close()
	var body struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil || len(body.Data) == 0 {
		return LLMCap{Available: false}
	}
	models := make([]string, 0, len(body.Data))
	for _, m := range body.Data {
		models = append(models, m.ID)
	}
	return LLMCap{Available: true, Endpoint: endpoint, Models: models}
}

// AllowsCommand 判断某个基础命令是否在 shell 白名单内。
func (c ShellCap) AllowsCommand(base string) bool {
	for _, a := range c.Allow {
		if a == base {
			return true
		}
	}
	return false
}

// DestructiveCommands 是即使在白名单也会被拒的高危命令前缀。
var DestructiveCommands = map[string]bool{
	"rm": true, "rmdir": true, "dd": true, "mkfs": true, "shutdown": true,
	"reboot": true, "kill": true, "killall": true, "format": true, "fdisk": true,
}
