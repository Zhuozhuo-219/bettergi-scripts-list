import { accountFileName } from "./account-store.js"

export function summarizeFrame(frame) {
  return { page: frame.page, uid: frame.uid, identity: frame.identity, dialogName: frame.dialogName,
    artifact: frame.artifact && { name: frame.artifact.name, slot: frame.artifact.slot, level: frame.artifact.level,
      owner: frame.artifact.owner, ownerRaw: frame.artifact.ownerRaw, ownerNormalization: frame.artifact.ownerNormalization,
      complete: frame.artifact.complete, warnings: frame.artifact.warnings },
    recommendations: frame.recommendations,
    identityOcr: (frame.raw || []).filter(item => item.x < 500 && item.y < 110 ||
      item.x >= 1450 && (item.y < 275 || item.y >= 885)).map(item => ({ text: item.text,
      x: item.x, y: item.y, width: item.width, height: item.height, field: item.ocrField, confidence: item.confidence })) }
}

// BGI已验证的覆盖写入接口；分片保持每次写入有界，避免日志随整轮长度反复增长。
export function createRunLogger(options = {}, io = file, warn = message => log.info(message)) {
  let account = "unassigned"
  try { account = accountFileName(options.userIdentifier).path.split("/").pop().replace(/\.json$/, "") } catch { /* 入口随后校验标识 */ }
  const runId = new Date().toISOString().replace(/[:.]/g, "-") + "-" + Math.random().toString(16).slice(2, 10)
  const directory = `data/logs/${account}-${runId}`
  const path = `${directory}/run.json`
  const metadata = { schemaVersion: 2, version: "0.9.3", runId, account, startedAt: new Date().toISOString(),
    mode: options.runCharacterWarehouse ? "account-capture" : options.selectTrainingCharacters ? "training-selection" : "strongbox",
    status: "running", chunks: 0, events: 0 }
  let lines = [], disabled = false, finished = false
  const write = (target, content) => {
    if (disabled) return
    try {
      if (!io.writeTextSync(target, content, false)) throw new Error("写入接口返回失败")
      if (io.readTextSync && io.readTextSync(target) !== content) throw new Error("回读校验不一致")
    } catch (error) {
      disabled = true
      warn(`运行日志写入失败（${target}）：${error.message}；录入数据保存仍独立执行`)
    }
  }
  const update = () => write(path, JSON.stringify(metadata, null, 2))
  update()
  write(`data/logs/${account}.latest.json`, JSON.stringify({ path, runId }, null, 2))
  const event = (type, data = {}) => {
    if (disabled || finished) return
    if (lines.length === 64) lines = []
    const chunk = Math.floor(metadata.events / 64)
    const entry = { sequence: ++metadata.events, at: new Date().toISOString(), type,
      ...data, ...(data.frame ? { frame: summarizeFrame(data.frame) } : {}) }
    lines.push(entry)
    write(`${directory}/events-${String(chunk).padStart(4, "0")}.json`, JSON.stringify(lines, null, 2))
    metadata.chunks = chunk + 1
    update()
  }
  event("run.started", { actionDelayMs: 600, stabilityIntervalMs: 120 })
  return { path, event, finish(status, details = {}) {
    if (finished) return
    event("run.finished", { status, ...details })
    metadata.status = status; metadata.finishedAt = new Date().toISOString(); metadata.details = details
    update(); finished = true
  }, get enabled() { return !disabled } }
}
