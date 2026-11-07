// 离线校验仅使用 Node 内置模块，BGI 运行时不会加载本文件。
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { parseArtifact, readSnapshot, REGIONS } from '../utils/artifact-reader.js'
import { evaluateArtifact, loadDecisionDatabase } from '../utils/artifact-decision.js'
import { estimateSubStatRolls, getEnhancementProgress, getSubStatKey } from '../utils/artifact-enhancement.js'
import { createProjectionService, loadProjectionProfiles } from '../utils/artifact-projection.js'

const root = new URL('../', import.meta.url)
const read = path => readFileSync(new URL(path, root), 'utf8')
const manifest = JSON.parse(read('manifest.json'))
for (const path of [manifest.main, manifest.settings_ui, 'assets/strongbox-mask.html']) {
  assert.ok(existsSync(new URL(path, root)), `缺少文件 ${path}`)
}
const settings = JSON.parse(read(manifest.settings_ui))
assert.equal(new Set(settings.map(item => item.name)).size, settings.length)

// 根据用户截图手工构建 OCR 输出；这不是实际 OCR 测试。
function item(text, x, y, width = 170, height = 26) {
  return { text, x, y, width, height, isExist: () => true }
}
const sample = [
  item('黄金之夜的喧器', 1013, 195, 380, 36),
  item('空之杯', 1013, 252), item('生命值', 1013, 335),
  item('7.0％', 1013, 365, 160, 40), item('+0', 1013, 491, 55),
  item('· 生命值', 1020, 543), item('+209', 1210, 543, 75),
  item('· 暴击率+3.1%', 1020, 582, 270),
  item('· 元素充能效率+5.8%', 1020, 621, 350),
  item('· 攻击力+18', 1020, 660, 185), item('（待激活）', 1210, 660),
  item('黄金剧团：', 1013, 700),
  item('2件套：元素战技造成的伤害提升20%', 1013, 740, 440)
]
const artifact = parseArtifact(sample)
assert.equal(artifact.slot, '空之杯')
assert.equal(artifact.mainStat.value, 7)
assert.equal(artifact.mainStat.percent, true)
assert.equal(artifact.level, 0)
assert.equal(artifact.setName, '黄金剧团')
assert.equal(artifact.subStats.length, 4)
assert.equal(artifact.subStats[0].value, 209)
assert.equal(artifact.subStats[0].percent, false)
assert.equal(artifact.subStats[1].percent, true)
assert.equal(artifact.subStats[3].pending, true)
assert.equal(artifact.subStats[3].activation, 'pending')
assert.equal(artifact.fourthSubStat.state, 'pending')
assert.equal(artifact.fourthSubStat.source, 'ocr-marker')
assert.equal(artifact.fourthSubStat.initialCount, 3)
assert.deepEqual(artifact.warnings, [])
assert.equal(artifact.enhancement.remainingActivationCount, 1)
assert.equal(artifact.enhancement.remainingUpgradeCount, 4)
assert.equal(artifact.subStats[0].rollEstimate.upgradeCount, 0)
assert.equal(artifact.subStats[3].rollEstimate, null, '待激活值不能当作已发生强化')
assert.ok(parseArtifact([]).warnings.length)
const incomplete = parseArtifact(sample.filter(row => row.text !== '+209'))
assert.ok(incomplete.warnings.some(message => message.includes('副词条')))
assert.equal(incomplete.fourthSubStat.initialCount, null, '缺少词条数值时不确认初始三条')
const noMarker = parseArtifact(sample.filter(row => row.text !== '（待激活）'))
assert.equal(noMarker.subStats.length, 4)
assert.equal(noMarker.subStats[3].pending, false)
assert.equal(noMarker.subStats[3].activation, 'active')
assert.equal(noMarker.fourthSubStat.initialCount, 4)
assert.equal(noMarker.fourthSubStat.state, 'active')
assert.equal(noMarker.fourthSubStat.source, 'complete-rows-no-marker')
// 新提供的初始四条截图：同时包含固定攻击和百分比攻击。
const fourStatSample = sample.filter(row => !((row.y >= 535 && row.y < 692) || row.text === '生命值'))
fourStatSample.push(item('岩元素伤害加成', 1013, 335, 230))
fourStatSample.push(item('元素充能效率+5.2%', 1020, 543, 350))
fourStatSample.push(item('防御力+19', 1020, 582))
fourStatSample.push(item('攻击力+4.7%', 1020, 621))
fourStatSample.push(item('攻击力+16', 1020, 660))
const fourStatArtifact = parseArtifact(fourStatSample.sort((a, b) => a.y - b.y || a.x - b.x))
assert.equal(fourStatArtifact.mainStat.name, '岩元素伤害加成')
assert.equal(fourStatArtifact.fourthSubStat.initialCount, 4)
assert.equal(fourStatArtifact.subStats[2].percent, true)
assert.equal(fourStatArtifact.subStats[3].percent, false)
assert.equal(fourStatArtifact.subStats[3].value, 16)
assert.equal(fourStatArtifact.subStats[3].activation, 'active')
assert.equal(fourStatArtifact.enhancement.remainingActivationCount, 0)
assert.equal(fourStatArtifact.enhancement.remainingUpgradeCount, 5)
assert.equal(getSubStatKey(fourStatArtifact.subStats[2]), 'atk')
assert.equal(getSubStatKey(fourStatArtifact.subStats[3]), 'atkPlus')
const noFourth = parseArtifact(sample.filter(row => row.y !== 660))
assert.equal(noFourth.subStats.length, 3)
assert.equal(noFourth.fourthSubStat.initialCount, null, '只有三行不推断第四条状态')
const upgraded = parseArtifact(sample.map(row => row.text === '+0' ? { ...row, text: '+4' } : row))
assert.equal(upgraded.fourthSubStat.state, 'pending')
assert.equal(upgraded.fourthSubStat.initialCount, null, '非 +0 不推断初始词条数')
const upgradedFour = parseArtifact(fourStatSample.map(row => row.text === '+0' ? { ...row, text: '+4' } : row))
assert.equal(upgradedFour.fourthSubStat.state, 'active')
assert.equal(upgradedFour.fourthSubStat.initialCount, null, '已强化四条不反推初始四条')
const missingFirstRow = parseArtifact(sample.filter(row => row.y !== 543))
assert.equal(missingFirstRow.fourthSubStat.initialCount, null)
assert.equal(missingFirstRow.subStats[0].activation, 'unknown', '缺行后不把行号当成完整布局证据')

