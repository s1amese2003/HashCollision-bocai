# 预测盘

极简的积分制事件预测市场（类似 Polymarket / Manifold）。积分只来自系统发放，不能充值、提现或兑换。

- 是/否二元市场，任何用户都可以创建，创建者出流动性补贴
- LMSR 自动做市，随时可买卖，价格即概率
- 创建者提交结果后进入公示期，管理员可以更正或作废
- 实时推送价格（WebSocket）、持仓、积分流水、排行榜

## 技术栈

Node 22+ / TypeScript / Fastify / SQLite (better-sqlite3) / Vue 3 + Vite

```
server/   后端（src/market/lmsr.ts 为定价核心）
web/      前端
deploy/   systemd、nginx、部署脚本
```

## 本地开发

```bash
pnpm install
pnpm --filter @pm/server dev      # API on :8090
pnpm --filter web dev             # 前端 on :5173，代理 /api 和 /ws
pnpm test                         # 单元测试 + 集成测试
```

## 部署

服务器上首次部署见 `deploy/`：Node 22 装在 `/opt/node22`，服务以 `predict` 用户运行，
数据库在 `/var/lib/predict/app.db`，nginx 在 8088 端口反向代理。之后更新只需：

```bash
/opt/HashCollision-bocai/deploy/deploy.sh
```

配置项见 `deploy/predict.env.example`（实际文件为 `/etc/predict.env`）。
`ADMIN_USERNAMES` 中的用户名注册后自动成为管理员。
