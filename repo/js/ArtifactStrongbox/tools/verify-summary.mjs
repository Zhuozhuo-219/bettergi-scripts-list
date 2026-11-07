import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { summarizeCharacterAssessments, presentCandidateProjection } from '../utils/strongbox-candidates.js'
const row = (name, id, status, code) => ({ name, id, label: '通用', assessment: { status, code, label: status === 'keep' ? '保留' : status === 'fodder' ? '舍弃' : '待定', reason: '测试' } })
const rows = [row('A', 'a1', 'fodder'), row('A', 'a2', 'keep'), row('B', 'b1', 'fodder'), row('B', 'b2', 'unknown'),
  row('C', 'c1', 'fodder'), row('D', 'd1', 'fodder')]
const candidates = [{ name: 'A', profileIds: ['a1', 'a2'] }, { name: 'B', profileIds: ['b1', 'b2'] },
  { name: 'C', profileIds: ['c1'] }, { name: 'D', profileIds: ['d1', 'd2'] }]
const summary = summarizeCharacterAssessments(rows, candidates)
assert.deepEqual({ keep: summary.keep, fodder: summary.fodder, unknown: summary.unknown, total: summary.total }, { keep: 1, fodder: 1, unknown: 2, total: 4 })
assert.equal(summary.characters.find(row => row.name === 'D').status, 'unknown', '某分支失败不得把该角色计入全舍弃')
assert.equal(summarizeCharacterAssessments([row('D', 'd1', 'fodder', 'main-not-recommended')], [candidates[3]]).fodder, 1,
  '可靠主词条范围排除不依赖评分分支')
assert.equal(summarizeCharacterAssessments([{ name: 'unknown' }]).unknown, 1)
assert.equal(summarizeCharacterAssessments([]).total, 0)
assert.equal(presentCandidateProjection({ state: 'blocked', message: '识别错误', rows: [] }, []).assessmentSummary, null)
assert.equal(presentCandidateProjection({ state: 'blocked', modelVersion: 'test', rows: [] }, []).assessmentSummary.total, 0)

const html = fs.readFileSync(new URL('../assets/strongbox-mask.html', import.meta.url), 'utf8'), elements = new Map()
const el = () => ({ style: {}, dataset: {}, value: '', children: [], replaceChildren(...children) { this.children = children }, append(child) { this.children.push(child) } })
const byId = id => { if (!elements.has(id)) elements.set(id, el()); return elements.get(id) }
const window = { innerWidth: 1920, innerHeight: 1080, addEventListener() {}, htmlMask: {} }
vm.runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], { window, document: { getElementById: byId, createElement: el } })
const payload = { state: 'ready', artifact: { name: '测试', slot: '空之杯', setName: '测试', level: 0, mainStat: { name: '生命值', value: 7, percent: true },
  subStats: [], warnings: [] }, decision: { label: '待人工判断', reasons: [] }, projection: { state: 'ready', rows, sampleCount: 1000, assessmentSummary: summary } }
window.htmlMask.onMessage({ url: '/artifact', data: payload })
assert.equal(byId('count-fodder').textContent, '1'); assert.equal(byId('count-unknown').textContent, '2'); assert.equal(byId('count-keep').textContent, '1')
assert.ok(byId('summary-scope').textContent.includes('4 位角色'))
window.htmlMask.onMessage({ url: '/artifact', data: { ...payload, projection: { state: 'computing', rows: [] } } })
assert.equal(byId('count-keep').textContent, '—', '换件重算时不得沿用旧计数')
window.htmlMask.onMessage({ url: '/artifact', data: { ...payload, projection: { state: 'blocked', message: '无候选', rows: [], assessmentSummary: summarizeCharacterAssessments([]) } } })
assert.equal(byId('count-keep').textContent, '0')
assert.equal(byId('summary-scope').textContent, '本次无分析角色')
window.htmlMask.onMessage({ url: '/artifact', data: { ...payload, state: 'waiting', projection: null } })
assert.equal(byId('count-fodder').textContent, '—')
assert.equal(byId('result').hidden, true)
console.log('通过：三色角色去重计数、多分支/失败分支、主词条排除、无候选/未完成/离开界面清理与HTML显示。')
