import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { deployToRoot, safePath } from './deploy.mjs'

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'strongbox-deploy-'))
const bgi = path.join(fixture, 'BetterGI')
const target = path.join(bgi, 'User', 'JsScript', 'ArtifactStrongbox')
fs.mkdirSync(target, { recursive: true })
fs.writeFileSync(path.join(bgi, 'BetterGI.exe'), 'fixture')
const files = {
  'assets/decision-rules.json': '{"local":"rules"}',
  'assets/character-profiles.json': '{"local":"profiles"}',
  'data/accounts/fixture.json': '{"local":"account"}',
  'data/logs/fixture.json': '{"local":"log"}',
  'data/name-migrations/fixture.json': '{"local":"migration"}'
}
for (const [name, value] of Object.entries(files)) {
  const file = path.join(target, name)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, value)
}
fs.writeFileSync(path.join(target, 'old-code.js'), 'old')
fs.writeFileSync(path.join(target, '.fork-deployment.json'), JSON.stringify({ files: ['old-code.js', ...Object.keys(files)] }))
const result = deployToRoot(bgi, path.join(fixture, 'backups'))
for (const [name, value] of Object.entries(files)) assert.equal(fs.readFileSync(path.join(target, name), 'utf8'), value)
assert.equal(fs.existsSync(path.join(target, 'old-code.js')), false)
assert.equal(fs.readFileSync(path.join(result.backup, 'ArtifactStrongbox', 'old-code.js'), 'utf8'), 'old')
assert.equal(fs.existsSync(path.join(target, 'tools/fixtures')), false)
assert.equal(fs.existsSync(path.join(target, 'utils/vendor/LICENSE-miao.txt')), true)
assert.equal(fs.existsSync(path.join(target, 'assets/images/main-ui.png')), true)
assert.throws(() => safePath(target, '../outside'))
assert.throws(() => safePath(target, '.'))
console.log('通过：独立临时目录部署，保留自定义规则、账号、日志与迁移文件，备份旧文件并限制写入范围。')
