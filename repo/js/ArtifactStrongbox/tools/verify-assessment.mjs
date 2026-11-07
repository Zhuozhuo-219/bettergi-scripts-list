import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { inventoryPressure, recommendationWeights, replacementContext, summarizeImprovement, classifyImprovement, ASSESSMENT_POLICY,
  mainStatSuitability, mainRuleAssessment } from '../utils/character-assessment.js'
import { createProjectionService } from '../utils/artifact-projection.js'
import { annotateArtifactEnhancement } from '../utils/artifact-enhancement.js'
import { recordedCharacterCatalog, matchStrongboxCandidates, presentCandidateProjection, createStrongboxSession } from '../utils/strongbox-candidates.js'

assert.equal(inventoryPressure('').level, 'unknown')
assert.equal(inventoryPressure(undefined).estimatedCount, null)
for (const [value, level] of [[0, 'relaxed'], [2159, 'relaxed'], [2160, 'tight'], [2564, 'tight'], [2565, 'high'], [2700, 'high']]) {
  assert.equal(inventoryPressure(String(value)).level, level)
}
for (const bad of [-1, 2701, 'foo', '20.5', Infinity]) assert.throws(() => inventoryPressure(bad), /0～2700/)
const recommendation = { status: 'ok', mainHeadingFound: true,
  mainStats: [{ name: '生命值', percent: true, usageRate: 70, rank: 1 }, { name: '元素精通', percent: false, usageRate: 15, rank: 2 },
    { name: '水元素伤害加成', percent: true, usageRate: 10, rank: 3 }], subStats: [
  { name: '暴击伤害', percent: true, rank: 1 }, { name: '暴击率', percent: true, rank: 2 },
  { name: '生命值', percent: true, rank: 3 }, { name: '元素充能效率', percent: true, rank: 4 }
] }
const weights = recommendationWeights(recommendation)
assert.deepEqual(weights[0].weights, { cpct: 1, cdmg: 1, hp: 2 / 3, recharge: 1 / 3 })
assert.deepEqual(weights[1].weights, { cpct: 1, cdmg: 1, hp: 0.5, recharge: 0.25 })
assert.equal(weights[0].weights.hpPlus, undefined, '生命%与固定生命不能混同')
assert.throws(() => recommendationWeights({ status: 'error', subStats: recommendation.subStats }), /缺少/)
assert.throws(() => recommendationWeights({ ...recommendation, subStats: recommendation.subStats.map((row, i) => ({ ...row, rank: [1, 3, 2, 4][i] })) }), /隔开/)
assert.equal(classifyImprovement([]).status, 'unknown')
const summary = deltas => summarizeImprovement(deltas, { id: 'test', label: 'test', weights: {} }, 0)
assert.equal(classifyImprovement([summary(Array(1000).fill(1))]).status, 'keep')
assert.equal(classifyImprovement([summary(Array(1000).fill(-1))]).status, 'fodder')
assert.equal(classifyImprovement([summary(Array(100).fill(-1))]).status, 'unknown', '少样本0成功仍不足以满足1%的保守上界')
assert.equal(classifyImprovement([summary(Array(1000).fill(1)), summary(Array(1000).fill(-1))]).status, 'unknown', '模型相反不选边')
assert.equal(summary([0.6, -0.2]).expectedPositiveGain, 0.3)
assert.equal(classifyImprovement([summary(Array(1000).fill(-0.1))], { mainChanged: true }).status, 'unknown',
  '不同主词条略低不能当作显著劣势')
assert.equal(classifyImprovement([summary(Array(1000).fill(-0.6))], { mainChanged: true }).status, 'fodder')

