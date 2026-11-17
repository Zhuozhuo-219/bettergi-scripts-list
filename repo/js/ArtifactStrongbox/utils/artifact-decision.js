import { prepareProjectionInput } from "./projection-model.js"

export const DECISION_VERSION = "conditional-decision-1"
const STAT_KEYS = ["hpPlus", "atkPlus", "defPlus", "hp", "atk", "def", "mastery", "recharge", "cpct", "cdmg"]

export function validateDecisionDatabase(database) {
  if (database?.schemaVersion !== 1 || !Array.isArray(database.rules)) throw new Error("取舍数据库格式错误，需要schemaVersion: 1和rules数组")
  const ids = new Set()
  for (const rule of database.rules) {
    if (!rule || typeof rule.id !== "string" || ids.has(rule.id) || rule.type !== "protect-stats" ||
      !Array.isArray(rule.keys) || !rule.keys.length || new Set(rule.keys).size !== rule.keys.length ||
      rule.keys.some(key => !STAT_KEYS.includes(key)) || typeof rule.reason !== "string" ||
      rule.enabled !== undefined && typeof rule.enabled !== "boolean") throw new Error("不支持的取舍规则，支持protect-stats及有效副词条键")
    ids.add(rule.id)
  }
  return database
}

export function loadDecisionDatabase() {
  return validateDecisionDatabase(JSON.parse(file.readTextSync("assets/decision-rules.json")))
}

export function evaluateArtifact(artifact, database, projection = null, controls = {}) {
  validateDecisionDatabase(database)
  const scopeCoverage = { confirmed: controls.flags?.confirmScope === true,
    evaluatedCharacters: projection?.assessmentSummary?.total || 0, inventory: "observed-equipped-snapshot" }
  const result = (status, label, reasonCode, reason, extra = {}) => ({ status, label, reasonCode,
    reasons: [reason], scopeCoverage, version: DECISION_VERSION, ...extra })
  if (artifact.warnings?.length) return result("unknown", "需核对资料", "artifact-ocr", artifact.warnings.join("，"), { dataConfidence: "invalid" })
  let input
  try { input = prepareProjectionInput(artifact) } catch (error) {
    return result("unknown", "需核对资料", "artifact-invalid", error.message, { dataConfidence: "invalid" })
  }
  if (artifact.locked === true || artifact.equipped === true || artifact.ownerText?.includes("已装备")) {
    return result("keep", "保留", "item-protected", "已锁定或装备中的物品", { dataConfidence: "verified" })
  }
  const rules = [{ id: "double-crit", type: "protect-stats", keys: ["cpct", "cdmg"], reason: "双爆属性模板保护" },
    ...(database?.rules || []).filter(rule => rule.enabled !== false)]
  const protection = rules.find(rule => rule.keys.every(key => input.keys.includes(key)))
  if (protection) return result("keep", "保留", "template-protection", protection.reason, { protection: protection.id, dataConfidence: "verified" })
  if (!projection || projection.state === "computing") return result("unknown", "正在分析", "computing", "正在计算离散强化分布")
  if (projection.state !== "ready" || !scopeCoverage.evaluatedCharacters) return result("unknown", "需核对资料", "scope-empty", projection.message || "当前用途范围没有可评估角色")
  const rows = projection.rows || []
  const keep = rows.find(row => row.assessment?.status === "keep")
  if (keep) return result("keep", "保留", "role-keep", `${keep.name}有保留价值，${keep.assessment.reason}`, { dataConfidence: "verified", modelRange: keep.assessment.modelRange })
  const test = rows.find(row => row.assessment?.status === "test")
  if (test) return result("test", "建议试强化", "role-test", `${test.name}可试至+${test.assessment.nextTestLevel}后复查`,
    { nextTestLevel: test.assessment.nextTestLevel, modelRange: test.assessment.modelRange, dataConfidence: "verified" })
  if (artifact.level > 0) return result("keep", "保留复核", "invested-resource", `已强化+${artifact.level}，需结合经验材料价值与已有投入复核`)
  if (projection.assessmentSummary.unknown > 0) {
    const pending = rows.find(row => !row.assessment || row.assessment.status === "unknown")
    return result("unknown", "需核对资料", "role-data", pending?.assessment?.reason || "存在未完成的评分分支", { dataConfidence: "incomplete" })
  }
  if (!scopeCoverage.confirmed) return result("unknown", "需核对用途范围", "scope-incomplete", "当前用途均为低价值，请确认已覆盖拟培养用途及散件需求", { dataConfidence: "incomplete" })
  if (!controls.flags?.confirmItem && (artifact.locked !== false || artifact.equipped !== false)) return result("unknown", "需核对物品状态", "item-status-unobserved", "尚无可靠的未锁定、未装备状态记录", { dataConfidence: "incomplete" })
  return result("fodder", "可作素材", "covered-low-value", "已确认范围内全部用途为低价值，且物品状态通过核验", { dataConfidence: "verified" })
}
