import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { recordedCharacterCatalog, matchStrongboxCandidates, presentCandidateProjection, createStrongboxSession } from '../utils/strongbox-candidates.js'
import { createProjectionService } from '../utils/artifact-projection.js'
import { annotateArtifactEnhancement } from '../utils/artifact-enhancement.js'
import { createMaskInteraction } from '../utils/mask-interaction.js'
import { accountFileName } from '../utils/account-store.js'

const record = (name, element, count, usageRate, main = '生命值') => ({
  identity: { displayName: name, element, verified: true }, slots: {},
  setRecommendations: { rows: [{ status: 'ok', rank: 1, usageRate, components: [{ setName: '黄金剧团', count }] }] },
  recommendations: { 空之杯: { status: 'ok', mainHeadingFound: true, mainStats: [{ name: main, percent: true, rank: 1, usageRate: 70 }] } }
})
const records = { furina: record('芙宁娜', '水', 4, 60), nahida: record('纳西妲', '草', 2, 95),
  chiori: record('千织', '岩', 4, 85, '防御力'), jean: record('琴', '风', 4, 9),
  doll: record('人偶A', '冰', 4, 75) }
const catalog = recordedCharacterCatalog(records)
assert.deepEqual(catalog.map(row => row.element), ['水', '风', '草', '冰', '岩'])
assert.equal(catalog.find(row => row.name === '人偶A').profileIds.length, 0)
const artifact = annotateArtifactEnhancement({ slot: '空之杯', level: 0, setName: '黄金剧团',
  mainStat: { name: '生命值', percent: true, value: 7 }, warnings: [],
  subStats: [['暴击率', 3.1], ['暴击伤害', 7.8], ['攻击力', 4.7], ['元素充能效率', 5.8]]
    .map(([name, value], rowIndex) => ({ name, value, rowIndex, percent: true, activation: 'active' })) })
const flags = { showSetCharacters: true, showTrainingCharacters: true, matchMainStat: false }
let candidates = matchStrongboxCandidates(artifact, catalog, ['芙宁娜', '琴'], flags)
assert.equal(candidates.length, 5)
assert.equal(candidates.filter(row => row.name === '芙宁娜').length, 1, '来源重叠只出现一位候选')
assert.equal(candidates.find(row => row.name === '芙宁娜').training, true)
const service = createProjectionService({ simulationCount: 100, returnAllRows: true })
const ids = candidates.flatMap(row => row.profileIds)
let result = await service.calculate(artifact, {}, ids)
const presented = presentCandidateProjection(result, candidates)
assert.deepEqual(presented.rows.map(row => row.name), ['千织', '人偶A', '芙宁娜', '纳西妲', '琴'], '四件套优先，组内使用率降序，再两件套，然后培养角色')
assert.equal(presented.rows[1].scoreUnavailable, true, '新角色缺权重仍展示候选，不伪造分数')
assert.ok(!Object.hasOwn(presented.rows[0], 'potentialMax'))
assert.equal(presentCandidateProjection({ state: 'blocked', message: '词条需核对', rows: [] }, [candidates.find(row => row.name === '人偶A')]).state,
  'blocked', '缺少权重的角色不能绕过圣遗物输入校验')
const onlyTraining = matchStrongboxCandidates(artifact, catalog, ['琴'], { ...flags, showSetCharacters: false })
assert.deepEqual(onlyTraining.map(row => row.name), ['琴'])
assert.equal(matchStrongboxCandidates(artifact, catalog, ['琴'], { ...flags, showSetCharacters: false, showTrainingCharacters: false }).length, 0)
const mainOnly = { showSetCharacters: false, showTrainingCharacters: false, matchMainStat: true }
assert.ok(matchStrongboxCandidates(artifact, catalog, [], mainOnly).some(row => row.name === '芙宁娜'))
assert.ok(!matchStrongboxCandidates(artifact, catalog, [], mainOnly).some(row => row.name === '千织'))
assert.equal(matchStrongboxCandidates({ ...artifact, mainStat: { ...artifact.mainStat, percent: false } }, catalog, [], mainOnly).length, 0)
assert.equal(matchStrongboxCandidates({ ...artifact, slot: '生之花' }, catalog, [], mainOnly).length, 0)
assert.equal(matchStrongboxCandidates({ ...artifact, slot: '时之沙' }, catalog, [], mainOnly).length, 0, '不把杯子推荐拿来给沙匹配')
assert.equal(matchStrongboxCandidates(artifact, recordedCharacterCatalog({ bad: { ...records.furina,
  setRecommendations: { rows: [{ ...records.furina.setRecommendations.rows[0], status: 'name_error' }] } } }), [], flags).length, 0)
