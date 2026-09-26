const { readDb, writeDb } = require("./store");
const rules = require("./planRules");
const { send, parseBody, makeId, required, httpError } = require("./http");

const DAMAGE_STATUSES = ["pending", "pending_review", "in_repair", "repaired"];

const routes = [
  "GET /health",
  "GET /rubbings",
  "POST /rubbings",
  "GET /rubbings/:id/damages",
  "POST /rubbings/:id/damages",
  "GET /damages?status=&type=",
  "PATCH /damages/:id",
  "POST /damages/:id/start",
  "GET /damages/:id/plan",
  "POST /damages/:id/plan",
  "GET /plans?status=&damageId=",
  "GET /plans/:id",
  "PATCH /plans/:id",
  "POST /plans/:id/confirm",
  "GET /batches",
  "POST /batches",
  "GET /batches/:id",
  "POST /batches/:id/complete"
];

function findRubbing(db, rubbingId) {
  const rubbing = db.rubbings.find((item) => item.id === rubbingId);
  if (!rubbing) throw httpError(404, "拓片不存在");
  return rubbing;
}

function findDamage(db, damageId) {
  const damage = db.damages.find((item) => item.id === damageId);
  if (!damage) throw httpError(404, "缺损项不存在");
  return damage;
}

function findPlan(db, planId) {
  const plan = db.plans.find((item) => item.id === planId);
  if (!plan) throw httpError(404, "修复方案不存在");
  return plan;
}

function findBatch(db, batchId) {
  const batch = db.batches.find((item) => item.id === batchId);
  if (!batch) throw httpError(404, "修补批次不存在");
  return batch;
}

function planIndex(db) {
  return new Map(db.plans.map((plan) => [plan.damageId, plan]));
}

// 方案变动后重算批次状态（等待审核 / 施工中）
function syncBatchStatus(db, batch) {
  const damages = db.damages.filter((item) => batch.damageIds.includes(item.id));
  batch.status = rules.evaluateBatchStatus(batch, damages, planIndex(db));
}

function syncBatchOfDamage(db, damage) {
  if (!damage.batchId) return;
  const batch = db.batches.find((item) => item.id === damage.batchId);
  if (batch) syncBatchStatus(db, batch);
}

