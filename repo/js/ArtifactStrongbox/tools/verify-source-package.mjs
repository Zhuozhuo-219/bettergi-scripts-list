// 验证公开源码包；不读取真实账号目录，也不运行游戏操作。
import assert from 'node:assert/strict'
import fs from 'node:fs'
const root = new URL('../', import.meta.url)
const read = name => JSON.parse(fs.readFileSync(new URL(name, root), 'utf8'))
for (const name of ['account-reference-ocr.json', 'custom-name-ocr.json', 'traveler-ocr-comparison.json']) {
  const fixture = read('tools/fixtures/' + name)
  assert.equal(fixture.redacted, true, name + '重新生成后必须先脱敏')
  const text = JSON.stringify(fixture)
  for (const match of text.matchAll(/UID\s*[:：]\s*(\d{8,12})/gi)) {
    assert.equal(match[1], '123456789', name + '只能包含演示UID')
  }
}
assert.deepEqual(fs.readdirSync(new URL('data/accounts/', root)), ['README.md'])
for (const folder of ['data/logs', 'data/name-migrations', 'reference-images', 'tools/previews']) {
  assert.equal(fs.existsSync(new URL(folder, root)), false, folder + '不应出现在干净的公开源码包')
}
assert.ok(fs.existsSync(new URL('utils/vendor/LICENSE-miao.txt', root)), '必须保留上游MIT许可')
const manifest = read('manifest.json')
assert.deepEqual(manifest.saved_files, [
  'assets/decision-rules.json', 'assets/character-profiles.json', 'data/accounts', 'data/logs', 'data/name-migrations'
])
console.log('通过：公开源码包脱敏标记、演示UID、个人数据排除及上游许可。')
