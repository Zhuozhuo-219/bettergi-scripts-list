import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { SLOTS } from '../utils/artifact-reader.js'
import { parseAccountFrame, parseEquippedArtifact, parseIdentity, parseRecommendations, ownershipObservation, createAccountReader, ACCOUNT_REGIONS, accountCaptureRegions, resolveIdentityConsensus } from '../utils/account-reader.js'
import { accountFileName, characterKey, createAccountStore, mergeCharacter } from '../utils/account-store.js'
import { captureAccount, semanticFrame, captureTiming } from '../utils/account-capture.js'
import { cleanSetRow, cleanCharacterRecord, isCharacterComplete } from '../utils/account-data-quality.js'
import { extractActions, buildCapturePlan } from './normalize-account-recording.mjs'

const root = new URL('../', import.meta.url)
const read = p => readFileSync(new URL(p, root), 'utf8')
const plan = JSON.parse(read('assets/account-capture-actions.json'))
const record = JSON.parse(read('tools/fixtures/account-recording-essential.json'))
assert.equal(extractActions(record).length, 44)
assert.equal(plan.source.recordedRounds, 4)
assert.equal(buildCapturePlan(record, 'test', 'test').source.recordedActionCount, 44)
assert.ok(plan.recordedActions.every((a, i, all) => !i || a.atMs - all[i - 1].atMs >= 500 && a.atMs - all[i - 1].atMs <= 1000))
assert.deepEqual(captureTiming({}), { actionDelayMs: 600, stabilityIntervalMs: 120 })
assert.equal(captureTiming({ minimumActionIntervalMs: 100 }).actionDelayMs, 500)
assert.equal(captureTiming({ minimumActionIntervalMs: 5000 }).actionDelayMs, 1000)
assert.throws(() => extractActions({ ...record, macroEvents: record.macroEvents.slice(1) }), /缺少按下/)
assert.equal(JSON.parse(read('settings.json')).find(item => item.name === 'runCharacterWarehouse').default, false)

const item = (text, x, y, width = 150, height = 25) => ({ text, x, y, width, height })
const identityItems = [item('草元素 / 纳西妲', 143, 35, 190), item('属性', 150, 145),
  item('圣遗物', 145, 282), item('纳西妲', 1465, 135), item('等级90 / 90', 1465, 212, 250)]
const nahida = parseIdentity(identityItems)
assert.equal(nahida.displayName, '纳西妲')
assert.equal(nahida.verified, true)
assert.equal(parseAccountFrame(identityItems).page, 'attributes')
assert.equal(parseIdentity(identityItems.map(i => i.text === '纳西妲' ? { ...i, text: '其他名字' } : i)).verified, false)
assert.equal(parseIdentity(identityItems.filter(i => !i.text.includes('草元素'))).verified, true, '右侧姓名与属性页证据足够时不因左上漏读退出')
assert.equal(parseIdentity(identityItems.map(i => i.text.startsWith('等级') ? { ...i, text: '等级90' } : i)).verified, true)
const focusIdentity = identityItems.map(i => i.text === '纳西妲' ? { ...i, ocrField: 'characterName' }
  : i.text.includes('草元素') ? { ...i, text: '草元素 / 纳西奶' } : i)
