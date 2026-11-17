import { observedLoadoutThreshold } from "./artifact-loadout.js"
import { distributionMetrics } from "./artifact-distribution.js"
import { SLOTS } from "./artifact-reader.js"
import { getSubStatKey, getSubStatRolls, annotateArtifactEnhancement, nextRandomEnhancementLevel } from "./artifact-enhancement.js"
import { prepareProjectionInput, compileCharacterScorer, getMainStatKey } from "./projection-model.js"
import { cleanName, hasEquippedOwner } from "./account-reader.js"

export const ASSESSMENT_POLICY = { meaningfulGain: 0.5, keepProbability: 0.8, discardProbability: 0.01,
  mainRecommendationMinUsage: 15, largeDeficit: 0.5,
  models: ["rank-linear", "rank-exponential", "legacy-stress"], version: "relative-equipment-2" }
const KEYS = ["hpPlus", "atkPlus", "defPlus", "hp", "atk", "def", "mastery", "recharge", "cpct", "cdmg"]
const same = (a, b) => cleanName(a) === cleanName(b)
const unknown = (code, reason, extra = {}) => ({ status: "unknown", label: "需核对", code, reason, ...extra })

export function mainStatSuitability(artifact, record) {
  const key = getMainStatKey(artifact.slot, artifact.mainStat)
  if (!key) return { state: "unknown", reason: "主词条名称、部位或单位尚未确认" }
  if (["生之花", "死之羽"].includes(artifact.slot)) return { state: "fixed", key }
  const rec = record?.recommendations?.[artifact.slot]
  if (rec?.status !== "ok" || !rec.mainHeadingFound || !rec.mainStats?.length) {
    return { state: "unknown", reason: "缺少本部位已确认的主词条推荐，不能按15%规则排除" }
  }
  const rows = [...rec.mainStats].sort((a, b) => a.rank - b.rank)
  const keys = rows.map(row => getMainStatKey(artifact.slot, row))
  if (keys.some(value => !value) || new Set(keys).size !== keys.length || rows.length > 3 ||
    rows.some((row, i) => row.rank !== i + 1 || !Number.isFinite(row.usageRate) || row.usageRate < 0 || row.usageRate > 100 ||
      i > 0 && row.usageRate > rows[i - 1].usageRate + 0.15) || rows.reduce((sum, row) => sum + row.usageRate, 0) > 100.5) {
    return { state: "unknown", reason: "主词条推荐种类、顺序或使用率需复核" }
  }
  const accepted = rows.filter(row => row.usageRate > ASSESSMENT_POLICY.mainRecommendationMinUsage)
    .map(row => ({ name: row.name, percent: row.percent, usageRate: row.usageRate, rank: row.rank, key: getMainStatKey(artifact.slot, row) }))
  const matched = accepted.find(row => row.key === key)
  if (matched) return { state: "allowed", key, matched, accepted, threshold: ASSESSMENT_POLICY.mainRecommendationMinUsage }
  // 正向命中可用局部证据；排除则需要三行或足够的累计使用率，避免把漏读当成不适配。
  const coverage = rows.reduce((sum, row) => sum + row.usageRate, 0)
  if (!accepted.length || rows.length < 3 && coverage < 85.15) {
    return { state: "unknown", key, accepted, reason: "主词条推荐覆盖不足，缺项不能直接判为不适配" }
  }
  return { state: "outside", key, accepted, threshold: ASSESSMENT_POLICY.mainRecommendationMinUsage }
}

export function mainRuleAssessment(artifact, record, fit = mainStatSuitability(artifact, record)) {
  if (artifact.level !== 0 || artifact.warnings?.length || !record?.identity?.verified || record.identity.conflicts || record.needsRefresh || fit.state !== "outside") return null
  return { status: "fodder", label: "舍弃", code: "main-not-recommended",
    reason: `主词条${artifact.mainStat.name}${artifact.mainStat.percent ? "%" : ""}不在>15%的推荐范围（仅本角色当前用途）`,
    mainPolicy: fit, scope: "用户指定的主词条推荐范围排除，不表示提升概率为零" }
}