assert.equal(service.cached(artifact, ids), result)
assert.equal(service.cached(artifact, ['default:芙宁娜']), null, '候选改变不能沿用旧缓存')
const single = await service.calculate(artifact, {}, ['default:芙宁娜'])
assert.equal(single.rows[0].top20, result.rows.find(row => row.name === '芙宁娜').top20, '改变来源不能改变同一件模拟样本')
assert.equal(single.rows[0].top80, result.rows.find(row => row.name === '芙宁娜').top80)
assert.equal((await service.calculate(artifact, {}, [])).simulatedProfiles, 0, '全部关闭不回退全角色库')
assert.equal((await service.calculate(artifact)).rows.length, 127, '滚动列表不再截断五行')

const files = new Map()
files.set('assets/character-search.json', fs.readFileSync(new URL('../assets/character-search.json', import.meta.url), 'utf8'))
const io = { isExists: path => files.has(path), readTextSync: path => files.get(path), writeTextSync: (path, value) => { files.set(path, value); return true } }
files.set(accountFileName('test').path, JSON.stringify({ schemaVersion: 1, accountId: 'test', revision: 1, characters: records }))
const session = createStrongboxSession({ userIdentifier: 'test' }, [], io)
assert.equal(session.controls().catalog.length, 5)
session.update({ characters: ['芙宁娜'], flags })
assert.deepEqual(createStrongboxSession({ userIdentifier: 'test' }, [], io).controls().selected, ['芙宁娜'])
session.update({ characters: [], flags: mainOnly })
assert.deepEqual(createStrongboxSession({ userIdentifier: 'test' }, [], io).controls().selected, [])
assert.throws(() => session.update({ characters: ['迪卢克'], flags }), /已录入/)
assert.throws(() => session.update({ characters: [], flags: {} }), /格式/)
assert.equal(createStrongboxSession({ userIdentifier: 'other' }, [], io).controls().catalog.length, 0)
assert.equal(session.controls().flags.respectExistingSets, true)
session.update({ characters: [], flags: { ...mainOnly, respectExistingSets: false } })
assert.equal(session.controls().flags.respectExistingSets, false)
session.update({ characters: [], flags: mainOnly })
assert.equal(session.controls().flags.respectExistingSets, false, '旧消息未携带选项时不覆盖本次设置')
assert.throws(() => session.update({ characters: [], flags: { ...mainOnly, respectExistingSets: 'false' } }), /格式/)

let hook, released = 0
class Hook { constructor() { hook = this } onKeyDown(fn) { this.down = fn } onKeyUp(fn) { this.up = fn } dispose() { released++ } }
const modes = []
const interaction = createMaskInteraction('mask', { exists: () => true, setClickThrough: (id, value) => modes.push(value) }, Hook)
hook.down('F7'); hook.down('F7'); assert.equal(interaction.interactive, true, '长按只切一次')
hook.up('F7'); hook.down({ keyCode: 118 }); assert.equal(interaction.interactive, false)
assert.deepEqual(modes, [true, false, true]); interaction.dispose(); assert.equal(released, 1)

// 执行真实HTML脚本，验证筛选通信和每轮推送不会覆盖尚未确认的本地勾选。
const html = fs.readFileSync(new URL('../assets/strongbox-mask.html', import.meta.url), 'utf8')
const elements = new Map(), posted = []
const element = () => ({ style: {}, dataset: {}, value: '', scrollTop: 0,
  replaceChildren(...children) { this.children = children }, append(child) { this.children.push(child) } })
const byId = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id) }
const window = { innerWidth: 1920, innerHeight: 1080, addEventListener() {}, htmlMask: {}, chrome: { webview: { postMessage: message => posted.push(JSON.parse(message)) } } }
vm.runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], { window, document: { getElementById: byId, createElement: element } })
const controls = session.controls()
const payload = { state: 'waiting', controls: { ...controls, revision: 10 }, showRegion: false }
window.htmlMask.onMessage({ url: '/artifact', data: payload })
assert.equal(byId('character-list').children.length, 5)
assert.equal(byId('show-set').checked, false)
assert.equal(byId('respect-sets').checked, false)
byId('respect-sets').checked = true; byId('respect-sets').onchange()
assert.equal(posted.at(-1).data.flags.respectExistingSets, true)
assert.equal(byId('set-limit-note').hidden, true)
byId('respect-sets').checked = false; byId('respect-sets').onchange()
assert.equal(posted.at(-1).data.flags.respectExistingSets, false)
assert.equal(byId('set-limit-note').hidden, false)
byId('show-set').checked = true; byId('show-set').onchange()
assert.equal(posted.at(-1).url, '/strongbox/filter')
assert.equal(posted.at(-1).data.flags.showSetCharacters, true)
window.htmlMask.onMessage({ url: '/artifact', data: payload })
assert.equal(byId('show-set').checked, true, '同revision推送不覆盖本地操作')
byId('return-game').onclick(); assert.equal(posted.at(-1).url, '/strongbox/game')
byId('character-search').value = '芙'; byId('character-search').oninput()
assert.equal(byId('character-list').children.length, 1)
for (const query of ['naxida', 'NXD', 'na xi da', 'nàxīdá']) {
  byId('character-search').value = query; byId('character-search').oninput()
  assert.equal(byId('character-list').children.length, 1, query)
  assert.equal(byId('character-list').children[0].children[1].children[0].children[1].textContent, '纳西妲')
}
byId('character-search').value = ''; byId('character-search').oninput()
byId('element-tabs').children.find(button => button.textContent === '水').onclick()
assert.equal(byId('character-list').children.length, 1)
assert.ok(byId('character-list').children[0].children[0].textContent.startsWith('水元素'))
assert.equal(byId('character-picker').hidden, true)
byId('character-summary').onclick(); assert.equal(byId('character-picker').hidden, false)
byId('close-character-picker').onclick(); assert.equal(byId('character-picker').hidden, true)
byId('character-summary').onclick()
window.htmlMask.onMessage({ url: '/interaction', data: { interactive: false } })
assert.equal(byId('character-picker').hidden, true, 'F7切回游戏时立即收起遮挡详情的选人面板')
assert.equal(recordedCharacterCatalog({ traveler: { identity: { kind: 'traveler', displayName: '旅行者', element: '冰' } } })[0].profileIds[0], 'default:旅行者:cryo')