const slots = ['生之花', '死之羽', '时之沙', '空之杯', '理之冠']
function baseline(strong) {
  return { name: strong ? '强现装' : '弱现装', slot: '空之杯', setName: '黄金剧团', level: 20, complete: true,
    owner: '芙宁娜', ownerText: '芙宁娜已装备', mainStat: { name: '生命值', value: 46.6, percent: true }, warnings: [],
    subStats: [{ name: '暴击率', value: strong ? 23.3 : 2.7, percent: true }, { name: '暴击伤害', value: strong ? 7.8 : 5.4, percent: true },
      { name: '防御力', value: strong ? 23 : 139, percent: false }, { name: '攻击力', value: strong ? 19 : 14, percent: false }] }
}
function record(strong = false, sets = ['黄金剧团', '黄金剧团', '黄金剧团', '黄金剧团', '昔日宗室之仪']) {
  return { identity: { displayName: '芙宁娜', element: '水', kind: 'regular', verified: true },
    slots: Object.fromEntries(slots.map((slot, i) => [slot, { status: 'equipped', equippedArtifact: { ...baseline(strong), slot, setName: sets[i] } }])),
    recommendations: { 空之杯: structuredClone(recommendation) },
    setRecommendations: { rows: [{ rank: 1, status: 'ok', usageRate: 85, components: [{ setName: '黄金剧团', count: 4 }] }] } }
}
function candidate(strong = true) {
  return annotateArtifactEnhancement({ name: '测试胚子', slot: '空之杯', setName: '黄金剧团', level: 0,
    mainStat: { name: '生命值', value: 7, percent: true }, warnings: [],
    subStats: [{ name: '暴击率', value: strong ? 3.9 : 2.7, percent: true }, { name: '暴击伤害', value: strong ? 7.8 : 5.4, percent: true },
      { name: '防御力', value: 23, percent: false }, { name: '攻击力', value: 19, percent: false }]
      .map((row, rowIndex) => ({ ...row, rowIndex, activation: 'active' })) })
}
const ids = ['default:芙宁娜'], good = candidate(), weakRecord = record(), strongRecord = record(true)
const original = JSON.stringify({ good, weakRecord })
const keep = await createProjectionService({ simulationCount: 1000 }, [], { 芙宁娜: weakRecord }).calculate(good, {}, ids)
assert.equal(keep.rows[0].assessment.status, 'keep')
assert.equal(keep.rows[0].assessment.models.length, 3)
assert.ok(keep.rows[0].assessment.bounds.minimumMeaningful >= ASSESSMENT_POLICY.keepProbability)
const discard = await createProjectionService({ simulationCount: 1000 }, [], { 芙宁娜: strongRecord }).calculate(candidate(false), {}, ids)
assert.equal(discard.rows[0].assessment.status, 'fodder')
assert.ok(discard.rows[0].assessment.bounds.maximumImprove <= 0.01)
const notEnough = await createProjectionService({ simulationCount: 100 }, [], { 芙宁娜: strongRecord }).calculate(candidate(false), {}, ids)
assert.equal(notEnough.rows[0].assessment.status, 'unknown')
assert.equal(JSON.stringify({ good, weakRecord }), original, '不改素材数值或账号原始记录')
assert.equal(replacementContext({ ...good, setName: '深林的记忆' }, weakRecord).code, 'set-break')
const breaksSet = { ...good, setName: '深林的记忆' }
const switchService = createProjectionService({ simulationCount: 1000 }, [], { 芙宁娜: weakRecord })
const restricted = await switchService.calculate(breaksSet, {}, ids)
assert.equal(restricted.rows[0].assessment.code, 'set-break')
assert.equal(switchService.cached(breaksSet, ids, { respectExistingSets: false }), null, '开关必须进入缓存键')
const unrestricted = await switchService.calculate(breaksSet, {}, ids, { respectExistingSets: false })
assert.equal(unrestricted.rows[0].assessment.status, 'keep', '关闭约束后允许原本拆套装的纯属性提升')
assert.equal(unrestricted.rows[0].assessment.respectExistingSets, false)
assert.equal(unrestricted.rows[0].assessment.brokenSets[0].count, 4)
assert.equal(unrestricted.rows[0].top20, restricted.rows[0].top20)
assert.equal(unrestricted.rows[0].top80, restricted.rows[0].top80, '切换只影响可行性，不重抽样改变原分位数')
assert.equal(switchService.cached(breaksSet, ids, { respectExistingSets: false }), unrestricted)
assert.equal(switchService.cached(breaksSet, ids), null)
assert.equal((await switchService.calculate(breaksSet, {}, ids)).rows[0].assessment.code, 'set-break', '重新勾选恢复限制')
const onlyCup = record(); delete onlyCup.slots.生之花
assert.equal(replacementContext(good, onlyCup).code, 'equipment')
const pureCup = replacementContext(good, onlyCup, { respectExistingSets: false })
assert.ok(pureCup.baseline, '关闭套装约束时其他部位缺失不妨碍同部位纯分比较')
assert.equal(pureCup.setCountsKnown, false)
assert.equal(pureCup.beforeCounts, null, '未知的完整套装件数不能伪造')
assert.ok(replacementContext({ ...good, setName: '深林的记忆' }, record(false, Array(5).fill('黄金剧团'))).baseline,
  '五件同套有一件余量可散')
