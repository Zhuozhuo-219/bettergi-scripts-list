import { SLOTS } from "./artifact-reader.js"
import { createAccountReader, ownershipObservation, cleanName, resolveIdentityConsensus, accountCaptureTargets, hasEquippedOwner } from "./account-reader.js"
import { cleanSetRow, cleanCharacterRecord, isCharacterComplete } from "./account-data-quality.js"
import { createAccountStore, characterKey } from "./account-store.js"
import { loadCharacterNames, createNameNormalizer } from "./character-names.js"

const RETRIES = 6
const MAX_CHARACTERS = 256
const MAX_DURATION_MS = 4 * 60 * 60 * 1000
const DATA_READS = 4
const MIN_SET_USAGE = 10
export const RECOMMENDATION_ICON_POINTS = [[[925, 125], [1065, 125]], [[925, 225], [1062, 225]], [[925, 325], [1065, 325]]]
const SCOPE_LABELS = { world: "大世界界面", identity: "角色名称", overview: "角色概览身份", detail: "圣遗物详情", page: "当前页面", recommendation: "推荐面板", setDialog: "套装名称" }

export function captureTiming(plan) {
  const configured = Number(plan.minimumActionIntervalMs)
  return {
    actionDelayMs: Number.isFinite(configured) && configured > 0 ? Math.min(1000, Math.max(500, configured)) : 600,
    stabilityIntervalMs: 120
  }
}

export function semanticFrame(frame, scope) {
  const stringify = value => JSON.stringify(value, (key, field) => ["raw", "ownerText", "ownerRaw", "ownerNormalization"].includes(key) ? undefined : field)
  if (scope === "world") return frame.page
  if (scope === "identity") return JSON.stringify([frame.page, frame.identity.displayName, frame.identity.customName || ""])
  if (scope === "overview") return JSON.stringify([frame.page, frame.identity.displayName])
  if (scope === "recommendation") return stringify([frame.page, frame.artifact?.slot, frame.recommendations && {
    ...frame.recommendations, setRows: frame.recommendations.setRows.filter(row => row.usageRate === null || row.usageRate >= MIN_SET_USAGE)
  }])
  if (scope === "setDialog") return JSON.stringify([frame.page, frame.dialogName])
  if (scope === "detail") return stringify([frame.page, frame.artifact])
  return JSON.stringify([frame.page, frame.header, frame.artifact?.slot])
}

export function createCaptureController(runtime, plan, token) {
  const timing = captureTiming(plan)
  const started = runtime.now()
  const guard = () => {
    if (token.isCancellationRequested) throw new Error("账号录入已取消")
    if (runtime.now() - started > MAX_DURATION_MS) throw new Error("账号录入超过4小时，已保留进度")
  }
  const wait = async (milliseconds = timing.actionDelayMs) => { guard(); await runtime.sleep(milliseconds); guard() }
  return {
    guard, wait,
    async press(key) { guard(); runtime.trace?.("action.key", { key }); runtime.keyPress(key); await wait() },
    async click(point) { guard(); runtime.trace?.("action.click", { point }); runtime.click(point[0], point[1]); await wait() },
    async stable(scope, predicate, attempts = RETRIES, captureScope = scope) {
      const seen = new Map()
      const frames = []
      let last = null
      for (let n = 0; n < attempts; n++) {
        guard()
        last = runtime.capture(captureScope)
        frames.push(last)
        const key = predicate(last) ? semanticFrame(last, scope) : null
        runtime.trace?.("recognition.sample", { scope, captureScope, attempt: n + 1, accepted: key !== null, frame: last })
        if (key !== null) {
          const entry = seen.get(key) || { count: 0, frame: last }
          const quality = frame => scope === "identity" ? Number(Boolean(frame.identity.element)) +
            Number(frame.identity.level !== null) + Number(Boolean(frame.uid)) + Number(!frame.identity.conflicts)
            : Number(Boolean(frame.uid))
          if (quality(last) >= quality(entry.frame)) entry.frame = last
          if (++entry.count >= 2) return entry.frame
          seen.set(key, entry)
        }
        if (n === 2) runtime.info(`识别复核：${SCOPE_LABELS[scope] || scope}仍未稳定，正在重试…`)
        if (n + 1 < attempts) await wait(timing.stabilityIntervalMs)
      }
      const error = new Error(`未稳定识别${SCOPE_LABELS[scope] || scope}（最后页面：${last?.page || "unknown"}）`)
      error.frames = frames
      throw error
    }
  }
}

