# 古籍拓片缺损修补API

纯后端零依赖 Node 服务，使用 `data/db.json` 持久化拓片、缺损项、修复方案、修补批次和审批/修改历史，重启服务后数据仍可查询。

## 分层结构（请求处理 / 方案规则 / 记录保存拆开维护）

- `server.js` —— 请求处理层：HTTP 路由、入参解析、错误响应
- `src/rules.js` —— 方案规则层：病害程度、确认规则、状态机、失效与返工、批次结项拦截（纯逻辑，无 I/O）
- `src/history.js` —— 记录层：审批与修改历史只追加、不修改
- `src/store.js` —— 存储层：`data/db.json` 读写与旧数据迁移

## 启动

```bash
PORT=3020 node server.js
```

## 核心规则

- 每项缺损须登记修复方案：病害程度（`minor` 轻微 / `moderate` 中等 / `severe` 严重）、拟用补法、责任修复师
- 缺损状态机：`waiting_review`（等待审核）→ `confirmed`（已确认）→ `in_repair`（施工中）→ `repaired`（已修复）
- 方案未确认：缺损停在等待审核，不能动工，所在批次无法结项
- 严重病害：必须由**另一名技术负责人**（`reviewerRole: "technical_lead"`，且不能是责任修复师本人）确认
- 更换补法或加重病害程度 → 原确认失效（方案版本 +1）：
  - 尚未动工 → 回到等待审核，同批其他缺损继续施工
  - 已经动工 → 不回退状态，留下返工记录，重新确认并完成返工后方可结项
  - 若所在批次已结项 → 批次自动重开（`batch_reopened`）
- 减轻病害程度、仅更换责任修复师 → 原确认保持有效
- 批次结项条件：批内每项缺损均已确认、无待返工、状态为已修复；否则返回 409 及逐项 `blockers`

## 主要接口

- `GET /health`
- `GET /rubbings` / `POST /rubbings`
- `GET /rubbings/:id/damages` / `POST /rubbings/:id/damages`
- `GET /damages?status=&severity=&needsReview=&type=` / `GET /damages/:id`
- `PATCH /damages/:id` —— 仅位置、类型、照片、修复备注等基础信息
- `PUT /damages/:id/plan` —— 登记/修改修复方案 `{severity, method, restorer}`
- `POST /damages/:id/confirm` —— 审核确认 `{reviewer, reviewerRole?}`
- `POST /damages/:id/start` / `POST /damages/:id/finish`
- `GET /damages/:id/history` —— 该缺损的审批与修改历史
- `GET /batches` / `POST /batches` / `GET /batches/:id`
- `POST /batches/:id/complete` / `GET /batches/:id/history`
- `GET /history?damageId=&batchId=&type=`

## 闭环示例

```bash
# 1. 登记方案（严重病害）
curl -X PUT http://127.0.0.1:3020/damages/damage_demo_2/plan \
  -H 'Content-Type: application/json' \
  -d '{"severity":"severe","method":"撕裂口托裱加固","restorer":"李师傅"}'

# 2. 另一名技术负责人确认
curl -X POST http://127.0.0.1:3020/damages/damage_demo_2/confirm \
  -H 'Content-Type: application/json' \
  -d '{"reviewer":"王主任","reviewerRole":"technical_lead"}'

# 3. 动工 -> 完工 -> 批次结项
curl -X POST http://127.0.0.1:3020/damages/damage_demo_2/start
curl -X POST http://127.0.0.1:3020/damages/damage_demo_2/finish \
  -H 'Content-Type: application/json' -d '{"repairNote":"托裱加固完成"}'
```

## 测试

```bash
node test/e2e.js   # 需服务已启动，覆盖全部方案规则
```