// 有效类型数包含预览第四条，另记当前激活数；阈值只提供排序特征。
export function initialEffectiveStatPolicy(artifact, record, { excludeLowInitialStats = false, minInitialEffectiveStats = 2 } = {}) {
  const threshold = excludeLowInitialStats ? minInitialEffectiveStats : null
  const unresolved = reason => ({ state: "unknown", threshold, reason })
  if (!Number.isInteger(minInitialEffectiveStats) || minInitialEffectiveStats < 0 || minInitialEffectiveStats > 4) return unresolved("初始有效词条阈值须为0～4整数")
  if (artifact.warnings?.length) return unresolved("素材识别有警告，初始有效词条数需核对")
  if (!record?.identity?.verified || record.identity.conflicts || record.needsRefresh) return unresolved("角色身份或元素资料需要复核")
  try { prepareProjectionInput(artifact) } catch (error) { return unresolved(`素材数值需复核：${error.message}`) }
  const rec = record.recommendations?.[artifact.slot]
  if (rec?.status !== "ok" || rec.subHeadingFound !== true || !rec.subStats?.length) return unresolved("缺少本部位已确认的推荐追加词条")
  const rows = [...rec.subStats].sort((a, b) => a.rank - b.rank), keys = rows.map(getSubStatKey)
  if (keys.some(key => !KEYS.includes(key)) || new Set(keys).size !== keys.length || rows.some((row, i) =>
    row.rank !== i + 1 || typeof row.percent !== "boolean" || row.percent !== (!keys[i].endsWith("Plus") && keys[i] !== "mastery"))) {
    return unresolved("推荐追加词条的种类、单位或顺序需复核")
  }
  const active = artifact.subStats.filter(stat => stat.activation === "active")
  if (![3, 4].includes(active.length) || artifact.subStats.some(stat => !["active", "pending"].includes(stat.activation))) return unresolved("初始词条激活状态需核对")
  const effective = active.filter(stat => keys.includes(getSubStatKey(stat)))
  return { state: "known", threshold, count: artifact.subStats.filter(stat => keys.includes(getSubStatKey(stat))).length, activatedCount: effective.length, activeCount: active.length,
    names: effective.map(stat => stat.name + (stat.percent ? "%" : "")),
    pendingEffectiveCount: artifact.subStats.filter(stat => stat.activation === "pending" && keys.includes(getSubStatKey(stat))).length,
    source: "本部位推荐追加词条", reason: "潜在有效数包含已知待激活第四条" }
}

export function inventoryPressure(value) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return { estimatedCount: null, capacity: 2700, level: "unknown", label: "容量未填写", note: "可在JS设置填写总量估计；不自动计数" }
  }
  const count = Number(value)
  if (!Number.isInteger(count) || count < 0 || count > 2700) throw new Error("当前圣遗物总量估计须为0～2700的整数，或留空")
  const ratio = count / 2700
  const level = ratio >= 0.95 ? "high" : ratio >= 0.8 ? "tight" : "relaxed"
  return { estimatedCount: count, capacity: 2700, ratio, level,
    label: level === "high" ? "接近满仓" : level === "tight" ? "空间偏紧" : "空间较宽裕",
    note: "手动静态估计；三合一后不自动扣减，不因容量直接改判舍弃" }
}

function currentArtifact(record, slot) {
  const observation = record?.slots?.[slot], artifact = observation?.equippedArtifact
  return observation?.status === "equipped" && !observation.baselineStale && artifact?.complete &&
    artifact.name && !artifact.warnings?.length && artifact.slot === slot && artifact.setName && hasEquippedOwner(artifact) &&
    same(artifact.owner, record.identity?.displayName) ? artifact : null
}