// 节点边界、非整四级及满级终态，不用词条次数估算决定剩余次数。
for (let level = 0; level <= 20; level++) {
  const progress = getEnhancementProgress(level, fourStatArtifact.subStats)
  assert.equal(progress.remainingNodeCount, 5 - Math.floor(level / 4))
  assert.equal(progress.remainingUpgradeCount, 5 - Math.floor(level / 4))
  assert.equal(progress.remainingActivationCount, 0)
  assert.ok(progress.remainingNodes.every(node => node > level))
}
assert.equal(getEnhancementProgress(3, artifact.subStats).remainingUpgradeCount, 4)
assert.equal(upgraded.enhancement.consistent, false, '+4 仍待激活是状态矛盾，不能照常预测')
assert.equal(upgraded.enhancement.remainingUpgradeCount, null)
assert.equal(getEnhancementProgress(null, []), null)
assert.equal(getEnhancementProgress(21, []), null)
assert.equal(estimateSubStatRolls('cpct', 999), null)
assert.equal(estimateSubStatRolls('cpct', 7, 1), null, '+0 不能匹配成已命中两次')
assert.equal(estimateSubStatRolls('cpct', 14).ambiguous, true, '取整后可能对应多个次数')
const maxedSample = fourStatSample.filter(row => row.y < 535 || row.y >= 692)
  .map(row => row.text === '+0' ? { ...row, text: '+20' } : row)
