const { readFile, writeFile, mkdir } = require("fs/promises");
const path = require("path");

const DB_FILE = path.join(__dirname, "..", "data", "db.json");

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
      status: "pending",
      repairNote: "",
      batchId: null,
      startedAt: null,
      reworkRecords: [],
      createdAt: "2026-06-16T00:00:00.000Z",
      repairedAt: null
    },
    {
      id: "damage_demo_2",
      rubbingId: "rubbing_demo",
      position: "下边缘中央",
      type: "撕裂",
      beforePhotoUrl: "https://example.local/before-014-2.jpg",
      afterPhotoUrl: "",
      status: "pending",
      repairNote: "",
      batchId: null,
      startedAt: null,
      reworkRecords: [],
      createdAt: "2026-06-16T00:00:00.000Z",
      repairedAt: null
    }
  ],
  batches: [],
  plans: []
};

// 兼容旧库：补齐后加的集合和字段，重启后历史数据仍可查
function normalize(db) {
  db.rubbings = db.rubbings || [];
  db.damages = db.damages || [];
  db.batches = db.batches || [];
  db.plans = db.plans || [];
  db.damages.forEach((damage) => {
    damage.reworkRecords = damage.reworkRecords || [];
    if (damage.startedAt === undefined) damage.startedAt = null;
  });
  db.plans.forEach((plan) => {
    plan.confirmations = plan.confirmations || [];
    plan.history = plan.history || [];
  });
  return db;
}

async function ensureDb() {
  await mkdir(path.dirname(DB_FILE), { recursive: true });
  try {
    JSON.parse(await readFile(DB_FILE, "utf8"));
  } catch {
    await writeFile(DB_FILE, JSON.stringify(initialData, null, 2));
  }
}

async function readDb() {
  await ensureDb();
  return normalize(JSON.parse(await readFile(DB_FILE, "utf8")));
}

async function writeDb(data) {
  await writeFile(DB_FILE, JSON.stringify(data, null, 2));
}

module.exports = { readDb, writeDb };