assert.equal(parseIdentity(focusIdentity).verified, false, '左右冲突即使聚焦也不能直接认定右侧正确')
assert.equal(parseIdentity(focusIdentity).displayName, '纳西妲')
assert.equal(parseIdentity(focusIdentity).element, '', '冲突的左上名字不能带入错误元素')
assert.deepEqual(ACCOUNT_REGIONS.rightPanel, [1460, 110, 460, 970])
assert.ok(accountCaptureRegions('identity').includes(ACCOUNT_REGIONS.rightPanel))
assert.ok(accountCaptureRegions('detailRetry').includes(ACCOUNT_REGIONS.ownerFocus))
const headerOnly = identityItems.filter(i => i.text !== '纳西妲' && !i.text.startsWith('等级'))
assert.equal(parseIdentity(headerOnly).displayName, '纳西妲')
assert.equal(parseIdentity(headerOnly).verified, true, '初次右侧名称漏读时允许完整左上标题与角色菜单作为证据')
const overviewItems = [...headerOnly, item('套装效果', 1465, 132), item('圣遗物详情', 1465, 292)]
const overviewFrame = parseAccountFrame(overviewItems)
assert.equal(overviewFrame.page, 'overview')
assert.equal(overviewFrame.identity.displayName, '纳西妲', '概览普通说明文字不能覆盖标题姓名')
assert.equal(overviewFrame.identity.panelName, '')
assert.equal(parseIdentity([item('草元素/纳西妲', 143, 35)]).verified, false, '孤立标题缺少页面证据时不确认角色')
for (const header of ['草元素纳西妲', '草元素|纳西妲', '草元素：纳西妲']) {
  assert.equal(parseIdentity(identityItems.map(i => i.text.includes('草元素') ? { ...i, text: header } : i)).headerName, '纳西妲')
}
assert.equal(parseIdentity(identityItems.map(i => i.text.includes('草元素') ? { ...i, text: '草元素/1号' } : i)).headerName, '1号', '不替换姓名内数字')
assert.equal(parseIdentity(identityItems.map(i => i.text.startsWith('等级') ? { ...i, text: '等级901' } : i)).level, null)
assert.equal(parseIdentity(identityItems.map(i => i.text.startsWith('等级') ? { ...i, text: '等级90190' } : i)).level, null)
assert.equal(parseIdentity(identityItems.map(i => i.text.startsWith('等级') ? { ...i, text: '等级90|90' } : i)).level, 90)
const frameOfNames = (headerName, panelName) => parseAccountFrame(identityItems.map(i =>
  i.text.includes('草元素') ? { ...i, text: `草元素/${headerName}` } : i.text === '纳西妲' ? { ...i, text: panelName } : i))
const noisyIdentityFrames = [frameOfNames('纳西妲', '纳西奶'), frameOfNames('纳西妲', '纳西姐'),
  frameOfNames('纳西妲', '纳西姐'), frameOfNames('纳西奶', '纳西妲'), frameOfNames('纳西妲', '纳西妲')]
assert.equal(resolveIdentityConsensus(noisyIdentityFrames)?.identity.displayName, '纳西妲', '单次完全一致不足两帧时由跨帧双来源共同确认')
assert.equal(resolveIdentityConsensus(Array.from({ length: 8 }, () => frameOfNames('纳西妲', '纳西奶'))), null, '两边各自稳定但持续冲突不选边')
assert.equal(resolveIdentityConsensus(noisyIdentityFrames.slice(0, 2)), null, '两帧噪声不足以投票确认')
assert.equal(resolveIdentityConsensus([frameOfNames('千织', '千织'), frameOfNames('纳西妲', '纳西妲')]), null)

const detailItems = [item('草元素 / 纳西妲', 143, 35, 190), item('迷宫的游人', 1465, 125, 260),
  item('生之花', 1465, 180), item('生命值', 1470, 220), item('4,780', 1770, 220, 100),
  item('+20', 1465, 310, 70), item('暴击伤害+20.2%', 1470, 350, 330),
  item('暴击率+6.2%', 1470, 385, 330), item('攻击力+16', 1470, 420, 330),
  item('防御力+35', 1470, 455, 330), item('深林的记忆: (4)', 1465, 495, 300),
  item('纳西妲已装备', 1520, 925, 240), item('圣遗物推荐', 1470, 32)]
const flower = parseEquippedArtifact(detailItems)
assert.equal(flower.complete, true)
assert.equal(flower.setName, '深林的记忆')
assert.equal(flower.mainStat.value, 4780)
assert.equal(flower.subStats.length, 4)
assert.equal(parseEquippedArtifact(detailItems.map(i => i.text === '+20' ? { ...i, text: '20' } : i)).level, 20)
assert.equal(parseAccountFrame(detailItems).page, 'detail')
assert.equal(ownershipObservation(nahida, flower, 'now').status, 'equipped')
const foreign = { ...flower, owner: '千织', ownerText: '千织已装备' }
assert.equal(ownershipObservation(nahida, foreign, 'now').status, 'selected_foreign')
assert.equal(ownershipObservation(nahida, foreign, 'now').equippedArtifact, null)
assert.equal(ownershipObservation(nahida, { ...flower, owner: null }, 'now').status, 'unknown')
assert.equal(ownershipObservation(nahida, { ...flower, ownerText: '' }, 'now').equippedArtifact, null,
  '即使残留owner字段，缺少已装备标记也不能记为当前装备')