maxedSample.push(item('暴击率+23.3%', 1020, 543, 280))
maxedSample.push(item('暴击伤害+7.8%', 1020, 582, 280))
maxedSample.push(item('元素充能效率+5.8%', 1020, 621, 350))
maxedSample.push(item('生命值+209', 1020, 660))
const maxedArtifact = parseArtifact(maxedSample.sort((a, b) => a.y - b.y))
assert.equal(maxedArtifact.level, 20)
assert.equal(maxedArtifact.enhancement.remainingNodeCount, 0)
assert.equal(maxedArtifact.enhancement.remainingUpgradeCount, 0)
assert.equal(maxedArtifact.enhancement.selectionProbabilities, null)
assert.equal(maxedArtifact.subStats[0].rollEstimate.upgradeCount, 5)
assert.equal(maxedArtifact.subStats[0].rollEstimate.count, 6)
assert.deepEqual(maxedArtifact.warnings, [])
// 可选对照：工作区有原脚本时验证移植算法与原实现的估算次数一致。
const referenceUrl = new URL('../ArtifactScore/utils/artis-score-utils.js', root)
if (existsSync(referenceUrl)) {
  const reference = await import(referenceUrl.href)
  for (const [key, value] of [['hpPlus', 478], ['atk', 10.5], ['cpct', 7],
    ['cpct', 23.3], ['cdmg', 15.5], ['recharge', 11.7], ['mastery', 42], ['defPlus', 39]]) {
    assert.equal(estimateSubStatRolls(key, value).count, reference.estimateSubStatRolls(key, value).count)
  }
}

globalThis.file = { readTextSync: read }
const database = loadDecisionDatabase()
assert.equal(evaluateArtifact(artifact, database).status, 'unknown')
assert.equal(evaluateArtifact(artifact, { rules: [{}] }).status, 'unknown')
globalThis.file = { readTextSync: () => '{"schemaVersion":2,"rules":[]}' }
assert.throws(loadDecisionDatabase, /格式错误/)
globalThis.file = { readTextSync: read }

globalThis.RecognitionObject = { Ocr: (...rect) => rect }
let captures = 0
let disposals = 0
let failOcr = false
let size = [1920, 1080]
let marker = true
globalThis.captureGameRegion = () => {
  captures++
  return {
    width: size[0], height: size[1],
    findMulti: region => {
      if (failOcr) throw new Error('模拟 OCR 故障')
      const rows = region[0] === REGIONS.detail[0] ? sample
        : marker ? [item('还圣奥迹', 1700, 1000)] : []
      return Object.assign([...rows], { count: rows.length })
    },
    dispose: () => { disposals++ }
  }
}
assert.equal(readSnapshot().onStrongboxPage, true)
assert.equal(captures, 1, '每轮应仅截图一次')
assert.equal(disposals, captures)
failOcr = true
assert.throws(readSnapshot, /OCR 故障/)
assert.equal(disposals, captures, 'OCR 异常也应释放截图')
failOcr = false
size = [1280, 720]
assert.throws(readSnapshot, /1280×720/)
assert.equal(disposals, captures, '不支持的尺寸也应释放截图')
size = [1920, 1080]

