import { MODEL_VERSION, prepareProjectionInput, getCharacterProfiles, validateProfileDatabase, compileCharacterScorer, scoreRound } from "./projection-model.js"
import { createDistributionEngine, distributionQuantile, DISTRIBUTION_VERSION } from "./artifact-distribution.js"
import { assessCharacterArtifact, observedEquipment } from "./character-assessment.js"

export function loadProjectionProfiles() {
  return validateProfileDatabase(JSON.parse(file.readTextSync("assets/character-profiles.json")))
}

export function descendingQuantile(values, quantile) {
  if (!values.length || quantile <= 0 || quantile > 1) throw new Error("降序分位参数无效")
  const sorted = [...values].sort((a, b) => b - a)
  return sorted[Math.max(0, Math.ceil(quantile * sorted.length) - 1)]
}

function randomGenerator(seed) {
  let value = seed >>> 0
  return () => {
    value = (value + 0x6D2B79F5) >>> 0
    let mixed = Math.imul(value ^ (value >>> 15), value | 1)
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61)
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
  }
}

export function enumerateAllocations(total) {
  const allocations = []
  for (let a = total; a >= 0; a--) for (let b = total - a; b >= 0; b--) {
    for (let c = total - a - b; c >= 0; c--) allocations.push([a, b, c, total - a - b - c])
  }
  return allocations
}

function checkCancelled(hooks) {
  if (hooks.isCancelled?.()) throw new Error("预测已取消")
}

export async function generateSamples(input, count, seed, hooks) {
  const random = randomGenerator(seed)
  const samples = []
  for (let index = 0; index < count; index++) {
    const values = [...input.values]
    for (let node = 0; node < input.remainingUpgrades; node++) {
      const target = Math.floor(random() * 4)
      const tier = Math.floor(random() * 4)
      values[target] += input.rollTables[target][tier]
    }
    samples.push(values)
    if (index % 1024 === 1023) {
      checkCancelled(hooks)
      await hooks.yieldControl?.()
    }
  }
  return samples
}

export function findPotentialMaximum(input, scorer) {
  let best = null
  for (const counts of enumerateAllocations(input.remainingUpgrades)) {
    const finalValues = input.values.map((value, index) => value + counts[index] * input.rollTables[index][3])
    const rawScore = scorer.score(finalValues)
    if (!best || rawScore > best.rawScore + 1e-9) best = { counts, finalValues, rawScore }
  }
  return {
    score: scoreRound(best.rawScore),
    allocation: best.counts.map((count, index) => ({
      key: input.keys[index], name: input.names[index], percent: input.percent[index], count,
      increment: Number((count * input.rollTables[index][3]).toFixed(2)),
      finalValue: Number(best.finalValues[index].toFixed(2))
    })),
    finalSubs: Object.fromEntries(input.keys.map((key, index) => [key, best.finalValues[index]]))
  }
}

function integerOption(value, fallback, min, max) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.max(min, Math.min(max, Math.round(parsed))) : fallback
}