assert.ok(replacementContext({ ...good, setName: '深林的记忆' }, record(false, ['黄金剧团', '黄金剧团', '饰金之梦', '昔日宗室之仪', '饰金之梦'])).baseline,
  '2+2保留，替换散件可行')
assert.equal(replacementContext({ ...good, setName: '饰金之梦' }, record(false, ['黄金剧团', '饰金之梦', '饰金之梦', '黄金剧团', '昔日宗室之仪'])).code, 'set-break')
const missingOwner = record(); missingOwner.slots.生之花.equippedArtifact.ownerText = ''
assert.equal(replacementContext(good, missingOwner).code, 'equipment')
assert.equal(replacementContext(good, missingOwner, { respectExistingSets: false }).baseline !== undefined, true,
  '关闭时只需要杯的归属可靠，花的装备者缺失可不参与')
const missingCupOwner = record(); missingCupOwner.slots.空之杯.equippedArtifact.ownerText = ''
assert.equal(replacementContext(good, missingCupOwner, { respectExistingSets: false }).code, 'equipment', '同部位装备者保护仍有效')
const stale = record(); stale.slots.空之杯.baselineStale = true
assert.equal(replacementContext(good, stale).code, 'equipment')
const low = record(); low.slots.空之杯.equippedArtifact.level = 16
assert.equal(replacementContext(good, low).code, 'baseline-level')
const bad = record(); bad.slots.空之杯.equippedArtifact.subStats[0].value = 999
assert.equal(replacementContext(good, bad).code, 'baseline-invalid')
assert.equal(replacementContext({ ...good, mainStat: { name: '水元素伤害加成', percent: true } }, weakRecord).code, 'main-changed')
const leveled = { ...good, level: 1 }
const protectedResult = await createProjectionService({ simulationCount: 1000 }, [], { 芙宁娜: weakRecord }).calculate(leveled, {}, ids)
assert.equal(protectedResult.rows[0].assessment.code, 'leveled')
const without = await createProjectionService({ simulationCount: 1000 }, [], {}).calculate(good, {}, ids)
assert.equal(without.rows[0].assessment.status, 'unknown')
assert.equal(mainStatSuitability(good, weakRecord).state, 'allowed')
const exactFifteen = { ...good, mainStat: { name: '元素精通', percent: false, value: 28 } }
assert.equal(mainStatSuitability(exactFifteen, weakRecord).state, 'outside', '严格高于15%，15%本身排除')
assert.equal(mainRuleAssessment(exactFifteen, weakRecord).status, 'fodder')
const rareMain = { ...good, mainStat: { name: '水元素伤害加成', percent: true, value: 7 } }
const rejectedMain = await createProjectionService({ simulationCount: 1000 }, [], { 芙宁娜: weakRecord }).calculate(rareMain, {}, ids)
assert.equal(rejectedMain.rows[0].assessment.code, 'main-not-recommended')
assert.equal(rejectedMain.rows[0].assessment.bounds, undefined, '主词条规则排除不能伪称提升概率0%')
const brokenAndWrong = { ...rareMain, setName: '深林的记忆' }
assert.equal((await createProjectionService({}, [], { 芙宁娜: weakRecord }).calculate(brokenAndWrong, {}, ids)).rows[0].assessment.code,
  'main-not-recommended', '可靠主词条规则先排除，避免全部被拆套装待定遮盖')
