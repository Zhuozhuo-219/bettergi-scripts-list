import { REGIONS, readSnapshot } from "./utils/artifact-reader.js"
import { loadDecisionDatabase, evaluateArtifact } from "./utils/artifact-decision.js"
import { createProjectionService, loadProjectionProfiles } from "./utils/artifact-projection.js"
import { runAccountCapture } from "./utils/account-capture.js"
import { resolveTrainingCharacters } from "./utils/training-characters.js"
import { createRunLogger } from "./utils/run-logger.js"
import { createStrongboxSession, presentCandidateProjection } from "./utils/strongbox-candidates.js"
import { createMaskInteraction } from "./utils/mask-interaction.js"

const MASK_PATH = "assets/strongbox-mask.html"
let maskWindowId = null
let cancellationToken = null
let runLogger = null
let failed = false
let lastLoggedSnapshot = null
let maskInteraction = null

function closeMask() {
  const id = maskWindowId
  maskWindowId = null
  if (!id) return
  try {
    if (htmlMask.exists(id)) htmlMask.close(id)
  } catch {
    // 停止任务时 BGI 可能已经清理了窗口。
  }
}

(async function () {
  try {
    setGameMetrics(1920, 1080, 1)
    cancellationToken = dispatcher.getLinkedCancellationToken()
    const options = typeof settings === "undefined" ? {} : settings
    runLogger = createRunLogger(options)
    log.info(runLogger.enabled === false ? "详细运行日志不可用，请查看BGI日志中的姓名复核读数" : `本次运行日志：${runLogger.path}`)
    if (options.runCharacterWarehouse === true) {
      await runAccountCapture(options, cancellationToken, runLogger)
      return
    }
    const customProfiles = loadProjectionProfiles()
    if (options.selectTrainingCharacters === true) {
      await resolveTrainingCharacters(options, customProfiles, cancellationToken)
      return
    }
    const session = createStrongboxSession(options, customProfiles)
    const database = loadDecisionDatabase()
    const projectionService = createProjectionService({ ...options, returnAllRows: true }, customProfiles, session.assessmentRecords?.() || {})
    const configuredInterval = Number(options.pollInterval)
    const interval = Number.isFinite(configuredInterval) && configuredInterval > 0
      ? Math.max(500, Math.round(configuredInterval)) : 1000

    maskWindowId = htmlMask.show(MASK_PATH, `artifact-strongbox-${Date.now()}`)
    if (!maskWindowId) throw new Error("无法创建三合一素材判断遮罩")
    maskInteraction = createMaskInteraction(maskWindowId)
    // 后续每轮都推送状态，避免页面首次加载时漏掉一次消息后一直空白。
    await sleep(200)
    log.info("三合一素材判断已启动：按F7切换遮罩交互，可选择培养角色、筛选来源及滚动列表；再次F7返回游戏操作。")
    let previousSnapshot = null
    let controlError = ""

    while (!cancellationToken.isCancellationRequested && htmlMask.exists(maskWindowId)) {
      for (let count = 0; count < 32; count++) {
        const message = htmlMask.poll(maskWindowId)
        if (!message) break
        let event
        try { event = JSON.parse(message) } catch { continue }
        if (event.url === "/strongbox/game") { maskInteraction.setInteractive(false); continue }
        if (event.url !== "/strongbox/filter") continue
        try {
          const controls = session.update(typeof event.data === "string" ? JSON.parse(event.data) : event.data)
          controlError = ""
          runLogger.event("strongbox.filter", { selected: controls.selected, flags: controls.flags })
        } catch (error) { controlError = String(error.message || error) }
      }
      // 交互模式暂停游戏截图，保留上一件信息，避免全屏WebView影响游戏操作和识别。
      const snapshot = maskInteraction.interactive && previousSnapshot ? previousSnapshot : readSnapshot()
      previousSnapshot = snapshot
      const hasDetail = Boolean(snapshot.artifact.slot && snapshot.artifact.mainStat)
      const ready = snapshot.onStrongboxPage && hasDetail
      const snapshotKey = JSON.stringify([snapshot.onStrongboxPage, snapshot.rawText, snapshot.markerText])
      if (snapshotKey !== lastLoggedSnapshot) {
        runLogger.event("strongbox.snapshot", { ready, artifact: snapshot.artifact, rawText: snapshot.rawText, markerText: snapshot.markerText })
        lastLoggedSnapshot = snapshotKey
      }
      const candidates = ready ? session.candidates(snapshot.artifact) : []
      const profileIds = [...new Set(candidates.flatMap(candidate => candidate.profileIds))]
      const assessmentOptions = { respectExistingSets: session.controls().flags.respectExistingSets !== false }
      const cachedProjection = ready ? projectionService.cached(snapshot.artifact, profileIds, assessmentOptions) : null
      const payload = {
        state: ready ? "ready" : "waiting",
        message: !snapshot.onStrongboxPage
          ? "等待还圣奥迹素材选择界面（未识别到底部按钮）"
          : "请点击一件圣遗物，显示完整详情",
        artifact: ready ? snapshot.artifact : null,
        decision: ready ? evaluateArtifact(snapshot.artifact, database) : null,
        projection: ready ? presentCandidateProjection(cachedProjection, candidates) || { state: "computing", rows: [] } : null,
        controls: { ...session.controls(), interactive: maskInteraction.interactive, error: controlError },
        region: REGIONS.detail,
        showRegion: options.showRegion === true,
        capturedAt: snapshot.capturedAt
      }
      // 每次重建完整状态；离开界面或识别失败时立即清空上一件的结果。
      htmlMask.send(maskWindowId, "/artifact", JSON.stringify(payload))
      if (ready && !cachedProjection) {
        const computed = await projectionService.calculate(snapshot.artifact, {
          isCancelled: () => cancellationToken.isCancellationRequested,
          yieldControl: () => sleep(1)
        }, profileIds, assessmentOptions)
        runLogger.event("strongbox.assessments", { name: snapshot.artifact.name, slot: snapshot.artifact.slot,
          level: snapshot.artifact.level, setName: snapshot.artifact.setName, capacity: session.controls().capacity,
          assessmentOptions,
          summary: presentCandidateProjection(computed, candidates)?.assessmentSummary,
          rows: computed.rows.map(row => ({ name: row.name, id: row.id, assessment: row.assessment })) })
        // 下一轮重新截图确认当前圣遗物后才发送结果，防止计算期间切换造成串件。
      }
      await sleep(maskInteraction.interactive ? 120 : interval)
    }
  } catch (error) {
    failed = true
    runLogger?.event("run.error", { message: String(error.message || error), stack: String(error.stack || "").slice(0, 8000) })
    if (!cancellationToken?.isCancellationRequested) {
      log.error(`圣遗物脚本运行失败：${error.message || error}`)
      throw error
    }
  } finally {
    try { maskInteraction?.dispose() } catch { /* BGI停止时仍继续关闭遮罩与日志。 */ }
    runLogger?.finish(cancellationToken?.isCancellationRequested ? "cancelled" : failed ? "failed" : "complete")
    closeMask()
  }
})()
