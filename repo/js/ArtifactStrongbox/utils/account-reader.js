import { SLOTS, STAT_NAMES, readOcrItems, inRegion, regionText, normalize, parseStat, groupRows } from "./artifact-reader.js"

export const ACCOUNT_REGIONS = {
  header: [125, 20, 350, 60], menu: [95, 120, 250, 210],
  headerRetry: [130, 24, 340, 48], characterNameRetry: [1450, 110, 470, 80],
  characterName: [1460, 110, 460, 70], characterLevel: [1460, 205, 460, 50],
  rightPanel: [1460, 110, 460, 970], topButton: [1450, 10, 185, 75],
  biography: [1450, 570, 460, 185], archiveBiography: [1450, 225, 460, 100],
  identityPanel: [1450, 110, 435, 155],
  name: [1460, 110, 460, 60], slot: [1460, 175, 460, 35],
  main: [1460, 210, 460, 50], level: [1460, 305, 160, 40],
  subStats: [1460, 345, 460, 140], set: [1460, 490, 460, 40],
  owner: [1460, 890, 460, 85], ownerFocus: [1515, 912, 405, 52], bottomAction: [1460, 980, 460, 60],
  overviewMarker: [1460, 275, 460, 110],
  recommendations: [875, 35, 555, 1000], recommendationTitle: [880, 35, 500, 50],
  mainRecommendations: [880, 395, 550, 255], subRecommendations: [880, 685, 550, 280],
  dialog: [705, 90, 510, 150], dialogTitle: [715, 95, 495, 70],
  dialogKind: [715, 160, 495, 65], uid: [1610, 1035, 300, 45]
}

export function cleanName(value) {
  return normalize(value || "").normalize("NFKC").replace(/[：:]$/, "")
}

function fieldItems(items, key) {
  const focused = items.filter(item => item.ocrField === key)
  return focused.length ? focused : items.filter(item => !item.ocrField && inRegion(item, ACCOUNT_REGIONS[key]))
}
function text(items, key) { return groupRows(fieldItems(items, key)).join(" ") }
function rows(items, region) { return groupRows(items.filter(item => inRegion(item, region))) }

export function deduplicateOcrItems(items) {
  const token = value => normalize(value).replace(/^[xX*]([24])$/, "×$1")
  const unique = items.filter((item, index, all) => !all.slice(0, index).some(other =>
    other.ocrField === item.ocrField && token(other.text) === token(item.text) &&
    Math.abs(other.x + other.width / 2 - item.x - item.width / 2) < 8 &&
    Math.abs(other.y + other.height / 2 - item.y - item.height / 2) < 8))
  // 小区域OCR偶尔同时输出完整名称和其中一个重叠字框，避免拼接出重复字。
  return unique.filter(item => !unique.some(other => {
    if (other === item || other.ocrField !== item.ocrField) return false
    const short = token(item.text), long = token(other.text)
    if (!short || long.length <= short.length || !long.includes(short)) return false
    const width = Math.max(0, Math.min(item.x + item.width, other.x + other.width) - Math.max(item.x, other.x))
    const height = Math.max(0, Math.min(item.y + item.height, other.y + other.height) - Math.max(item.y, other.y))
    return width * height > item.width * item.height * 0.5
  }))
}