export function createProjectionService(options = {}, customProfiles = [], characterRecords = null) {
  const distributionEngine = createDistributionEngine()
  const inventory = observedEquipment(characterRecords)
  const gainPolicy = { keep: Number(options.keepGainThreshold ?? 0.5), drop: Number(options.discardGainThreshold ?? 0.05) }
  if (!Number.isFinite(gainPolicy.keep) || !Number.isFinite(gainPolicy.drop) || gainPolicy.drop < 0 || gainPolicy.keep <= gainPolicy.drop) throw new Error("期望收益阈值须满足0≤低价值线<保留线")
  const rowCount = integerOption(options.projectionRows, 5, 1, 5)

  const profiles = getCharacterProfiles(customProfiles).filter(profile =>
    !Array.isArray(options.selectedProfileIds) || options.selectedProfileIds.includes(profile.id))
  let lastKey = null
  let lastResult = null


  function artifactKey(artifact) {
    // 仅使用参与模型的语义字段，不因 OCR 框、空格、时间或估算角标波动重算。
    return JSON.stringify({ version: MODEL_VERSION, level: artifact.level, slot: artifact.slot,
      main: artifact.mainStat && { name: artifact.mainStat.name, value: artifact.mainStat.value, percent: artifact.mainStat.percent },
      stats: artifact.subStats.map(stat => ({ name: stat.name, value: stat.value, percent: stat.percent, activation: stat.activation })),
      setName: artifact.setName })
  }

  function keyFor(artifact, profileIds = null, assessmentOptions = {}) {
    return artifactKey(artifact) + JSON.stringify({ profiles: Array.isArray(profileIds) ? [...new Set(profileIds)].sort() : null,
      gainPolicy, distributionVersion: DISTRIBUTION_VERSION, warnings: artifact.warnings || [], enhancementConsistent: artifact.enhancement?.consistent === true,
      respectExistingSets: assessmentOptions.respectExistingSets !== false,
      excludeLowInitialStats: assessmentOptions.excludeLowInitialStats === true, minInitialEffectiveStats: assessmentOptions.minInitialEffectiveStats ?? 2 })
  }

  return {
    keyFor,
    distributionStats: distributionEngine.stats,
    cached: (artifact, profileIds = null, assessmentOptions = {}) => keyFor(artifact, profileIds, assessmentOptions) === lastKey ? lastResult : null,
    async calculate(artifact, hooks = {}, profileIds = null, assessmentOptions = {}) {
      const key = keyFor(artifact, profileIds, assessmentOptions)
      if (key === lastKey) return lastResult
      let input
      try { input = prepareProjectionInput(artifact) } catch (error) {
        const result = { state: "blocked", message: error.message, rows: [] }
        lastKey = key
        lastResult = result
        return result
      }
      checkCancelled(hooks)
      // 固定四条初值（包括已知待激活值），只卷积未来随机强化。
      const activeProfiles = profiles.filter(profile => !Array.isArray(profileIds) || profileIds.includes(profile.id))
      const rows = []
      const skipped = []
      for (let index = 0; index < activeProfiles.length; index++) {
        checkCancelled(hooks)
        const profile = activeProfiles[index]
        try {
          const scorer = compileCharacterScorer(profile, input)
          const distribution = await distributionEngine.calculate(input, scorer.coefficients, scorer.intercept, hooks)
          rows.push({ id: profile.id, name: profile.name, label: profile.label, ruleTitle: scorer.title,
            ...(characterRecords ? { assessment: await assessCharacterArtifact({ artifact, input, profile, record: characterRecords[profile.name],
              distributionEngine, hooks, gainPolicy, inventory,
              respectExistingSets: assessmentOptions.respectExistingSets !== false,
              excludeLowInitialStats: assessmentOptions.excludeLowInitialStats === true, minInitialEffectiveStats: assessmentOptions.minInitialEffectiveStats ?? 2 }) } : {}),
            distribution: { method: distribution.method, mean: distribution.mean, variance: distribution.variance,
              minimum: distribution.minimum, maximum: distribution.maximum, errorBound: distribution.errorBound },
            top20: scoreRound(distributionQuantile(distribution, 0.2)),
            top80: scoreRound(distributionQuantile(distribution, 0.8)) })
        } catch (error) { skipped.push({ name: profile.name, message: error.message || String(error) }) }
        if (index % 8 === 7) await hooks.yieldControl?.()
      }
      rows.sort((a, b) => b.top20 - a.top20 || b.top80 - a.top80 || a.id.localeCompare(b.id))
      checkCancelled(hooks)
      const result = {
        state: rows.length ? "ready" : "blocked", message: rows.length ? "" : activeProfiles.length ? "当前没有可计算的角色规则" : "当前筛选条件没有可评分角色，可勾选培养角色或开启其他匹配来源",
        modelVersion: DISTRIBUTION_VERSION, sampleCount: 0, distributionMethod: DISTRIBUTION_VERSION, gainPolicy,
        respectExistingSets: assessmentOptions.respectExistingSets !== false,
        excludeLowInitialStats: assessmentOptions.excludeLowInitialStats === true, minInitialEffectiveStats: assessmentOptions.minInitialEffectiveStats ?? 2,
        simulatedProfiles: rows.length, skipped, rows: options.returnAllRows ? rows : rows.slice(0, rowCount),
        selectedOnly: Array.isArray(options.selectedProfileIds),
        remainingUpgrades: input.remainingUpgrades, fixedActivation: input.activation,
        finalMain: { key: input.mainKey, value: input.mainValue },
        assumptions: "固定角色上下文，四条四档等概率离散卷积，分位数最终显示取整"
      }
      lastKey = key
      lastResult = result
      return result
    }
  }
}
