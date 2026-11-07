// 开发预览：只读账号资料，将交互遮罩导出成浏览器可独立打开的HTML；不执行游戏输入或账号写回。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createStrongboxSession, presentCandidateProjection } from '../utils/strongbox-candidates.js'
import { createProjectionService } from '../utils/artifact-projection.js'
import { annotateArtifactEnhancement } from '../utils/artifact-enhancement.js'
const root = fileURLToPath(new URL('../', import.meta.url))
const io = { isExists: name => fs.existsSync(path.join(root, name)), readTextSync: name => fs.readFileSync(path.join(root, name), 'utf8') }
const session = createStrongboxSession({ userIdentifier: process.argv[2] || 'preview', artifactCountEstimate: process.argv[3] || '2600' }, [], io)
const artifact = annotateArtifactEnhancement({ name: '黄金之夜的喧嚣', slot: '空之杯', level: 0, setName: '黄金剧团',
  mainStat: { name: '生命值', percent: true, value: 7 }, warnings: [], fourthSubStat: { label: '初始四词条', detail: '第 4 条已生效' },
  subStats: [['暴击率', 3.1], ['暴击伤害', 7.8], ['攻击力', 4.7], ['元素充能效率', 5.8]]
    .map(([name, value], rowIndex) => ({ name, value, rowIndex, percent: true, activation: 'active' })) })
const candidates = session.candidates(artifact)
const assessmentOptions = { respectExistingSets: process.argv[4] !== 'ignore-sets' }
const projection = presentCandidateProjection(await createProjectionService({ simulationCount: 1000, returnAllRows: true }, [], session.assessmentRecords())
  .calculate(artifact, {}, candidates.flatMap(row => row.profileIds), assessmentOptions), candidates)
const payload = { state: 'ready', artifact, decision: { label: '待人工判断', status: 'unknown', reasons: [] }, projection,
  controls: { ...session.controls(), flags: { ...session.controls().flags, ...assessmentOptions }, accountId: '界面预览', interactive: true }, showRegion: false }
const html = fs.readFileSync(path.join(root, 'assets/strongbox-mask.html'), 'utf8')
  .replace('<script>', '<script>window.htmlMask={};</script><script>')
  .replace('</body>', `<script>window.htmlMask.onMessage({url:'/artifact',data:${JSON.stringify(payload).replace(/</g, '\\u003c')}});document.body.style.background='#293244';</script></body>`)
fs.mkdirSync(path.join(root, 'tools/previews'), { recursive: true })
fs.writeFileSync(path.join(root, 'tools/previews/strongbox.html'), html)
fs.writeFileSync(path.join(root, 'tools/previews/strongbox-characters.html'), html.replace('</body>', "<script>document.getElementById('character-picker').hidden=false;</script></body>"))
console.log('预览已生成：tools/previews/strongbox.html；角色：' + session.controls().catalog.length + '，候选：' + candidates.length)