assert.equal(ownershipObservation(nahida, { ...flower, complete: false }, 'now').equippedArtifact, null)
assert.equal(semanticFrame({ page: 'detail', artifact: flower }, 'detail'),
  semanticFrame({ page: 'detail', artifact: { ...flower, subStats: flower.subStats.map(s => ({ ...s, raw: '· ' + s.raw })) } }, 'detail'),
  '原始OCR空白和项目符号不同，不应阻止语义稳定')
assert.equal(parseEquippedArtifact(detailItems.filter(i => i.text !== '暴击率+6.2%')).complete, false)
assert.equal(parseEquippedArtifact(detailItems.filter(i => i.text !== '迷宫的游人')).complete, false)
const ownerNoise = detailItems.filter(i => i.text !== '纳西妲已装备')
ownerNoise.push(item('的银杯了', 1520, 895, 220, 20), item('枫原万叶已装备', 1520, 930, 300))
assert.equal(parseEquippedArtifact(ownerNoise).owner, '枫原万叶', '说明文字不能拼进装备者姓名')
assert.equal(parseEquippedArtifact([...ownerNoise, { ...item('纳西妲已装备', 1520, 930, 250), ocrField: 'owner' }]).owner,
  '纳西妲', '聚焦复核与整列OCR分开，不混入整列的错误文字')

const recommendationItems = [item('推荐套装搭配', 893, 50, 250), item('×4', 978, 118, 42),
  item('87.5%', 1280, 118, 80), item('×4', 978, 214, 42), item('3.3%', 1280, 214, 80),
  item('×2', 978, 310, 42), item('×2', 1118, 310, 42), item('2.1%', 1280, 310, 80),
  item('理之冠-推荐的主要属性', 893, 400, 330), item('推荐的追加属性', 893, 659, 300),
  item('元素精通', 893, 453), item('47.4%', 1270, 453, 90),
  item('暴击率', 893, 520), item('30.5%', 1270, 520, 90),
  item('暴击伤害', 893, 587), item('18.7%', 1270, 587, 90),
  item('元素精通', 893, 710), item('元素充能效率', 893, 777, 230),
  item('暴击伤害', 893, 844), item('暴击率', 893, 911)]
const rec = parseRecommendations(recommendationItems)
assert.deepEqual(rec.setRows.map(r => r.counts), [[4, null], [4, null], [2, 2]])
assert.deepEqual(rec.mainStats.map(r => r.usageRate), [47.4, 30.5, 18.7])
assert.equal(rec.subStats.length, 4)
const duplicateCounts = parseRecommendations(recommendationItems.map(i => i.text === '×4' ? { ...i, text: '×4 ×4' } : i))
assert.deepEqual(duplicateCounts.setRows[0].counts, [4, null])
const fixedMainLayout = recommendationItems.filter(i => i.y < 395 || i.y >= 695)
  .map(i => i.y >= 695 ? { ...i, y: i.y - 265 } : i)
fixedMainLayout.push(item('推荐的追加属性', 893, 395, 300))
const fixedRec = parseRecommendations(fixedMainLayout)
assert.equal(fixedRec.mainStats.length, 0)
assert.equal(fixedRec.subStats.length, 4, '固定主词条省略主属性区后仍读取全部副词条')
assert.equal(parseAccountFrame([...detailItems, ...recommendationItems]).page, 'recommendation')
assert.equal(parseAccountFrame([...detailItems, ...recommendationItems.filter(i => i.y >= 165 || i.x >= 1210),
  item('深林的记忆', 744, 116, 320), item('圣遗物套装', 744, 174, 230)]).dialogName, '深林的记忆')

