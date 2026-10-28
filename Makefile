# MeshMind 本地开发命令
.DEFAULT_GOAL := help
.PHONY: help saas saas-check saas-container

help:
	@echo "MeshMind v3: make saas | make saas-check | make saas-container"
	@echo "首次运行：cd saas && npm ci；说明见 saas/README.md"

saas:
	cd saas && npm start

saas-check:
	cd saas && npm run typecheck && npm test

saas-container:
	docker compose -f saas/compose.local.yml up --build -d

# 以下是 v1/v2 历史开发入口。
.PHONY: infra-env nats nats-stop master agent agent2 task-echo clean

infra-env:
	@sh infra/init-local-env.sh

# 启动 NATS（JetStream）。本机无 docker compose 插件，用 docker run。
nats: infra-env
	docker rm -f meshmind-nats 2>/dev/null || true
	@set -a; . infra/.env; set +a; \
	  docker run -d --name meshmind-nats \
	    -p 127.0.0.1:4222:4222 -p 127.0.0.1:8222:8222 \
	    nats:2.10-alpine -js -m 8222 --user "$$NATS_USERNAME" --pass "$$NATS_PASSWORD"
	@sleep 2 && curl -s http://localhost:8222/healthz && echo " <- NATS OK"

nats-stop:
	docker rm -f meshmind-nats 2>/dev/null || true

# 主 Agent 监听器（P0：在线设备表）
master: infra-env
	@set -a; . infra/.env; set +a; cd master && \
	  NATS_URL="nats://127.0.0.1:4222" npm run start

# 子 Agent（默认 device_id=本机 hostname）
agent: infra-env
	@set -a; . infra/.env; set +a; cd agent && \
	  NATS_URL="nats://127.0.0.1:4222" go run .

# 第二台模拟设备
agent2: infra-env
	@set -a; . infra/.env; set +a; cd agent && \
	  NATS_URL="nats://127.0.0.1:4222" DEVICE_ID=linux-box go run .

# 发一条 echo 任务给某设备：make task-echo DEV=mac-studio
task-echo: infra-env
	@set -a; . infra/.env; set +a; cd master && \
	  NATS_URL="nats://127.0.0.1:4222" npm run -s task -- $(DEV) echo "hello from make"

clean: nats-stop
	pkill -f "tsx src/index.ts" 2>/dev/null || true
	pkill -f "meshmind/agent" 2>/dev/null || true

# 下发编排目标：make goal G="shell-all uname -a"
goal: infra-env
	@set -a; . infra/.env; set +a; cd master && \
	  NATS_URL="nats://127.0.0.1:4222" npm run -s goal -- $(G)

# v2 历史部署，显式命名以免将旧原型误作 SaaS 发布。
deploy-legacy-cloudflare:
	bash cloudflare/scripts/deploy.sh

deploy:
	@echo "v3 SaaS 部署入口：saas/compose.public.yml；先按 saas/README.md 配置域名与 HTTPS。"
	@echo "v2 历史 Cloudflare 部署：make deploy-legacy-cloudflare"