// 在隔离上下文执行原入口，注入真实模块函数与 BGI 模拟宿主。
const main = read('main.js').replace(/^import .* from .*\r?\n/gm, '')
const token = { isCancellationRequested: false }
const messages = []
let closes = 0
let sleeps = 0
const context = {
  createRunLogger: () => ({ path: 'test-run', event() {}, finish() {} }),
  resolveTrainingCharacters: async () => ({ characters: ['芙宁娜'], profileIds: ['default:芙宁娜'] }),
  createStrongboxSession: () => ({ controls: () => ({ accountId: 'test', catalog: [], selected: [], revision: 0,
    flags: { showSetCharacters: true, showTrainingCharacters: true, matchMainStat: false } }),
    candidates: () => [{ name: '芙宁娜', profileIds: ['default:芙宁娜'], training: true }], update() {} }),
  presentCandidateProjection: value => value,
  createMaskInteraction: () => ({ interactive: false, setInteractive() {}, dispose() {} }),
  REGIONS, readSnapshot, evaluateArtifact, loadDecisionDatabase, createProjectionService, loadProjectionProfiles,
  setGameMetrics: () => {}, settings: { simulationCount: 100 },
  dispatcher: { getLinkedCancellationToken: () => token },
  htmlMask: {
    show: () => 'test-window', exists: () => true,
    setClickThrough: (id, enabled) => assert.equal(enabled, true),
    poll: () => null,
    send: (id, url, data) => messages.push(JSON.parse(data)),
    close: () => { closes++ }
  },
  sleep: async milliseconds => {
    if (milliseconds === 1) return
    sleeps++
    if (sleeps === 2) marker = false
    if (sleeps === 3) token.isCancellationRequested = true
  },
  log: { info: () => {}, error: () => {} }
}
await vm.runInNewContext(main, context)
assert.equal(messages.length, 2)
assert.equal(messages[0].state, 'ready')
assert.equal(messages[0].decision.status, 'unknown')
assert.equal(messages[0].projection.state, 'computing')
assert.equal(messages[0].showRegion, false)
assert.equal('rawText' in messages[0], false, '不向遮罩发送原始 OCR')
assert.equal('markerText' in messages[0], false)
assert.equal(messages[1].state, 'waiting')
assert.equal(messages[1].artifact, null, '界面切换后不得保留上一件数据')
assert.equal(messages[1].decision, null)
assert.equal(messages[1].projection, null)
assert.equal(closes, 1)
assert.equal(disposals, captures)
token.isCancellationRequested = false
failOcr = true
await assert.rejects(vm.runInNewContext(main, { ...context }), /OCR 故障/)
assert.equal(closes, 2, '运行故障后也应关闭遮罩')
assert.equal(disposals, captures)
failOcr = false

// 同一件至少重新截图确认一轮后才展示结果；稳定输入不重复计算。
const stableToken = { isCancellationRequested: false }
const stableMessages = []
let stableSleeps = 0
let calculations = 0
marker = true
await vm.runInNewContext(main, {
  ...context,
  dispatcher: { getLinkedCancellationToken: () => stableToken },
  createProjectionService: (...args) => {
    const service = createProjectionService(...args)
    const calculate = service.calculate.bind(service)
    service.calculate = (...params) => { calculations++; return calculate(...params) }
    return service
  },
  htmlMask: { ...context.htmlMask, send: (id, url, value) => stableMessages.push(JSON.parse(value)) },
  sleep: async milliseconds => {
    if (milliseconds === 1) return
    stableSleeps++
    if (stableSleeps === 3) marker = false
    if (stableSleeps === 4) stableToken.isCancellationRequested = true
  }
})
assert.equal(stableMessages.length, 3)
assert.equal(stableMessages[0].projection.state, 'computing')
assert.equal(stableMessages[1].projection.state, 'ready')
assert.equal(stableMessages[2].projection, null)
assert.equal(calculations, 1)

// 验证 HTML 消息桥接、状态展示和结果清空，不替代真实 WebView2 视觉验证。
const html = read('assets/strongbox-mask.html')
assert.equal(html.includes('id="raw"'), false)
assert.equal(settings.some(item => item.name === 'showRawOcr'), false)
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1]
const elements = new Map()
const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map(match => match[1]))
function element() {
  return { style: {}, dataset: {}, hidden: false, textContent: '',
    replaceChildren(...children) { this.children = children } }
}
const window = { innerWidth: 1920, innerHeight: 1080,
  addEventListener: () => {}, htmlMask: {} }
