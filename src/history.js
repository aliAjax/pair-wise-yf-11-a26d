"use strict";

// 记录层：审批与修改历史只追加、不修改、不删除，与规则层分离维护。
const { makeId } = require("./store");

// 领域事件统一从这里入库；每次返回带 id/时间的完整记录
function append(db, { type, damageId = null, batchId = null, actor = "", detail = {} }, now) {
  const record = {
    id: makeId("hist"),
    type,
    damageId,
    batchId,
    actor,
    detail,
    at: now
  };
  db.history.push(record);
  return record;
}

// 一次操作可能产生多条记录（如方案失效 + 返工 + 批次重开）
function appendMany(db, damageId, events, now) {
  return events.map((event) =>
    append(
      db,
      {
        type: event.type,
        damageId: damageId || null,
        batchId: event.batchId || null,
        actor: event.actor || "",
        detail: event.detail || {}
      },
      now
    )
  );
}

function query(db, { damageId, batchId, type } = {}) {
  return db.history
    .filter(
      (record) =>
        (!damageId || record.damageId === damageId)
        && (!batchId || record.batchId === batchId)
        && (!type || record.type === type)
    )
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

module.exports = { append, appendMany, query };
