// 默认仅预览；--apply先备份主文件、pending、backup及选择文件，再按账号事务顺序提交。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAccountStore } from '../utils/account-store.js'
import { migrateAccountNames } from '../utils/account-name-migration.js'
import { createNameNormalizer, normalizeTravelerLabel } from '../utils/character-names.js'
import { parseAccountFrame } from '../utils/account-reader.js'
import { createHash } from 'node:crypto'
const root = fileURLToPath(new URL('../', import.meta.url))
const dictionary = JSON.parse(fs.readFileSync(path.join(root, 'assets/character-names.json'), 'utf8'))
const descriptions = JSON.parse(fs.readFileSync(path.join(root, 'assets/custom-character-descriptions.json'), 'utf8')).descriptions
const directory = path.join(root, 'data/accounts')
const apply = process.argv.includes('--apply')
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const report = []
const referenceEvidence = []
if (process.argv.includes('--traveler-reference')) {
  const example = JSON.parse(fs.readFileSync(path.join(root, 'tools/fixtures/traveler-ocr-comparison.json'), 'utf8'))
  if (example.redacted) throw new Error('公开仓库的OCR样本已脱敏，不能作为真实账号迁移证据；请在本机重新生成真实参考样本。')
  const actualHash = createHash('sha256').update(fs.readFileSync(path.join(root, example.file))).digest('hex')
  if (actualHash !== example.sha256) throw new Error('旅行者参考图校验失败')
  const frame = parseAccountFrame(example.methods.find(method => method.method === 'original').items)
  const identity = createNameNormalizer(dictionary, descriptions).identity(frame.identity)
  if (!frame.uid || !identity.verified || identity.kind !== 'traveler' || !identity.element) throw new Error('参考图未可靠确认旅行者、元素及UID')
  referenceEvidence.push({ identity, uid: frame.uid, file: example.file, sha256: actualHash })
}
for (const name of fs.readdirSync(directory).filter(name => name.endsWith('.json') && !/\.(pending|backup|training)\.json$/.test(name))) {
  const originalText = fs.readFileSync(path.join(directory, name), 'utf8')
  const primary = JSON.parse(originalText)
  if (primary.schemaVersion !== 1 || !primary.characters || !primary.accountId) continue
  const trainingName = name.replace(/\.json$/, '.training.json')
  const capturedFiles = new Map([name, name.replace(/\.json$/, '.pending.json'), name.replace(/\.json$/, '.backup.json'), trainingName]
    .filter(file => fs.existsSync(path.join(directory, file))).map(file => [file, fs.readFileSync(path.join(directory, file), 'utf8')]))
  if (capturedFiles.get(name) !== originalText) throw new Error('读取期间主文件变化，请结束录入后再迁移')
  const store = createAccountStore(primary.accountId, {
    isExists: file => capturedFiles.has(path.basename(file)), readTextSync: file => capturedFiles.get(path.basename(file))
  })
  if (path.basename(store.path) !== name) throw new Error('主文件名与内部账号标识不一致')
  const input = store.snapshot()
  const migration = migrateAccountNames(input, dictionary, descriptions, referenceEvidence)
  let nextSelection = null
  if (capturedFiles.has(trainingName)) {
    const selection = JSON.parse(capturedFiles.get(trainingName))
    if (selection.accountId !== input.accountId || !Array.isArray(selection.characters)) throw new Error('选择文件格式或账号不匹配')
    const normalizer = createNameNormalizer(dictionary, descriptions, () => migration.data.characters)
    nextSelection = { ...selection, characters: [...new Set(selection.characters.map(name => normalizer.owner(normalizeTravelerLabel(name)).name || name))], updatedAt: new Date().toISOString() }
  }
  const accountReport = { accountId: input.accountId, before: Object.keys(input.characters).length,
    after: Object.keys(migration.data.characters).length, changes: migration.changes,
    ownerCorrections: migration.ownerCorrections, unresolved: migration.unresolved }
  report.push(accountReport)
  if (!apply) continue
  for (const [file, text] of capturedFiles) if (fs.readFileSync(path.join(directory, file), 'utf8') !== text) throw new Error('录入文件在迁移期间变化，停止以免覆盖新数据')
  const backup = path.join(root, 'data/name-migrations', stamp)
  fs.mkdirSync(backup, { recursive: true })
  for (const [file, text] of capturedFiles) fs.writeFileSync(path.join(backup, file), text)
  const next = { ...migration.data, revision: input.revision + 1, updatedAt: new Date().toISOString(),
    nameMigration: { at: new Date().toISOString(), dictionaryVersion: dictionary.gameVersion, backup: path.relative(root, backup), changes: migration.changes } }
  const checkedWrite = (file, data) => {
    const text = JSON.stringify(data, null, 2)
    fs.writeFileSync(path.join(directory, file), text)
    if (fs.readFileSync(path.join(directory, file), 'utf8') !== text) throw new Error('迁移后回读失败')
  }
  checkedWrite(name.replace(/\.json$/, '.pending.json'), next)
  checkedWrite(name.replace(/\.json$/, '.backup.json'), input)
  checkedWrite(name, next)
  if (nextSelection) checkedWrite(trainingName, nextSelection)
}
if (apply && report.length) fs.writeFileSync(path.join(root, 'data/name-migrations', stamp, 'report.json'), JSON.stringify(report, null, 2))
console.log(JSON.stringify({ applied: apply, backup: apply ? `data/name-migrations/${stamp}` : null, accounts: report }, null, 2))
