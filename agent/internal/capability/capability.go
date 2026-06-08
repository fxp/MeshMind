// Package capability 描述本设备能力，主 Agent 据此调度，子 Agent 据此强制作用域。
package capability

import (
	"os"
	"runtime"
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
	Sensors []string `json:"sensors"`
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
			Sensors: []string{},
		},
	}
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
