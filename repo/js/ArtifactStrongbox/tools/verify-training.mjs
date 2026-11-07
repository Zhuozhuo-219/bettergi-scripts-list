import assert from 'node:assert/strict'
import { trainingCatalog, createTrainingStore, resolveTrainingCharacters } from '../utils/training-characters.js'
import { createProjectionService } from '../utils/artifact-projection.js'
import { annotateArtifactEnhancement } from '../utils/artifact-enhancement.js'
import { deduplicateOcrItems } from '../utils/account-reader.js'

const records = { nahida: { identity: { displayName: '纳西妲' } } }
const catalog = trainingCatalog([], records)
assert.equal(catalog[0].name, '纳西妲')
assert.equal(catalog[0].owned, true)
assert.equal(catalog.find(row => row.name === '芙宁娜').owned, false)
assert.ok(catalog.some(row => row.name === '旅行者（草）'))
assert.ok(catalog.some(row => row.name === '旅行者（冰）'))
const travelerCatalog = trainingCatalog([], { traveler: { identity: { displayName: '旅行者（冰）', kind: 'traveler', element: '冰' } } })
assert.equal(travelerCatalog.find(row => row.name === '旅行者（冰）').owned, true)
assert.equal(travelerCatalog.find(row => row.name === '旅行者（火）').owned, false)
const memory = new Map()
const io = { isExists: path => memory.has(path), readTextSync: path => memory.get(path),
  writeTextSync: (path, value) => { memory.set(path, value); return true } }
const store = createTrainingStore('test-a', io)
assert.deepEqual(store.read(), [])
store.save(['纳西妲', '纳西妲'], catalog)
assert.deepEqual(store.read(), ['纳西妲'])
assert.deepEqual(createTrainingStore('test-b', io).read(), [])
assert.throws(() => store.save([], catalog), /至少/)
assert.throws(() => store.save(['未知角色'], catalog), /角色库/)
const broken = createTrainingStore('other', io)
memory.set(broken.path, memory.get(store.path))
assert.throws(() => broken.read(), /格式错误/)

const artifact = annotateArtifactEnhancement({ slot: '空之杯', level: 0, setName: '黄金剧团',
  mainStat: { name: '生命值', percent: true, value: 7 }, warnings: [],
  subStats: [['暴击率', 3.1], ['暴击伤害', 7.8], ['攻击力', 4.7], ['元素充能效率', 5.8]]
    .map(([name, value], rowIndex) => ({ name, value, rowIndex, percent: true, activation: 'active' })) })
const service = createProjectionService({ simulationCount: 100, selectedProfileIds: ['default:芙宁娜'] })
const result = await service.calculate(artifact)
assert.equal(result.simulatedProfiles, 1)
assert.equal(result.rows[0].name, '芙宁娜')
assert.equal(result.selectedOnly, true)
assert.equal((await createProjectionService({ selectedProfileIds: [] }).calculate(artifact)).state, 'blocked', '空选择不退回全库')

// 真实聚焦OCR出现完整名称+重叠字框，去掉重叠字，保留相邻重复字和不同字段。
const boxes = [{ text: '迷宫的游人', x: 1460, y: 112, width: 152, height: 53, ocrField: 'name' },
  { text: '人', x: 1588, y: 118, width: 43, height: 44, ocrField: 'name' }]
assert.equal(deduplicateOcrItems(boxes).length, 1)
assert.equal(deduplicateOcrItems([boxes[0], { ...boxes[1], x: 1635 }]).length, 2)
assert.equal(deduplicateOcrItems([boxes[0], { ...boxes[1], ocrField: 'owner' }]).length, 2)

globalThis.file = io
globalThis.log = { info: () => {} }
let closed = 0, receives = 0, submitted = null
globalThis.htmlMask = {
  show: () => 'training', exists: () => !closed, setClickThrough: (id, value) => assert.equal(value, false),
  send: (id, url, text) => { if (url === '/training') submitted = JSON.parse(text) },
  receive: async () => { receives++; return JSON.stringify({ url: '/training/save', data: { characters: ['纳西妲'] } }) },
  close: () => { closed++ }
}
const selected = await resolveTrainingCharacters({ userIdentifier: 'new-account' }, [], { isCancellationRequested: false })
assert.deepEqual(selected.profileIds, ['default:纳西妲'])
assert.equal(closed, 1)
assert.ok(submitted.catalog.length > 100)
await resolveTrainingCharacters({ userIdentifier: 'new-account' }, [], { isCancellationRequested: false })
assert.equal(receives, 1, '保存后正常启动直接使用账号选择')
console.log('通过：已录入优先、账号选择隔离、角色过滤/空选择保护、选择窗口通信保存及重叠OCR去重。')