export function observedEquipment(records) {
  const result = []
  for (const record of Object.values(records || {})) {
    if (!record.identity?.verified || record.identity.conflicts || record.needsRefresh) continue
    for (const slot of SLOTS) {
      const artifact = currentArtifact(record, slot)
      if (!artifact || artifact.level !== 20) continue
      try {
        const prepared = annotateArtifactEnhancement({ ...artifact, warnings: [],
          subStats: artifact.subStats.map((stat, rowIndex) => ({ ...stat, rowIndex, activation: "active" })) })
        result.push({ slot, setName: artifact.setName, owner: record.identity.displayName, name: artifact.name,
          input: prepareProjectionInput(prepared) })
      } catch { /* 仅可靠满级观察可参与配套证明。 */ }
    }
  }
  return result
}

export function replacementContext(artifact, record, { allowMainChange = false, respectExistingSets = true, allowCompanionAnalysis = false } = {}) {
  if (!record?.identity?.verified || record.identity.conflicts || record.needsRefresh) return unknown("identity", "角色身份或元素资料需要复核")
  const equipment = SLOTS.map(slot => currentArtifact(record, slot))
  const setsKnown = equipment.every(Boolean)
  if (respectExistingSets && !setsKnown && !allowCompanionAnalysis) return unknown("equipment", "五部位现装归属或详情不完整，不能确认替换约束")
  const baseline = equipment[SLOTS.indexOf(artifact.slot)]
  if (!baseline) return unknown("equipment", "同部位现装归属或详情不完整，不能建立基线")
  if (!baseline || !artifact.setName) return unknown("slot", "素材部位或套装尚未确认")
  const counts = {}
  for (const item of equipment.filter(Boolean)) counts[item.setName] = (counts[item.setName] || 0) + 1
  const required = setsKnown ? Object.entries(counts).filter(([, count]) => count >= 2).map(([name, count]) => ({ name, count: count >= 4 ? 4 : 2 })) : []
  const after = { ...counts }
  after[baseline.setName]--
  after[artifact.setName] = (after[artifact.setName] || 0) + 1
  const broken = required.filter(set => (after[set.name] || 0) < set.count)
  if (respectExistingSets && broken.length && !allowCompanionAnalysis) return unknown("set-break", `替换会拆散${broken.map(set => `${set.name}${set.count}件套`).join("、")}；仅作配套备选`, { requiredSets: required, beforeCounts: counts, afterCounts: after })
  const mainChanged = !artifact.mainStat || !baseline.mainStat || !same(artifact.mainStat.name, baseline.mainStat.name) ||
    Boolean(artifact.mainStat.percent) !== Boolean(baseline.mainStat.percent)
  if (mainChanged && !allowMainChange) {
    return unknown("main-changed", "主词条与现装不同，尚不能用副词条分证明提升")
  }
  if (baseline.level !== 20) return unknown("baseline-level", "同部位现装未满级，暂不作等培养终点的取舍")
  try {
    const prepared = annotateArtifactEnhancement({ ...baseline, warnings: [...(baseline.warnings || [])],
      subStats: baseline.subStats.map((stat, rowIndex) => ({ ...stat, rowIndex, activation: "active" })) })
    return { baseline: prepareProjectionInput(prepared), baselineName: baseline.name, mainChanged,
      baselineObservedAt: record.slots[artifact.slot].observedAt || record.capturedAt || null,
      requiredSets: required, brokenSets: broken, respectExistingSets, setCountsKnown: setsKnown,
      requiresCompanion: respectExistingSets && (!setsKnown || broken.length > 0),
      beforeCounts: setsKnown ? counts : null, afterCounts: setsKnown ? after : null }
  } catch (error) { return unknown("baseline-invalid", `现装数值需复核：${error.message}`) }
}

