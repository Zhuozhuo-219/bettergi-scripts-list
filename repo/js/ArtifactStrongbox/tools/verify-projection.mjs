import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { annotateArtifactEnhancement, getSubStatKey } from '../utils/artifact-enhancement.js'
import { prepareProjectionInput, getCharacterProfiles, compileCharacterScorer, validateProfileDatabase, scoreRound } from '../utils/projection-model.js'
import { createProjectionService, descendingQuantile, findPotentialMaximum, enumerateAllocations } from '../utils/artifact-projection.js'
import { calcArtifactScore } from '../utils/vendor/miao-score.js'

function fixture(level = 0, pending = false) {
  const subs = [
    { name: '暴击率', value: level === 20 ? 23.3 : 3.1, percent: true },
    { name: '暴击伤害', value: 7.8, percent: true },
    { name: '攻击力', value: 4.7, percent: true },
    { name: '元素充能效率', value: 5.8, percent: true }
  ].map((stat, rowIndex) => ({ ...stat, rowIndex,
    activation: pending && rowIndex === 3 ? 'pending' : 'active' }))
  return annotateArtifactEnhancement({ name: '测试杯', slot: '空之杯', setName: '黄金剧团', level,
    mainStat: { name: '生命值', value: level === 20 ? 46.6 : 7, percent: true },
    subStats: subs, warnings: [] })
}

assert.equal(descendingQuantile([1, 2, 3, 4, 5], 0.2), 5)
assert.equal(descendingQuantile([1, 2, 3, 4, 5], 0.8), 2)
assert.equal(descendingQuantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.2), 9)
assert.equal(descendingQuantile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.8), 3)
assert.throws(() => descendingQuantile([], 0.2))
assert.equal(enumerateAllocations(5).length, 56)
assert.ok(enumerateAllocations(5).every(counts => counts.reduce((sum, n) => sum + n, 0) === 5))
const artifact = fixture()
const original = JSON.stringify(artifact)
const input = prepareProjectionInput(artifact)
assert.equal(input.mainValue, 46.6, '必须先把主词条推进到 +20，不沿用 +0 的 7%')
assert.equal(input.remainingUpgrades, 5)
assert.equal(prepareProjectionInput(fixture(0, true)).remainingUpgrades, 4)
assert.equal(prepareProjectionInput(fixture(20)).remainingUpgrades, 0)
assert.throws(() => prepareProjectionInput(fixture(4, true)), /需核对/)
const duplicate = fixture()
duplicate.subStats[3] = { ...duplicate.subStats[0], rowIndex: 3 }
assert.throws(() => prepareProjectionInput(duplicate), /重复/)
const conflict = fixture()
conflict.subStats[3] = { ...conflict.subStats[3], name: '生命值', value: 5.8 }
assert.throws(() => prepareProjectionInput(conflict), /冲突/)
const impossibleHistory = fixture(20)
impossibleHistory.subStats[0].value = 3.1
assert.throws(() => prepareProjectionInput(impossibleHistory), /累计次数/)
const wrongMaxMain = fixture(20)
wrongMaxMain.mainStat.value = 7
assert.throws(() => prepareProjectionInput(wrongMaxMain), /满级主词条/)

const profiles = getCharacterProfiles()
assert.equal(profiles.length, 127)
assert.equal(new Set(profiles.map(profile => profile.id)).size, profiles.length)
// 所有默认条件与评分器原单件 API 对照；当前固定条件下应保持同一公式。
for (const profile of profiles) {
  const scorer = compileCharacterScorer(profile, input)
  for (const values of [input.values, input.values.map((v, i) => v + input.rollTables[i][2] * 2)]) {
    const expected = calcArtifactScore(profile.character, [{ pos: input.pos, mainKey: input.mainKey,
      mainValue: input.mainValue, subs: Object.fromEntries(input.keys.map((key, i) => [key, values[i]]))
    }], profile.options).artifacts[0].score
    assert.ok(Math.abs(scoreRound(scorer.score(values)) - expected) < 1e-8, profile.name)
  }
}