function memoryIo() {
  const files = new Map()
  return { files, isExists: path => files.has(path), readTextSync: path => files.get(path) || '',
    writeTextSync(path, value) { files.set(path, value); return true } }
}
assert.throws(() => accountFileName(''), /用户标识/)
assert.notEqual(accountFileName('A').path, accountFileName('a').path)
assert.notEqual(accountFileName('a/b').path, accountFileName('a\\b').path)
assert.equal(accountFileName('1234567889').path, 'data/accounts/uid-1234567889.json')
assert.ok(!accountFileName('../../outside').path.includes('..'))
const io = memoryIo()
let store = createAccountStore('test', io)
store.bindUid('1234567889')
assert.throws(() => store.bindUid('1234567890'), /其他账号/)
store.saveCharacter({ identity: nahida, slots: { 生之花: ownershipObservation(nahida, flower, 'old') } })
store.checkpoint({ status: 'running' })
store.saveCharacter({ identity: nahida, slots: { 生之花: ownershipObservation(nahida, { ...flower, level: 0 }, 'new') } })
store.checkpoint({ status: 'complete' })
assert.equal(store.snapshot().characters[characterKey(nahida)].slots.生之花.equippedArtifact.level, 0)
const merged = mergeCharacter(store.snapshot().characters[characterKey(nahida)], {
  identity: nahida, slots: { 生之花: ownershipObservation(nahida, foreign, 'later') }
})
assert.equal(merged.slots.生之花.equippedArtifact, null, '本轮他人物品不能成为当前基准')
assert.equal(merged.slots.生之花.lastVerifiedArtifact.level, 0)
const elementStore = createAccountStore('missing-element', memoryIo())
elementStore.saveCharacter({ identity: { ...nahida, element: '' }, slots: {} })
elementStore.saveCharacter({ identity: nahida, slots: {} })
assert.equal(Object.keys(elementStore.snapshot().characters).length, 1, '左上元素漏读后恢复不重复建角色')
io.files.set(store.path, '{corrupted')
store = createAccountStore('test', io)
assert.equal(store.snapshot().revision, 2, '主文件损坏时恢复已经回读的pending')
assert.equal(createAccountStore('another', io).snapshot().revision, 0)
const broken = memoryIo()
broken.files.set(accountFileName('bad').path, '{broken')
assert.throws(() => createAccountStore('bad', broken), /损坏/)
const numericStore = createAccountStore('1234567889', memoryIo())
assert.throws(() => numericStore.bindUid('1234567890'), /UID不符/)
const failedIo = memoryIo()
failedIo.writeTextSync = () => false
assert.throws(() => createAccountStore('bad-write', failedIo).checkpoint({}), /写入失败/)

