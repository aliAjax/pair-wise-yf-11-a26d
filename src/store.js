"use strict";

// 存储层：只负责 data/db.json 的读写与结构迁移，重启服务后数据仍可查询。
const { readFile, writeFile, mkdir } = require("fs/promises");
const path = require("path");

const DB_FILE = process.env.DB_FILE
  ? path.resolve(process.env.DB_FILE)
  : path.join(__dirname, "..", "data", "db.json");

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function blankDamagePlanFields() {
  return {
    severity: null, // minor | moderate | severe
    plan: null, // { severity, method, restorer, version, submittedAt, updatedAt }
    confirmation: null, // { reviewer, reviewerRole, confirmedAt, planVersion, planSnapshot }
    startedAt: null,
    rework: null,
    reworkCount: 0
  };
}

const initialData = {
  rubbings: [
    {
      id: "rubbing_demo",
      code: "TP-清-014",
      source: "地方碑刻残页",
      paperSize: "42x68cm",
      note: "边缘有旧折痕",
      createdAt: "2026-06-16T00:00:00.000Z"
    }
  ],
  damages: [
    {
      id: "damage_demo_1",
      rubbingId: "rubbing_demo",
      position: "左上角第3列题字旁",
      type: "虫蛀孔",
      beforePhotoUrl: "https://example.local/before-014-1.jpg",
      afterPhotoUrl: "",
      status: "waiting_review",
      repairNote: "",
      batchId: null,
      createdAt: "2026-06-16T00:00:00.000Z",
      startedAt: null,
      repairedAt: null,
      plan: null,
      confirmation: null,
      rework: null,
      reworkCount: 0
    },
    {
      id: "damage_demo_2",
      rubbingId: "rubbing_demo",
      position: "下边缘中央",
      type: "撕裂",
      beforePhotoUrl: "https://example.local/before-014-2.jpg",
      afterPhotoUrl: "",
      status: "waiting_review",
      repairNote: "",
      batchId: null,
      createdAt: "2026-06-16T00:00:00.000Z",
      startedAt: null,
      repairedAt: null,
      plan: null,
      confirmation: null,
      rework: null,
      reworkCount: 0
    }
  ],
  batches: [],
  history: []
};

// 旧库字段迁移：旧 pending/in_repair 状态映射到新工作流
function migrate(db) {
  let changed = false;
  if (!Array.isArray(db.history)) {
    db.history = [];
    changed = true;
  }
  for (const damage of db.damages || []) {
    if (damage.plan === undefined) {
      Object.assign(damage, blankDamagePlanFields());
      if (damage.status === "pending") damage.status = "waiting_review";
      changed = true;
    }
  }
  return changed;
}

async function ensureDb() {
  await mkdir(path.dirname(DB_FILE), { recursive: true });
  let needInit = false;
  let db;
  try {
    db = JSON.parse(await readFile(DB_FILE, "utf8"));
  } catch {
    needInit = true;
    db = JSON.parse(JSON.stringify(initialData));
  }
  if (migrate(db) || needInit) {
    await writeFile(DB_FILE, JSON.stringify(db, null, 2));
  }
  return db;
}

async function readDb() {
  await ensureDb();
  return JSON.parse(await readFile(DB_FILE, "utf8"));
}

async function writeDb(db) {
  await writeFile(DB_FILE, JSON.stringify(db, null, 2));
}

module.exports = { DB_FILE, makeId, readDb, writeDb, initialData, blankDamagePlanFields };
