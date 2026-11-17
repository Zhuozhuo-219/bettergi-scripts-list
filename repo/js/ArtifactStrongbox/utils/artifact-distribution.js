// 四词条×四档的有限离散卷积。路径计数为整数，比分只在单步增量处量化。
export const DISTRIBUTION_VERSION = "conditional-pmf-1"
const SCALE = 1e8

function cancelled(hooks) {
  if (hooks.isCancelled?.()) throw new Error("预测已取消")
}

export function createDistributionEngine(limit = 512) {
  const cache = new Map()
  const stats = { convolutions: 0, hits: 0 }
  return { stats, async calculate(input, coefficients, intercept = 0, hooks = {}) {
    const q = input.remainingUpgrades
    if (!Number.isInteger(q) || q < 0 || q > 5 || input.values.length !== 4 ||
        input.values.some(value => !Number.isFinite(value) || value < 0) || input.rollTables.length !== 4 ||
        input.rollTables.some(tiers => tiers.length !== 4 || tiers.some(value => !Number.isFinite(value) || value < 0)) || coefficients.length !== 4 ||
        coefficients.some(value => !Number.isFinite(value) || value < 0) || !Number.isFinite(intercept)) {
      throw new Error("离散分布参数无效")
    }
    const baseline = intercept + input.values.reduce((sum, value, i) => sum + value * coefficients[i], 0)
    const increments = input.rollTables.flatMap((tiers, i) => tiers.map(value => value * coefficients[i]))
    const key = JSON.stringify([q, increments])
    let kernel = cache.get(key)
    if (kernel) stats.hits++
    else {
      const step = new Map()
      for (const value of increments) {
        const units = Math.round(value * SCALE)
        if (!Number.isSafeInteger(units * 5)) throw new Error("评分超出安全量化范围")
        step.set(units, (step.get(units) || 0) + 1)
      }
      let mass = new Map([[0, 1]])
      for (let node = 0; node < q; node++) {
        cancelled(hooks)
        const next = new Map()
        let visited = 0
        for (const [value, ways] of mass) {
          for (const [increment, count] of step) next.set(value + increment, (next.get(value + increment) || 0) + ways * count)
          if (++visited % 2048 === 0) { cancelled(hooks); await hooks.yieldControl?.() }
        }
        mass = next
        await hooks.yieldControl?.()
      }
      const total = 16 ** q
      const points = [...mass].sort((a, b) => a[0] - b[0]).map(([units, count]) => [units / SCALE, count / total])
      const meanStep = increments.reduce((sum, value) => sum + value, 0) / 16
      const varianceStep = increments.reduce((sum, value) => sum + (value - meanStep) ** 2, 0) / 16
      const mean = points.reduce((sum, [value, probability]) => sum + value * probability, 0)
      const variance = points.reduce((sum, [value, probability]) => sum + (value - mean) ** 2 * probability, 0)
      kernel = { points, mean, variance, analyticMean: q * meanStep, analyticVariance: q * varianceStep,
        errorBound: q / (2 * SCALE), paths: total }
      if (cache.size >= limit) cache.delete(cache.keys().next().value)
      cache.set(key, kernel)
      stats.convolutions++
    }
    cancelled(hooks)
    return { ...kernel, baseline, minimum: baseline + kernel.points[0][0],
      maximum: baseline + kernel.points.at(-1)[0], mean: baseline + kernel.mean,
      method: DISTRIBUTION_VERSION }
  } }
}

export function distributionQuantile(distribution, fraction) {
  if (!(fraction > 0 && fraction <= 1)) throw new Error("降序分位参数无效")
  let tail = 0
  for (let i = distribution.points.length - 1; i >= 0; i--) {
    tail += distribution.points[i][1]
    if (tail + 1e-12 >= fraction) return distribution.baseline + distribution.points[i][0]
  }
  return distribution.minimum
}

export function distributionMetrics(distribution, threshold) {
  let pGreater = 0, pAtLeast = 0, lower = 0, upper = 0, positiveGain = 0
  const error = distribution.errorBound + 1e-10
  for (const [increment, probability] of distribution.points) {
    const delta = distribution.baseline + increment - threshold
    if (delta > 1e-10) pGreater += probability
    if (delta >= -1e-10) pAtLeast += probability
    if (delta > error) lower += probability
    if (delta > -error) upper += probability
    positiveGain += Math.max(delta, 0) * probability
  }
  const clamp = value => Math.max(0, Math.min(1, value))
  return { pGreater: clamp(pGreater), pAtLeast: clamp(pAtLeast), probabilityBounds: { lower: clamp(lower), upper: clamp(upper) },
    expectedPositiveGain: positiveGain, gainBounds: { lower: Math.max(0, positiveGain - error), upper: positiveGain + error },
    minimum: distribution.minimum, maximum: distribution.maximum, mean: distribution.mean, variance: distribution.variance,
    threshold, errorBound: distribution.errorBound, supportSize: distribution.points.length,
    top20: distributionQuantile(distribution, 0.2), top80: distributionQuantile(distribution, 0.8) }
}