function fakeRuntime({ names = ['纳西妲', '千织'], unchanged = false, failSlotOnce = false, cancelAt = Infinity,
  foreignSlot = '空之杯', initialPage = 'other', noWorld = false, failPopup = false,
  failIdentityOnce = false, alwaysFailIdentity = false, failArtifactOnce = false, alwaysFailArtifact = false,
  overviewNoise = false, changeRoleOnReturn = false, noisyIdentityConsensus = false,
  recRows = null, missingOwner = false, actualCounts = [[4, null], [4, null], [2, 2]] } = {}) {
  let time = 0, page = initialPage, slotIndex = 0, role = 0, lastAction = -Infinity, skipSlot = failSlotOnce
  let escCount = 0, popup = '', actions = [], messages = [], reads = [], sleeps = []
  let returnedFromDetail = false
  let identityReadCount = 0
  const token = { isCancellationRequested: false }
  const recommendation = { ...structuredClone(rec), ...(recRows ? { setRows: structuredClone(recRows) } : {}) }
  const id = () => ({ displayName: names[role], element: role % 2 ? '岩' : '草', panelName: names[role], level: 90, verified: ['attributes', 'overview'].includes(page) })
  const doAction = action => {
    assert.ok(time - lastAction >= 600, '任意两次输入操作间隔至少600毫秒')
    lastAction = time; actions.push({ action, time, page })
  }
  return {
    token, actions, messages, reads, sleeps,
    now: () => time, timestamp: () => 'test:' + time, info: message => messages.push(message),
    async sleep(ms) {
      assert.ok(ms === 600 || ms === 120, '动作等待与稳定帧复核分开，不能重复等待1秒')
      sleeps.push(ms); time += ms; if (time >= cancelAt) token.isCancellationRequested = true
    },
    keyPress(key) {
      doAction(key)
      if (key === 'C') { assert.equal(page, 'world', '首次C必须从已确认大世界发送'); page = 'attributes' }
      else if (key === 'F') { assert.equal(page, 'overview'); page = 'detail'; slotIndex = 0 }
      else if (key === 'VK_ESCAPE') {
        if (page === 'other') { if (++escCount >= 2 && !noWorld) page = 'world' }
        else if (page === 'setDialog') page = 'recommendation'
        else if (page === 'detail') { page = 'overview'; returnedFromDetail = true; if (changeRoleOnReturn) role = (role + 1) % names.length }
        else throw new Error('不应在此状态Esc: ' + page)
      } else if (key === 'E') {
        if (page === 'detail') { if (skipSlot) skipSlot = false; else slotIndex = (slotIndex + 1) % 5 }
        else { assert.ok(['overview', 'attributes'].includes(page)); if (!unchanged) role = (role + 1) % names.length; page = 'overview' }
      }
    },
    click(x, y) {
      doAction([x, y])
      if (x === plan.buttons.attributes[0] && y === plan.buttons.attributes[1]) { page = 'attributes'; returnedFromDetail = false }
      else if (x === plan.buttons.artifacts[0] && y === plan.buttons.artifacts[1]) page = 'overview'
      else if (x === plan.buttons.recommendation[0] && y === plan.buttons.recommendation[1]) {
        assert.ok(['detail', 'recommendation'].includes(page)); page = page === 'detail' ? 'recommendation' : 'detail'
      } else if (plan.slotButtons.some(p => p[0] === x && p[1] === y)) {
        assert.equal(page, 'detail'); slotIndex = plan.slotButtons.findIndex(p => p[0] === x && p[1] === y)
      } else {
        assert.equal(page, 'recommendation')
        const row = plan.recommendationIconButtons.findIndex(points => points.some(p => p[0] === x && p[1] === y))
        assert.ok(row >= 0, '使用用户提供的推荐图标坐标')
        const col = plan.recommendationIconButtons[row].findIndex(p => p[0] === x && p[1] === y)
        if (col === 1 && actualCounts[row][1] === null) return
        popup = col === 1 || row === 1 ? '饰金之梦' : '深林的记忆'
        page = 'setDialog'
      }
    },
    capture(scope) {
      reads.push({ scope, role, slotIndex, page, time })
      if (scope === 'world') return { page: page === 'world' ? 'world' : 'unknown' }
      const identity = id()
      if (noisyIdentityConsensus && /^identity/.test(scope)) {
        const sample = identityReadCount++ % 5
        const name = names[role]
        const header = sample === 3 ? '误读丙' : name
        const panel = sample >= 3 ? name : sample === 0 ? '误读甲' : '误读乙'
        Object.assign(identity, { verified: header === panel, headerName: header, panelName: panel, displayName: panel,
          conflicts: header !== panel, candidates: [{ name: header, source: 'header', element: identity.element }, { name: panel, source: 'panel' }] })
      }
      if (overviewNoise && returnedFromDetail && page === 'overview') {
        identity.displayName = '圣遗物详情'; identity.verified = false
      }
      let artifact = { ...flower, slot: SLOTS[slotIndex], owner: SLOTS[slotIndex] === foreignSlot ? '其他角色' : identity.displayName }
      if (missingOwner) artifact = { ...artifact, owner: null, ownerText: '' }
      const badIdentity = alwaysFailIdentity || failIdentityOnce && scope === 'identity'
      const badArtifact = alwaysFailArtifact || failArtifactOnce && scope === 'detail'
      if (badIdentity && /^identity/.test(scope)) identity.verified = false
      if (badArtifact && /^detail/.test(scope)) artifact = { ...artifact, complete: false, owner: null, warnings: ['副词条未读全'] }
      return { page, header: identity.element + '元素/' + identity.displayName, identity, artifact,
        uid: null, capturedAt: 'test:' + time,
        recommendations: page === 'recommendation' ? structuredClone(recommendation) : null,
        dialogName: page === 'setDialog' && !failPopup ? popup : null }
    }
  }
}
const runFake = async options => {
  const runtime = fakeRuntime(options)
  const io = memoryIo()
  const store = createAccountStore('scan', io)
  const result = await captureAccount(runtime, store, plan, runtime.token)
  return { runtime, store, io, result }
}
const normal = await runFake({ failSlotOnce: true })
assert.equal(normal.result.status, 'complete')
assert.equal(normal.result.saved, 2)
assert.equal(Object.keys(normal.store.snapshot().characters).length, 2, '绕回起点不重复保存')
for (const char of Object.values(normal.store.snapshot().characters)) {
  assert.equal(Object.keys(char.slots).length, 5)
  assert.equal(char.slots.空之杯.equippedArtifact, null)
  assert.equal(char.setRecommendations.rows[2].status, 'skipped_low_usage')
  assert.equal(char.setRecommendations.rows[2].components.length, 0)
  assert.equal(char.recommendations.时之沙.mainStats.length, 3)
  assert.equal(char.recommendations.理之冠.subStats.length, 4)
}
assert.ok(normal.runtime.actions.some(i => Array.isArray(i.action) && i.action[0] === 201), '切换失败时按部位图标纠正')
assert.ok(normal.runtime.messages.some(message => message.includes('识别角色：纳西妲')))
assert.ok(normal.runtime.messages.some(message => message.includes('[1/5] 生之花：迷宫的游人')))
assert.ok(normal.runtime.messages.some(message => message.includes('推荐搭配1：深林的记忆×4')))
assert.ok(normal.runtime.messages.some(message => message.includes('已保存纳西妲')))
const happy = await runFake({ foreignSlot: null })
const skipRuntime = fakeRuntime({ foreignSlot: null })
const skipResult = await captureAccount(skipRuntime, happy.store, plan, skipRuntime.token, { skipExistingCharacters: true })
assert.equal(skipResult.status, 'complete')
assert.equal(skipResult.skipped, 2)
assert.equal(skipResult.saved, 0)
assert.equal(skipRuntime.actions.filter(row => row.action === 'F').length, 0, '跳过角色仅识别属性并切换，不进入详情')
assert.ok(Object.values(happy.store.snapshot().characters).every(char => char.setRecommendations.rows.length === 3), '跳过时身份更新不清空已有推荐')
const partialStore = createAccountStore('partial-skip', memoryIo())
for (const record of Object.values(happy.store.snapshot().characters)) partialStore.saveCharacter(record)
const partial = Object.values(partialStore.snapshot().characters)[0]
delete partial.slots.理之冠
const partialIo = memoryIo()
const partiallyRecorded = createAccountStore('partial-real', partialIo)
partiallyRecorded.saveCharacter(partial)
const partialRuntime = fakeRuntime({ foreignSlot: null })
const partialResult = await captureAccount(partialRuntime, partiallyRecorded, plan, partialRuntime.token, { skipExistingCharacters: true })
assert.equal(partialResult.saved, 2, '未完成五部位的角色不会误跳过')
for (const corrupt of [
  record => { record.slots.生之花.status = 'unknown'; record.slots.生之花.equippedArtifact = null },
  record => { record.recommendations.生之花.status = 'partial' },
  record => { record.slots.生之花.equippedArtifact.subStats = [] },
  record => { record.setRecommendations.rows[0].status = 'name_error'; record.setRecommendations.rows[0].error = '未读全' },
  record => { record.slots.生之花.equippedArtifact.ownerText = '' }
]) {
  const retryStore = createAccountStore('retry-incomplete', memoryIo())
  for (const record of Object.values(happy.store.snapshot().characters)) {
    corrupt(record); record.complete = true; retryStore.saveCharacter(record)
  }
  const runtime = fakeRuntime({ foreignSlot: null })
  const result = await captureAccount(runtime, retryStore, plan, runtime.token, { skipExistingCharacters: true })
  assert.equal(result.skipped, 0, '已有五部位但装备/推荐有未确认字段时不跳过，不能只信complete标记')
  assert.equal(result.saved, 2)
}
const ownerMissingRun = await runFake({ missingOwner: true })
const missingIdentityLevel = structuredClone(Object.values(happy.store.snapshot().characters)[0])
missingIdentityLevel.identity.level = null
assert.equal(isCharacterComplete(missingIdentityLevel), false, '未读到角色等级时完整性标志应为false；本轮属性识别恢复后可重新满足跳过条件')
assert.equal(ownerMissingRun.result.status, 'complete', '缺少装备者标记不退出整轮')
assert.ok(Object.values(ownerMissingRun.store.snapshot().characters).every(record =>
  !isCharacterComplete(record) && Object.values(record.slots).every(slot => !slot.equippedArtifact && slot.status === 'unknown')))
