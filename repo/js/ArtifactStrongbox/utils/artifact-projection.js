import { MODEL_VERSION, prepareProjectionInput, getCharacterProfiles, validateProfileDatabase, compileCharacterScorer, scoreRound } from "./projection-model.js"
import { assessCharacterArtifact } from "./character-assessment.js"

export function loadProjectionProfiles() {
  return validateProfileDatabase(JSON.parse(file.readTextSync("assets/character-profiles.json")))
}

export function descendingQuantile(values, quantile) {
  if (!values.length || quantile <= 0 || quantile > 1) throw new Error("降序分位参数无效")
  const sorted = [...values].sort((a, b) => b - a)
  return sorted[Math.max(0, Math.ceil(quantile * sorted.length) - 1)]
}

function hash(text) {
  let value = 2166136261
  for (let i = 0; i < text.length; i++) value = Math.imul(value ^ text.charCodeAt(i), 16777619)
  return value >>> 0
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

async function generateSamples(input, count, seed, hooks) {
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
  const sampleCount = integerOption(options.simulationCount, 10000, 100, 50000)
  const rowCount = integerOption(options.projectionRows, 5, 1, 5)
  const seed = integerOption(options.simulationSeed, 20261025, 1, 4294967295)
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
      respectExistingSets: assessmentOptions.respectExistingSets !== false })
  }

  return {
    keyFor,
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
      const actualSampleCount = input.remainingUpgrades === 0 ? 1 : sampleCount
      // 同一批终值供全部角色评分；待激活值已固定于 input.values，绝不重抽。
      const samples = await generateSamples(input, actualSampleCount, seed ^ hash(artifactKey(artifact)), hooks)
      const activeProfiles = profiles.filter(profile => !Array.isArray(profileIds) || profileIds.includes(profile.id))
      const rows = []
      const skipped = []
      for (let index = 0; index < activeProfiles.length; index++) {
        checkCancelled(hooks)
        const profile = activeProfiles[index]
        try {
          const scorer = compileCharacterScorer(profile, input)
          const scores = samples.map(values => scoreRound(scorer.score(values))).sort((a, b) => b - a)
          rows.push({ id: profile.id, name: profile.name, label: profile.label, ruleTitle: scorer.title,
            ...(characterRecords ? { assessment: assessCharacterArtifact({ artifact, input, samples, profile, record: characterRecords[profile.name],
              respectExistingSets: assessmentOptions.respectExistingSets !== false }) } : {}),
            top20: scores[Math.max(0, Math.ceil(scores.length * 0.2) - 1)],
            top80: scores[Math.max(0, Math.ceil(scores.length * 0.8) - 1)] })
        } catch (error) { skipped.push({ name: profile.name, message: error.message || String(error) }) }
        if (index % 8 === 7) await hooks.yieldControl?.()
      }
      rows.sort((a, b) => b.top20 - a.top20 || b.top80 - a.top80 || a.id.localeCompare(b.id))
      checkCancelled(hooks)
      const result = {
        state: rows.length ? "ready" : "blocked", message: rows.length ? "" : activeProfiles.length ? "当前没有可计算的角色规则" : "当前筛选条件没有可评分角色，可勾选培养角色或开启其他匹配来源",
        modelVersion: MODEL_VERSION, sampleCount: actualSampleCount, seed,
        respectExistingSets: assessmentOptions.respectExistingSets !== false,
        simulatedProfiles: rows.length, skipped, rows: options.returnAllRows ? rows : rows.slice(0, rowCount),
        selectedOnly: Array.isArray(options.selectedProfileIds),
        remainingUpgrades: input.remainingUpgrades, fixedActivation: input.activation,
        finalMain: { key: input.mainKey, value: input.mainValue },
        assumptions: "默认角色条件；四条、四档均等概率；通用单件分，不代表真实伤害"
      }
      lastKey = key
      lastResult = result
      return result
    }
  }
}
