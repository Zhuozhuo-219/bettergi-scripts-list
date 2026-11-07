// 只读诊断，不改变运行时权重/配置。精确枚举首张截图字段对应的 16^4 个终值路径。
import assert from 'node:assert/strict'
import { annotateArtifactEnhancement, getSubStatRolls } from '../utils/artifact-enhancement.js'
import { prepareProjectionInput, compileCharacterScorer, scoreRound } from '../utils/projection-model.js'
import { descendingQuantile, findPotentialMaximum } from '../utils/artifact-projection.js'
import scoreData, { getAttrWeight } from '../utils/vendor/miao-score.js'

const artifact = annotateArtifactEnhancement({
  name: '首张截图生命杯手工字段', setName: '黄金剧团', slot: '空之杯', level: 0,
  mainStat: { name: '生命值', value: 7, percent: true }, warnings: [],
  subStats: [
    { name: '生命值', value: 209, percent: false },
    { name: '暴击率', value: 3.1, percent: true },
    { name: '元素充能效率', value: 5.8, percent: true },
    { name: '攻击力', value: 18, percent: false }
  ].map((stat, rowIndex) => ({ ...stat, rowIndex, activation: rowIndex === 3 ? 'pending' : 'active' }))
})
const input = prepareProjectionInput(artifact)
const keys = ['cpct', 'cdmg', 'hp', 'recharge']
const reports = []
for (const character of ['芙宁娜', '夜兰', '芭芭拉', '钟离']) {
  const profile = { character, options: { elem: scoreData.charElemMap[character] } }
  const scorer = compileCharacterScorer(profile, input)
  const scores = []
  function enumerate(values, remaining) {
    if (!remaining) { scores.push(scoreRound(scorer.score(values))); return }
    for (let target = 0; target < 4; target++) for (const roll of input.rollTables[target]) {
      const next = [...values]
      next[target] += roll
      enumerate(next, remaining - 1)
    }
  }
  enumerate(input.values, input.remainingUpgrades)
  // 用固定生命主词条的花比较四种副词条，避免生命%主杯与生命%副词条互斥。
  const probe = { ...input, pos: 0, mainKey: 'hpPlus', mainValue: 4780, keys, values: [0, 0, 0, 0] }
  const probeScorer = compileCharacterScorer(profile, probe)
  const oneMaxRollGainsOnFlower = Object.fromEntries(keys.map((key, i) => {
    const values = [0, 0, 0, 0]
    values[i] = getSubStatRolls(key)[3]
    return [key, Number((probeScorer.score(values) - probeScorer.intercept).toFixed(4))]
  }))
  assert.equal(scores.length, 65536)
  reports.push({ character,
    weights: Object.fromEntries(keys.map(key => [key, scorer.weights[key] || 0])),
    oneMaxRollGainsOnFlower,
    mainOnly: scoreRound(scorer.intercept),
    initialSubs: scoreRound(scorer.score(input.values) - scorer.intercept),
    minimumFinal: Math.min(...scores),
    top20: descendingQuantile(scores, 0.2), top80: descendingQuantile(scores, 0.8),
    potentialMax: findPotentialMaximum(input, scorer).score,
    top80WithoutMain: scoreRound(descendingQuantile(scores, 0.8) - scorer.intercept)
  })
}
const profile = { character: '芙宁娜', options: { elem: 'hydro' } }
const normal = compileCharacterScorer(profile, input)
const halved = compileCharacterScorer({ ...profile,
  weightOverrides: Object.fromEntries(Object.entries(normal.weights).map(([key, value]) => [key, value / 2]))
}, input)
assert.ok(Math.abs(normal.intercept - halved.intercept) < 1e-8)
assert.ok(normal.coefficients.every((value, i) => Math.abs(value - halved.coefficients[i]) < 1e-8))
console.log(JSON.stringify({
  model: '0.4.0 local snapshot; fixed default conditions; four stats/four tiers equiprobable',
  input: { level: input.level, mainFinal: input.mainValue, stats: input.keys.map((key, i) => ({ key, value: input.values[i] })), remainingUpgrades: input.remainingUpgrades },
  exactPaths: 65536, reports,
  uniformHalfWeights: { character: '芙宁娜', potentialMax: findPotentialMaximum(input, halved).score,
    unchanged: true, note: 'Numerator and per-character denominator both rescale in this case.' },
  conditionalRuleAudit: { character: '芙宁娜',
    default: getAttrWeight('芙宁娜', {}).attrWeight,
    c4: getAttrWeight('芙宁娜', { cons: 4 }).attrWeight,
    note: 'Local converted branch returns null; upstream C4 rule sets recharge=75 before returning def(...). No runtime changes in this audit.' }
}, null, 2))
