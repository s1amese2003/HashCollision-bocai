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

## 运维

在服务器上以 root 执行（不需要登录网页，立即生效）：

```bash
predictctl status              # 全站交易状态 + 未结算市场
predictctl halt on|off         # 暂停 / 恢复全站交易
predictctl pause <id> on|off   # 暂停 / 恢复单个市场
predictctl reconcile           # 账务对账
```

管理员在网页上也可以操作：市场页面的「交易控制」卡片（暂停本市场、追加流动性），页脚的「暂停全站交易」。

## 流动性

每个新市场的流动性 = 创建者补贴 + 平台补贴（`HOUSE_SUBSIDY`，默认 500 积分）。
平台资金走系统账户 `__house__`（不能登录，不进排行榜），每笔注资记为 `house_mint` 流水。
结算后池中剩余按出资比例退还创建者和平台。管理员可给交易中的市场追加流动性，价格保持不变，
所需注资随价格偏离 50% 而增加；价格超出 1%–99% 时不能追加。
