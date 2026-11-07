import assert from 'node:assert/strict'
import fs from 'node:fs'
import { matchCharacterName, createNameNormalizer, identifyByDescription, TRAVELER_ELEMENTS, normalizeTravelerLabel } from '../utils/character-names.js'
import { migrateAccountNames } from '../utils/account-name-migration.js'
import { parseAccountFrame } from '../utils/account-reader.js'
import { createAccountStore, characterKey } from '../utils/account-store.js'
const read = path => JSON.parse(fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8'))
const dictionary = read('assets/character-names.json')
const descriptions = read('assets/custom-character-descriptions.json').descriptions
assert.equal(dictionary.gameVersion, '7.1')
assert.equal(dictionary.characters.length, 125, '含旅行者及人偶变体的名称条目，不等于可玩角色人数')
assert.ok(!dictionary.characters.some(row => ['米提亚', '瓦列里'].includes(row.name)))
for (const [raw, name] of [['伊湿芙','伊涅芙'],['桑多湿','桑多涅'],['纳西姐','纳西妲'],['纳西奶','纳西妲'],['拉乌玛','菈乌玛'],['乌玛','菈乌玛'],['茜特莉','茜特菈莉'],['优拉','优菈']]) {
  assert.equal(matchCharacterName(raw, dictionary).name, name)
}
assert.equal(matchCharacterName('神里绫', dictionary).method, 'ambiguous')
assert.equal(matchCharacterName('示例', dictionary).name, '示例')
assert.equal(matchCharacterName('任意测试名', dictionary).method, 'unmatched')
assert.equal(identifyByDescription(descriptions.mannequin.replace('派蒙','派豪').replace('探索','探素'), descriptions).kind, 'mannequin')
assert.equal(identifyByDescription('这是普通角色的说明，正在流浪，偶尔探索世界', descriptions), null)
let records = {}
const normalizer = createNameNormalizer(dictionary, descriptions, () => records)
const base = name => ({ displayName: name, headerName: name, panelName: name, element: '冰', verified: true, rosterEvidence: true, attributeEvidence: true })
for (const raw of ['纳t西妲', 't纳西妲T', '琴t', '七t']) {
  assert.equal(matchCharacterName(raw, dictionary).name, raw.includes('纳') ? '纳西妲' : raw.includes('琴') ? '琴' : '七七')
}
for (const [headerName, panelName, expected] of [
  ['七七', 'tt', '七七'], ['七t', '七七', '七七'], ['tt', '七七', '七七'],
  ['纳西妲', '陌生名', '纳西妲'], ['陌生名', '纳西妲', '纳西妲'],
  ['纳西妲', '纳西姐', '纳西妲'], ['迪卢克', '迪奥娜娜', '迪卢克']
]) {
  const result = normalizer.identity({ ...base(panelName), headerName, element: '',
    header: `冰元素/${headerName}`, verified: false, conflicts: true,
    candidates: [{ name: headerName, source: 'header' }, { name: panelName, source: 'panel' }] })
  assert.equal(result.displayName, expected)
  assert.equal(result.verified, true, `${headerName}/${panelName}优先字典有效名`)
  assert.equal(result.rejectionReason, '')
  assert.ok(result.candidates.every(candidate => candidate.name === expected))
  assert.equal(result.rawNames.panel, panelName, '保留识别原文以便日志排查')
  if (panelName === 'tt') assert.ok(!result.aliases.includes('tt'), '不把无效字母登记成账号别名')
}
for (const name of ['tt', '七txyz未知']) {
  const result = normalizer.identity({ ...base(name), candidates: [{ name, source: 'header' }] })
  assert.equal(result.verified, false, '未匹配字母不能作为普通角色身份')
  assert.equal(result.candidates.length, 0, '多帧投票不能绕过字母过滤')
}
assert.equal(normalizer.identity({ ...base('迪卢克'), headerName: '迪奥娜' }).verified, false,
  '两个不同完整字典名仍然保留冲突')
const englishTraveler = normalizer.identity({ ...base('Alice'), description: descriptions.traveler })
assert.equal(englishTraveler.displayName, '旅行者（冰）')
assert.equal(englishTraveler.customName, 'Alice', '自定义角色的真实英文名不被清洗')
assert.equal(englishTraveler.verified, true)
for (const identity of read('tools/fixtures/character-name-latin-failure.json').identities) {
  const result = normalizer.identity(identity)
  assert.equal(result.displayName, '七七')
  assert.equal(result.verified, true, '用户最新七七/tt实际失败帧应全部通过')
}
const dollA = normalizer.identity({ ...base('例名'), description: descriptions.mannequin })
assert.equal(dollA.displayName, '人偶A'); assert.equal(dollA.element, '冰')
records.a = { identity: dollA }
const dollB = normalizer.identity({ ...base('另一个名字'), description: descriptions.mannequin })
assert.equal(dollB.displayName, '人偶B')
records.b = { identity: dollB }
assert.equal(normalizer.identity({ ...base('例名'), description: descriptions.mannequin }).displayName, '人偶A')
assert.equal(normalizer.identity({ ...base('第三个名字'), description: descriptions.mannequin }).verified, false)
assert.equal(normalizer.identity({ ...base('例名'), panelName: '完全不同', description: descriptions.mannequin }).verified, false)
assert.equal(normalizer.owner('例名').name, '人偶A')
const wanderer = normalizer.identity({ ...base('优拉'), element: '风', description: descriptions.wanderer })
assert.equal(wanderer.displayName, '流浪者', '先看简介，不把自定义名称套成优菈')
records.w = { identity: wanderer }
assert.equal(normalizer.owner('优拉').name, '流浪者')
const traveler = normalizer.identity({ ...base('示例'), description: descriptions.traveler })
assert.equal(traveler.displayName, '旅行者（冰）'); assert.equal(traveler.element, '冰')
assert.equal(normalizeTravelerLabel('旅行者·草'), '旅行者（草）')
for (const name of ['空', '荧', '旅行者']) {
  assert.equal(normalizer.identity({ ...base(name), element: '风', header: `风元素/${name}` }).displayName, '旅行者（风）', '不区分男女旅行者')
}
for (const element of TRAVELER_ELEMENTS) {
  const current = normalizer.identity({ ...base('示例'), element, header: `${element}元素/示例`, description: descriptions.traveler })
  assert.equal(current.displayName, `旅行者（${element}）`)
  assert.equal(current.baseName, '旅行者')
  assert.equal(current.verified, true)
}
const missingElement = normalizer.identity({ ...base('示例'), element: '', description: descriptions.traveler })
assert.equal(missingElement.verified, false, '识别出旅行者但未读到当前元素时不得借用旧元素')
records.travelerIce = { identity: traveler }
records.travelerFire = { identity: normalizer.identity({ ...base('示例'), element: '火', description: descriptions.traveler }) }
const currentTraveler = normalizer.identity({ ...base('示例'), element: '冰' })
assert.equal(currentTraveler.displayName, '旅行者（冰）', '多元素历史记录仍是同一旅行者别名')
assert.equal(normalizer.identity({ ...base('示例'), element: '' }).verified, false, '已有历史元素也不得填充当前未知元素')
assert.equal(normalizer.identity({ ...base('示例'), element: '风', header: '冰元素/示例' }).displayName, '旅行者（冰）', '当前标题元素优先于历史字段')
normalizer.setActiveIdentity(currentTraveler)
assert.equal(normalizer.owner('示例').name, '旅行者（冰）')
normalizer.setActiveIdentity(records.travelerFire.identity)
assert.equal(normalizer.owner('示例').name, '旅行者（火）')
normalizer.setActiveIdentity(null)
assert.equal(normalizer.owner('示例').name, null, '未确认当前元素时不随便选择历史分支')
delete records.travelerIce; delete records.travelerFire
assert.equal(normalizer.identity({ ...base('示例') }).displayName, '示例', '无简介证据不擅自给未知自定义名分类')
records.collision = { identity: { ...wanderer, aliases: ['琴'], customName: '琴' } }
assert.equal(normalizer.owner('琴').name, null, '自定义名与标准角色重名的装备者不强行归属')
const files = new Map()
const store = createAccountStore('custom-test', { isExists: path => files.has(path), readTextSync: path => files.get(path),
  writeTextSync: (path, value) => { files.set(path, value); return true } })
store.saveCharacter({ identity: { ...base('琴'), kind: 'regular', element: '风' }, slots: { 生之花: { status: 'unknown', marker: '琴原有记录' } } })
const namedJean = normalizer.identity({ ...base('琴'), element: '风', description: descriptions.wanderer })
store.saveCharacter({ identity: namedJean, slots: {} })
assert.equal(Object.keys(store.snapshot().characters).length, 2, '流浪者自定义名为琴时不能合并或删除真正的琴')
store.saveCharacter({ identity: dollA, slots: {} })
const changedElement = { ...dollA, element: '火' }
store.saveCharacter({ identity: changedElement, slots: {} })
assert.equal(characterKey(changedElement), characterKey(dollA))
assert.equal(store.snapshot().characters[characterKey(dollA)].needsRefresh, true, '人偶元素改变需要重新录入')
const failure = read('tools/fixtures/character-name-failure.json')
assert.equal(failure.frames.length, 8)
for (const frame of failure.frames) {
  const corrected = normalizer.identity(frame.identity)
  assert.equal(corrected.displayName, '菈乌玛')
  assert.equal(corrected.verified, true)
}
const rawIdentity = { ...base('纳西姐'), headerName: '纳西妲', element: '' }
const artifact = { name: '测试花', slot: '生之花', level: 20, owner: '纳西姐', ownerText: '纳西姐已装备', complete: true }
const input = { characters: {
  old: { identity: rawIdentity, capturedAt: '2026-01', slots: { 生之花: { status: 'selected_foreign', selectedArtifact: artifact } } },
  current: { identity: { ...base('纳西妲'), element: '草' }, capturedAt: '2026-02', slots: {} }
} }
const migrated = migrateAccountNames(input, dictionary, descriptions)
assert.equal(Object.keys(migrated.data.characters).length, 1)
const record = Object.values(migrated.data.characters)[0]
assert.equal(record.identity.displayName, '纳西妲')
assert.equal(record.slots.生之花.selectedArtifact.owner, '纳西妲')
assert.equal(record.slots.生之花.selectedArtifact.ownerText, '纳西姐已装备')
assert.equal(input.characters.old.identity.displayName, '纳西姐', '迁移为纯函数，不改原始对象')
for (const example of read('tools/fixtures/custom-name-ocr.json').examples) {
  const frame = parseAccountFrame(example.items)
  const identity = createNameNormalizer(dictionary, descriptions).identity(frame.identity)
  assert.equal(identity.kind, example.file.includes('人偶') ? 'mannequin' : 'wanderer', example.file)
  assert.equal(identity.displayName, example.file.includes('人偶') ? '人偶A' : '流浪者')
  assert.equal(identity.verified, true, example.file + '介绍与姓名必须能实际通过验证')
}
console.log('通过：7.1字典、近似匹配/歧义、最新失败8帧修正、自定义介绍与A/B别名、历史迁移及两张实图OCR。')