const noisyReturn = await runFake({ foreignSlot: null, overviewNoise: true })
assert.equal(noisyReturn.result.status, 'complete', '返回概览误读姓名后回属性复核，继续遍历')
assert.ok(noisyReturn.runtime.messages.some(message => message.includes('返回属性页复核')))
await assert.rejects(runFake({ foreignSlot: null, changeRoleOnReturn: true }), /角色身份复核不符/, '真实角色变化仍停止')
assert.equal(happy.runtime.reads.filter(read => read.scope === 'detail').length, 20,
  '两角色十个部位各核对两帧，不再重复进行页面两帧加详情两帧')
assert.ok(happy.runtime.sleeps.every(ms => ms <= 600))
assert.ok(happy.runtime.now() < 60000, '纯等待模拟整轮不应再积累到数分钟')
await assert.rejects(runFake({ unchanged: true }), /角色仍未变化/)
await assert.rejects(runFake({ names: ['纳西妲', '千织', '菲谢尔', '千织', '八重神子'] }), /重复了非起始角色/)
await assert.rejects(runFake({ noWorld: true }), /大世界/)
const cancelled = await runFake({ cancelAt: 10000 })
assert.equal(cancelled.result.status, 'cancelled')
assert.ok(Object.keys(cancelled.store.snapshot().characters).length > 0, '取消时保留当前角色部分记录')
const popupFailure = await runFake({ failPopup: true })
assert.equal(popupFailure.result.status, 'complete')
assert.ok(popupFailure.result.errors.length > 0)
assert.equal(popupFailure.store.snapshot().characters[characterKey(nahida)]?.setRecommendations?.complete, false)
assert.equal(popupFailure.store.snapshot().characters[characterKey(nahida)]?.recommendations.生之花.mainStats.length, 3,
  '套装名失败不丢弃已识别属性推荐')

