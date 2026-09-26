"use strict";

// 请求处理层：HTTP 路由/入参解析，业务规则全部委托给 src/rules.js，
// 审批与修改历史由 src/history.js 记录，持久化由 src/store.js 负责。
const http = require("http");
const { readDb, writeDb, makeId, blankDamagePlanFields } = require("./src/store");
const history = require("./src/history");
const rules = require("./src/rules");

const PORT = Number(process.env.PORT || 3020);

const STATUS = rules.STATUS;
const SEVERITY = rules.SEVERITY;

const routes = [
  "GET /health",
  "GET /rubbings",
  "POST /rubbings",
  "GET /rubbings/:id/damages",
  "POST /rubbings/:id/damages",
  "GET /damages?status=&severity=&needsReview=",
  "GET /damages/:id",
  "PATCH /damages/:id",
  "PUT /damages/:id/plan",
  "POST /damages/:id/confirm",
  "POST /damages/:id/start",
  "POST /damages/:id/finish",
  "GET /damages/:id/history",
  "GET /batches",
  "POST /batches",
  "GET /batches/:id",
  "POST /batches/:id/complete",
  "GET /batches/:id/history",
  "GET /history?damageId=&batchId=&type="
];

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

async function parseBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const error = new rules.DomainError("请求体必须是合法JSON", 400);
    throw error;
  }
}

function required(body, fields) {
  const missing = fields.filter((field) => body[field] === undefined || body[field] === "");
  if (missing.length) {
    throw new rules.DomainError(`缺少字段：${missing.join("、")}`, 400);
  }
}

function findRubbing(db, rubbingId) {
  const rubbing = db.rubbings.find((item) => item.id === rubbingId);
  if (!rubbing) throw new rules.DomainError("拓片不存在", 404);
  return rubbing;
}

function findDamage(db, damageId) {
  const damage = db.damages.find((item) => item.id === damageId);
  if (!damage) throw new rules.DomainError("缺损项不存在", 404);
  return damage;
}

function findBatch(db, batchId) {
  const batch = db.batches.find((item) => item.id === batchId);
  if (!batch) throw new rules.DomainError("修补批次不存在", 404);
  return batch;
}

