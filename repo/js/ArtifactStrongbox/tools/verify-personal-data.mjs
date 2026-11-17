// 只读运行目录，报告写到显式指定的外部路径。个人资料不导入源码。
import fs from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'
import { createStrongboxSession, presentCandidateProjection } from '../utils/strongbox-candidates.js'
import { createProjectionService } from '../utils/artifact-projection.js'
import { evaluateArtifact } from '../utils/artifact-decision.js'

const runtime = process.argv[2]
const output = process.argv[3]
const legacyRoot = process.argv[4]
const legacyModule = legacyRoot ? await import(pathToFileURL(path.join(legacyRoot, 'utils/artifact-projection.js')).href) : null
if (!runtime || !output) throw new Error('Usage: node tools/verify-personal-data.mjs <runtime-script-directory> <external-report.json>')
const source = path.resolve(import.meta.dirname, '..')
const reportPath = path.resolve(output)
if (!path.relative(source, reportPath).startsWith('..')) throw new Error('个人验证报告请写到源码目录以外')
const read = name => fs.readFileSync(path.join(runtime, name), 'utf8')
const io = { isExists: name => fs.existsSync(path.join(runtime, name)), readTextSync: read }
const report = { version: '0.10.0', accountCount: 0, characterCount: 0, artifacts: 0, evaluatedRoles: 0,
  decisions: {}, elapsedMs: 0, maxMs: 0, convolutions: 0, cachedConvolutions: 0 }
if (legacyModule) report.legacyComparison = { artifacts: 0, rows: 0, elapsedMs: 0, maxQuantileDifference: 0, legacyUnknownRows: 0, revisedUnknownRows: 0 }
const files = fs.readdirSync(path.join(runtime, 'data/accounts')).filter(name => /^(uid-\d+|id-[^.]+)\.json$/.test(name))
const artifacts = new Map()
const logs = path.join(runtime, 'data/logs')
for (const directory of fs.readdirSync(logs).sort().reverse().slice(0, 16)) {
  const folder = path.join(logs, directory)
  if (!fs.statSync(folder).isDirectory()) continue
  for (const name of fs.readdirSync(folder).filter(name => /^events-.*\.json$/.test(name))) {
    const events = JSON.parse(fs.readFileSync(path.join(folder, name), 'utf8'))
    for (const event of events) {
      if (event.type !== 'strongbox.snapshot' || !event.ready || !event.artifact) continue
      const item = event.artifact
      artifacts.set(JSON.stringify([item.name, item.level, item.subStats]), item)
    }
  }
}
for (const name of files) {
  const account = JSON.parse(read('data/accounts/' + name))
  const session = createStrongboxSession({ userIdentifier: account.accountId }, [], io)
  const records = session.assessmentRecords()
  report.accountCount++
  report.characterCount += session.controls().catalog.length
  const service = createProjectionService({ returnAllRows: true }, [], records)
  const legacyService = legacyModule?.createProjectionService({ returnAllRows: true, simulationCount: 10000 }, [], records)
  for (const artifact of [...artifacts.values()].slice(0, 24)) {
    const candidates = session.candidates(artifact)
    const ids = candidates.flatMap(row => row.profileIds)
    const started = performance.now()
    const raw = await service.calculate(artifact, {}, ids, session.controls().flags)
    const projection = presentCandidateProjection(raw, candidates)
    const elapsed = performance.now() - started
    const decision = evaluateArtifact(artifact, { schemaVersion: 1, rules: [] }, projection, session.controls())
    report.artifacts++
    report.evaluatedRoles += projection.assessmentSummary?.total || 0
    report.decisions[decision.reasonCode] = (report.decisions[decision.reasonCode] || 0) + 1
    report.elapsedMs += elapsed
    report.maxMs = Math.max(report.maxMs, elapsed)
    if (legacyService) {
      const oldStarted = performance.now()
      const old = await legacyService.calculate(artifact, {}, ids, session.controls().flags)
      report.legacyComparison.elapsedMs += performance.now() - oldStarted
      report.legacyComparison.artifacts++
      for (const row of raw.rows) {
        const previous = old.rows.find(item => item.id === row.id)
        if (!previous) continue
        report.legacyComparison.rows++
        report.legacyComparison.maxQuantileDifference = Math.max(report.legacyComparison.maxQuantileDifference,
          Math.abs(row.top20 - previous.top20), Math.abs(row.top80 - previous.top80))
        if (previous.assessment?.status === 'unknown') report.legacyComparison.legacyUnknownRows++
        if (row.assessment?.status === 'unknown') report.legacyComparison.revisedUnknownRows++
      }
    }
    const previous = service.distributionStats.convolutions
    await service.calculate(artifact, {}, ids, { ...session.controls().flags, excludeLowInitialStats: true })
    if (service.distributionStats.convolutions !== previous) throw new Error('切换特征提示重复进行了卷积')
  }
  report.convolutions += service.distributionStats.convolutions
  report.cachedConvolutions += service.distributionStats.hits
}
if (!report.artifacts) throw new Error('没有找到可验证的已识别素材日志')
report.elapsedMs = Math.round(report.elapsedMs)
report.maxMs = Math.round(report.maxMs)
fs.mkdirSync(path.dirname(reportPath), { recursive: true })
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report))
