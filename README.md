# 古籍拓片缺损修补API

纯后端零依赖Node服务，使用 `data/db.json` 持久化拓片、缺损项、修复方案和修补批次，重启后审批与修改历史仍可查。

## 目录结构

- `server.js` — 入口，仅负责启动HTTP服务
- `src/router.js` — 请求处理：路由、参数校验、编排
- `src/planRules.js` — 方案规则：病害分级、确认要求、变更失效与返工处置
- `src/store.js` — 记录保存：读写 `data/db.json`，兼容旧库字段
- `src/http.js` — 通用HTTP小工具

## 启动

```bash
PORT=3020 node server.js
```

## 业务流程

1. 为每项缺损登记修复方案（病害程度、拟用补法、责任修复师）：`POST /damages/:id/plan`
   - 病害程度：`轻微 / 中度 / 严重`；轻微、中度登记即生效，**严重**方案进入 `pending_review`
2. 严重方案须由**另一名技术负责人**确认（不能是责任修复师本人）：`POST /plans/:id/confirm`
3. 组批：`POST /batches`。批次内所有缺损须已登记方案；有方案未确认时批次停在 `pending_review`，`POST /batches/:id/complete` 会被拒绝（409）
4. 动工登记：`POST /damages/:id/start`（方案未确认不能动工）
5. 修改方案：`PATCH /plans/:id`。**更换补法或加重病害程度**会导致：
   - 原确认失效，严重方案需重新确认
   - 尚未动工的缺损回到 `pending_review`
   - 已动工的缺损留下返工记录（`damage.reworkRecords`），继续施工
   - 同批其他缺损不受影响
6. 全部方案确认后批次恢复 `in_progress`，可结项：`POST /batches/:id/complete`

## 主要接口

- `GET /health`
- `GET /rubbings` / `POST /rubbings`
- `GET /rubbings/:id/damages` / `POST /rubbings/:id/damages`
- `GET /damages?status=&type=` / `PATCH /damages/:id`
- `POST /damages/:id/start`
- `GET /damages/:id/plan` / `POST /damages/:id/plan`
- `GET /plans?status=&damageId=` / `GET /plans/:id` / `PATCH /plans/:id`
- `POST /plans/:id/confirm`
- `GET /batches` / `POST /batches` / `GET /batches/:id` / `POST /batches/:id/complete`

## 闭环示例

```bash
# 登记严重病害方案
curl -X POST http://127.0.0.1:3020/damages/damage_demo_1/plan \
  -H 'Content-Type: application/json' \
  -d '{"severity":"严重","method":"整挖镶补","restorer":"王师傅"}'

# 另一名技术负责人确认
curl -X POST http://127.0.0.1:3020/plans/<planId>/confirm \
  -H 'Content-Type: application/json' \
  -d '{"confirmer":"赵技术","note":"同意该补法"}'

# 组批（缺损须均已登记方案）
curl -X POST http://127.0.0.1:3020/batches \
  -H 'Content-Type: application/json' \
  -d '{"name":"九月残页修补","damageIds":["damage_demo_1","damage_demo_2"]}'

# 中途更换补法：原确认失效，已动工的缺损留下返工记录
curl -X PATCH http://127.0.0.1:3020/plans/<planId> \
  -H 'Content-Type: application/json' \
  -d '{"method":"补纸托裱","reason":"虫蛀范围比预估大"}'

# 重新确认后结项
curl -X POST http://127.0.0.1:3020/batches/<batchId>/complete \
  -H 'Content-Type: application/json' \
  -d '{"defaultRepairNote":"按确认方案修补完成"}'
```
