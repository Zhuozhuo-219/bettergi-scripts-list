import { SLOTS } from "./artifact-reader.js"
import { getSubStatKey, getSubStatRolls, annotateArtifactEnhancement } from "./artifact-enhancement.js"
import { prepareProjectionInput, compileCharacterScorer, getMainStatKey } from "./projection-model.js"
import { cleanName, hasEquippedOwner } from "./account-reader.js"

export const ASSESSMENT_POLICY = { meaningfulGain: 0.5, keepProbability: 0.8, discardProbability: 0.01,
  mainRecommendationMinUsage: 15, largeDeficit: 0.5,
  models: ["rank-linear", "rank-exponential", "legacy-stress"], version: "relative-equipment-2" }
const KEYS = ["hpPlus", "atkPlus", "defPlus", "hp", "atk", "def", "mastery", "recharge", "cpct", "cdmg"]
const same = (a, b) => cleanName(a) === cleanName(b)
const unknown = (code, reason, extra = {}) => ({ status: "unknown", label: "待定", code, reason, ...extra })

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

export function replacementContext(artifact, record, { allowMainChange = false, respectExistingSets = true } = {}) {
  if (!record?.identity?.verified || record.identity.conflicts || record.needsRefresh) return unknown("identity", "角色身份或元素资料需要复核")
  const equipment = SLOTS.map(slot => currentArtifact(record, slot))
  const setsKnown = equipment.every(Boolean)
  if (respectExistingSets && !setsKnown) return unknown("equipment", "五部位现装归属或详情不完整，不能确认替换约束")
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
  if (respectExistingSets && broken.length) return unknown("set-break", `替换会拆散${broken.map(set => `${set.name}${set.count}件套`).join("、")}；仅作配套备选`, { requiredSets: required, beforeCounts: counts, afterCounts: after })
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

export function assessCharacterArtifact({ artifact, input, samples, profile, record, respectExistingSets = true }) {
  if (artifact.level !== 0) return unknown("leveled", "非0级素材需人工确认，不自动按胚子判舍弃")
  if (artifact.warnings?.length) return unknown("artifact-ocr", "素材识别仍有警告，需核对后再判定")
  if (!record?.identity?.verified || record.identity.conflicts || record.needsRefresh) return unknown("identity", "角色身份或元素资料需要复核")
  const mainPolicy = mainStatSuitability(artifact, record)
  const rejected = mainRuleAssessment(artifact, record, mainPolicy)
  if (rejected) return rejected
  if (mainPolicy.state === "unknown") return unknown("main-recommendation", mainPolicy.reason, { mainPolicy })
  const context = replacementContext(artifact, record, { allowMainChange: true, respectExistingSets })
  if (context.status) return context
  let models
  try { models = [...recommendationWeights(record.recommendations?.[artifact.slot]), legacyModel(profile, input)] }
  catch (error) { return unknown("weights", error.message) }
  if (context.mainChanged && models.some(model => !KEYS.includes(input.mainKey) || !KEYS.includes(context.baseline.mainKey) ||
    !(model.weights[input.mainKey] > 0) || !(model.weights[context.baseline.mainKey] > 0))) {
    return unknown("main-unpriced", "两个主词条均在推荐范围，但主属性类型或其权重尚不能统一计价", { mainPolicy, mainChanged: true })
  }
  if (!samples.length) return unknown("samples", "尚无强化样本")
  const summaries = models.map(model => {
    const mainContribution = (key, value) => context.mainChanged ? model.weights[key] * value / getSubStatRolls(key)[3] : 0
    const baseline = score(model.weights, context.baseline.keys, context.baseline.values) + mainContribution(context.baseline.mainKey, context.baseline.mainValue)
    const deltas = samples.map(values => score(model.weights, input.keys, values) + mainContribution(input.mainKey, input.mainValue) - baseline)
    return summarizeImprovement(deltas, model, baseline)
  })
  return { ...classifyImprovement(summaries, { mainChanged: context.mainChanged }), models: summaries, sampleCount: samples.length,
    mainPolicy, mainChanged: context.mainChanged, comparison: context.mainChanged ? "main-and-subs" : "same-main-subs",
    baselineName: context.baselineName, baselineObservedAt: context.baselineObservedAt,
    requiredSets: context.requiredSets, brokenSets: context.brokenSets, respectExistingSets, setCountsKnown: context.setCountsKnown,
    policy: ASSESSMENT_POLICY.version,
    scope: respectExistingSets ? "推荐主词条范围、保留已录入现装套装的单部位替换；情景评分不等于真实伤害" :
      "忽略现有套装组合的属性评分对比；不计入拆套装损失，不代表实际换装收益" }
}
