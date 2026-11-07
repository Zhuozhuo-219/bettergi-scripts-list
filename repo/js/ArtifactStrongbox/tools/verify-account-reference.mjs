import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseAccountFrame } from '../utils/account-reader.js'

const examples = JSON.parse(readFileSync(new URL('./fixtures/account-reference-ocr.json', import.meta.url), 'utf8'))
const frames = new Map(examples.images.map(example => [example.file, parseAccountFrame(example.items)]))
const retries = new Map((examples.retryImages || []).map(example => [example.file, parseAccountFrame(example.items)]))
let focusedRecoveries = 0
const expected = [
  ['生之花', '迷宫的游人', '深林的记忆', '生命值', 4780, [20.2, 6.2, 16, 35]],
  ['死之羽', '翠蔓的智者', '深林的记忆', '攻击力', 311, [3.1, 4.7, 91, 16.2]],
  ['时之沙', '贤智的定期', '深林的记忆', '元素精通', 187, [12.8, 9.3, 5.8, 15.5]],
  ['空之杯', '绯花之壶', '绝缘之旗印', '元素精通', 187, [7, 39, 22.5, 16]],
  ['理之冠', '月桂的宝冠', '深林的记忆', '元素精通', 187, [3.1, 24.9, 11, 33]]
]
for (const [slot, name, setName, statName, value, subs] of expected) {
  const file = `圣遗物详情页-${slot}.png`
  let frame = frames.get(file)
  if (!frame.artifact.complete || frame.artifact.owner !== '纳西妲') {
    frame = retries.get(file)
    focusedRecoveries++
  }
  assert.equal(frame.page, 'detail')
  assert.equal(frame.artifact.complete, true, slot + '应完整解析')
  assert.equal(frame.artifact.name, name)
  assert.equal(frame.artifact.setName, setName)
  assert.equal(frame.artifact.mainStat.name, statName)
  assert.equal(frame.artifact.mainStat.value, value)
  assert.equal(frame.artifact.owner, '纳西妲')
  assert.equal(frame.uid, '123456789')
  assert.equal(frame.artifact.level, 20)
  assert.deepEqual(frame.artifact.subStats.map(item => item.value), subs)
}
assert.equal(frames.get('角色界面图.png').identity.verified, true)
const cropped = JSON.parse(readFileSync(new URL('./fixtures/identity-retry-ocr.json', import.meta.url), 'utf8'))
const characterBase = examples.images.find(row => row.file === '角色界面图.png').items
const primaryCrop = parseAccountFrame([...characterBase, ...cropped.primary])
const retryCrop = parseAccountFrame([...characterBase, ...cropped.retry])
assert.equal(primaryCrop.identity.conflicts, true, '新实跑记录了普通标题裁剪产生多余字的真实OCR现象')
assert.equal(retryCrop.identity.headerName, '纳西妲', '元素/姓名之间独立分隔框识别为1时格式归一化')
assert.equal(retryCrop.identity.panelName, '纳西妲')
assert.equal(retryCrop.identity.verified, true, '调整裁剪后真实OCR可恢复左右一致')
assert.equal(frames.get('圣遗物页面图.png').page, 'overview')
const rec = frames.get('圣遗物推荐页.png').recommendations
assert.deepEqual(rec.setRows.map(row => row.counts), [[4, null], [4, null], [2, 2]])
assert.deepEqual(rec.setRows.map(row => row.usageRate), [87.5, 3.3, 2.1])
assert.deepEqual(rec.mainStats.map(stat => stat.usageRate), [47.4, 30.5, 18.7])
assert.equal(rec.subStats.length, 4)
for (const [file, frame] of frames) {
  if (file.startsWith('圣遗物三合一')) assert.equal(frame.page, 'unknown', '强匣不能误判角色页')
}
console.log(`通过：${examples.images.length}张参考图及${retries.size}份聚焦复核输出，五件详情/装备者、角色名、推荐件数与属性；聚焦恢复${focusedRecoveries}例。非BGI游戏实测。`)