export function parseIdentity(items) {
  const headerItems = fieldItems(items, "header").sort((a, b) => a.x - b.x)
  const header = cleanName(groupRows(headerItems).join(" "))
  // 实际OCR会把元素与姓名之间的独立斜杠框识别为“1”。只修复中间分隔框，不替换姓名中的数字。
  const headerNormalized = cleanName(groupRows(headerItems.map((item, index) =>
    /^[1Il]$/.test(normalize(item.text)) && /^(风|岩|雷|草|水|火|冰)元素$/.test(normalize(headerItems[index - 1]?.text || "")) &&
      headerItems[index + 1] && Math.abs(item.y - headerItems[index + 1].y) < 25
      ? { ...item, text: "/" } : item)).join(" "))
  // 固定“元素”边界后允许分隔符漏读；不纠正、补字或模糊映射角色姓名。
  const headerMatch = headerNormalized.match(/^(风|岩|雷|草|水|火|冰)元素[/／|丨:：\\]?([\p{L}\p{N}·・\-]{1,24})$/u)
  const panelName = groupRows(fieldItems(items, "characterName")).map(cleanName)
    .find(value => /^[\p{L}\p{N}·・\-]{1,24}$/u.test(value) && /\p{L}/u.test(value) &&
      !/生命|攻击|防御|精通|等级|属性|已装备/.test(value)) || ""
  const levelText = normalize(text(items, "characterLevel"))
  const levelMatch = levelText.match(/(?:等级|Lv\.?)(\d{1,3})(?:[/／|](\d{1,3}))?(?!\d)/i)
  const level = levelMatch && Number(levelMatch[1]) >= 1 && Number(levelMatch[1]) <= 120 &&
    (!levelMatch[2] || Number(levelMatch[2]) <= 120 && Number(levelMatch[2]) >= Number(levelMatch[1])) ? Number(levelMatch[1]) : null
  const headerName = headerMatch?.[2] || ""
  const attributeEvidence = Boolean(level !== null || /体力上限|好感度/.test(regionText(items, ACCOUNT_REGIONS.rightPanel)))
  // 概览右侧是圣遗物说明，不是角色姓名；不能仅凭“像名字”的文字覆盖左上标题。
  const usablePanelName = attributeEvidence ? panelName : ""
  const displayName = usablePanelName || headerName
  const conflicts = Boolean(headerName && usablePanelName && headerName !== usablePanelName)
  const rosterEvidence = /属性|圣遗物/.test(text(items, "menu"))
  const focusedName = fieldItems(items, "characterName").some(item => item.ocrField === "characterName")
  return {
    displayName, element: conflicts ? "" : headerMatch?.[1] || "", level, levelText,
    panelName: usablePanelName, panelCandidate: panelName, headerName, attributeEvidence, rosterEvidence,
    description: [text(items, "biography"), text(items, "archiveBiography")].filter(Boolean).join(" "),
    source: usablePanelName ? focusedName ? "right-panel-focused" : "right-panel" : "header",
    verified: Boolean(!conflicts && (usablePanelName && attributeEvidence || headerName && rosterEvidence)), header, headerNormalized, conflicts,
    candidates: [
      ...(headerName && rosterEvidence ? [{ name: headerName, source: "header", element: headerMatch[1] }] : []),
      ...(usablePanelName ? [{ name: usablePanelName, source: "panel" }] : [])
    ],
    rejectionReason: conflicts ? "左右姓名不一致" : !displayName ? "左右姓名均未读全"
      : !attributeEvidence && !rosterEvidence ? "缺少角色页面证据" : ""
  }
}

export function resolveIdentityConsensus(frames) {
  const candidates = new Map()
  for (const [index, frame] of frames.entries()) {
    if (!["attributes", "overview"].includes(frame.page)) continue
    for (const candidate of frame.identity?.candidates || []) {
      const entry = candidates.get(candidate.name) || { name: candidate.name, frames: new Set(), sources: new Set(), observations: [] }
      entry.frames.add(index); entry.sources.add(candidate.source); entry.observations.push({ candidate, frame })
      candidates.set(candidate.name, entry)
    }
  }
  const ranked = [...candidates.values()].sort((a, b) => b.frames.size - a.frames.size)
  const best = ranked[0]
  if (!best || best.frames.size < 3 || best.frames.size - (ranked[1]?.frames.size || 0) < 2 ||
      ranked.length > 1 && best.sources.size < 2) return null
  // 姓名可跨帧投票；等级与其他身份字段只取同一张原始帧，不拼接数值。
  const chosen = [...best.observations].reverse().find(item => item.frame.identity.panelName === best.name) || best.observations.at(-1)
  const identity = { ...chosen.frame.identity, displayName: best.name,
    element: best.observations.find(item => item.candidate.source === "header")?.candidate.element || "",
    verified: true, conflicts: false, source: "multi-frame-consensus",
    consensus: { frames: best.frames.size, totalFrames: frames.length, sources: [...best.sources],
      alternatives: ranked.slice(1).map(row => ({ name: row.name, frames: row.frames.size })) } }
  return { ...chosen.frame, identity }
}

