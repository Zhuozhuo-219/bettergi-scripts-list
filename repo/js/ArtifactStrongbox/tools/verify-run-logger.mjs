import assert from 'node:assert/strict'
import { createRunLogger, summarizeFrame } from '../utils/run-logger.js'
const files = new Map()
const io = { readTextSync: path => files.get(path), writeTextSync: (path, text) => {
  // BGI LimitedFile白名单允许.json，不允许.jsonl。仅模拟磁盘成功会漏掉此问题。
  if (!path.endsWith('.json')) return false
  JSON.parse(text)
  files.set(path, text); return true
} }
const journal = createRunLogger({ userIdentifier: '123456789', runCharacterWarehouse: true }, io)
for (let i = 0; i < 70; i++) journal.event('test', { index: i })
journal.event('capture', { frame: { page: 'overview', identity: { displayName: '纳西妲', headerName: '纳西妲', panelCandidate: '圣遗物详情' },
  raw: [{ text: '草元素/纳西妲', x: 143, y: 35 }, { text: '不相关', x: 700, y: 600 }] } })
journal.finish('failed', { message: '角色身份复核不符' })
const metadata = JSON.parse(files.get(journal.path))
assert.equal(metadata.status, 'failed')
assert.equal(metadata.chunks, 2)
assert.equal(metadata.events, 73)
const events = [...files.entries()].filter(([path]) => /events-\d+\.json$/.test(path)).flatMap(([, text]) => JSON.parse(text))
assert.equal(events.length, 73)
assert.deepEqual(events.map(row => row.sequence), Array.from({ length: 73 }, (_, i) => i + 1))
assert.equal(events.find(row => row.type === 'capture').frame.identityOcr.length, 1)
assert.equal(JSON.parse(files.get('data/logs/uid-123456789.latest.json')).path, journal.path)
const other = createRunLogger({ userIdentifier: '123456788' }, io)
assert.notEqual(journal.path, other.path)
assert.ok(files.has('data/logs/uid-123456788.latest.json'))
let warnings = 0
const broken = createRunLogger({}, { writeTextSync: () => false }, () => warnings++)
broken.event('test'); broken.finish('complete')
assert.equal(warnings, 1, '日志写失败只提示一次，不影响数据录入')
assert.equal(broken.enabled, false)
assert.equal(journal.enabled, true)
let readbackWarnings = 0
const mismatch = createRunLogger({}, { writeTextSync: () => true, readTextSync: () => 'bad' }, () => readbackWarnings++)
assert.equal(mismatch.enabled, false)
assert.equal(readbackWarnings, 1)
assert.equal(summarizeFrame({ page: 'unknown' }).identityOcr.length, 0)
console.log('通过：日志分片、逐条序号、账号定位文件、错误结束、姓名OCR证据及写入失败降级。')
