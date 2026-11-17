import assert from 'node:assert/strict'
import { initialEffectiveStatPolicy } from '../utils/character-assessment.js'
import { annotateArtifactEnhancement } from '../utils/artifact-enhancement.js'
import { createProjectionService } from '../utils/artifact-projection.js'
import { recordedCharacterCatalog, matchStrongboxCandidates, presentCandidateProjection } from '../utils/strongbox-candidates.js'

const stat = (name, percent, rank) => ({ name, percent, rank })
const record = (name, subStats) => ({ identity: { displayName: name, verified: true, element: '水' }, slots: {},
  recommendations: { 生之花: { status: 'ok', subHeadingFound: true, subStats } } })
const rec = [stat('攻击力', true, 1), stat('元素精通', false, 2), stat('暴击率', true, 3)]
const artifact = annotateArtifactEnhancement({ name: '测试胚子', slot: '生之花', setName: '测试套装', level: 0,
  mainStat: { name: '生命值', percent: false, value: 717 }, warnings: [],
  subStats: [{ name: '攻击力', percent: true, value: 5.8 }, { name: '攻击力', percent: false, value: 18 },
    { name: '防御力', percent: false, value: 21 }, { name: '元素精通', percent: false, value: 23 }]
    .map((row, rowIndex) => ({ ...row, rowIndex, activation: rowIndex === 3 ? 'pending' : 'active' })) })
const furina = record('芙宁娜', rec)
const options = { excludeLowInitialStats: true, minInitialEffectiveStats: 2 }
assert.equal(initialEffectiveStatPolicy(artifact, furina).threshold, null, '默认记录特征但不启用低优先级提示')
let policy = initialEffectiveStatPolicy(artifact, furina, options)
assert.equal(policy.count, 2, '潜在有效数包含精通预览')
assert.equal(policy.activatedCount, 1, '保留已激活数以供解释')
assert.equal(policy.activeCount, 3)
assert.equal(policy.pendingEffectiveCount, 1, '已知待激活有效词条计入潜在数并单独记录')
const four = annotateArtifactEnhancement({ ...artifact, subStats: artifact.subStats.map(row => ({ ...row, activation: 'active' })) })
const every = record('芙宁娜', four.subStats.map((row, i) => stat(row.name, row.percent, i + 1)))
assert.equal(initialEffectiveStatPolicy(four, every, options).count, 4)

const crit = annotateArtifactEnhancement({ name: '双爆测试', slot: '生之花', setName: '测试套装', level: 0,
  mainStat: artifact.mainStat, warnings: [], subStats: [
    { name: '暴击率', value: 3.9, percent: true }, { name: '暴击伤害', value: 7.8, percent: true },
    { name: '攻击力', value: 5.8, percent: true }, { name: '元素精通', value: 23, percent: false }]
    .map((row, rowIndex) => ({ ...row, rowIndex, activation: 'active' })) })
assert.equal(initialEffectiveStatPolicy(crit, record('芙宁娜', [stat('暴击率', true, 1), stat('暴击伤害', true, 2)]), options).count, 2,
  '暴击率、暴击伤害分别各计一个初始词条')
for (const invalid of [
  { ...artifact, level: 4 }, { ...artifact, warnings: ['OCR需核对'] },
  { ...artifact, subStats: artifact.subStats.slice(0, 3) },
  { ...artifact, subStats: artifact.subStats.map((row, i) => i ? row : { ...row, value: 999 }) }
]) {
  const info = initialEffectiveStatPolicy(invalid, furina, options)
  assert.equal(info.state, 'unknown')
}
for (const invalid of [
  { ...furina, recommendations: {} }, { ...furina, identity: { ...furina.identity, verified: false } },
  record('芙宁娜', rec.slice(1)), record('芙宁娜', [rec[0], { ...rec[0], rank: 2 }]),
  record('芙宁娜', [stat('元素精通', true, 1)])
]) assert.equal(initialEffectiveStatPolicy(artifact, invalid, options).state, 'unknown', '未知不是0条')

const service = createProjectionService({ simulationCount: 100, returnAllRows: true }, [], { 芙宁娜: furina })
const ids = ['default:芙宁娜']
const disabled = await service.calculate(artifact, {}, ids)
assert.equal(disabled.rows[0].assessment.status, 'unknown', '缺少现装原本待定')
assert.equal(service.cached(artifact, ids, options), null)
const enabled = await service.calculate(artifact, {}, ids, options)
assert.equal(enabled.rows[0].assessment.code, 'equipment', '低词条特征不能覆盖缺失基线')
assert.equal(enabled.rows[0].top20, disabled.rows[0].top20)
assert.equal(enabled.rows[0].top80, disabled.rows[0].top80, '阈值不重抽强化样本或修改原分位分数')
assert.equal(service.cached(artifact, ids, { ...options, minInitialEffectiveStats: 1 }), null)
assert.equal((await service.calculate(artifact, {}, ids, { ...options, minInitialEffectiveStats: 1 })).rows[0].assessment.status, 'unknown')
assert.equal((await service.calculate(artifact, {}, ids)).rows[0].assessment.status, 'unknown', '关闭后恢复原待定')
await service.calculate(artifact, {}, ids, options)
const warned = { ...artifact, warnings: ['识别状态变化'] }
assert.equal(service.cached(warned, ids, options), null, '出现识别警告时不得复用旧阈值舍弃')
assert.equal((await service.calculate(warned, {}, ids, options)).rows[0].assessment.code, 'artifact-ocr')

const flags = { ...options, showTrainingCharacters: true }
const doll = record('人偶A', [stat('暴击率', true, 1)])
const catalog = recordedCharacterCatalog({ f: furina, doll })
const candidates = matchStrongboxCandidates(artifact, catalog, ['芙宁娜', '人偶A'], flags)
assert.equal(candidates.find(row => row.name === '芙宁娜').initialStats.count, 2)
assert.equal(candidates.find(row => row.name === '人偶A').initialStats.count, 0, '相同物品对不同角色分别计数')
const display = presentCandidateProjection(enabled, candidates)
assert.equal(display.rows.find(row => row.name === '人偶A').assessment.status, 'unknown', '无评分规则保留资料缺失')
assert.equal(display.rows.find(row => row.name === '人偶A').top20, null)
assert.equal(display.assessmentSummary.fodder, 0)
const partial = presentCandidateProjection({ ...enabled, rows: [{ ...enabled.rows[0], assessment: { status: 'keep' } }] },
  candidates.map(row => ({ ...row, profileIds: [...row.profileIds, 'missing-branch'] })))
assert.equal(partial.assessmentSummary.keep, 1, '低词条提示不能覆盖其他保留证据')
console.log('通过：潜在/激活有效数、逐角色单位与预览计数、缺资料保护、提示阈值、缓存切换和分支汇总。')
