import assert from 'node:assert/strict'
import fs from 'node:fs'
import { parseAccountFrame } from '../utils/account-reader.js'
import { createNameNormalizer, normalizeTravelerLabel, TRAVELER_ELEMENTS } from '../utils/character-names.js'
import { migrateAccountNames } from '../utils/account-name-migration.js'
import { getCharacterProfiles, validateProfileDatabase } from '../utils/projection-model.js'
import { createTrainingStore } from '../utils/training-characters.js'
const read = path => JSON.parse(fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8'))
const dictionary = read('assets/character-names.json')
const descriptions = read('assets/custom-character-descriptions.json').descriptions
const example = read('tools/fixtures/traveler-ocr-comparison.json')
assert.equal(example.redacted, true, '公开回归样本必须脱敏；这里不校验或分发私人参考图')
const original = example.methods.find(row => row.method === 'original')
let originalIdentity, originalFrame
for (const method of example.methods) {
  const replaced = new Set(method.items.map(item => item.ocrField))
  const items = [...original.items.filter(item => !replaced.has(item.ocrField)), ...method.items]
  const frame = parseAccountFrame(items)
  const identity = createNameNormalizer(dictionary, descriptions).identity(frame.identity)
  assert.equal(identity.verified, true, method.method)
  assert.equal(identity.displayName, '旅行者（冰）')
  assert.equal(identity.customName, '示例')
  assert.equal(identity.kind, 'traveler')
  if (method.method === 'original') { originalIdentity = identity; originalFrame = frame }
}
assert.ok(original.results.every(row => row.editDistance === 0))
assert.ok(example.methods.find(row => row.method === 'otsu').results.find(row => row.field === 'biography').editDistance > 0,
  '单张实图说明二值化不一定提升准确率，不据此修改默认OCR')
const evidence = [{ uid: originalFrame.uid, identity: originalIdentity, file: example.file, sha256: example.sha256 }]
const data = { accountId: originalFrame.uid, observedUid: originalFrame.uid, characters: { old: {
  identity: { displayName: '示例', headerName: '示例', panelName: '示例', element: '冰', verified: true }, slots: {}
} } }
const migrated = migrateAccountNames(data, dictionary, descriptions, evidence)
const identity = Object.values(migrated.data.characters)[0].identity
assert.equal(identity.displayName, '旅行者（冰）')
assert.equal(identity.referenceEvidence.sha256, example.sha256)
assert.equal(Object.values(migrateAccountNames({ ...data, observedUid: '999999999' }, dictionary, descriptions, evidence).data.characters)[0].identity.displayName, '示例',
  '其他账号不得使用此参考图迁移')
const travelers = getCharacterProfiles().filter(profile => profile.character === '旅行者')
assert.equal(travelers.length, 7)
assert.deepEqual(new Set(travelers.map(profile => profile.name)), new Set(TRAVELER_ELEMENTS.map(elem => `旅行者（${elem}）`)))
assert.throws(() => validateProfileDatabase({ schemaVersion: 1, profiles: [{ id: 'unknown-traveler', character: '旅行者' }] }), /必须指定/)
assert.equal(normalizeTravelerLabel('旅行者(冰)'), '旅行者（冰）')
const memory = new Map()
const io = { isExists: path => memory.has(path), readTextSync: path => memory.get(path), writeTextSync: (path, text) => { memory.set(path, text); return true } }
const store = createTrainingStore('legacy-traveler', io)
memory.set(store.path, JSON.stringify({ schemaVersion: 1, accountId: 'legacy-traveler', characters: ['旅行者·火'] }))
assert.deepEqual(store.read(), ['旅行者（火）'], '旧选择名单兼容，无需重新选人')
console.log('通过：脱敏旅行者OCR、跨账号保护、七元素分支及旧选择名单兼容；不含私人参考图验收。')
