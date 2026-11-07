import { annotateArtifactEnhancement } from "./artifact-enhancement.js"

/** 坐标均相对于 1920×1080 游戏截图左上角，x 向右，y 向下。 */
export const REGIONS = {
  detail: [984, 182, 492, 818],
  // 使用同一帧的底部按钮文字确认还圣奥迹界面。
  strongbox: [1600, 980, 280, 80],
  name: [984, 182, 492, 58],
  slot: [1000, 245, 230, 45],
  mainStat: [1000, 325, 270, 90],
  level: [1000, 480, 100, 48],
  subStats: [1000, 535, 455, 157],
  setName: [1000, 695, 455, 40]
}

export const SLOTS = ["生之花", "死之羽", "时之沙", "空之杯", "理之冠"]
export const STAT_NAMES = [
  "元素充能效率", "火元素伤害加成", "水元素伤害加成", "冰元素伤害加成",
  "雷元素伤害加成", "风元素伤害加成", "岩元素伤害加成", "草元素伤害加成",
  "物理伤害加成", "治疗加成", "元素精通", "暴击伤害", "暴击率",
  "生命值", "攻击力", "防御力"
]

export function readOcrItems(image, region) {
  const results = image.findMulti(RecognitionObject.Ocr(...region))
  const items = []
  // findMulti 返回 C# 集合，沿用 ArtifactScore 的 count + 索引访问方式。
  for (let i = 0; i < results.count; i++) {
    const item = results[i]
    if (!item.isExist() || !item.text) continue
    items.push({
      text: item.text.trim(), x: item.x, y: item.y,
      width: item.width, height: item.height
    })
  }
  return items.sort((a, b) => (a.y - b.y) || (a.x - b.x))
}

export function inRegion(item, [x, y, w, h]) {
  const cx = item.x + item.width / 2
  const cy = item.y + item.height / 2
  return cx >= x && cx < x + w && cy >= y && cy < y + h
}

export function regionText(items, region) {
  return items.filter(item => inRegion(item, region)).map(item => item.text).join(" ")
}

export function normalize(text) {
  return String(text).replace(/\s/g, "").replace(/％/g, "%")
    .replace(/＋/g, "+").replace(/，/g, ",").replace(/．/g, ".")
}

export function parseStat(text) {
  const normalized = normalize(text)
  const name = STAT_NAMES.find(candidate => normalized.includes(candidate))
  if (!name) return null
  const tail = normalized.slice(normalized.indexOf(name) + name.length)
  const match = tail.match(/\+?(\d[\d,]*(?:\.\d+)?)(%?)/)
  if (!match) return null
  return {
    name, value: Number(match[1].replace(/,/g, "")),
    percent: match[2] === "%", pending: normalized.includes("待激活"), raw: text
  }
}

/** 将同一行被 OCR 拆开的名称、数值和“待激活”合并。 */
export function groupRows(items) {
  const rows = []
  for (const item of items) {
    const cy = item.y + item.height / 2
    const row = rows.find(candidate => Math.abs(candidate.cy - cy) < 14)
    if (row) row.items.push(item)
    else rows.push({ cy, items: [item] })
  }
  return rows.sort((a, b) => a.cy - b.cy).map(row => row.items
    .sort((a, b) => a.x - b.x).map(item => item.text).join(" "))
}

/** 按已提供的两类界面样例：完整四行有标记为待激活，无标记为已生效。 */
function describeFourthSubStat(subRows, subStats, level) {
  const complete = subRows.length === 4 && subStats.length === 4 &&
    subStats.every((stat, index) => stat.rowIndex === index) &&
    subStats.slice(0, 3).every(stat => stat.activation === "active")
  if (complete && subStats[3].activation === "pending") {
    return {
      state: "pending", source: "ocr-marker", initialCount: level === 0 ? 3 : null,
      label: level === 0 ? "初始三词条" : "第四词条待激活",
      detail: "第 4 条待激活"
    }
  }
  if (complete && subStats[3].activation === "active") {
    return {
      state: "active", source: "complete-rows-no-marker", initialCount: level === 0 ? 4 : null,
      label: level === 0 ? "初始四词条" : "四条已生效",
      detail: "第 4 条已生效"
    }
  }
  // 缺行或解析失败仍保留未知；没有进行像素颜色检测。
  return {
    state: "unknown", source: "unconfirmed", initialCount: null,
    label: "词条状态待确认", detail: "第 4 条是否生效尚未确认"
  }
}

/** 初步解析仅适配用户提供的固定详情布局；保留所有原始文本便于后续校准。 */
export function parseArtifact(items) {
  const name = regionText(items, REGIONS.name).trim()
  const slotText = normalize(regionText(items, REGIONS.slot))
  const slot = SLOTS.find(candidate => slotText.includes(candidate)) || ""
  const mainStat = parseStat(regionText(items, REGIONS.mainStat))
  const levelMatch = normalize(regionText(items, REGIONS.level)).match(/\+(\d{1,2})/)
  const level = levelMatch ? Number(levelMatch[1]) : null
  const subRows = groupRows(items.filter(item => inRegion(item, REGIONS.subStats)))
  const parsedRows = subRows.map(parseStat)
  const completeRows = parsedRows.length === 4 && parsedRows.every(Boolean)
  const subStats = parsedRows.map((stat, rowIndex) => {
    if (!stat) return null
    const activeByLayout = completeRows && (rowIndex < 3 || !subRows.some(row => normalize(row).includes("待激活")))
    const activation = stat.pending ? "pending" : activeByLayout ? "active" : "unknown"
    return {
      ...stat, rowIndex, activation,
      activationSource: stat.pending ? "ocr-marker" : activeByLayout
        ? rowIndex === 3 ? "complete-rows-no-marker" : "row-order" : "unconfirmed",
      pending: activation === "unknown" ? null : activation === "pending"
    }
  }).filter(Boolean)
  const fourthSubStat = describeFourthSubStat(subRows, subStats, level)
  const setName = regionText(items, REGIONS.setName).replace(/[：:]\s*$/, "").trim()
  const warnings = []
  if (!name) warnings.push("名称未识别")
  if (!slot) warnings.push("部位未识别")
  if (!mainStat) warnings.push("主词条未完整识别")
  if (level === null || level > 20) warnings.push("等级未可靠识别")
  if (subStats.length < 3 || subRows.some(row => !parseStat(row))) {
    warnings.push("副词条可能不完整，请核对游戏详情")
  }
  if (!setName) warnings.push("套装未识别")
  return annotateArtifactEnhancement({ name, slot, mainStat, level, subStats, setName, fourthSubStat, warnings })
}

/** 每轮只截图一次，详情和界面标记均从同一帧读取；异常时也释放图像。 */
export function readSnapshot() {
  const image = captureGameRegion()
  try {
    if (image.width !== 1920 || image.height !== 1080) {
      throw new Error(`当前截图为 ${image.width}×${image.height}，请使用 1920×1080、16:9 游戏窗口`)
    }
    const items = readOcrItems(image, REGIONS.detail)
    const markerText = readOcrItems(image, REGIONS.strongbox).map(item => item.text).join(" ")
    const artifact = parseArtifact(items)
    return {
      capturedAt: new Date().toISOString(),
      onStrongboxPage: normalize(markerText).includes("还圣奥迹"),
      markerText, items, artifact,
      rawText: items.map(item => item.text).join("\n")
    }
  } finally {
    image.dispose()
  }
}