// 用完整 16^2 种分支验证最高档命中分配的最大值，与抽样最大值分开。
const twoNodes = { ...input, remainingUpgrades: 2 }
for (const profile of profiles.filter(profile => ['芙宁娜', '玛薇卡', '钟离'].includes(profile.character))) {
  const scorer = compileCharacterScorer(profile, twoNodes)
  let exhaustiveMax = -Infinity
  for (let a = 0; a < 16; a++) for (let b = 0; b < 16; b++) {
    const values = [...input.values]
    values[Math.floor(a / 4)] += input.rollTables[Math.floor(a / 4)][a % 4]
    values[Math.floor(b / 4)] += input.rollTables[Math.floor(b / 4)][b % 4]
    exhaustiveMax = Math.max(exhaustiveMax, scorer.score(values))
  }
  assert.equal(findPotentialMaximum(twoNodes, scorer).score, scoreRound(exhaustiveMax))
}
const balanced = findPotentialMaximum({
  remainingUpgrades: 4, values: [0, 0, 0, 0], keys: ['a', 'b', 'c', 'd'],
  names: ['a', 'b', 'c', 'd'], percent: [false, false, false, false], rollTables: Array(4).fill([0.7, 0.8, 0.9, 1])
}, { score: values => Math.min(values[0], values[1]) })
assert.equal(balanced.score, 2)
assert.deepEqual(balanced.allocation.map(stat => stat.count), [2, 2, 0, 0])

const service = createProjectionService({ simulationCount: 1000 })
const started = performance.now()
const result = await service.calculate(artifact)
assert.equal(result.state, 'ready')
assert.equal(result.simulatedProfiles, 127)
assert.equal(result.skipped.length, 0)
assert.equal(result.rows.length, 5)
assert.ok(result.rows.every(row => row.top20 >= row.top80 && !Object.hasOwn(row, 'potentialMax')))
assert.equal(JSON.stringify(artifact), original, '不能修改已经识别的词条值')
assert.equal(service.cached(artifact), result)
assert.equal(service.cached({ ...artifact, capturedAt: 'jitter', rawText: 'OCR 空格变化' }), result)
const repeated = await createProjectionService({ simulationCount: 1000 }).calculate(artifact)
assert.deepEqual(result, repeated, '固定种子和同一数据应完全重现')
assert.equal(result.sampleCount, 1000)

const pendingArtifact = fixture(0, true)
const pending = await createProjectionService({ simulationCount: 100 }).calculate(pendingArtifact)
assert.equal(pending.remainingUpgrades, 4)
assert.equal(pending.fixedActivation.length, 1)
assert.equal(pending.fixedActivation[0].value, 5.8)
assert.ok(pending.rows.every(row => row.top20 >= row.top80))
const maxed = await createProjectionService().calculate(fixture(20))
assert.equal(maxed.sampleCount, 1)
assert.ok(maxed.rows.every(row => row.top20 === row.top80))
const blocked = await service.calculate(duplicate)
assert.equal(blocked.state, 'blocked')
await assert.rejects(createProjectionService().calculate(artifact, { isCancelled: () => true }), /取消/)

// 不依赖已有杯子条目的评分规则也要能评估花、羽、沙、冠。
for (const [slot, mainStat] of [
  ['生之花', { name: '生命值', value: 717, percent: false }],
  ['死之羽', { name: '攻击力', value: 47, percent: false }],
  ['时之沙', { name: '防御力', value: 8.7, percent: true }],
  ['理之冠', { name: '治疗加成', value: 5.4, percent: true }]
]) {
  const item = { ...fixture(), slot, mainStat }
  const results = await createProjectionService({ simulationCount: 100 }).calculate(item)
  assert.equal(results.skipped.length, 0, slot)
  assert.equal(results.simulatedProfiles, 127, slot)
}

const custom = validateProfileDatabase({ schemaVersion: 1, profiles: [{
  id: 'attack-only', character: '芙宁娜', label: '测试自定分支',
  options: { cons: 0, charAttrs: { recharge: 180 } },
  weightOverrides: { atk: 100, hp: 0, cpct: 0, cdmg: 0, recharge: 0 }
}] })
const customScorer = compileCharacterScorer(custom[0], input)
const customMaximum = findPotentialMaximum(input, customScorer)
assert.equal(customMaximum.allocation.find(stat => stat.key === 'atk').count, 5)
assert.throws(() => validateProfileDatabase({ schemaVersion: 1, profiles: [{ id: 'x', character: '不存在' }] }))
assert.throws(() => validateProfileDatabase({ schemaVersion: 1, profiles: [{ id: 'x', character: '芙宁娜', weightOverrides: { atk: -1 } }] }))
assert.throws(() => validateProfileDatabase({ schemaVersion: 1, profiles: [null] }))
assert.throws(() => validateProfileDatabase({ schemaVersion: 1, profiles: [{ id: 'x', character: '芙宁娜', options: [] }] }))
console.log(`通过：降序分位、127 分支评分对照、理论上限穷举、固定激活值、五部位、满级、缓存/取消与手工权重。1000 次全角色计算 ${(performance.now() - started).toFixed(0)} ms（含后续验证）。`)
