// 修复方案的业务规则：病害程度分级、确认要求、变更失效与返工处置。
// 不依赖 HTTP 与存储，所有函数接收数据对象并就地修改，由调用方负责落库。

const SEVERITY_RANK = { 轻微: 1, 中度: 2, 严重: 3 };
const SEVERITY_ALIASES = {
  轻微: "轻微",
  中度: "中度",
  严重: "严重",
  light: "轻微",
  moderate: "中度",
  severe: "严重"
};

function ruleError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function normalizeSeverity(input) {
  const severity = SEVERITY_ALIASES[String(input == null ? "" : input).trim()];
  if (!severity) throw ruleError(400, "病害程度必须是：轻微 / 中度 / 严重");
  return severity;
}

// 严重病害的方案须由另一名技术负责人确认后才可施工
function requiresConfirmation(plan) {
  return plan.severity === "严重";
}

function statusFor(plan) {
  return requiresConfirmation(plan) ? "pending_review" : "confirmed";
}

function createPlan({ damageId, severity, method, restorer, note, now, makeId }) {
  const plan = {
    id: makeId("plan"),
    damageId,
    severity: normalizeSeverity(severity),
    method,
    restorer,
    note: note || "",
    status: "pending_review",
    confirmations: [],
    history: [],
    createdAt: now,
    updatedAt: now
  };
  plan.status = statusFor(plan);
  plan.history.push({
    id: makeId("history"),
    action: "create",
    changes: {},
    reason: "登记修复方案",
    invalidatedConfirmations: [],
    changedAt: now
  });
  return plan;
}

function diffPlan(plan, patch) {
  const changes = {};
  if (patch.method !== undefined && patch.method !== plan.method) {
    changes.method = { from: plan.method, to: patch.method };
  }
  if (patch.severity !== undefined && patch.severity !== plan.severity) {
    changes.severity = { from: plan.severity, to: patch.severity };
  }
  if (patch.restorer !== undefined && patch.restorer !== plan.restorer) {
    changes.restorer = { from: plan.restorer, to: patch.restorer };
  }
  return changes;
}

// 更换补法或加重病害程度都会导致原确认失效
function isInvalidating(changes) {
  if (changes.method) return true;
  if (changes.severity && SEVERITY_RANK[changes.severity.to] > SEVERITY_RANK[changes.severity.from]) return true;
  return false;
}

// 已动工 = 已开始施工或已修复
function damageStarted(damage) {
  return Boolean(damage.startedAt) || damage.status === "repaired";
}

// 批次内有方案未确认（或缺损被退回等待审核）时，整批停在等待审核
function evaluateBatchStatus(batch, batchDamages, planByDamageId) {
  if (batch.status === "completed") return batch.status;
  const waiting = batchDamages.some((damage) => {
    if (damage.status === "pending_review") return true;
    const plan = planByDamageId.get(damage.id);
    return !plan || plan.status !== "confirmed";
  });
  return waiting ? "pending_review" : "in_progress";
}

// 修改方案：登记修改历史；若换补法或加重病害，原确认失效，
// 未动工的缺损退回等待审核，已动工的留下返工记录，同批其他缺损不受影响。
function applyPlanChange({ plan, damage, patch, reason, now, makeId }) {
  const changes = diffPlan(plan, patch);
  if (Object.keys(changes).length === 0) {
    return { changed: false, invalidating: false, reworkRecord: null };
  }
  if (changes.method) plan.method = changes.method.to;
  if (changes.severity) plan.severity = changes.severity.to;
  if (changes.restorer) plan.restorer = changes.restorer.to;
  plan.updatedAt = now;

  const invalidating = isInvalidating(changes);
  let invalidatedConfirmations = [];
  if (invalidating) {
    invalidatedConfirmations = plan.confirmations.splice(0).map((item) => ({ ...item, invalidatedAt: now }));
    plan.status = statusFor(plan);
  }
  plan.history.push({
    id: makeId("history"),
    action: "update",
    changes,
    reason: reason || "",
    invalidatedConfirmations,
    changedAt: now
  });

  let reworkRecord = null;
  if (invalidating && damage && damage.batchId) {
    if (damageStarted(damage)) {
      reworkRecord = {
        id: makeId("rework"),
        planId: plan.id,
        batchId: damage.batchId,
        reason: reason || "更换补法或加重病害程度，原确认失效",
        changes,
        createdAt: now
      };
      damage.reworkRecords.push(reworkRecord);
    } else if (plan.status === "pending_review") {
      damage.status = "pending_review";
    }
  }
  return { changed: true, invalidating, reworkRecord };
}

// 确认方案：仅限待审核方案，且确认人不能是责任修复师本人
function applyConfirmation({ plan, damage, confirmer, note, now, makeId }) {
  if (plan.status !== "pending_review") throw ruleError(409, "方案当前无需确认或已确认");
  if (!confirmer) throw ruleError(400, "缺少字段：confirmer");
  if (confirmer === plan.restorer) {
    throw ruleError(400, "严重病害方案须由另一名技术负责人确认，确认人不能是责任修复师");
  }
  const confirmation = { id: makeId("confirm"), confirmer, note: note || "", confirmedAt: now };
  plan.confirmations.push(confirmation);
  plan.status = "confirmed";
  plan.updatedAt = now;
  plan.history.push({
    id: makeId("history"),
    action: "confirm",
    changes: {},
    reason: note || "",
    invalidatedConfirmations: [],
    confirmer,
    changedAt: now
  });
  if (damage && damage.batchId && damage.status === "pending_review") {
    damage.status = "in_repair";
  }
  return confirmation;
}

module.exports = {
  SEVERITY_RANK,
  normalizeSeverity,
  requiresConfirmation,
  statusFor,
  createPlan,
  diffPlan,
  isInvalidating,
  damageStarted,
  evaluateBatchStatus,
  applyPlanChange,
  applyConfirmation
};