export function recommendationWeights(recommendation) {
  if (recommendation?.status !== "ok" || !recommendation.subStats?.length) throw new Error("缺少本部位已确认的推荐追加词条")
  const rows = [...recommendation.subStats].sort((a, b) => a.rank - b.rank)
  const keys = rows.map(getSubStatKey)
  if (keys.some(key => !KEYS.includes(key)) || new Set(keys).size !== keys.length ||
    rows.some(row => typeof row.percent !== "boolean" || !Number.isInteger(row.rank) || row.rank < 1) || new Set(rows.map(row => row.rank)).size !== rows.length) {
    throw new Error("推荐词条种类或顺序不完整")
  }
  const cr = keys.indexOf("cpct"), cd = keys.indexOf("cdmg")
  if (cr >= 0 && cd >= 0 && Math.abs(cr - cd) !== 1) throw new Error("双爆推荐顺序被其他属性隔开，同权分组需要确认")
  const groups = []
  for (const key of keys) {
    if (["cpct", "cdmg"].includes(key) && cr >= 0 && cd >= 0) {
      if (!groups.some(group => group.includes(key))) groups.push(["cpct", "cdmg"])
    } else groups.push([key])
  }
  return ["linear", "exponential"].map(kind => ({ id: `rank-${kind}`, label: kind === "linear" ? "推荐线性秩" : "推荐指数秩",
    weights: Object.fromEntries(groups.flatMap((group, rank) => group.map(key => [key,
      kind === "linear" ? (groups.length - rank) / groups.length : 2 ** -rank]))) }))
}

function legacyModel(profile, input) {
  const initial = compileCharacterScorer(profile, input)
  const extended = { ...input, keys: KEYS, values: KEYS.map(key => input.values[input.keys.indexOf(key)] || 0) }
  // 冻结当前用途实际选出的权重；扩展词条键仅为公平评估现装，不重新决定条件分支。
  const scorer = compileCharacterScorer({ ...profile, weightOverrides: { hp: 0, atk: 0, def: 0, mastery: 0,
    recharge: 0, cpct: 0, cdmg: 0, dmg: 0, phy: 0, heal: 0, ...initial.weights } }, extended)
  const effective = KEYS.map((key, index) => scorer.coefficients[index] * getSubStatRolls(key)[3])
  const maximum = Math.max(...effective)
  if (!(maximum > 0)) throw new Error("原评分规则无有效权重，无法交叉核验")
  return { id: "legacy-stress", label: "原规则敏感性核验", weights: Object.fromEntries(KEYS.map((key, i) => [key, effective[i] / maximum])) }
}

const score = (weights, keys, values) => keys.reduce((sum, key, i) => sum + (weights[key] || 0) * values[i] / getSubStatRolls(key)[3], 0)
// 旧版抽样统计接口保留供离线对照，新决策入口使用下方的PMF期望收益。
export function probabilityInterval(successes, total) {
  const z2 = 1.96 ** 2, p = successes / total, denominator = 1 + z2 / total
  const centre = p + z2 / (2 * total), radius = Math.sqrt(z2 * p * (1 - p) / total + z2 * z2 / (4 * total * total))
  return { lower: Math.max(0, (centre - radius) / denominator), upper: Math.min(1, (centre + radius) / denominator) }
}

export function summarizeImprovement(deltas, model, baselineScore) {
  let improve = 0, meaningful = 0, positive = 0, nearBaseline = 0
  for (const delta of deltas) {
    if (delta > 1e-8) improve++
    if (delta >= ASSESSMENT_POLICY.meaningfulGain - 1e-8) meaningful++
    if (delta > -ASSESSMENT_POLICY.largeDeficit + 1e-8) nearBaseline++
    positive += Math.max(delta, 0)
  }
  const sorted = [...deltas].sort((a, b) => b - a)
  return { id: model.id, label: model.label, baselineScore, weights: model.weights,
    pImprove: improve / deltas.length, pMeaningful: meaningful / deltas.length,
    pNearBaseline: nearBaseline / deltas.length, nearBaselineInterval: probabilityInterval(nearBaseline, deltas.length),
    improveInterval: probabilityInterval(improve, deltas.length), meaningfulInterval: probabilityInterval(meaningful, deltas.length),
    top20Gain: sorted[Math.max(0, Math.ceil(sorted.length * 0.2) - 1)], top80Gain: sorted[Math.max(0, Math.ceil(sorted.length * 0.8) - 1)],
    expectedPositiveGain: positive / deltas.length }
}

