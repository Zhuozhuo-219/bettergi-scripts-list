/**
 * 从 ArtifactScore/utils/artis-score-utils.js 移植五星副词条档位、
 * 最接近数值的组合估算及 effective 换算；不引入角色评分权重。
 * 改为缓存整数百分之一单位的去重组合，并按当前等级限制次数。
 */
const SUB_STAT_ROLLS = {
  hpPlus: [209.13, 239, 268.88, 298.75],
  hp: [4.08, 4.66, 5.25, 5.83],
  atkPlus: [13.62, 15.56, 17.51, 19.45],
  atk: [4.08, 4.66, 5.25, 5.83],
  defPlus: [16.2, 18.52, 20.83, 23.15],
  def: [5.1, 5.83, 6.56, 7.29],
  recharge: [4.53, 5.18, 5.83, 6.48],
  mastery: [16.32, 18.65, 20.98, 23.31],
  cpct: [2.72, 3.11, 3.5, 3.89],
  cdmg: [5.44, 6.22, 6.99, 7.77]
}

const SUB_KEYS = {
  "暴击率": "cpct", "暴击伤害": "cdmg",
  "元素精通": "mastery", "元素充能效率": "recharge"
}
const NODES = [4, 8, 12, 16, 20]
const sumCache = new Map()
const round = (value, digits = 1) => Number(value.toFixed(digits))

export function getSubStatRolls(key) {
  return SUB_STAT_ROLLS[key] ? [...SUB_STAT_ROLLS[key]] : null
}

export function getSubStatKey(stat) {
  if (["生命值", "攻击力", "防御力"].includes(stat.name)) {
    const key = { "生命值": "hp", "攻击力": "atk", "防御力": "def" }[stat.name]
    return stat.percent ? key : key + "Plus"
  }
  return SUB_KEYS[stat.name] || ""
}

function getRollSums(key, count) {
  const cacheKey = `${key}:${count}`
  if (sumCache.has(cacheKey)) return sumCache.get(cacheKey)
  const previous = count === 1 ? [0] : getRollSums(key, count - 1)
  const sums = new Set()
  for (const value of previous) {
    for (const roll of SUB_STAT_ROLLS[key]) sums.add(value + Math.round(roll * 100))
  }
  const result = [...sums].sort((a, b) => a - b)
  sumCache.set(cacheKey, result)
  return result
}

/** count 包含一次初始值，upgradeCount 才是额外命中次数。 */
export function estimateSubStatRolls(key, value, maxCount = 6) {
  const rolls = SUB_STAT_ROLLS[key]
  if (!rolls || !Number.isFinite(value) || value <= 0) return null
  const countLimit = Math.max(1, Math.min(6, Math.floor(maxCount)))
  if (!Number.isFinite(countLimit)) return null
  const integerStat = key.endsWith("Plus") || key === "mastery"
  const tolerance = integerStat ? 0.51 : 0.051
  const compatibleCounts = []
  let best = null
  for (let count = 1; count <= countLimit; count++) {
    let countError = Infinity
    for (const cents of getRollSums(key, count)) {
      const error = Math.abs(cents - value * 100) / 100
      countError = Math.min(countError, error)
      if (!best || error < best.error - 1e-9 ||
        (Math.abs(error - best.error) < 1e-9 && count > best.count)) {
        best = { count, value: cents / 100, error }
      }
    }
    if (countError <= tolerance) compatibleCounts.push(count)
  }
  // 原模块总返回最近值；本脚本不为超出显示取整误差的 OCR 值编造次数。
  if (!best || best.error > tolerance) return null
  return {
    count: best.count,
    upgradeCount: best.count - 1,
    effective: round(best.value / rolls[rolls.length - 1] / 0.85),
    matchedValue: round(best.value, integerStat ? 0 : 1),
    error: round(best.error, 2),
    compatibleCounts,
    ambiguous: compatibleCounts.length > 1
  }
}

/** 剩余节点按等级确定，不能用次数估算反推，+20 必须为零。 */
export function getEnhancementProgress(level, subStats) {
  if (!Number.isInteger(level) || level < 0 || level > 20) return null
  const remainingNodes = NODES.filter(node => node > level)
  const completedNodes = NODES.length - remainingNodes.length
  const complete = subStats.length === 4 && subStats.every((stat, index) => stat.rowIndex === index)
  const pending = subStats.filter(stat => stat.activation === "pending")
  const active = subStats.filter(stat => stat.activation === "active")
  const threeActive = complete && active.length === 3 && pending.length === 1 &&
    subStats[3].activation === "pending"
  const fourActive = complete && active.length === 4
  const consistent = level < 4 ? threeActive || fourActive : fourActive
  const activationNodes = consistent ? threeActive ? 1 : 0 : null
  return {
    level, completedNodes, remainingNodes,
    remainingNodeCount: remainingNodes.length,
    remainingActivationCount: activationNodes,
    remainingUpgradeCount: consistent ? remainingNodes.length - activationNodes : null,
    nextNode: remainingNodes[0] ?? null,
    selectionProbabilities: consistent && remainingNodes.length > activationNodes
      ? [0.25, 0.25, 0.25, 0.25] : null,
    consistent
  }
}

export function annotateArtifactEnhancement(artifact) {
  const enhancement = getEnhancementProgress(artifact.level, artifact.subStats)
  const maxCount = enhancement ? enhancement.completedNodes + 1 : 6
  const warnings = [...artifact.warnings]
  const subStats = artifact.subStats.map(stat => {
    const statKey = getSubStatKey(stat)
    const rollEstimate = stat.activation === "active" && enhancement
      ? estimateSubStatRolls(statKey, stat.value, maxCount) : null
    if (stat.activation === "active" && enhancement && !rollEstimate) {
      warnings.push(`${stat.name}数值无法匹配五星词条档位，请核对`)
    }
    return { ...stat, statKey, rollEstimate }
  })
  if (enhancement && !enhancement.consistent) warnings.push("词条状态或数量与等级不一致，请核对")
  return { ...artifact, subStats, enhancement, warnings }
}
