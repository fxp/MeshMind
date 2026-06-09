// MeshMind 子 Agent
//
// 子命令：
//   join   一次性入网仪式（令牌 → 生成密钥 → 入 mesh → 注册端点 → 落盘）
//   run    正常运行态（加载身份 → 连 NATS → 签名注册 → 心跳 → 监听任务）
//
//   meshmind-agent join --token <令牌> [--skip-network]
//   meshmind-agent run
//   go run . run            # 等价
//   go run .                # 无子命令 → 默认 run（兼容 dev 回退）
package main

import "os"

const agentVersion = "0.0.1"

func main() {
	if len(os.Args) < 2 {
		runCmd(nil) // 无参数 → 默认 run
		return
	}
	switch os.Args[1] {
	case "join":
		joinCmd(os.Args[2:])
	case "run":
		runCmd(os.Args[2:])
	default:
		// 兼容旧用法：裸 flag 直接当 run（如 DEVICE_ID=x go run .）
		runCmd(os.Args[1:])
	}
}