export function classifyImprovement(models, { mainChanged = false } = {}) {
  if (!models.length || models.some(model => !Number.isFinite(model.meaningfulInterval?.lower) || !Number.isFinite(model.improveInterval?.upper))) {
    return unknown("models", "比较模型或样本统计不足")
  }
  const minimumMeaningful = Math.min(...models.map(model => model.meaningfulInterval.lower))
  const maximumImprove = Math.max(...models.map(model => model.improveInterval.upper))
  const bounds = { minimumMeaningful, maximumImprove }
  if (minimumMeaningful >= ASSESSMENT_POLICY.keepProbability) return { status: "keep", label: "保留", code: "robust-keep",
    reason: "各模型下有意义提升概率的保守界均达到80%", bounds }
  if (maximumImprove <= ASSESSMENT_POLICY.discardProbability) {
    if (mainChanged && models.some(model => !Number.isFinite(model.nearBaselineInterval?.upper) || model.nearBaselineInterval.upper > ASSESSMENT_POLICY.discardProbability)) {
      return unknown("cross-main-gap", "不同主词条下，计入主副词条后的劣势幅度仍不足以判舍弃", { bounds })
    }
    return { status: "fodder", label: "舍弃", code: mainChanged ? "cross-main-fodder" : "robust-fodder",
      reason: mainChanged ? "计入主副词条后，各模型下接近现装半档以内的概率上界均≤1%（仅本角色）" : "各模型下超过现装概率的保守上界均不超过1%（仅本角色当前用途）", bounds }
  }
  return unknown("overlap", "分布仍有重叠或模型结论不一致，保留待复核", { bounds })
}

export function classifyExpectedGain(models, policy = { keep: 0.5, drop: 0.05 }) {
  if (!models.length || models.some(model => !Number.isFinite(model.gainBounds?.lower) || !Number.isFinite(model.gainBounds?.upper))) {
    return unknown("models", "期望收益分布不完整")
  }
  const lower = Math.min(...models.map(model => model.gainBounds.lower))
  const upper = Math.max(...models.map(model => model.gainBounds.upper))
  const modelRange = { lower, upper, keepThreshold: policy.keep, dropThreshold: policy.drop }
  if (lower >= policy.keep) return { status: "keep", label: "保留", code: "expected-gain-keep",
    reason: `各情景期望正提升至少${lower.toFixed(2)}，达到保留线${policy.keep}`, modelRange }
  if (upper <= policy.drop) return { status: "fodder", label: "低价值", code: "expected-gain-low",
    reason: `各情景期望正提升至多${upper.toFixed(2)}，低于低价值线${policy.drop}`, modelRange }
  return { status: "test", label: "建议试强化", code: "expected-gain-test",
    reason: `期望正提升范围${lower.toFixed(2)}～${upper.toFixed(2)}，可在下一随机节点复查`, modelRange }
}