export async function captureAccount(runtime, store, plan, token = { isCancellationRequested: false }, options = {}) {
  if (plan.schemaVersion !== 1 || !Array.isArray(plan.slots) || plan.slots.join() !== SLOTS.join()) {
    throw new Error("角色录入动作参考格式不正确，请重新生成")
  }
  const flow = createCaptureController(runtime, plan, token)
  const scan = { status: "running", startedAt: runtime.timestamp(), visited: [], saved: 0,
    incomplete: 0, skipped: 0, sourceRecording: plan.source.recording, sourceRecordingSha256: plan.source.sha256,
    collectorVersion: "0.9.3", captureSize: [1920, 1080], minimumActionIntervalMs: captureTiming(plan).actionDelayMs,
    stabilityIntervalMs: captureTiming(plan).stabilityIntervalMs,
    errors: [] }
  let draft = null
  let worldConfirmed = false
  const checkpoint = () => store.checkpoint(scan)
  const rosterPage = frame => ["attributes", "overview"].includes(frame.page)
  const ensureWorld = async () => {
    for (let n = 0; n < 12; n++) {
      const frame = runtime.capture("world")
      if (frame.page === "world") {
        await flow.stable("world", next => next.page === "world")
        return
      }
      await flow.press("VK_ESCAPE")
    }
    throw new Error("多次Esc仍未识别大世界派蒙图标，请先退出对话、加载或特殊界面")
  }
  const readIdentity = async () => {
    const evidence = []
    const accept = (frame, attempts) => {
      store.bindUid(frame.uid)
      const identity = { ...frame.identity, recognitionAttempts: attempts }
      if (!identity.element) {
        const matches = Object.values(store.snapshot().characters).filter(character =>
          cleanName(character.identity?.displayName) === cleanName(identity.displayName))
        if (matches.length === 1) identity.element = matches[0].identity.element || ""
      }
      runtime.trace?.("identity.confirmed", { identity })
      store.saveCharacter({ identity, slots: {}, recommendations: {} })
      runtime.confirmIdentity?.(identity)
      runtime.info(`识别角色：${identity.displayName}（${identity.level === null ? "等级未读清" : `${identity.level}级`}）`)
      return identity
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt) runtime.info("角色名称未确认：重新点击属性并复核左上、右侧姓名（重试1/1）")
      await flow.click(plan.buttons.attributes)
      try {
        const frame = await flow.stable("identity", item => rosterPage(item) && item.identity.verified,
          DATA_READS, attempt ? "identityRetry" : "identity")
        return accept(frame, attempt + 1)
      } catch (error) {
        flow.guard()
        if (/UID|用户标识已绑定/.test(String(error.message))) throw error
        evidence.push(...(error.frames || []))
        const last = error.frames?.at(-1)?.identity
        if (last) runtime.info(`姓名复核读数：左上“${last.headerName || last.header || "未读到"}”，右侧“${last.panelName || last.panelCandidate || "未读到"}”；${last.rejectionReason || "尚未形成两帧一致结果"}`)
        if (attempt) {
          const consensus = resolveIdentityConsensus(evidence)
          if (consensus) {
            for (const sample of evidence) store.bindUid(sample.uid)
            runtime.info(`角色姓名已通过${consensus.identity.consensus.frames}帧交叉复核`)
            runtime.trace?.("identity.consensus", { identity: consensus.identity })
            return accept(consensus, 2)
          }
          runtime.trace?.("identity.unresolved", { observations: evidence.map(frame => ({ page: frame.page, identity: frame.identity })) })
          if (last) error.message += `；左上“${last.headerName || last.header || "未读到"}”，右侧“${last.panelName || last.panelCandidate || "未读到"}”`
          throw error
        }
      }
    }
  }
  const readArtifact = async slot => {
    let lastError
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt) {
        runtime.info(`${slot}详情或装备者未确认：重新点击该部位（重试1/1）`)
        if (runtime.capture("page").page !== "detail") throw lastError
        await flow.click(plan.slotButtons[SLOTS.indexOf(slot)])
      }
      try {
        const frame = await flow.stable("detail", item => item.page === "detail" && item.artifact?.slot === slot &&
          item.artifact.complete && (attempt || hasEquippedOwner(item.artifact)), DATA_READS, attempt ? "detailRetry" : "detail")
        store.bindUid(frame.uid)
        if (!attempt && cleanName(frame.artifact.owner) !== cleanName(draft.identity.displayName)) {
          lastError = new Error("装备者与当前角色不符，重新核对一次")
          runtime.info(`${slot}识别装备者为${frame.artifact.owner}，与${draft.identity.displayName}不符，复核一次`)
          continue
        }
        frame.artifact = { ...frame.artifact, recognitionAttempts: attempt + 1,
          recognitionSource: attempt ? "focused-retry" : "right-panel" }
        return frame
      } catch (error) { flow.guard(); lastError = error }
    }
    // 身份或UID冲突不能降级接受；详情的第二次失败则保留未确认观察，继续其他部位。
    if (/UID|用户标识已绑定/.test(String(lastError?.message))) throw lastError
    const state = runtime.capture("page")
    if (state.page !== "detail" || state.artifact?.slot !== slot) throw lastError
    const frame = [...(lastError?.frames || [])].reverse().find(item => item.page === "detail" && item.artifact?.slot === slot)
      || runtime.capture("detailRetry")
    if (!frame.artifact || frame.artifact.slot !== slot) throw lastError
    frame.artifact = { ...frame.artifact, complete: false,
      recognitionAttempts: 2, recognitionSource: "unconfirmed-after-retry",
      warnings: [...frame.artifact.warnings, "重试后仍未稳定，保留待核对"] }
    scan.errors.push({ character: draft.identity.displayName, slot, stage: "artifact", message: String(lastError?.message) })
    runtime.info(`${slot}重试后仍未读全：已保留待核对结果，继续下一项`)
    return frame
  }
  const ensureOverview = async (identity, requireOverview = false) => {
    const matches = frame => rosterPage(frame) && (!requireOverview || frame.page === "overview") &&
      frame.identity.verified && !frame.identity.conflicts && cleanName(frame.identity.displayName) === cleanName(identity.displayName)
    runtime.trace?.("overview.check", { expected: identity.displayName, requireOverview })
    try { return await flow.stable("overview", matches, DATA_READS, "page") } catch (error) {
      flow.guard()
      runtime.trace?.("overview.recheck", { expected: identity.displayName, message: error.message })
      runtime.info(`概览姓名未确认：返回属性页复核${identity.displayName}`)
      const confirmed = await readIdentity()
      if (cleanName(confirmed.displayName) !== cleanName(identity.displayName)) {
        runtime.trace?.("identity.mismatch", { expected: identity.displayName, observed: confirmed })
        throw new Error(`角色身份复核不符：预期${identity.displayName}，实际${confirmed.displayName}，停止以避免装备串角色`)
      }
      if (requireOverview) {
        await flow.click(plan.buttons.artifacts)
        return flow.stable("overview", matches, DATA_READS, "page")
      }
      return { page: "attributes", identity: confirmed }
    }
  }
  const closeRecommendation = async () => {
    await flow.click(plan.buttons.recommendation)
    return flow.stable("page", frame => frame.page === "detail")
  }
  const readRecommendation = async (slot, resolveSets) => {
    runtime.info(`${slot}：读取圣遗物推荐`)
    await flow.click(plan.buttons.recommendation)
    const frame = await flow.stable("recommendation", item => item.page === "recommendation" &&
      item.artifact?.slot === slot && Boolean(item.recommendations))
    const result = { ...frame.recommendations, sourceSlot: slot, capturedAt: frame.capturedAt,
      minimumSetUsageRate: MIN_SET_USAGE,
      status: frame.recommendations.subHeadingFound && frame.recommendations.subStats.length &&
        (!frame.recommendations.mainHeadingFound || frame.recommendations.mainStats.length) ? "ok" : "partial" }
    if (resolveSets) {
      for (const row of result.setRows) {
        if (row.usageRate !== null && row.usageRate < MIN_SET_USAGE) {
          row.status = "skipped_low_usage"
          runtime.info(`推荐搭配${row.rank}：${row.usageRate}%低于10%，跳过`)
          continue
        }
        if (row.usageRate === null) {
          runtime.info(`推荐搭配${row.rank}：使用率未读清，保留待核对`)
          continue
        }
        // “×4”未读清也先点击第一图标取名字，不能因此跳过主要推荐。
        for (let col = 0; col < 2; col++) {
          if (col === 1 && row.counts[0] === 4 && row.counts[1] === null) break
          try {
            const point = (plan.recommendationIconButtons || RECOMMENDATION_ICON_POINTS)[row.rank - 1][col]
            const allowAbsent = col === 1 && row.counts[1] === null && row.counts[0] !== 2
            let popup
            for (let attempt = 0; attempt < 2; attempt++) {
              const before = attempt ? runtime.capture("setDialog") : null
              if (!attempt || before.page === "recommendation") await flow.click(point)
              else if (before.page !== "setDialog") throw new Error("套装名称重试时未确认弹窗或推荐面板")
              try {
                popup = await flow.stable("setDialog", item => item.page === "setDialog" && Boolean(item.dialogName) ||
                  allowAbsent && item.page === "recommendation")
                break
              } catch (error) {
                flow.guard()
                if (attempt) throw error
                runtime.info(`推荐搭配${row.rank}：重新确认图标弹窗（重试1/1）`)
              }
            }
            if (popup.page === "recommendation") { row.secondIconState = "not_opened"; break }
            row.components.push({ setName: popup.dialogName, count: row.counts[col], source: "clicked-title-ocr" })
            runtime.info(`推荐搭配${row.rank}：${popup.dialogName}${row.counts[col] ? `×${row.counts[col]}` : "（件数待核对）"}`)
            await flow.press("VK_ESCAPE")
            const refreshed = await flow.stable("recommendation", item => item.page === "recommendation" && item.artifact?.slot === slot)
            const fresh = refreshed.recommendations.setRows.find(item => item.rank === row.rank)
            if (fresh) {
              for (let i = 0; i < 2; i++) if (row.counts[i] === null && fresh.counts[i] !== null) row.counts[i] = fresh.counts[i]
              row.components.forEach((component, i) => { if (component.count === null) component.count = row.counts[i] })
            }
          } catch (error) {
            flow.guard()
            row.status = "name_error"
            row.error = String(error.message || error)
            runtime.info(`推荐搭配${row.rank}：套装名称未读全，保留已识别信息`)
            scan.errors.push({ character: draft.identity.displayName, slot, stage: "set-name", rank: row.rank, message: row.error })
            const state = runtime.capture("setDialog")
            if (state.page === "setDialog") {
              await flow.press("VK_ESCAPE")
              await flow.stable("recommendation", item => item.page === "recommendation" && item.artifact?.slot === slot)
            } else if (state.page !== "recommendation") throw error
            break
          }
        }
        if (row.status !== "name_error") row.status = row.components.length &&
          row.components.every(component => component.count !== null) ? "ok" : "name_ok_counts_unknown"
      }
    }
    if (resolveSets) result.setRows = result.setRows.map(cleanSetRow)
    const main = result.mainStats[0]?.name
    runtime.info(`${slot}推荐：${main ? `主属性${main}等${result.mainStats.length}项，` : ""}副属性${result.subStats.length}项`)
    await closeRecommendation()
    return result
  }

  try {
    // 不依赖 returnMainUi 的内部输入间隔。所有 Esc、C、E、F 和点击均经统一等待。
    runtime.info("角色录入：确认大世界界面…")
    await ensureWorld()
    worldConfirmed = true
    runtime.info("已确认大世界，按C进入角色界面")
    await flow.press("C")
    let identity = await readIdentity()
    const firstKey = cleanName(identity.displayName)
    const visited = new Set()
    while (visited.size < MAX_CHARACTERS) {
      flow.guard()
      const key = cleanName(identity.displayName)
      if (visited.has(key)) throw new Error("在采集开始处遇到重复角色，已停止")
      visited.add(key)
      scan.visited.push({ key: characterKey(identity), name: identity.displayName, element: identity.element })
      const existing = store.snapshot().characters[characterKey(identity)]
      const skip = options.skipExistingCharacters === true && isCharacterComplete(existing)
      if (skip) {
        scan.skipped++
        runtime.info(`跳过已有数据：${identity.displayName}（身份、五部位装备和推荐信息均完整）`)
        runtime.trace?.("character.skipped", { character: identity.displayName, key: characterKey(identity) })
        checkpoint()
      } else {
      draft = { identity, capturedAt: runtime.timestamp(), slots: {}, recommendations: {}, complete: false, needsRefresh: false }
      runtime.info(`角色仓库录入：第${visited.size}位 ${identity.displayName}`)
      runtime.info(`${identity.displayName}：打开圣遗物详情`)
      await flow.click(plan.buttons.artifacts)
      await ensureOverview(identity, true)
      await flow.press("F")
      // 若F保留了此前部位，先确认详情后点花校正，不能误把其他部位记为花。
      let detail
      let setsAttempted = false
      for (let index = 0; index < SLOTS.length; index++) {
        const slot = SLOTS[index]
        if (index) {
          runtime.info(`${identity.displayName}：切换到${slot}`)
          await flow.press("E")
        }
        detail = await readArtifact(slot)
        draft.slots[slot] = ownershipObservation(identity, detail.artifact, detail.capturedAt)
        runtime.info(`[${index + 1}/5] ${slot}：${detail.artifact.name || "名称未读全"}（${detail.artifact.level === null ? "等级未知" : `+${detail.artifact.level}`}，${detail.artifact.setName || "套装未知"}）`)
        if (draft.slots[slot].status !== "equipped") {
          runtime.info(`${identity.displayName} ${slot}：${draft.slots[slot].reason}`)
        }
        try {
          const rec = await readRecommendation(slot, !setsAttempted)
          draft.recommendations[slot] = rec
          if (!setsAttempted) {
            const complete = rec.setRows.length > 0 && rec.setRows.every(row => row.status === "ok" || row.status === "skipped_low_usage")
            draft.setRecommendations = { complete, minimumUsageRate: MIN_SET_USAGE, sourceSlot: slot, capturedAt: rec.capturedAt, rows: rec.setRows }
            setsAttempted = true
          }
        } catch (error) {
          flow.guard()
          draft.recommendations[slot] = { status: "error", error: String(error.message || error), capturedAt: runtime.timestamp() }
          runtime.info(`${slot}推荐未读全，已记录错误并尝试返回详情`)
          scan.errors.push({ character: identity.displayName, slot, stage: "recommendations", message: String(error.message || error) })
          // 最多关闭两层，只在识别到相应页面时发送；无法确认详情则保留进度并停止。
          let page = runtime.capture("setDialog")
          if (page.page === "setDialog") { await flow.press("VK_ESCAPE"); page = runtime.capture("recommendation") }
          if (page.page === "recommendation") await closeRecommendation()
          await flow.stable("page", frame => frame.page === "detail" && frame.artifact?.slot === slot)
        }
      }
      draft = cleanCharacterRecord(draft)
      const verifiedSlots = SLOTS.filter(slot => draft.slots[slot]?.status === "equipped").length
      store.saveCharacter(draft)
      scan.saved++
      if (!draft.complete) scan.incomplete++
      draft = null
      checkpoint()
      runtime.info(`已保存${identity.displayName}：${verifiedSlots}/5个部位已核验`)
      await flow.press("VK_ESCAPE")
      await ensureOverview(identity)
      }
      let next = null
      // E未生效与回到起点分开：从当前角色未离开时，不认为完成一圈。
      for (let retry = 0; retry < 3; retry++) {
        runtime.info(retry ? "角色未变化，重试切换下一位" : "返回概览，切换下一位角色")
        await flow.press("E")
        const candidate = await readIdentity()
        if (cleanName(candidate.displayName) !== key) { next = candidate; break }
      }
      if (!next) throw new Error("三次E后角色仍未变化；未按正常循环结束处理")
      const nextKey = cleanName(next.displayName)
      if (nextKey === firstKey && visited.size > 1) {
        scan.status = "complete"
        scan.completedAt = runtime.timestamp()
        checkpoint()
        runtime.info(`角色仓库录入完成：本次录入${scan.saved}位，跳过${scan.skipped}位，${scan.incomplete}位有待核对字段。文件：${store.path}`)
        return scan
      }
      if (visited.has(nextKey)) throw new Error(`重复了非起始角色 ${next.displayName}，未视为完整遍历`)
      identity = next
    }
    throw new Error("角色数量超过256，已保留进度并停止")
  } catch (error) {
    if (draft) { store.saveCharacter(draft); scan.partialCharacter = draft.identity.displayName }
    scan.status = token.isCancellationRequested ? "cancelled" : "failed"
    scan.error = String(error.message || error)
    scan.stoppedAt = runtime.timestamp()
    // checkpoint是同步写入，不经过已经取消的sleep，保证当前角色部分结果也有保存机会。
    checkpoint()
    if (!token.isCancellationRequested) throw error
    return scan
  } finally {
    // 不在取消或异常后盲按Esc；正常结束留在起始角色属性页，日志给出文件位置。
    if (!worldConfirmed) runtime.info("未确认进入大世界，本轮没有发送C或执行角色遍历。")
  }
}

