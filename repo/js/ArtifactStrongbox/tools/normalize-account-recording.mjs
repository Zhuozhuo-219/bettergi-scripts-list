import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

export function extractActions(record) {
  if (record.info?.width !== 1920 || record.info?.height !== 1080) throw new Error('录制分辨率必须为1920×1080')
  const pending = new Map()
  const actions = []
  for (const event of record.macroEvents) {
    if (event.type === 2 || event.type === 3) continue
    if (![0, 1, 4, 5].includes(event.type)) throw new Error('不支持的录制事件类型')
    const keyboard = event.type === 0 || event.type === 1
    const key = keyboard ? `key:${event.keyCode}` : `mouse:${event.mouseButton}`
    if (event.type === 0 || event.type === 4) {
      if (pending.has(key)) throw new Error('重复按下，无法标准化')
      pending.set(key, event)
    } else {
      const down = pending.get(key)
      if (!down) throw new Error('缺少按下事件')
      pending.delete(key)
      const name = { 67: 'C', 69: 'E', 70: 'F', 27: 'VK_ESCAPE' }[down.keyCode]
      if (keyboard && !name || !keyboard && down.mouseButton !== 'Left') throw new Error('包含参考流程以外的按键')
      actions.push({ type: keyboard ? 'key' : 'click', ...(keyboard ? { key: name } : { point: [down.mouseX, down.mouseY] }),
        originalTimeMs: down.time, originalHoldMs: Math.round(event.time - down.time) })
    }
  }
  if (pending.size) throw new Error('存在未松开的输入')
  return actions.sort((a, b) => a.originalTimeMs - b.originalTimeMs)
}

export function buildCapturePlan(record, recording, sha256) {
  const actions = extractActions(record)
  if (actions[0]?.key !== 'C') throw new Error('首个有效动作必须为C')
  const expected = ['click', 'click', 'F', 'E', 'E', 'E', 'E', 'click', 'click', 'VK_ESCAPE']
  let cursor = 1
  let rounds = 0
  while (cursor < actions.length) {
    const group = actions.slice(cursor, cursor + expected.length)
    if (group.length !== expected.length || group.some((action, i) => (action.key || action.type) !== expected[i])) {
      throw new Error(`第${rounds + 1}段不符合 属性→圣遗物→F→四次E→推荐开关→Esc 流程`)
    }
    rounds++
    cursor += expected.length
    if (cursor < actions.length) {
      if (actions[cursor++].key !== 'E') throw new Error('段间不是E切换角色')
    }
  }
  if (!rounds) throw new Error('没有完整部位遍历')
  return {
    schemaVersion: 1, source: { recording, sha256, recordedRounds: rounds, recordedActionCount: actions.length },
    minimumActionIntervalMs: 600,
    description: '每个key/click为一次完整短按/点击；动作后默认等待600毫秒，稳定帧间隔120毫秒，不将down/up之间拉成长按。实际执行加入页面验证并循环到起始角色。',
    slots: ['生之花', '死之羽', '时之沙', '空之杯', '理之冠'],
    buttons: { attributes: actions[1].point, artifacts: actions[2].point, recommendation: actions[8].point },
    slotButtons: [[90, 48], [201, 48], [312, 48], [422, 48], [533, 48]],
    recommendationIconButtons: [[[925, 125], [1065, 125]], [[925, 225], [1062, 225]], [[925, 325], [1065, 325]]],
    recommendationIconButtonsSource: 'user-provided-2026-10-25',
    recordedActions: actions.map((action, i) => ({ ...action, atMs: (i + 1) * 600 }))
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const folder = fileURLToPath(new URL('../../../KeyMouseScript/', import.meta.url))
  const recording = readdirSync(folder).filter(name => /^BetterGI_GCM_\d+\.json$/.test(name)).sort().at(-1)
  if (!recording) throw new Error('没有找到录制')
  const bytes = readFileSync(path.join(folder, recording))
  const record = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''))
  const plan = buildCapturePlan(record, recording,
    createHash('sha256').update(bytes).digest('hex'))
  writeFileSync(new URL('../assets/account-capture-actions.json', import.meta.url), JSON.stringify(plan, null, 2) + '\n')
  writeFileSync(new URL('./fixtures/account-recording-essential.json', import.meta.url), JSON.stringify({
    source: plan.source, info: record.info, macroEvents: record.macroEvents.filter(event => event.type !== 2 && event.type !== 3)
  }, null, 2) + '\n')
  console.log(`已整理 ${recording}：${plan.source.recordedRounds}段、${plan.source.recordedActionCount}个操作，动作等待600毫秒。`)
}
