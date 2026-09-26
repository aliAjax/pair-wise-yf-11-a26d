"use strict";

// 端到端规则验证：node test/e2e.js（需服务已在 BASE 运行）
const BASE = process.env.BASE || "http://127.0.0.1:3020";

let failures = 0;
function check(name, condition, extra) {
  if (condition) {
    console.log(`  ok  ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL  ${name}`, extra === undefined ? "" : JSON.stringify(extra));
  }
}

async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: res.status, body: await res.json() };
}

async function main() {
  // ---- 1. 登记修复方案 ----
  let r = await api("PUT", "/damages/damage_demo_1/plan", {
    severity: "minor",
    method: "虫蛀孔补纸嵌补",
    restorer: "张师傅"
  });
  check("登记轻微病害方案", r.status === 200 && r.body.data.status === "waiting_review", r.body);
  const planV1 = r.body.data.plan.version;

  r = await api("PUT", "/damages/damage_demo_2/plan", {
    severity: "severe",
    method: "撕裂口托裱加固",
    restorer: "李师傅"
  });
  check("登记严重病害方案", r.status === 200 && r.body.data.plan.severity === "severe", r.body);

  r = await api("PUT", "/damages/damage_demo_1/plan", { severity: "extreme", method: "x", restorer: "y" });
  check("非法病害程度被拒绝", r.status === 400, r.body);

  // ---- 2. 未确认不能动工，批次停在等待审核 ----
  r = await api("POST", "/damages/damage_demo_1/start", {});
  check("方案未确认不能动工", r.status === 409 && r.body.code === "waiting_confirmation", r.body);

  r = await api("POST", "/batches", { name: "九月残页批", damageIds: ["damage_demo_1", "damage_demo_2"] });
  check("创建批次", r.status === 201, r.body);
  const batchId = r.body.data.id;
  check("批次有未确认方案时停在等待审核", r.body.data.status === "waiting_review", r.body.data.status);

  r = await api("POST", `/batches/${batchId}/complete`, {});
  check("未确认时批次无法结项", r.status === 409 && r.body.code === "batch_blocked" && r.body.blockers.filter((b) => b.code === "waiting_confirmation").length === 2, r.body);

  // ---- 3. 严重病害须另一名技术负责人确认 ----
  r = await api("POST", "/damages/damage_demo_2/confirm", { reviewer: "王主任", reviewerRole: "reviewer" });
  check("严重病害非技术负责人确认被拒绝", r.status === 400 && r.body.code === "technical_lead_required", r.body);

  r = await api("POST", "/damages/damage_demo_2/confirm", { reviewer: "李师傅", reviewerRole: "technical_lead" });
  check("严重病害审核人不能是责任修复师本人", r.status === 400 && r.body.code === "reviewer_must_differ", r.body);

  r = await api("POST", "/damages/damage_demo_2/confirm", { reviewer: "王主任", reviewerRole: "technical_lead" });
  check("严重病害由另一名技术负责人确认", r.status === 200 && r.body.data.confirmation.reviewer === "王主任", r.body);

  r = await api("POST", "/damages/damage_demo_1/confirm", { reviewer: "张师傅" });
  check("轻微病害常规确认", r.status === 200 && r.body.data.status === "confirmed", r.body);

  r = await api("GET", `/batches/${batchId}`);
  check("全部确认后批次离开等待审核", r.body.data.status === "open", r.body.data.status);

  // ---- 4. 动工后更换补法：确认失效、留返工记录、同批其他不受影响 ----
  await api("POST", "/damages/damage_demo_1/start", {});
  await api("POST", "/damages/damage_demo_2/start", {});

  r = await api("PUT", "/damages/damage_demo_1/plan", {
    severity: "minor",
    method: "虫蛀孔挖补镶绢",
    restorer: "张师傅"
  });
  const d1 = r.body.data;
  check("已动工缺损换补法后不回退状态", d1.status === "in_repair", d1.status);
  check("原确认失效", d1.confirmation === null, d1.confirmation);
  check("留下返工记录", d1.rework && d1.rework.required === true && d1.reworkCount === 1, d1.rework);
  check("方案版本递增", d1.plan.version === planV1 + 1, d1.plan.version);

  r = await api("GET", "/damages/damage_demo_2");
  check("同批其他缺损继续施工不受影响", r.body.data.status === "in_repair" && r.body.data.confirmation !== null, r.body.data);

  r = await api("POST", `/batches/${batchId}/complete`, {});
  check("返工未完成批次无法结项", r.status === 409 && r.body.blockers.some((b) => b.code === "rework_pending"), r.body.blockers);

  // 返工：重新确认 -> 完工
  r = await api("POST", "/damages/damage_demo_1/confirm", { reviewer: "赵组长" });
  check("返工方案重新确认", r.status === 200, r.body);
  r = await api("POST", "/damages/damage_demo_1/finish", { afterPhotoUrl: "https://example.local/after-014-1.jpg", repairNote: "挖补镶绢完成" });
  check("返工完工并消除返工标记", r.status === 200 && r.body.data.rework.required === false, r.body.data.rework);

  // ---- 5. 未动工缺损改方案：回到等待审核 ----
  const d3 = (await api("POST", "/rubbings/rubbing_demo/damages", {
    position: "右下角", type: "撕裂", beforePhotoUrl: "https://example.local/before-014-3.jpg"
  })).body.data;
  await api("PUT", `/damages/${d3.id}/plan`, { severity: "moderate", method: "撕裂口溜口纸加固", restorer: "陈师傅" });
  await api("POST", `/damages/${d3.id}/confirm`, { reviewer: "赵组长" });
  r = await api("PUT", `/damages/${d3.id}/plan`, { severity: "severe", method: "整页托裱", restorer: "陈师傅" });
  check("未动工缺损加重病害后回到等待审核", r.body.data.status === "waiting_review" && r.body.data.confirmation === null, r.body.data);

  // 减轻病害程度不触发失效
  await api("POST", `/damages/${d3.id}/confirm`, { reviewer: "王主任", reviewerRole: "technical_lead" });
  r = await api("PUT", `/damages/${d3.id}/plan`, { severity: "minor", method: "整页托裱", restorer: "陈师傅" });
  check("减轻病害程度原确认保持有效", r.body.data.confirmation !== null && r.body.data.status === "confirmed", r.body.data);

  // ---- 6. 结项 ----
  r = await api("POST", "/damages/damage_demo_2/finish", { repairNote: "托裱加固完成" });
  check("严重病害缺损完工", r.status === 200 && r.body.data.status === "repaired", r.body);
  r = await api("POST", `/batches/${batchId}/complete`, { note: "九月批结项" });
  check("全部修复后批次结项", r.status === 200 && r.body.data.status === "completed", r.body);

  // ---- 7. 历史留痕 ----
  r = await api("GET", "/damages/damage_demo_1/history");
  const types = r.body.data.map((h) => h.type);
  check("历史含方案/确认/动工/失效/返工/完工", ["plan_submitted", "confirmed", "started", "plan_changed", "confirmation_invalidated", "rework", "repaired"].every((t) => types.includes(t)), types);

  r = await api("GET", `/batches/${batchId}/history`);
  check("批次历史含创建与结项", r.body.data.some((h) => h.type === "batch_created") && r.body.data.some((h) => h.type === "batch_completed"), r.body.data);

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