vm.runInNewContext(script, {
  window, document: {
    getElementById(id) {
      assert.ok(ids.has(id), `HTML 中不存在元素 ${id}`)
      if (!elements.has(id)) elements.set(id, element())
      return elements.get(id)
    },
    createElement: element
  }
})
window.htmlMask.onMessage({ url: '/artifact', data: { data: messages[0] } })
assert.equal(elements.get('result').hidden, false)
assert.equal(elements.get('count-fodder').textContent, '—')
assert.equal(elements.get('count-unknown').textContent, '—')
assert.equal(elements.get('count-keep').textContent, '—')
assert.equal(elements.get('subs').children.length, 4)
assert.equal(elements.get('subs').children[3].className, 'stat-row pending')
assert.equal(elements.get('subs').children[3].children[1].textContent, '+18 待激活')
assert.equal(elements.get('initial-count').textContent, '初始三词条')
window.htmlMask.onMessage({ url: '/artifact', data: {
  ...messages[0], artifact: { ...noMarker, name: '<img src=x onerror=alert(1)>' }
} })
assert.equal(elements.get('initial-count').textContent, '初始四词条')
assert.equal(elements.get('fourth-detail').textContent, '第 4 条已生效')
assert.equal(elements.get('subs').children[3].children[1].textContent, '+18')
assert.equal(elements.get('subs').children[3].className, 'stat-row active')
assert.equal(elements.get('name').textContent, '<img src=x onerror=alert(1)>')
window.htmlMask.onMessage({ url: '/artifact', data: { ...messages[0], artifact: fourStatArtifact } })
assert.equal(elements.get('initial-count').textContent, '初始四词条')
assert.equal(elements.get('subs').children[3].children[1].textContent, '+16')
assert.equal(elements.get('name').className, '')
assert.equal(elements.get('level-warning').hidden, true)
window.htmlMask.onMessage({ url: '/artifact', data: { ...messages[0], artifact: maxedArtifact } })
assert.equal(elements.get('name').className, 'leveled', '+20 名称必须使用红色样式')
assert.equal(elements.get('level-warning').hidden, false)
assert.equal(elements.get('subs').children[0].children[0].children[1].textContent, '≈5次')
assert.equal(elements.get('enhancement').textContent, '已满级 · 无剩余强化次数')
for (const level of [1, 4, 8, 12, 16, 19]) {
  window.htmlMask.onMessage({ url: '/artifact', data: {
    ...messages[0], artifact: { ...fourStatArtifact, level }
  } })
  assert.equal(elements.get('name').className, 'leveled', `+${level} 名称也必须使用红色样式`)
}
window.htmlMask.onMessage({ url: '/artifact', data: { ...messages[0], artifact } })
assert.equal(elements.get('name').className, '', '切回 +0 必须移除红名')
assert.equal(elements.get('level-warning').hidden, true)
assert.ok(elements.get('enhancement').textContent.includes('先激活第 4 条，再增量 4 次'))
const projectionForUi = await createProjectionService({ simulationCount: 100 }).calculate(artifact)
window.htmlMask.onMessage({ url: '/artifact', data: { ...messages[0], projection: projectionForUi } })
assert.equal(elements.get('projection-head').hidden, false)
assert.equal(elements.get('projection-list').children.length, 5)
const firstProjectionRow = elements.get('projection-list').children[0]
assert.equal(firstProjectionRow.children[0].children[1].textContent, projectionForUi.rows[0].top20.toFixed(1))
assert.equal(firstProjectionRow.children[0].children[2].textContent, projectionForUi.rows[0].top80.toFixed(1))
assert.equal(firstProjectionRow.children[0].children.length, 3)
assert.ok(!html.includes('潜在最高') && !html.includes('最高分分配'), '不再显示理论最高分与分配')
window.htmlMask.onMessage({ url: '/artifact', data: { ...messages[0], projection: { state: 'blocked', message: '需核对', rows: [] } } })
assert.equal(elements.get('projection-list').children.length, 0)
assert.equal(elements.get('projection-head').hidden, true)
assert.equal(elements.get('projection-status').textContent, '需核对')
window.htmlMask.onMessage({ url: '/artifact', data: JSON.stringify({
  ...messages[1], rawText: '<img src=x onerror=alert(1)>'
}) })
assert.equal(elements.get('result').hidden, true)
assert.equal(elements.get('name').textContent, '')
assert.equal(elements.get('subs').children.length, 0)
assert.equal(elements.get('initial-count').textContent, '')
assert.equal(elements.get('level-warning').hidden, true)
assert.equal(elements.get('enhancement').textContent, '')
assert.equal(elements.get('projection-list').children.length, 0)
assert.equal(elements.get('projection-note').textContent, '')
assert.equal(elements.get('region').style.left, '982px')
console.log(`通过：配置、两类截图解析、原算法次数对照、0～20 级节点、非零等级红名、满级终态、次数角标、消息清理和资源释放。目录：${fileURLToPath(root)}`)
