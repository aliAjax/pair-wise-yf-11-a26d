"use strict";

// 修复方案领域规则：纯逻辑，不做任何 HTTP / 文件 I/O。
// 状态机：waiting_review(等待审核) -> confirmed(已确认) -> in_repair(施工中) -> repaired(已修复)
// 已动工缺损方案失效：不回退状态，挂 rework(返工) 记录，重新确认并完成返工后才能结项。

const SEVERITY = {
  MINOR: "minor", // 轻微
  MODERATE: "moderate", // 中等
  SEVERE: "severe" // 严重
};

const SEVERITY_RANK = {
  [SEVERITY.MINOR]: 1,
  [SEVERITY.MODERATE]: 2,
  [SEVERITY.SEVERE]: 3
};

const STATUS = {
  WAITING_REVIEW: "waiting_review",
  CONFIRMED: "confirmed",
  IN_REPAIR: "in_repair",
  REPAIRED: "repaired"
};

class DomainError extends Error {
  constructor(message, status = 400, extra = {}) {
    super(message);
    this.name = "DomainError";
    this.status = status;
    Object.assign(this, extra);
  }
}

function trim(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new DomainError(`${label}不能为空`, 400);
  }
  return value.trim();
}

function normalizePlanInput(body) {
  const severity = trim(body.severity, "病害程度");
  if (!SEVERITY_RANK[severity]) {
    throw new DomainError(
      `病害程度只能是：${Object.values(SEVERITY).join(", ")}`,
      400
    );
  }
  return {
    severity,
    method: trim(body.method, "拟用补法"),
    restorer: trim(body.restorer, "责任修复师")
  };
}

function hasBeenWorked(damage) {
  return Boolean(damage.startedAt) ||
    damage.status === STATUS.IN_REPAIR ||
    damage.status === STATUS.REPAIRED;
}

// 登记或修改修复方案，返回需要留痕的事件列表
function applyPlan(damage, body, now) {
  const next = normalizePlanInput(body);
  const actor = (typeof body.actor === "string" && body.actor.trim()) || next.restorer;
  const events = [];

  if (!damage.plan) {
    damage.plan = { ...next, version: 1, submittedAt: now, updatedAt: now };
    damage.confirmation = null;
    damage.status = STATUS.WAITING_REVIEW;
    events.push({
      type: "plan_submitted",
      actor,
      detail: { plan: { ...damage.plan } }
    });
    return events;
  }

  const before = {
    severity: damage.plan.severity,
    method: damage.plan.method,
    restorer: damage.plan.restorer
  };
  const methodChanged = before.method !== next.method;
  const severityIncreased = SEVERITY_RANK[next.severity] > SEVERITY_RANK[before.severity];
  const severityDecreased = SEVERITY_RANK[next.severity] < SEVERITY_RANK[before.severity];
  const restorerChanged = before.restorer !== next.restorer;

  if (!methodChanged && !severityIncreased && !severityDecreased && !restorerChanged) {
    return events;
  }

  // 规则：更换补法 或 加重病害程度 → 原确认失效
  const invalidated = methodChanged || severityIncreased;
  const reasons = [];
  if (methodChanged) reasons.push("method_changed");
  if (severityIncreased) reasons.push("severity_increased");
  if (severityDecreased) reasons.push("severity_decreased");
  if (restorerChanged) reasons.push("restorer_changed");

  Object.assign(damage.plan, next, { updatedAt: now });
  if (invalidated) damage.plan.version += 1;

  events.push({
    type: "plan_changed",
    actor,
    detail: { before, after: { ...next }, invalidated, reasons }
  });

  if (invalidated) {
    if (damage.confirmation) {
      events.push({
        type: "confirmation_invalidated",
        actor,
        detail: {
          reasons,
          previousConfirmation: damage.confirmation,
          worked: hasBeenWorked(damage)
        }
      });
    }
    damage.confirmation = null;

    if (hasBeenWorked(damage)) {
      // 已动工：不回退等待审核，留返工记录，返工方案需重新确认
      damage.reworkCount += 1;
      damage.rework = {
        required: true,
        reasons,
        at: now,
        reconfirmedAt: null,
        resolvedAt: null
      };
      if (damage.status === STATUS.REPAIRED) damage.status = STATUS.IN_REPAIR;
      events.push({
        type: "rework",
        actor,
        detail: { reasons, reworkCount: damage.reworkCount }
      });
    } else {
      // 尚未动工：回到等待审核；同批其他缺损不受影响
      damage.status = STATUS.WAITING_REVIEW;
    }
  }
  return events;
}