const recovered = await runFake({ foreignSlot: null, failIdentityOnce: true, failArtifactOnce: true })
const consensusRun = await runFake({ foreignSlot: null, noisyIdentityConsensus: true })
assert.equal(consensusRun.result.status, 'complete')
assert.ok(consensusRun.runtime.messages.some(message => message.includes('帧交叉复核')))
assert.equal(recovered.result.status, 'complete')
assert.equal(recovered.runtime.messages.filter(message => message.includes('角色名称未确认')).length, 3,
  '两角色及绕回起点各最多重试属性一次')
assert.equal(recovered.runtime.messages.filter(message => message.includes('详情或装备者未确认')).length, 10,
  '十个部位各重试动作一次')
assert.ok(recovered.runtime.reads.some(read => read.scope === 'identityRetry'))
assert.ok(recovered.runtime.reads.some(read => read.scope === 'detailRetry'))
const unavailable = await runFake({ foreignSlot: null, alwaysFailArtifact: true })
assert.equal(unavailable.result.status, 'complete', '单件重试后仍失败时保留未知并继续，而非退出全账号')
assert.ok(Object.values(unavailable.store.snapshot().characters).every(c => Object.values(c.slots).every(s => s.status === 'unknown')))
const badNameRuntime = fakeRuntime({ alwaysFailIdentity: true })
await assert.rejects(captureAccount(badNameRuntime, createAccountStore('bad-name', memoryIo()), plan, badNameRuntime.token), /角色名称/)
assert.equal(badNameRuntime.actions.filter(a => Array.isArray(a.action) && a.action.join() === plan.buttons.attributes.join()).length, 2,
  '角色永久不可读时只执行首次点击加一次重试')

