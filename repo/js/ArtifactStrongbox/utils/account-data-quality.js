import { SLOTS } from "./artifact-reader.js"
import { cleanName, hasEquippedOwner } from "./account-reader.js"

// 件数推导必须以已完成的图标检查为依据；第二套读失败不能误当成只有一套。
export function cleanSetRow(row) {
  const result = JSON.parse(JSON.stringify(row))
  if (result.status === "skipped_low_usage") return result
  const components = result.components || []
  const names = [...new Set(components.map(item => item.setName).filter(Boolean))]
  const failed = result.status === "name_error" || Boolean(result.error)
  const singleConfirmed = names.length === 1 && components.length === 1 &&
    (result.secondIconState === "not_opened" || result.counts?.[0] === 4 && !result.counts?.[1]) &&
    !result.counts?.includes(2)
  if (!failed && (names.length === 2 && components.length === 2 || singleConfirmed)) {
    if (!result.rawCounts) result.rawCounts = [...(result.counts || [null, null])]
    result.counts = names.length === 2 ? [2, 2] : [4, null]
    result.components = components.map(component => ({ ...component, count: names.length === 2 ? 2 : 4 }))
    result.countSource = "confirmed-set-composition"
    result.status = "ok"
  }
  return result
}

function validSetRow(row) {
  if (row.usageRate !== null && Number.isFinite(row.usageRate) && row.usageRate < 10) return row.status === "skipped_low_usage"
  if (!Number.isFinite(row.usageRate) || row.status !== "ok") return false
  const parts = row.components || []
  return parts.length === 1 && Boolean(parts[0].setName) && parts[0].count === 4 ||
    parts.length === 2 && parts.every(part => part.setName && part.count === 2) && parts[0].setName !== parts[1].setName
}

export function isCharacterComplete(record) {
  return Boolean(record?.identity?.verified && !record.identity.conflicts && !record.needsRefresh &&
    record.identity.displayName && /^[风岩雷草水火冰]$/.test(record.identity.element || "") &&
    Number.isInteger(record.identity.level) && record.identity.level >= 1 && record.identity.level <= 120 &&
    SLOTS.every(slot => {
      const observation = record.slots?.[slot], artifact = observation?.equippedArtifact
      return observation?.status === "equipped" && !observation.baselineStale && artifact?.complete &&
        artifact.name && artifact.slot === slot && artifact.setName && artifact.mainStat &&
        Number.isInteger(artifact.level) && artifact.level >= 0 && artifact.level <= 20 &&
        artifact.subStats?.length >= (artifact.level >= 4 ? 4 : 3) && artifact.subStats.length <= 4 &&
        hasEquippedOwner(artifact) && cleanName(artifact.owner) === cleanName(record.identity.displayName)
    }) && SLOTS.every(slot => {
      const rec = record.recommendations?.[slot]
      return rec?.status === "ok" && rec.subStats?.length && (!rec.mainHeadingFound || rec.mainStats?.length)
    }) && record.setRecommendations?.complete && record.setRecommendations.rows?.length &&
    record.setRecommendations.rows.every(validSetRow))
}

export function cleanCharacterRecord(record) {
  const result = JSON.parse(JSON.stringify(record))
  for (const rec of Object.values(result.recommendations || {})) {
    if (rec.setRows) rec.setRows = rec.setRows.map(cleanSetRow)
  }
  if (result.setRecommendations) {
    const sets = result.setRecommendations
    sets.rows = (sets.rows || []).map(cleanSetRow)
    sets.complete = sets.rows.length > 0 && sets.rows.every(validSetRow)
  }
  for (const observation of Object.values(result.slots || {})) {
    const artifact = observation.equippedArtifact
    if (artifact && (!hasEquippedOwner(artifact) || cleanName(artifact.owner) !== cleanName(result.identity?.displayName))) {
      observation.equippedArtifact = null
      observation.status = hasEquippedOwner(artifact) ? "selected_foreign" : "unknown"
      observation.reason = "装备者未确认或不属于当前角色，清除当前装备引用"
    }
  }
  result.complete = isCharacterComplete(result)
  return result
}