const incomplete = record(); incomplete.recommendations.空之杯 = { ...recommendation, mainStats: [recommendation.mainStats[0]] }
assert.equal(mainStatSuitability(rareMain, incomplete).state, 'unknown', '仅一行70%时不能把其余缺项判作无推荐')
const absent = record(); absent.recommendations.空之杯.mainHeadingFound = false
assert.equal((await createProjectionService({}, [], { 芙宁娜: absent }).calculate(good, {}, ids)).rows[0].assessment.code, 'main-recommendation')
const aboveFifteen = record()
aboveFifteen.recommendations.空之杯.mainStats = [
  { name: '生命值', percent: true, usageRate: 69, rank: 1 }, { name: '水元素伤害加成', percent: true, usageRate: 15.1, rank: 2 },
  { name: '元素精通', percent: false, usageRate: 10, rank: 3 } ]
assert.equal(mainStatSuitability(rareMain, aboveFifteen).state, 'allowed')
assert.equal((await createProjectionService({}, [], { 芙宁娜: aboveFifteen }).calculate(rareMain, {}, ids)).rows[0].assessment.code, 'main-unpriced',
  '元素伤害不能被当作0分主属性与生命杯强行比较')
// 杯子无充能主词条；以头部暴率/暴伤进行合法跨主词条比较。
const crossHead = record(true)
crossHead.slots.理之冠.equippedArtifact = { ...baseline(true), slot: '理之冠', setName: '昔日宗室之仪' }
crossHead.recommendations.理之冠 = { ...recommendation, mainStats: [
  { name: '生命值', percent: true, usageRate: 70, rank: 1 }, { name: '暴击伤害', percent: true, usageRate: 25, rank: 2 } ] }
const crossCandidate = annotateArtifactEnhancement({ name: '测试暴伤头', slot: '理之冠', setName: '昔日宗室之仪', level: 0, warnings: [],
  mainStat: { name: '暴击伤害', percent: true, value: 9.3 }, subStats: [
    { name: '暴击率', percent: true, value: 2.7 }, { name: '生命值', percent: true, value: 4.1 },
    { name: '防御力', percent: false, value: 23 }, { name: '攻击力', percent: false, value: 19 }
  ].map((row, rowIndex) => ({ ...row, rowIndex, activation: 'active' })) })
const crossResult = await createProjectionService({ simulationCount: 1000 }, [], { 芙宁娜: crossHead }).calculate(crossCandidate, {}, ids)
assert.equal(crossResult.rows[0].assessment.comparison, 'main-and-subs')
assert.equal(crossResult.rows[0].assessment.mainChanged, true)
const linearCross = crossResult.rows[0].assessment.models[0]
const expectedBase = (23.3 / 3.89 + 7.8 / 7.77) + (2 / 3) * 46.6 / 5.83
assert.ok(Math.abs(linearCross.baselineScore - expectedBase) < 1e-8, '不同主词条必须计入现装主属性，不能只看副词条')
assert.equal(crossResult.rows[0].assessment.status, 'unknown', '两种推荐主词条缺乏清晰分布优势时待定')
const crossSands = record(true)
crossSands.slots.时之沙.equippedArtifact = { ...baseline(true), slot: '时之沙' }
crossSands.recommendations.时之沙 = { ...recommendation, mainStats: [
  { name: '生命值', percent: true, usageRate: 70, rank: 1 }, { name: '元素充能效率', percent: true, usageRate: 25, rank: 2 } ] }
const rechargeSands = annotateArtifactEnhancement({ ...crossCandidate, name: '构造充能沙', slot: '时之沙', setName: '黄金剧团',
  mainStat: { name: '元素充能效率', percent: true, value: 7.8 },
  subStats: crossCandidate.subStats.map(row => ({ ...row })) })
