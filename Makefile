# MeshMind 本地开发命令
.PHONY: nats nats-stop master agent agent2 task-echo clean

# 启动 NATS（JetStream）。本机无 docker compose 插件，用 docker run。
nats:
	docker rm -f meshmind-nats 2>/dev/null || true
	docker run -d --name meshmind-nats -p 4222:4222 -p 8222:8222 nats:2.10-alpine -js -m 8222
	@sleep 2 && curl -s http://localhost:8222/healthz && echo " <- NATS OK"

nats-stop:
	docker rm -f meshmind-nats 2>/dev/null || true

# 主 Agent 监听器（P0：在线设备表）
master:
	cd master && npm run start

# 子 Agent（默认 device_id=本机 hostname）
agent:
	cd agent && go run .

# 第二台模拟设备
agent2:
	cd agent && DEVICE_ID=linux-box go run .

# 发一条 echo 任务给某设备：make task-echo DEV=mac-studio
task-echo:
	cd master && npm run -s task -- $(DEV) echo "hello from make"

clean: nats-stop
	pkill -f "tsx src/index.ts" 2>/dev/null || true
	pkill -f "meshmind/agent" 2>/dev/null || true

# 下发编排目标：make goal G="shell-all uname -a"
goal:
	cd master && npm run -s goal -- $(G)

# 部署 Cloudflare Hub（需先放好 cloudflare/.deploy.env 或 wrangler login）
deploy:
	bash cloudflare/scripts/deploy.sh
