import assert from 'node:assert/strict'
import { createDistributionEngine, distributionMetrics, distributionQuantile } from '../utils/artifact-distribution.js'
import { observedLoadoutThreshold } from '../utils/artifact-loadout.js'
import { classifyExpectedGain } from '../utils/character-assessment.js'
import { evaluateArtifact, validateDecisionDatabase } from '../utils/artifact-decision.js'
import { annotateArtifactEnhancement, nextRandomEnhancementLevel } from '../utils/artifact-enhancement.js'
import { prepareProjectionInput } from '../utils/projection-model.js'

const engine = createDistributionEngine()
const input = { values: [1, 2, 3, 4], rollTables: Array.from({ length: 4 }, () => [0.7, 0.8, 0.9, 1]), remainingUpgrades: 2 }
const weights = [1, 0.5, 0, 0.25]
const distribution = await engine.calculate(input, weights, 0.2)
assert.ok(Math.abs(distribution.points.reduce((sum, [, p]) => sum + p, 0) - 1) < 1e-12)
const enumerated = []
for (let a = 0; a < 16; a++) for (let b = 0; b < 16; b++) {
  enumerated.push(distribution.baseline + weights[Math.floor(a / 4)] * input.rollTables[0][a % 4] + weights[Math.floor(b / 4)] * input.rollTables[0][b % 4])
}
const threshold = 5.12
const metrics = distributionMetrics(distribution, threshold)
assert.ok(Math.abs(metrics.pGreater - enumerated.filter(score => score > threshold).length / 256) < 1e-12)
assert.ok(Math.abs(metrics.expectedPositiveGain - enumerated.reduce((sum, score) => sum + Math.max(0, score - threshold), 0) / 256) < 1e-9)
assert.ok(Math.abs(distribution.mean - enumerated.reduce((sum, score) => sum + score, 0) / 256) < 1e-9)
assert.ok(Math.abs(distribution.variance - enumerated.reduce((sum, score) => sum + (score - distribution.mean) ** 2, 0) / 256) < 1e-9)
enumerated.sort((a, b) => b - a)
assert.ok(Math.abs(distributionQuantile(distribution, 0.2) - enumerated[Math.ceil(256 * 0.2) - 1]) < 1e-8)
const three = await engine.calculate({ ...input, remainingUpgrades: 4 }, weights)
const four = await engine.calculate({ ...input, remainingUpgrades: 5 }, weights)
assert.ok(four.mean > three.mean)
for (const fraction of [0.01, 0.2, 0.5, 0.8, 1]) assert.ok(distributionQuantile(four, fraction) >= distributionQuantile(three, fraction) - 1e-8)
const deterministic = await engine.calculate({ ...input, remainingUpgrades: 0 }, weights)
assert.equal(deterministic.variance, 0)
assert.equal(deterministic.points.length, 1)
assert.equal(distributionMetrics(deterministic, deterministic.mean).pGreater, 0)
assert.equal(distributionMetrics(deterministic, deterministic.mean).pAtLeast, 1)
const before = engine.stats.convolutions
await engine.calculate(input, weights, 100)
assert.equal(engine.stats.convolutions, before, '只换确定性基线复用卷积核')
await assert.rejects(engine.calculate({ ...input, remainingUpgrades: 5 }, weights, 0, { isCancelled: () => true }), /取消/)