export function parseEquippedArtifact(items) {
  const r = ACCOUNT_REGIONS
  const slot = SLOTS.find(name => normalize(text(items, "slot")).includes(name)) || ""
  const levelText = normalize(text(items, "level"))
  const level = levelText.match(/\+(\d{1,2})/) || levelText.match(/^(\d{1,2})$/)
  const setLine = normalize(text(items, "set"))
  const setMatch = setLine.match(/^(.+?)[：:]?[(（](\d+)[)）]$/)
  const subRows = groupRows(fieldItems(items, "subStats"))
  const subStats = subRows.map(parseStat).filter(Boolean).map(stat => ({
    ...stat, activation: stat.pending ? "pending" : "active"
  }))
  // 只选带“已装备”的那一行，不把上方长描述拼成装备者姓名。
  const ownerRows = groupRows(fieldItems(items, "owner")).map(cleanName)
  const ownerMatches = ownerRows.filter(line => /(?:已|己)装[备備各]$/.test(line))
  const ownerText = ownerMatches[ownerMatches.length - 1] || ""
  const ownerMatch = ownerText.replace(/(?:已|己)装[备備各]$/, "已装备").match(/^(.+?)已装备$/)
  // 同一行的大数字框常比名称框高几像素，必须按行再按x合并，不能按y直接拼接。
  const mainStat = parseStat(groupRows(fieldItems(items, "main")).join(" "))
  const name = cleanName(text(items, "name"))
  const warnings = []
  if (!name) warnings.push("物品名称未读全")
  if (!slot || !mainStat || !level) warnings.push("部位、主词条或等级未读全")
  if (!setMatch) warnings.push("套装名称或件数未读全")
  if (subStats.length !== subRows.length || subStats.length > 4) warnings.push("副词条未读全")
  if (level && Number(level[1]) >= 16 && subStats.length !== 4) warnings.push("高等级物品副词条不足四行")
  if (level && Number(level[1]) > 20) warnings.push("等级异常")
  const keys = subStats.map(stat => stat.name + (stat.percent ? "%" : ""))
  if (new Set(keys).size !== keys.length) warnings.push("副词条重复")
  if (mainStat && subStats.some(stat => stat.name === mainStat.name && stat.percent === mainStat.percent)) {
    warnings.push("主副词条冲突")
  }
  return {
    name, slot, level: level ? Number(level[1]) : null,
    setName: setMatch ? setMatch[1].replace(/[：:]$/, "") : "",
    contextSetCount: setMatch ? Number(setMatch[2]) : null,
    mainStat, subStats, rarity: null,
    owner: ownerMatch ? cleanName(ownerMatch[1]).replace(/^[·•:：]+/, "") : null, ownerText,
    warnings, complete: Boolean(slot && mainStat && level && setMatch && !warnings.length)
  }
}

export function hasEquippedOwner(artifact) {
  return Boolean(artifact?.owner && /(?:已|己)装[备備各]$/.test(cleanName(artifact.ownerText)))
}

export function ownershipObservation(character, artifact, capturedAt) {
  const confirmedOwner = hasEquippedOwner(artifact)
  const sameOwner = Boolean(confirmedOwner && cleanName(artifact.owner) === cleanName(character.displayName))
  const status = confirmedOwner && !sameOwner ? "selected_foreign"
    : sameOwner && artifact.complete ? "equipped" : "unknown"
  return {
    status, observedOwner: artifact.owner, observedOwnerRaw: artifact.ownerRaw || artifact.owner, observedAt: capturedAt,
    selectedArtifact: artifact, equippedArtifact: status === "equipped" ? artifact : null,
    reason: !confirmedOwner ? "未识别到装备者标记，未记录当前装备；不据此判为空部位"
      : status === "selected_foreign" ? "默认选中其他角色的物品，未归入当前角色"
      : status === "unknown" ? "归属或详情尚未可靠识别；未据此判为空部位" : "装备者与当前角色匹配"
  }
}