// 方案变更可能波及已结项批次（返工需重开批次）
function changeDamagePlan(db, damage, body, now) {
  const events = applyPlan(damage, body, now);
  if (damage.batchId) {
    const batch = db.batches.find((item) => item.id === damage.batchId);
    if (batch && batch.completedAt) {
      batch.completedAt = null;
      events.push({
        type: "batch_reopened",
        batchId: batch.id,
        actor: (typeof body.actor === "string" && body.actor.trim()) || damage.plan?.restorer || "",
        detail: { reason: "plan_changed_after_completion", damageId: damage.id }
      });
    }
  }
  return events;
}

function confirmPlan(damage, body, now) {
  if (!damage.plan) {
    throw new DomainError("尚未登记修复方案，无法审核", 400, { code: "plan_missing" });
  }
  if (damage.confirmation) {
    throw new DomainError("方案已确认，无需重复审核", 409, { code: "already_confirmed" });
  }
  const reviewer = trim(body.reviewer, "审核人");
  const reviewerRole = (typeof body.reviewerRole === "string" && body.reviewerRole.trim()) || "reviewer";

  if (damage.plan.severity === SEVERITY.SEVERE) {
    if (reviewerRole !== "technical_lead") {
      throw new DomainError(
        "严重病害的修复方案必须由技术负责人确认",
        400,
        { code: "technical_lead_required" }
      );
    }
    if (reviewer === damage.plan.restorer) {
      throw new DomainError(
        "严重病害须由责任修复师以外的另一名技术负责人确认，审核人不能与责任修复师为同一人",
        400,
        { code: "reviewer_must_differ" }
      );
    }
  }

  damage.confirmation = {
    reviewer,
    reviewerRole,
    confirmedAt: now,
    planVersion: damage.plan.version,
    planSnapshot: {
      severity: damage.plan.severity,
      method: damage.plan.method,
      restorer: damage.plan.restorer
    }
  };
  if (damage.status === STATUS.WAITING_REVIEW) damage.status = STATUS.CONFIRMED;
  if (damage.rework && damage.rework.required) damage.rework.reconfirmedAt = now;

  return [{
    type: "confirmed",
    actor: reviewer,
    detail: { reviewerRole, planVersion: damage.plan.version, plan: damage.confirmation.planSnapshot }
  }];
}

function startWork(damage, body, now) {
  if (!damage.plan) {
    throw new DomainError("尚未登记修复方案，不能动工", 400, { code: "plan_missing" });
  }
  if (!damage.confirmation) {
    throw new DomainError("方案尚未审核确认，该缺损停在等待审核", 409, { code: "waiting_confirmation" });
  }
  if (damage.status === STATUS.IN_REPAIR) {
    throw new DomainError("该缺损已在施工中", 409, { code: "already_in_repair" });
  }
  if (damage.status === STATUS.REPAIRED) {
    throw new DomainError("该缺损已修复，如需返工请先变更方案", 409, { code: "already_repaired" });
  }
  damage.status = STATUS.IN_REPAIR;
  if (!damage.startedAt) damage.startedAt = now;
  const actor = (typeof body.actor === "string" && body.actor.trim()) || damage.plan.restorer;
  return [{ type: "started", actor, detail: {} }];
}

function finishWork(damage, body, now) {
  if (damage.status !== STATUS.IN_REPAIR) {
    throw new DomainError("只有施工中的缺损可以登记修复完成", 409, { code: "not_in_repair" });
  }
  if (!damage.confirmation) {
    throw new DomainError("返工后的新方案尚未重新确认，不能完工", 409, { code: "waiting_confirmation" });
  }
  damage.status = STATUS.REPAIRED;
  damage.repairedAt = now;
  if (typeof body.afterPhotoUrl === "string") damage.afterPhotoUrl = body.afterPhotoUrl;
  if (typeof body.repairNote === "string") damage.repairNote = body.repairNote;

  const actor = (typeof body.actor === "string" && body.actor.trim()) || damage.plan.restorer;
  const detail = {};
  if (damage.rework && damage.rework.required) {
    damage.rework.required = false;
    damage.rework.resolvedAt = now;
    detail.reworkResolved = {
      reworkCount: damage.reworkCount,
      reconfirmedAt: damage.rework.reconfirmedAt,
      resolvedAt: now
    };
  }
  return [{ type: "repaired", actor, detail }];
}