const slots = ['生之花', '死之羽', '时之沙', '空之杯', '理之冠']
const equipped = slots.map((slot, i) => ({ slot, setName: i === 4 ? '散件' : 'A', value: 1, input: { mainKey: slot } }))
const candidate = { slot: '空之杯', setName: 'B' }
assert.equal(observedLoadoutThreshold(candidate, equipped, equipped, [{ name: 'A', count: 4 }], item => item.value), null)
const spare = { ...equipped[4], setName: 'A', value: 0.5 }
const alternative = observedLoadoutThreshold(candidate, equipped, [...equipped, spare], [{ name: 'A', count: 4 }], item => item.value)
assert.ok(alternative)
assert.equal(alternative.threshold, 1.5)
assert.equal(alternative.items[4].setName, 'A', '允许杯成为散件并让冠回到目标套装')
const pair = equipped.map((item, i) => ({ ...item, setName: i < 2 ? 'A' : i < 4 ? 'B' : '散件' }))
assert.ok(observedLoadoutThreshold({ slot: '理之冠', setName: 'C' }, pair, pair, [{ name: 'A', count: 2 }, { name: 'B', count: 2 }], item => item.value))
const model = gain => ({ gainBounds: { lower: gain, upper: gain } })
assert.equal(classifyExpectedGain([]).status, 'unknown')
assert.equal(classifyExpectedGain([model(0.7), model(0.9)]).status, 'keep')
assert.equal(classifyExpectedGain([model(0), model(0.01)]).status, 'fodder')
assert.equal(classifyExpectedGain([model(0.1), model(0.8)]).status, 'test', '分歧进入试强化而非资料未知')

const artifact = annotateArtifactEnhancement({ name: '回归胚子', slot: '生之花', setName: 'A', level: 0, warnings: [],
  mainStat: { name: '生命值', value: 717, percent: false }, subStats: [
    { name: '攻击力', value: 5.8, percent: true }, { name: '防御力', value: 6.6, percent: true },
    { name: '攻击力', value: 18, percent: false }, { name: '元素精通', value: 23, percent: false }
  ].map((stat, rowIndex) => ({ ...stat, rowIndex, activation: rowIndex === 3 ? 'pending' : 'active' })) })
assert.equal(prepareProjectionInput(artifact).remainingUpgrades, 4)
assert.equal(nextRandomEnhancementLevel(artifact), 8, '初始三条首次随机信息在+8')
assert.equal(nextRandomEnhancementLevel(annotateArtifactEnhancement({ ...artifact,
  subStats: artifact.subStats.map(stat => ({ ...stat, activation: 'active' })) })), 4)
assert.equal(nextRandomEnhancementLevel({ enhancement: { consistent: true, remainingUpgradeCount: 0 } }), null)
const db = { schemaVersion: 1, rules: [] }
const projection = { state: 'ready', rows: [{ name: 'A', assessment: { status: 'fodder' } }], assessmentSummary: { total: 1, unknown: 0 } }
assert.equal(evaluateArtifact(artifact, db, projection).reasonCode, 'scope-incomplete')
assert.equal(evaluateArtifact(artifact, db, projection, { flags: { confirmScope: true } }).reasonCode, 'item-status-unobserved')
assert.equal(evaluateArtifact(artifact, db, projection, { flags: { confirmScope: true, confirmItem: true } }).status, 'fodder')
assert.equal(evaluateArtifact({ ...artifact, locked: true }, db, projection, { flags: { confirmScope: true, confirmItem: true } }).status, 'keep')
assert.equal(evaluateArtifact({ ...artifact, warnings: ['OCR错误'] }, db, projection, { flags: { confirmScope: true, confirmItem: true } }).status, 'unknown')
const mixed = { ...projection, rows: [...projection.rows, { name: 'B', assessment: { status: 'keep', reason: '有提升' } }] }
assert.equal(evaluateArtifact(artifact, db, mixed).status, 'keep', '一个角色排除不覆盖另一个保留用途')
const test = { ...projection, rows: [{ name: 'B', assessment: { status: 'test', nextTestLevel: 8 } }] }
assert.equal(evaluateArtifact(artifact, db, test).nextTestLevel, 8)
const custom = validateDecisionDatabase({ schemaVersion: 1, rules: [{ id: 'em', type: 'protect-stats', keys: ['mastery'], reason: '精通备用' }] })
assert.equal(evaluateArtifact(artifact, custom, projection).reasonCode, 'template-protection', '自定义保护规则实际执行')
assert.throws(() => validateDecisionDatabase({ schemaVersion: 1, rules: [{ type: 'always-drop' }] }))
console.log('通过：修订模型PMF/穷举、均值方差、严格尾概率、随机占优、确定激活、缓存取消、自由位/2+2、四种仲裁与保护规则。')