function enrichBatch(db, batch) {
  const plans = planIndex(db);
  const damages = db.damages
    .filter((item) => batch.damageIds.includes(item.id))
    .map((damage) => ({ ...damage, plan: plans.get(damage.id) || null }));
  return {
    ...batch,
    damages,
    total: damages.length,
    repaired: damages.filter((item) => item.status === "repaired").length,
    pending: damages.filter((item) => item.status !== "repaired").length,
    pendingReview: damages.filter((item) => item.status === "pending_review").length,
    unconfirmedPlans: damages.filter((item) => !item.plan || item.plan.status !== "confirmed").length
  };
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  const db = await readDb();

  if (req.method === "GET" && pathname === "/health") {
    return send(res, 200, { ok: true, service: "rubbing-repair-api", routes });
  }

  if (req.method === "GET" && pathname === "/rubbings") {
    const data = db.rubbings.map((rubbing) => {
      const damages = db.damages.filter((item) => item.rubbingId === rubbing.id);
      return {
        ...rubbing,
        damageCount: damages.length,
        pendingDamages: damages.filter((item) => item.status !== "repaired").length
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
      createdAt: new Date().toISOString()
    };
    db.rubbings.push(rubbing);
    await writeDb(db);
    return send(res, 201, { data: rubbing });
  }

  const rubbingDamagesMatch = pathname.match(/^\/rubbings\/([^/]+)\/damages$/);
  if (rubbingDamagesMatch && req.method === "GET") {
    const rubbing = findRubbing(db, rubbingDamagesMatch[1]);
    return send(res, 200, { data: db.damages.filter((item) => item.rubbingId === rubbing.id) });
  }

  if (rubbingDamagesMatch && req.method === "POST") {
    const rubbing = findRubbing(db, rubbingDamagesMatch[1]);
    const body = await parseBody(req);
    required(body, ["position", "type", "beforePhotoUrl"]);
    const damage = {
      id: makeId("damage"),
      rubbingId: rubbing.id,
      position: body.position,
      type: body.type,
      beforePhotoUrl: body.beforePhotoUrl,
      afterPhotoUrl: "",
      status: "pending",
      repairNote: "",
      batchId: null,
      startedAt: null,
      reworkRecords: [],
      createdAt: new Date().toISOString(),
      repairedAt: null
    };
    db.damages.push(damage);
    await writeDb(db);
    return send(res, 201, { data: damage });
  }

  if (req.method === "GET" && pathname === "/damages") {
    const status = url.searchParams.get("status");
    const type = url.searchParams.get("type");
    const data = db.damages.filter((item) => (!status || item.status === status) && (!type || item.type === type));
    return send(res, 200, { data });
  }

  const damageMatch = pathname.match(/^\/damages\/([^/]+)$/);
  if (damageMatch && req.method === "PATCH") {
    const damage = findDamage(db, damageMatch[1]);
    const body = await parseBody(req);
    if (body.status !== undefined && !DAMAGE_STATUSES.includes(body.status)) {
      throw httpError(400, `status必须是：${DAMAGE_STATUSES.join(" / ")}`);
    }
    Object.assign(damage, {
      position: body.position ?? damage.position,
      type: body.type ?? damage.type,
      beforePhotoUrl: body.beforePhotoUrl ?? damage.beforePhotoUrl,
      afterPhotoUrl: body.afterPhotoUrl ?? damage.afterPhotoUrl,
      status: body.status ?? damage.status,
      repairNote: body.repairNote ?? damage.repairNote
    });
    if (damage.status === "in_repair" && !damage.startedAt) damage.startedAt = new Date().toISOString();
    if (damage.status === "repaired") damage.repairedAt = new Date().toISOString();
    syncBatchOfDamage(db, damage);
    await writeDb(db);
    return send(res, 200, { data: damage });
  }

  const damageStartMatch = pathname.match(/^\/damages\/([^/]+)\/start$/);
  if (damageStartMatch && req.method === "POST") {
    const damage = findDamage(db, damageStartMatch[1]);
    if (!damage.batchId) throw httpError(400, "缺损尚未纳入修补批次，不能动工");
    if (damage.status === "repaired") throw httpError(409, "缺损已修复");
    const plan = planIndex(db).get(damage.id);
    if (!plan || plan.status !== "confirmed") throw httpError(409, "修复方案未确认，不能动工");
    damage.status = "in_repair";
    damage.startedAt = damage.startedAt || new Date().toISOString();
    await writeDb(db);
    return send(res, 200, { data: damage });
  }

  const damagePlanMatch = pathname.match(/^\/damages\/([^/]+)\/plan$/);
  if (damagePlanMatch && req.method === "GET") {
    const damage = findDamage(db, damagePlanMatch[1]);
    const plan = planIndex(db).get(damage.id);
    if (!plan) throw httpError(404, "该缺损尚未登记修复方案");
    return send(res, 200, { data: plan });
  }

  if (damagePlanMatch && req.method === "POST") {
    const damage = findDamage(db, damagePlanMatch[1]);
    if (planIndex(db).has(damage.id)) {
      throw httpError(409, "该缺损已登记修复方案，请使用 PATCH /plans/:id 修改");
    }
    const body = await parseBody(req);
    required(body, ["severity", "method", "restorer"]);
    const plan = rules.createPlan({
      damageId: damage.id,
      severity: body.severity,
      method: body.method,
      restorer: body.restorer,
      note: body.note,
      now: new Date().toISOString(),
      makeId
    });
    db.plans.push(plan);
    if (damage.batchId) {
      damage.status = plan.status === "confirmed" ? "in_repair" : "pending_review";
      syncBatchOfDamage(db, damage);
    }
    await writeDb(db);
    return send(res, 201, { data: plan });
  }

  if (req.method === "GET" && pathname === "/plans") {
    const status = url.searchParams.get("status");
    const damageId = url.searchParams.get("damageId");
    const data = db.plans.filter(
      (item) => (!status || item.status === status) && (!damageId || item.damageId === damageId)
    );
    return send(res, 200, { data });
  }

  const planMatch = pathname.match(/^\/plans\/([^/]+)$/);
  if (planMatch && req.method === "GET") {
    return send(res, 200, { data: findPlan(db, planMatch[1]) });
  }

  if (planMatch && req.method === "PATCH") {
    const plan = findPlan(db, planMatch[1]);
    const body = await parseBody(req);
    const patch = {};
    if (body.method !== undefined) patch.method = body.method;
    if (body.restorer !== undefined) patch.restorer = body.restorer;
    if (body.severity !== undefined) patch.severity = rules.normalizeSeverity(body.severity);
    const damage = db.damages.find((item) => item.id === plan.damageId);
    const result = rules.applyPlanChange({
      plan,
      damage,
      patch,
      reason: body.reason,
      now: new Date().toISOString(),
      makeId
    });
    if (result.changed) {
      if (damage) syncBatchOfDamage(db, damage);
      await writeDb(db);
    }
    return send(res, 200, {
      data: plan,
      meta: { changed: result.changed, invalidating: result.invalidating, reworkRecord: result.reworkRecord }
    });
  }

  const planConfirmMatch = pathname.match(/^\/plans\/([^/]+)\/confirm$/);
  if (planConfirmMatch && req.method === "POST") {
    const plan = findPlan(db, planConfirmMatch[1]);
    const body = await parseBody(req);
    const damage = db.damages.find((item) => item.id === plan.damageId);
    rules.applyConfirmation({
      plan,
      damage,
      confirmer: body.confirmer,
      note: body.note,
      now: new Date().toISOString(),
      makeId
    });
    if (damage) syncBatchOfDamage(db, damage);
    await writeDb(db);
    return send(res, 200, { data: plan });
  }

  if (req.method === "GET" && pathname === "/batches") {
    return send(res, 200, { data: db.batches.map((batch) => enrichBatch(db, batch)) });
  }

  if (req.method === "POST" && pathname === "/batches") {
    const body = await parseBody(req);
    required(body, ["name", "damageIds"]);
    if (!Array.isArray(body.damageIds) || body.damageIds.length === 0) {
      throw httpError(400, "damageIds必须是非空数组");
    }
    const invalid = body.damageIds.filter((id) => !db.damages.find((damage) => damage.id === id));
    if (invalid.length) throw httpError(400, `缺损项不存在：${invalid.join(", ")}`);
    const activeBatchIds = new Set(db.batches.filter((item) => item.status !== "completed").map((item) => item.id));
    const occupied = body.damageIds.filter((id) => {
      const damage = db.damages.find((item) => item.id === id);
      return damage.batchId && activeBatchIds.has(damage.batchId);
    });
    if (occupied.length) throw httpError(409, `缺损已在未结项批次中：${occupied.join(", ")}`);
    const plans = planIndex(db);
    const missingPlan = body.damageIds.filter((id) => !plans.has(id));
    if (missingPlan.length) throw httpError(400, `以下缺损尚未登记修复方案：${missingPlan.join(", ")}`);

    const batch = {
      id: makeId("batch"),
      name: body.name,
      status: "pending_review",
      damageIds: body.damageIds,
      note: body.note || "",
      createdAt: new Date().toISOString(),
      completedAt: null
    };
    db.batches.push(batch);
    db.damages.forEach((damage) => {
      if (!body.damageIds.includes(damage.id)) return;
      damage.batchId = batch.id;
      damage.status = plans.get(damage.id).status === "confirmed" ? "in_repair" : "pending_review";
    });
    syncBatchStatus(db, batch);
    await writeDb(db);
    return send(res, 201, { data: enrichBatch(db, batch) });
  }

  const batchMatch = pathname.match(/^\/batches\/([^/]+)$/);
  if (batchMatch && req.method === "GET") {
    return send(res, 200, { data: enrichBatch(db, findBatch(db, batchMatch[1])) });
  }

  const completeMatch = pathname.match(/^\/batches\/([^/]+)\/complete$/);
  if (completeMatch && req.method === "POST") {
    const batch = findBatch(db, completeMatch[1]);
    if (batch.status === "completed") throw httpError(409, "批次已结项");
    const plans = planIndex(db);
    const blocked = batch.damageIds.filter((id) => {
      const plan = plans.get(id);
      return !plan || plan.status !== "confirmed";
    });
    if (blocked.length) {
      throw httpError(409, `存在未确认的修复方案，批次停留在等待审核，无法结项：${blocked.join(", ")}`);
    }
    const body = await parseBody(req);
    const results = Array.isArray(body.results) ? body.results : [];
    batch.status = "completed";
    batch.completedAt = new Date().toISOString();
    batch.note = body.note ?? batch.note;
    db.damages.forEach((damage) => {
      if (!batch.damageIds.includes(damage.id)) return;
      const result = results.find((item) => item.damageId === damage.id) || {};
      damage.status = "repaired";
      damage.afterPhotoUrl = result.afterPhotoUrl || body.defaultAfterPhotoUrl || damage.afterPhotoUrl;
      damage.repairNote = result.repairNote || body.defaultRepairNote || damage.repairNote;
      damage.repairedAt = new Date().toISOString();
    });
    await writeDb(db);
    return send(res, 200, { data: enrichBatch(db, batch) });
  }

  return send(res, 404, { error: "接口不存在", routes });
}

module.exports = { handle };