const unknownCountRows = structuredClone(rec.setRows)
unknownCountRows[0].counts = [null, null]
unknownCountRows[0].status = 'unreadable_counts'
const unknownCounts = await runFake({ recRows: unknownCountRows, foreignSlot: null })
assert.equal(Object.values(unknownCounts.store.snapshot().characters)[0].setRecommendations.rows[0].components[0].setName, '深林的记忆',
  '×4读不到时仍点开高使用率第一图标读取名字')
assert.equal(Object.values(unknownCounts.store.snapshot().characters)[0].setRecommendations.rows[0].components[0].count, 4,
  '已确认只有一个套装图标时清洗为4件套')
assert.equal(Object.values(unknownCounts.store.snapshot().characters)[0].setRecommendations.complete, true)
const twoSets = cleanSetRow({ usageRate: 20, status: 'name_ok_counts_unknown', counts: [null, null],
  components: [{ setName: '深林的记忆', count: null }, { setName: '饰金之梦', count: null }] })
assert.deepEqual(twoSets.components.map(part => part.count), [2, 2])
const failedSecond = cleanSetRow({ usageRate: 20, status: 'name_error', error: '第二图标识别失败', counts: [2, null],
  components: [{ setName: '深林的记忆', count: null }] })
assert.equal(failedSecond.status, 'name_error')
assert.equal(failedSecond.components[0].count, null, '第二套未读到不等于只有一套')
const cancelledClean = createAccountStore('cancel-clean', memoryIo())
const cleanupRecord = Object.values(happy.store.snapshot().characters)[0]
cleanupRecord.setRecommendations.rows[0] = { usageRate: 80, status: 'name_ok_counts_unknown', counts: [null, null],
  secondIconState: 'not_opened', components: [{ setName: '深林的记忆', count: null }] }
cancelledClean.saveCharacter(cleanupRecord)
cancelledClean.checkpoint({ status: 'cancelled' })
assert.equal(Object.values(cancelledClean.snapshot().characters)[0].setRecommendations.rows[0].components[0].count, 4,
  '取消保存的检查点也完成推荐件数清洗')
const popularRows = structuredClone(rec.setRows)
popularRows[1] = { ...popularRows[1], usageRate: 10, counts: [2, 2] }
popularRows[2].usageRate = 9.9
const popular = await runFake({ recRows: popularRows, actualCounts: [[4, null], [2, 2], [2, 2]], foreignSlot: null })
assert.ok(popular.runtime.actions.some(a => Array.isArray(a.action) && a.action.join() === '1062,225'), '正好10%时读取第二行第二图标')
assert.ok(!popular.runtime.actions.some(a => Array.isArray(a.action) && a.action[1] === 325), '低于10%时不点击第三行')

// 主入口模式隔离：录入开关开启时不启动三合一遮罩或模拟服务。
let called = 0
const main = read('main.js').replace(/^import .* from .*\r?\n/gm, '')
await vm.runInNewContext(main, {
  settings: { runCharacterWarehouse: true, userIdentifier: 'test' }, setGameMetrics: () => {},
  dispatcher: { getLinkedCancellationToken: () => ({}) },
  runAccountCapture: async options => { assert.equal(options.userIdentifier, 'test'); called++ },
  createRunLogger: () => ({ path: 'test-run', event() {}, finish() {} }),
  loadDecisionDatabase: () => { throw new Error('不应加载三合一规则') }, log: { error: () => {}, info: () => {} }
})
assert.equal(called, 1)

// 读取器异常时仍释放捕获图像和模板。
let disposedImage = 0, disposedTemplate = 0
globalThis.file = { readImageMatSync: () => ({ dispose: () => disposedTemplate++ }) }
globalThis.captureGameRegion = () => ({ width: 1280, height: 720, dispose: () => disposedImage++ })
const reader = createAccountReader()
assert.throws(() => reader.capture(), /1920/)
reader.dispose()
assert.equal(disposedImage, 1)
assert.equal(disposedTemplate, 1)
console.log('通过：录制标准化、字段/归属/推荐解析、账号隔离、同字段覆盖、备份恢复、状态导航、E纠正、起点循环、非起点重复、取消保存与入口隔离。')