// 领域操作 + 历史记录 + 落库 的统一包装
async function commit(db, damageId, events) {
  const records = history.appendMany(db, damageId, events, new Date().toISOString());
  await writeDb(db);
  return records;
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  const db = await readDb();
  const now = new Date().toISOString();

  if (req.method === "GET" && pathname === "/health") {
    return send(res, 200, {
      ok: true,
      service: "rubbing-repair-api",
      severity: SEVERITY,
      statusFlow: [STATUS.WAITING_REVIEW, STATUS.CONFIRMED, STATUS.IN_REPAIR, STATUS.REPAIRED],
      routes
    });
  }

  if (req.method === "GET" && pathname === "/rubbings") {
    const data = db.rubbings.map((rubbing) => {
      const damages = db.damages.filter((item) => item.rubbingId === rubbing.id);
      return {
        ...rubbing,
        damageCount: damages.length,
        waitingReview: damages.filter((item) => !item.plan || !item.confirmation).length
      };
    });
    return send(res, 200, { data });
  }

  if (req.method === "POST" && pathname === "/rubbings") {
    const body = await parseBody(req);
    required(body, ["code", "source", "paperSize"]);
    const rubbing = {
      id: makeId("rubbing"),
      code: body.code,
      source: body.source,
      paperSize: body.paperSize,
      note: body.note || "",
      createdAt: now
    };
    db.rubbings.push(rubbing);
    await writeDb(db);
    return send(res, 201, { data: rubbing });
  }

  const rubbingDamagesMatch = pathname.match(/^\/rubbings\/([^/]+)\/damages$/);
  if (rubbingDamagesMatch && req.method === "GET") {
    const rubbingId = rubbingDamagesMatch[1];
    findRubbing(db, rubbingId);
    return send(res, 200, { data: db.damages.filter((item) => item.rubbingId === rubbingId) });
  }

  if (rubbingDamagesMatch && req.method === "POST") {
    const rubbingId = rubbingDamagesMatch[1];
    findRubbing(db, rubbingId);
    const body = await parseBody(req);
    required(body, ["position", "type", "beforePhotoUrl"]);
    const damage = {
      id: makeId("damage"),
      rubbingId,
      position: body.position,
      type: body.type,
      beforePhotoUrl: body.beforePhotoUrl,
      afterPhotoUrl: "",
      status: STATUS.WAITING_REVIEW,
      repairNote: "",
      batchId: null,
      createdAt: now,
      repairedAt: null,
      ...blankDamagePlanFields()
    };
    db.damages.push(damage);
    history.append(
      db,
      { type: "damage_registered", damageId: damage.id, actor: "", detail: { position: damage.position, type: damage.type } },
      now
    );
    await writeDb(db);
    return send(res, 201, { data: damage });
  }

  if (req.method === "GET" && pathname === "/damages") {
    const status = url.searchParams.get("status");
    const severity = url.searchParams.get("severity");
    const needsReview = url.searchParams.get("needsReview");
    const type = url.searchParams.get("type");
    const data = db.damages.filter((item) => {
      if (status && item.status !== status) return false;
      if (severity && (!item.plan || item.plan.severity !== severity)) return false;
      if (type && item.type !== type) return false;
      if (needsReview === "true" && (item.plan && item.confirmation)) return false;
      if (needsReview === "false" && (!item.plan || !item.confirmation)) return false;
      return true;
    });
    return send(res, 200, { data });
  }

  if (pathname === "/history" && req.method === "GET") {
    const records = history.query(db, {
      damageId: url.searchParams.get("damageId"),
      batchId: url.searchParams.get("batchId"),
      type: url.searchParams.get("type")
    });
    return send(res, 200, { data: records });
  }

  const damageMatch = pathname.match(/^\/damages\/([^/]+)$/);
  if (damageMatch && req.method === "GET") {
    return send(res, 200, { data: findDamage(db, damageMatch[1]) });
  }

  if (damageMatch && req.method === "PATCH") {
    const damage = findDamage(db, damageMatch[1]);
    const body = await parseBody(req);
    // 基础登记信息可改；方案三要素必须走 PUT /plan，状态只能走确认/动工/完工接口
    for (const field of ["position", "type", "beforePhotoUrl", "afterPhotoUrl", "repairNote"]) {
      if (typeof body[field] === "string") damage[field] = body[field];
    }
    await commit(db, damage.id, [
      { type: "damage_info_updated", actor: body.actor || "", detail: { fields: Object.keys(body) } }
    ]);
    return send(res, 200, { data: damage });
  }

  const planMatch = pathname.match(/^\/damages\/([^/]+)\/plan$/);
  if (planMatch && req.method === "PUT") {
    const damage = findDamage(db, planMatch[1]);
    const body = await parseBody(req);
    const events = rules.changeDamagePlan(db, damage, body, now);
    const records = await commit(db, damage.id, events);
    return send(res, 200, { data: damage, events: records });
  }

  const confirmMatch = pathname.match(/^\/damages\/([^/]+)\/confirm$/);
  if (confirmMatch && req.method === "POST") {
    const damage = findDamage(db, confirmMatch[1]);
    const body = await parseBody(req);
    const events = rules.confirmPlan(damage, body, now);
    const records = await commit(db, damage.id, events);
    return send(res, 200, { data: damage, events: records });
  }

  const startMatch = pathname.match(/^\/damages\/([^/]+)\/start$/);
  if (startMatch && req.method === "POST") {
    const damage = findDamage(db, startMatch[1]);
    const body = await parseBody(req);
    const events = rules.startWork(damage, body, now);
    const records = await commit(db, damage.id, events);
    return send(res, 200, { data: damage, events: records });
  }

  const finishMatch = pathname.match(/^\/damages\/([^/]+)\/finish$/);
  if (finishMatch && req.method === "POST") {
    const damage = findDamage(db, finishMatch[1]);
    const body = await parseBody(req);
    const events = rules.finishWork(damage, body, now);
    const records = await commit(db, damage.id, events);
    return send(res, 200, { data: damage, events: records });
  }

  const damageHistoryMatch = pathname.match(/^\/damages\/([^/]+)\/history$/);
  if (damageHistoryMatch && req.method === "GET") {
    findDamage(db, damageHistoryMatch[1]);
    return send(res, 200, { data: history.query(db, { damageId: damageHistoryMatch[1] }) });
  }

  if (req.method === "GET" && pathname === "/batches") {
    return send(res, 200, { data: db.batches.map((batch) => rules.batchView(db, batch)) });
  }

  if (req.method === "POST" && pathname === "/batches") {
    const body = await parseBody(req);
    required(body, ["name", "damageIds"]);
    const { batch, events } = rules.createBatch(db, body, makeId("batch"), now);
    for (const event of events) history.append(db, event, now);
    await writeDb(db);
    return send(res, 201, { data: rules.batchView(db, batch) });
  }

  const batchMatch = pathname.match(/^\/batches\/([^/]+)$/);
  if (batchMatch && req.method === "GET") {
    const batch = findBatch(db, batchMatch[1]);
    return send(res, 200, { data: rules.batchView(db, batch), blockers: rules.completionBlockers(db, batch) });
  }

  const batchHistoryMatch = pathname.match(/^\/batches\/([^/]+)\/history$/);
  if (batchHistoryMatch && req.method === "GET") {
    findBatch(db, batchHistoryMatch[1]);
    return send(res, 200, { data: history.query(db, { batchId: batchHistoryMatch[1] }) });
  }

  const completeMatch = pathname.match(/^\/batches\/([^/]+)\/complete$/);
  if (completeMatch && req.method === "POST") {
    const batch = findBatch(db, completeMatch[1]);
    const body = await parseBody(req);
    const events = rules.completeBatch(db, batch, body, now);
    for (const event of events) history.append(db, event, now);
    await writeDb(db);
    return send(res, 200, { data: rules.batchView(db, batch) });
  }

  return send(res, 404, { error: "接口不存在", routes });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => {
    if (error instanceof rules.DomainError) {
      return send(res, error.status || 400, {
        error: error.message,
        code: error.code,
        blockers: error.blockers
      });
    }
    return send(res, 500, { error: error.message || "服务器错误" });
  });
});

server.listen(PORT, () => {
  console.log(`Rubbing repair API running at http://127.0.0.1:${PORT}`);
});