export async function runAccountCapture(options, cancellationToken, journal = null) {
  // 标识先校验，避免空标识下操作游戏或混入公共账号文件。
  const store = createAccountStore(options.userIdentifier)
  const plan = JSON.parse(file.readTextSync("assets/account-capture-actions.json"))
  const { dictionary, descriptions } = loadCharacterNames()
  const normalizer = createNameNormalizer(dictionary, descriptions, () => store.identityRecords())
  const reader = createAccountReader({ normalizer })
  try {
    return await captureAccount({
      capture: scope => {
        try { const frame = reader.capture(scope); journal?.event("capture", { scope,
          regions: scope === "world" ? [[0, 0, 260, 165]] : accountCaptureTargets(scope), frame }); return frame }
        catch (error) { journal?.event("capture.error", { scope, message: String(error.message || error) }); throw error }
      }, sleep: milliseconds => sleep(milliseconds),
      keyPress: key => keyPress(key), click: (x, y) => click(x, y),
      now: () => Date.now(), timestamp: () => new Date().toISOString(),
      info: message => { log.info(message); journal?.event("progress", { message }) },
      trace: (type, data) => journal?.event(type, data),
      confirmIdentity: identity => normalizer.setActiveIdentity(identity)
    }, store, plan, cancellationToken, options)
  } finally { reader.dispose() }
}