function createBatch(db, body, id, now) {
  if (!Array.isArray(body.damageIds) || body.damageIds.length === 0) {
    throw new DomainError("damageIds必须是非空数组", 400);
  }
  const missing = body.damageIds.filter(
    (damageId) => !db.damages.some((damage) => damage.id === damageId)
  );
  if (missing.length) {
    throw new DomainError(`缺损项不存在：${missing.join(", ")}`, 400);
  }
  const alreadyBatched = body.damageIds.filter((damageId) => {
    const damage = db.damages.find((item) => item.id === damageId);
    if (!damage.batchId) return false;
    const batch = db.batches.find((item) => item.id === damage.batchId);
    return batch && !batch.completedAt;
  });
  if (alreadyBatched.length) {
    throw new DomainError(`缺损项已在未结项批次中：${alreadyBatched.join(", ")}`, 409);
  }

  const batch = {
    id,
    name: trim(body.name, "批次名称"),
    damageIds: [...body.damageIds],
    note: typeof body.note === "string" ? body.note : "",
    createdAt: now,
    completedAt: null
  };
  db.batches.push(batch);
  for (const damage of db.damages) {
    if (batch.damageIds.includes(damage.id)) damage.batchId = batch.id;
  }
  return {
    batch,
    events: [{ type: "batch_created", batchId: batch.id, actor: "", detail: { damageIds: batch.damageIds } }]
  };
}

function batchItems(db, batch) {
  return batch.damageIds
    .map((id) => db.damages.find((damage) => damage.id === id))
    .filter(Boolean);
}

// 结项前逐项检查；任何一项不满足都阻止结项
function completionBlockers(db, batch) {
  const blockers = [];
  for (const damage of batchItems(db, batch)) {
    if (!damage.plan) {
      blockers.push({ damageId: damage.id, code: "plan_missing", message: "未登记修复方案" });
    } else if (!damage.confirmation) {
      blockers.push({ damageId: damage.id, code: "waiting_confirmation", message: "修复方案尚未审核确认" });
    }
    if (damage.rework && damage.rework.required) {
      blockers.push({ damageId: damage.id, code: "rework_pending", message: "方案变更后的返工尚未完成" });
    }
    if (damage.status !== STATUS.REPAIRED) {
      blockers.push({ damageId: damage.id, code: "not_repaired", message: `缺损尚未修复完成（当前状态：${damage.status}）` });
    }
  }
  return blockers;
}

function completeBatch(db, batch, body, now) {
  if (batch.completedAt) {
    throw new DomainError("该批次已结项", 409, { code: "already_completed" });
  }
  const blockers = completionBlockers(db, batch);
  if (blockers.length) {
    throw new DomainError("批次仍有缺损不满足结项条件，停在等待审核，无法结项", 409, {
      code: "batch_blocked",
      blockers
    });
  }
  const results = Array.isArray(body.results) ? body.results : [];
  for (const damage of batchItems(db, batch)) {
    const result = results.find((item) => item.damageId === damage.id) || {};
    if (result.afterPhotoUrl) damage.afterPhotoUrl = result.afterPhotoUrl;
    if (result.repairNote) damage.repairNote = result.repairNote;
  }
  batch.completedAt = now;
  if (typeof body.note === "string") batch.note = body.note;
  return [{ type: "batch_completed", batchId: batch.id, actor: "", detail: { damageIds: batch.damageIds } }];
}

// 批次状态为派生值：有方案未确认 -> waiting_review；否则未结项期间为 open
function batchView(db, batch) {
  const damages = batchItems(db, batch);
  const waitingReview = damages.filter(
    (item) => !item.plan || !item.confirmation || (item.rework && item.rework.required)
  ).length;
  let status;
  if (batch.completedAt) status = "completed";
  else if (waitingReview > 0) status = STATUS.WAITING_REVIEW;
  else status = "open";
  return {
    ...batch,
    status,
    damages,
    total: damages.length,
    waitingReview,
    confirmed: damages.filter((item) => item.status === STATUS.CONFIRMED).length,
    inRepair: damages.filter((item) => item.status === STATUS.IN_REPAIR).length,
    repaired: damages.filter((item) => item.status === STATUS.REPAIRED).length,
    reworkRequired: damages.filter((item) => item.rework && item.rework.required).length
  };
}

module.exports = {
  SEVERITY,
  SEVERITY_RANK,
  STATUS,
  DomainError,
  normalizePlanInput,
  changeDamagePlan,
  confirmPlan,
  startWork,
  finishWork,
  createBatch,
  completeBatch,
  completionBlockers,
  batchView
};