// 真实入口整轮：动态筛选改变缓存；交互时暂停截图；离开交互后恢复；退出释放热键。
const token = { isCancellationRequested: false }, queue = [], payloads = []
let interactive = false, ticks = 0, reads = 0, disposed = 0, closed = 0, calculations = 0
const main = fs.readFileSync(new URL('../main.js', import.meta.url), 'utf8').replace(/^import .* from .*\r?\n/gm, '')
await vm.runInNewContext(main, {
  settings: { userIdentifier: 'test', simulationCount: 100 },
  setGameMetrics() {}, dispatcher: { getLinkedCancellationToken: () => token },
  createRunLogger: () => ({ event() {}, finish() {} }),
  createStrongboxSession: options => createStrongboxSession(options, [], io), presentCandidateProjection,
  loadProjectionProfiles: () => [], loadDecisionDatabase: () => ({}), evaluateArtifact: () => ({ label: '待人工判断', status: 'unknown', reasons: [] }),
  createProjectionService: (...args) => {
    const service = createProjectionService(...args), calculate = service.calculate
    return { ...service, calculate: (...params) => { calculations++; return calculate(...params) } }
  },
  createMaskInteraction: () => ({ get interactive() { return interactive }, setInteractive(value) { interactive = value }, dispose() { disposed++ } }),
  readSnapshot: () => { reads++; return { artifact, onStrongboxPage: true, markerText: '还圣奥迹', rawText: 'test' } },
  REGIONS: { detail: [984, 182, 492, 818] },
  htmlMask: { show: () => 'main', exists: () => true, poll: () => queue.shift() || null,
    send: (id, url, payload) => payloads.push(JSON.parse(payload)), close: () => { closed++ } },
  log: { info() {}, error() {} },
  sleep: async ms => {
    if (ms === 200 || ms === 1) return
    ticks++
    if (ticks === 1) {
      interactive = true
      queue.push(JSON.stringify({ url: '/strongbox/filter', data: { characters: [], flags: { showSetCharacters: false, showTrainingCharacters: false, matchMainStat: false } } }))
    }
    if (ticks === 2) queue.push(JSON.stringify({ url: '/strongbox/filter', data: { characters: ['芙宁娜'], flags: { ...flags, showSetCharacters: false } } }))
    if (ticks === 3) queue.push(JSON.stringify({ url: '/strongbox/filter', data: { characters: ['芙宁娜'], flags: { ...flags, showSetCharacters: false, respectExistingSets: false } } }))
    if (ticks === 4) queue.push(JSON.stringify({ url: '/strongbox/game' }))
    if (ticks === 5) token.isCancellationRequested = true
  }
})
assert.equal(reads, 2, '交互期间保留同一件截图，返回游戏后恢复识别')
assert.equal(calculations, 4, '候选与套装约束切换需要重新计算，不变条件使用缓存')
assert.deepEqual(Array.from(payloads.at(-1).projection.rows, row => row.name), ['芙宁娜'])
assert.equal(payloads.at(-1).controls.interactive, false)
assert.equal(payloads.at(-1).controls.flags.respectExistingSets, false)
assert.equal(payloads.at(-1).projection.respectExistingSets, false, '真实入口将开关传入计算服务')
assert.equal(disposed, 1); assert.equal(closed, 1)
console.log('通过：录入推荐候选、4件/2件使用率排序、三来源并集、按部位与单位匹配、动态缓存、完整滚动列表、空选择/账号隔离、F7及HTML交互。')