export async function assessCharacterArtifact({ artifact, input, profile, record, distributionEngine, hooks = {},
  gainPolicy, inventory = [], respectExistingSets = true, excludeLowInitialStats = false, minInitialEffectiveStats = 2 }) {
  if (artifact.warnings?.length) return unknown("artifact-ocr", "素材识别仍有警告，需核对后再判定")
  if (!record?.identity?.verified || record.identity.conflicts || record.needsRefresh) return unknown("identity", "角色身份或元素资料需要复核")
  const initialStats = initialEffectiveStatPolicy(artifact, record, { excludeLowInitialStats, minInitialEffectiveStats })
  const mainPolicy = mainStatSuitability(artifact, record)
  const rejected = mainRuleAssessment(artifact, record, mainPolicy)
  if (rejected) return { ...rejected, eligibility: "outside", initialStats }
  if (mainPolicy.state === "unknown") return unknown("main-recommendation", mainPolicy.reason, { mainPolicy, initialStats })
  const context = replacementContext(artifact, record, { allowMainChange: true, respectExistingSets, allowCompanionAnalysis: true })
  if (context.status) return { ...context, dataConfidence: "incomplete", initialStats }
  let models
  try { models = [...recommendationWeights(record.recommendations?.[artifact.slot]), legacyModel(profile, input)] }
  catch (error) { return unknown("weights", error.message) }
  if (context.mainChanged && models.some(model => !KEYS.includes(input.mainKey) || !KEYS.includes(context.baseline.mainKey) ||
    !(model.weights[input.mainKey] > 0) || !(model.weights[context.baseline.mainKey] > 0))) {
    return unknown("main-unpriced", "推荐主属性需在同一上下文统一计价", { mainPolicy, mainChanged: true })
  }
  const summaries = []
  let companionProven = context.setCountsKnown && respectExistingSets
  let loadoutEvidence = null
  const ownItems = observedEquipment({ current: record })
  for (const model of models) {
    const mainContribution = (key, value) => context.mainChanged ? model.weights[key] * value / getSubStatRolls(key)[3] : 0
    const baseline = score(model.weights, context.baseline.keys, context.baseline.values) + mainContribution(context.baseline.mainKey, context.baseline.mainValue)
    const coefficients = input.keys.map(key => (model.weights[key] || 0) / getSubStatRolls(key)[3])
    const distribution = await distributionEngine.calculate(input, coefficients, mainContribution(input.mainKey, input.mainValue), hooks)
    let threshold = baseline
    if (context.setCountsKnown && ownItems.length === 5 && respectExistingSets) {
      const loadout = observedLoadoutThreshold(artifact, ownItems, inventory.length ? inventory : ownItems, context.requiredSets,
        item => score(model.weights, item.input.keys, item.input.values) +
          (item.slot === artifact.slot ? mainContribution(item.input.mainKey, item.input.mainValue) : 0))
      if (loadout) {
        threshold = loadout.threshold
        loadoutEvidence = { scope: loadout.scope, companions: loadout.items.filter(item => item.slot !== artifact.slot)
          .map(item => ({ slot: item.slot, name: item.name, owner: item.owner, setName: item.setName })) }
      }
      else companionProven = false
    } else companionProven = false
    const metrics = distributionMetrics(distribution, threshold)
    summaries.push({ ...metrics, id: model.id, label: model.label, baselineScore: baseline, weights: model.weights,
      pImprove: metrics.pGreater, effectiveCount: coefficients.filter(value => value > 0).length })
  }
  let decision = classifyExpectedGain(summaries, gainPolicy)
  const requiresCompanion = context.requiresCompanion && !companionProven
  if (requiresCompanion) {
    decision = decision.status === "keep" ? { ...decision, label: "有条件保留", reason: decision.reason + "，可能需要配套圣遗物" }
      : unknown("companion-evidence", "缺配套替代品证据，属性分布已计算", { modelRange: decision.modelRange })
  }
  if (companionProven && loadoutEvidence?.companions.some(item => item.owner !== record.identity.displayName)) {
    decision = { ...decision, reason: decision.reason + "，涉及已录入其他角色装备的调配" }
  }
  const nextTestLevel = nextRandomEnhancementLevel(artifact)
  if (decision.status === "test" && nextTestLevel === null) decision = { ...decision, status: "keep", label: "保留复核", reason: "已满级，保留并按实际配装收益复核" }
  return { ...decision, models: summaries, initialStats, nextTestLevel, dataConfidence: "verified",
    eligibility: requiresCompanion ? "unknown" : "eligible", requiresCompanion, loadoutEvidence,
    mainPolicy, mainChanged: context.mainChanged, comparison: context.mainChanged ? "main-and-subs" : "same-main-subs",
    baselineName: context.baselineName, baselineObservedAt: context.baselineObservedAt,
    requiredSets: context.requiredSets, brokenSets: context.brokenSets, respectExistingSets, setCountsKnown: context.setCountsKnown,
    policy: "conditional-decision-1", scope: "已装备快照支持的局部比较" }
}