function recommendationAttributes(items, region, withUsage) {
  const result = []
  for (const row of rows(items, region)) {
    const line = normalize(row)
    const name = STAT_NAMES.find(stat => line.includes(stat))
    if (!name) continue
    const usage = line.match(/(\d+(?:\.\d+)?)%/)
    if (withUsage && (!usage || Number(usage[1]) > 100)) continue
    const percent = ["生命值", "攻击力", "防御力"].includes(name)
      ? /百分比|%/.test(line) : !["元素精通"].includes(name)
    result.push({ name, percent, rank: result.length + 1,
      ...(withUsage ? { usageRate: Number(usage[1]) } : {}), raw: row })
  }
  return result
}

export function parseRecommendations(items) {
  const setRows = []
  for (let row = 0; row < 3; row++) {
    const y = 90 + row * 96
    const counts = [970, 1110].map(x => {
      const line = cleanName(regionText(items, [x, y, 65, 85])).replace(/四/g, "4").replace(/二/g, "2")
        .replace(/[×xX*✕·:：]/g, "")
      // 重叠ROI可把同一个×4读成“×4 ×4”；只有数字一致才消重，不猜矛盾的2/4。
      return /^[24]+$/.test(line) && new Set(line).size === 1 ? Number(line[0]) : null
    })
    const usageText = normalize(regionText(items, [1250, y, 120, 85]))
    const usage = usageText.match(/^(\d+(?:\.\d+)?)%$/)
    if (!usage || Number(usage[1]) > 100) {
      if (counts.some(Boolean)) setRows.push({ rank: row + 1, usageRate: null, counts,
        components: [], status: "unreadable_usage" })
      continue
    }
    const valid = counts[0] === 4 && counts[1] === null || counts[0] === 2 && counts[1] === 2
    setRows.push({ rank: row + 1, usageRate: Number(usage[1]), counts,
      components: [], status: valid ? "names_pending" : "unreadable_counts" })
  }
  const subHeading = items.find(item => item.x >= 875 && item.x < 1435 && normalize(item.text).includes("追加属性"))
  const mainHeading = items.find(item => item.x >= 875 && item.x < 1435 && normalize(item.text).includes("主要属性"))
  const subStart = subHeading ? subHeading.y + subHeading.height + 5 : ACCOUNT_REGIONS.subRecommendations[1]
  const mainStart = mainHeading ? mainHeading.y + mainHeading.height + 5 : ACCOUNT_REGIONS.mainRecommendations[1]
  const mainEnd = subHeading ? subHeading.y - 5 : 650
  return {
    source: "in-game-recent-active-players", setRows,
    mainHeadingFound: Boolean(mainHeading), subHeadingFound: Boolean(subHeading),
    mainStats: mainHeading ? recommendationAttributes(items, [880, mainStart, 550, Math.max(1, mainEnd - mainStart)], true) : [],
    subStats: recommendationAttributes(items, [880, subStart, 550, Math.max(1, 1000 - subStart)], false)
  }
}

export function parseAccountFrame(items, capturedAt = new Date().toISOString()) {
  items = deduplicateOcrItems(items)
  const slot = SLOTS.find(name => normalize(text(items, "slot")).includes(name)) || ""
  const button = cleanName(text(items, "topButton"))
  const header = cleanName(text(items, "header"))
  const menu = cleanName(text(items, "menu"))
  const identity = parseIdentity(items)
  const isRoster = !slot && (identity.verified || header.includes("元素/") && menu.includes("圣遗物") ||
    menu.includes("圣遗物") && /圣遗物详情|套装效果/.test(cleanName(text(items, "overviewMarker"))))
  const recommendation = cleanName(text(items, "recommendationTitle")).includes("推荐套装搭配")
  const isDialog = cleanName(text(items, "dialogKind")).includes("圣遗物套装")
  let page = isDialog ? "setDialog" : recommendation && slot ? "recommendation"
    : slot && /圣遗物推荐|收起参考/.test(button) ? "detail"
      : isRoster ? identity.verified && identity.attributeEvidence ? "attributes" : "overview" : "unknown"
  const uidMatch = normalize(text(items, "uid")).match(/UID[:：]?(\d{8,12})/i)
  const dialogName = isDialog ? cleanName(text(items, "dialogTitle")) : ""
  return {
    page, capturedAt, uid: uidMatch?.[1] || null,
    identity, header,
    artifact: slot ? parseEquippedArtifact(items) : null,
    recommendations: recommendation ? parseRecommendations(items) : null,
    dialogName: dialogName && !/推荐|圣遗物套装|%|×/.test(dialogName) ? dialogName : null,
    raw: items
  }
}

