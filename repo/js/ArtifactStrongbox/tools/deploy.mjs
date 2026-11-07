// 从 Fork 源码部署；保留 manifest.saved_files，不清空整个运行目录。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const sourceRoot = fileURLToPath(new URL('../', import.meta.url))
const repoRoot = path.resolve(sourceRoot, '../../..')
const runtimeFiles = new Set(['main.js', 'manifest.json', 'settings.json', 'package.json', 'README.md', 'CHANGELOG.md', 'RELEASE.md', 'FORK.md'])
const runtimeDirs = new Set(['assets', 'utils', 'docs'])
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-')

function execute(command, args, cwd = repoRoot) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', windowsHide: true })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || `${command} failed`).trim())
  return result.stdout || ''
}

export function safePath(root, relative) {
  const destination = path.resolve(root, relative)
  const back = path.relative(root, destination)
  if (!back || back === '..' || back.startsWith(`..${path.sep}`) || path.isAbsolute(back)) throw new Error(`Unsafe path: ${relative}`)
  return destination
}

function rejectLinks(file) {
  if (fs.lstatSync(file).isSymbolicLink()) throw new Error(`不支持链接目录或文件：${file}`)
  if (fs.statSync(file).isDirectory()) for (const name of fs.readdirSync(file)) rejectLinks(path.join(file, name))
}

function writeFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = file + `.tmp-${process.pid}`
  fs.writeFileSync(temporary, content)
  fs.renameSync(temporary, file)
}

function listRuntimeFiles() {
  const entries = []
  function visit(directory, relative = '') {
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const name = relative ? relative + '/' + item.name : item.name
      if (!relative && !runtimeFiles.has(item.name) && !runtimeDirs.has(item.name) && item.name !== 'data') continue
      if (name.startsWith('data/') && name !== 'data/accounts' && name !== 'data/accounts/README.md') continue
      if (item.isSymbolicLink()) throw new Error(`源码包含链接：${name}`)
      if (item.isDirectory()) visit(path.join(directory, item.name), name)
      else if (item.isFile()) entries.push(name)
    }
  }
  visit(sourceRoot)
  for (const required of ['main.js', 'manifest.json', 'settings.json']) if (!entries.includes(required)) throw new Error(`缺少 ${required}`)
  return entries
}

export function deployToRoot(bgiRoot, backupBase = path.join(path.dirname(path.resolve(bgiRoot)), 'BetterGI-Dev', 'backups')) {
  bgiRoot = path.resolve(bgiRoot)
  if (!fs.existsSync(path.join(bgiRoot, 'BetterGI.exe'))) throw new Error('目标目录缺少 BetterGI.exe')
  const target = path.join(bgiRoot, 'User', 'JsScript', 'ArtifactStrongbox')
  const manifest = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'manifest.json'), 'utf8'))
  const saved = manifest.saved_files.map(name => name.replace(/\\/g, '/').replace(/\/$/, ''))
  for (const name of saved) safePath(target, name)
  const preserved = name => saved.some(entry => name === entry || name.startsWith(entry + '/'))
  const files = listRuntimeFiles()
  const backup = path.join(backupBase, 'ArtifactStrongbox-' + stamp())
  fs.mkdirSync(backup, { recursive: true })
  if (fs.existsSync(target)) {
    rejectLinks(target)
    fs.cpSync(target, path.join(backup, 'ArtifactStrongbox'), { recursive: true })
  }
  fs.mkdirSync(target, { recursive: true })
  const marker = path.join(target, '.fork-deployment.json')
  const previous = fs.existsSync(marker) ? JSON.parse(fs.readFileSync(marker, 'utf8')) : { files: [] }
  for (const name of previous.files) {
    if (files.includes(name) || preserved(name)) continue
    const file = safePath(target, name)
    if (fs.existsSync(file) && fs.statSync(file).isFile()) fs.unlinkSync(file)
  }
  const kept = []
  for (const name of files) {
    const destination = safePath(target, name)
    if (preserved(name) && fs.existsSync(destination)) { kept.push(name); continue }
    writeFile(destination, fs.readFileSync(safePath(sourceRoot, name)))
  }
  writeFile(marker, JSON.stringify({ commit: execute('git', ['rev-parse', 'HEAD']).trim(),
    deployedAt: new Date().toISOString(), files }, null, 2) + '\n')
  return { target, backup, kept, fileCount: files.length }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2)
    if (args.length !== 2 || args[0] !== '--bgi-root') throw new Error('Usage: node tools/deploy.mjs --bgi-root E:\\BetterGI')
    const tasks = execute('tasklist.exe', ['/FI', 'IMAGENAME eq BetterGI.exe', '/FO', 'CSV', '/NH'])
    if (/^"BetterGI\.exe",/im.test(tasks)) throw new Error('请先从托盘退出 BetterGI，再部署脚本。')
    if (execute('git', ['branch', '--show-current']).trim() !== 'custom/fishing-area-priority') throw new Error('请切换到 custom/fishing-area-priority 分支')
    if (execute('git', ['status', '--porcelain']).trim()) throw new Error('请先提交工作区修改，再部署已确认的源码。')
    process.stdout.write(execute(process.execPath, ['tools/verify-all.mjs'], sourceRoot))
    console.log(JSON.stringify(deployToRoot(args[1]), null, 2))
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