const crossDiscard = await createProjectionService({ simulationCount: 1000 }, [], { 芙宁娜: crossSands }).calculate(rechargeSands, {}, ids)
assert.equal(crossDiscard.rows[0].assessment.code, 'cross-main-fodder')
assert.ok(crossDiscard.rows[0].assessment.models.every(model => model.nearBaselineInterval.upper <= 0.01))
assert.equal(mainStatSuitability({ slot: '生之花', mainStat: { name: '生命值', percent: false } }, {}).state, 'fixed')
assert.equal(mainStatSuitability({ slot: '死之羽', mainStat: { name: '攻击力', percent: false } }, {}).state, 'fixed')
const badMainRecord = record(); badMainRecord.recommendations.空之杯.mainStats[0].usageRate = 170
assert.equal(mainStatSuitability(good, badMainRecord).state, 'unknown', '异常推荐比例不得触发错误主词条舍弃')
const mainCatalog = recordedCharacterCatalog({ a: aboveFifteen })
assert.equal(matchStrongboxCandidates(rareMain, mainCatalog, [], { showSetCharacters: false, showTrainingCharacters: false, matchMainStat: true }).length, 1)
const lowerCatalog = recordedCharacterCatalog({ a: weakRecord })
assert.equal(matchStrongboxCandidates(exactFifteen, lowerCatalog, [], { showSetCharacters: false, showTrainingCharacters: false, matchMainStat: true }).length, 0)
const dollRecord = record(); dollRecord.identity = { ...dollRecord.identity, displayName: '人偶A', kind: 'mannequin' }
const dollCandidates = matchStrongboxCandidates(rareMain, recordedCharacterCatalog({ a: dollRecord }), ['人偶A'],
  { showSetCharacters: false, showTrainingCharacters: true, matchMainStat: false })
const emptyRules = await createProjectionService({ simulationCount: 100 }, [], {}).calculate(rareMain, {}, [])
assert.equal(presentCandidateProjection(emptyRules, dollCandidates).rows[0].assessment.code, 'main-not-recommended',
  '可靠主词条范围排除独立于旧权重库是否存在，不伪造数值分')
const highPressure = await createProjectionService({ simulationCount: 1000, artifactCountEstimate: 2700 }, [], { 芙宁娜: weakRecord }).calculate(good, {}, ids)
assert.deepEqual(highPressure.rows[0].assessment, keep.rows[0].assessment, '满仓不强迫改变高置信保留线')
const catalog = recordedCharacterCatalog({ a: weakRecord })
const flags = { showSetCharacters: true, showTrainingCharacters: false, matchMainStat: true }
const matched = matchStrongboxCandidates(good, catalog, ['芙宁娜'], flags)
assert.equal(matched[0].selectedForTraining, true, '培养来源隐藏时，其他来源命中的已选角色仍保留培养身份')
assert.equal(presentCandidateProjection(keep, matched).rows[0].assessment.status, 'keep')

// 真实HTML验证三个颜色/标签、解释文本与静态容量提示。
const html = fs.readFileSync(new URL('../assets/strongbox-mask.html', import.meta.url), 'utf8'), elements = new Map()
const el = () => ({ style: {}, dataset: {}, children: [], value: '', replaceChildren(...children) { this.children = children }, append(child) { this.children.push(child) } })
const byId = id => { if (!elements.has(id)) elements.set(id, el()); return elements.get(id) }
const window = { innerWidth: 1920, innerHeight: 1080, addEventListener() {}, htmlMask: {} }
vm.runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], { window, document: { getElementById: byId, createElement: el } })
for (const [result, status, label] of [[keep, 'keep', '保留'], [discard, 'fodder', '舍弃'], [without, 'unknown', '待定']]) {
  const payload = { state: 'ready', artifact: good, decision: { status: 'unknown', label: '待人工判断', reasons: [] }, projection: presentCandidateProjection(result, matched),
    controls: { accountId: 'test', selected: [], flags, catalog: [], revision: 0, capacity: inventoryPressure(2600), interactive: false } }
  window.htmlMask.onMessage({ url: '/artifact', data: payload })
  const block = byId('projection-list').children[0], badge = block.children[0].children[0].children[1]
  assert.equal(badge.textContent, label); assert.equal(badge.dataset.status, status)
  assert.equal(block.dataset.assessment, status)
  assert.ok(block.children[2].textContent)
  assert.ok(byId('capacity').textContent.includes('2600 / 2700'))
  assert.equal(byId('capacity').dataset.level, 'high')
  assert.equal(byId('count-' + status).textContent, '1')
  assert.ok(byId('summary-scope').textContent.includes('非整件最终结论'))
}
console.log('通过：容量边界、秩权重单位、Wilson少样本保护、三模型保留/舍弃/分歧、真实模拟、套装4件/2+2/散件约束、未知/过期/低级现装保护、三色标签和综合结论保护。')