export function createAccountReader({ normalizer = null } = {}) {
  const template = file.readImageMatSync("assets/images/main-ui.png")
  return {
    capture(scope = "page") {
      const image = captureGameRegion()
      try {
        if (image.width !== 1920 || image.height !== 1080) throw new Error("账号录入需要实际截图为1920×1080")
        if (scope === "world") {
          const ro = RecognitionObject.TemplateMatch(template, 0, 0, 260, 165)
          const match = image.find(ro)
          return { page: !match.isEmpty() ? "world" : "unknown" }
        }
        // 页面确认只读小块锚点；真正保存详情时才识别整列数值，避免每次检查都重复跑全套OCR。
        const targets = accountCaptureTargets(scope)
        const items = targets.flatMap(({ region, field }) => readOcrItems(image, region)
          .map(item => field ? { ...item, ocrField: field } : item))
          .filter((item, index, all) => all.findIndex(other => other.text === item.text && other.x === item.x && other.y === item.y && other.ocrField === item.ocrField) === index)
          .sort((a, b) => a.y - b.y || a.x - b.x)
        const frame = parseAccountFrame(items)
        if (normalizer) {
          frame.identity = normalizer.identity(frame.identity)
          if (!frame.artifact && ["unknown", "attributes", "overview"].includes(frame.page) && frame.identity.verified) {
            frame.page = frame.identity.attributeEvidence ? "attributes" : "overview"
          }
          if (frame.artifact) {
            const owner = normalizer.owner(frame.artifact.owner)
            frame.artifact = { ...frame.artifact, ownerRaw: frame.artifact.owner, owner: owner.name, ownerNormalization: owner }
          }
        }
        return frame
      } finally { image.dispose() }
    },
    dispose() {
      if (typeof template.dispose === "function") template.dispose()
      else template.Dispose()
    }
  }
}

export function accountCaptureRegions(scope) {
  return accountCaptureTargets(scope).map(target => target.region)
}

export function accountCaptureTargets(scope) {
  const r = ACCOUNT_REGIONS
  let regions
  if (scope === "detail" || scope === "detailRetry") regions = [r.rightPanel, r.topButton, r.recommendationTitle, r.dialogKind]
  else if (scope === "recommendation") regions = [r.slot, r.topButton, r.recommendations, r.dialogKind]
  else if (scope === "setDialog") regions = [r.slot, r.topButton, r.recommendationTitle, r.dialog]
  else if (scope === "identity" || scope === "identityRetry") regions = [r.header, r.menu, r.rightPanel, r.topButton, r.recommendationTitle, r.dialogKind]
  else regions = [r.header, r.menu, r.identityPanel, r.overviewMarker, r.topButton, r.recommendationTitle, r.dialogKind]
  const targets = regions.map(region => ({ region }))
  const focused = scope === "identityRetry" ? [["header", r.headerRetry], ["characterName", r.characterNameRetry], ["characterLevel", r.characterLevel]]
    : scope === "detailRetry" ? [["name", r.name], ["slot", r.slot], ["level", r.level], ["main", r.main], ["subStats", r.subStats], ["set", r.set], ["owner", r.ownerFocus]] : []
  return [...targets, ...focused.map(([field, region]) => ({ field, region }))]
}
