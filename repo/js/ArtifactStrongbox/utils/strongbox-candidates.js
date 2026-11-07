import { createAccountStore } from "./account-store.js"
import { createTrainingStore, trainingCatalog } from "./training-characters.js"
import { normalizeTravelerLabel, travelerDisplayName } from "./character-names.js"
import { loadCharacterSearch, searchKeysForName } from "./character-search.js"
import { inventoryPressure, mainStatSuitability, mainRuleAssessment } from "./character-assessment.js"

export const CANDIDATE_ELEMENTS = ["火", "水", "风", "雷", "草", "冰", "岩"]
const normalize = value => String(value || "").normalize("NFKC").replace(/\s/g, "")
const rankElement = element => CANDIDATE_ELEMENTS.includes(element) ? CANDIDATE_ELEMENTS.indexOf(element) : 7

export function recordedCharacterCatalog(records, customProfiles = [], searchDictionary = {}) {
  const profiles = trainingCatalog(customProfiles, records)
  return Object.entries(records).filter(([, record]) => record.identity?.displayName && record.identity.verified !== false)
    .map(([key, record]) => {
      const name = record.identity.kind === "traveler" || record.identity.displayName === "旅行者"
        ? travelerDisplayName(record.identity.element) || record.identity.displayName : normalizeTravelerLabel(record.identity.displayName)
      return { key, name, element: record.identity.element || "", searchKeys: searchKeysForName(name, searchDictionary), complete: Boolean(record.complete),
        profileIds: profiles.find(profile => profile.name === name)?.profileIds || [], record }
    }).sort((a, b) => rankElement(a.element) - rankElement(b.element) || a.name.localeCompare(b.name, "zh-CN"))
}

export function matchStrongboxCandidates(artifact, catalog, selected, flags) {
  const mainSlot = ["时之沙", "空之杯", "理之冠"].includes(artifact.slot)
  const candidates = []
  for (const character of catalog) {
    let setMatch = null, mainMatch = null
    const mainFit = mainStatSuitability(artifact, character.record)
    if (flags.showSetCharacters && artifact.setName) {
      for (const row of character.record.setRecommendations?.rows || []) {
        if (row.status !== "ok" || !Number.isFinite(row.usageRate) || row.usageRate < 10) continue
        for (const component of row.components || []) {
          if (normalize(component.setName) !== normalize(artifact.setName) || ![2, 4].includes(component.count)) continue
          const match = { count: component.count, usageRate: row.usageRate, rank: row.rank }
          if (!setMatch || match.count > setMatch.count || match.count === setMatch.count && match.usageRate > setMatch.usageRate) setMatch = match
        }
      }
    }
    if (flags.matchMainStat && mainSlot && artifact.mainStat) {
      if (mainFit.state === "allowed") mainMatch = { usageRate: mainFit.matched.usageRate, rank: mainFit.matched.rank }
    }
    const training = flags.showTrainingCharacters && selected.includes(character.name)
    if (setMatch || training || mainMatch) candidates.push({ name: character.name, element: character.element,
      profileIds: character.profileIds, setMatch, training, mainMatch, selectedForTraining: selected.includes(character.name),
      mainRule: mainRuleAssessment(artifact, character.record, mainFit) })
  }
  return candidates
}

export function summarizeCharacterAssessments(rows, candidates = []) {
  const groups = new Map(candidates.map(candidate => [candidate.name, { rows: [], expected: candidate.profileIds || [] }]))
  for (const row of rows) {
    if (!groups.has(row.name)) groups.set(row.name, { rows: [], expected: [] })
    groups.get(row.name).rows.push(row)
  }
  const result = { fodder: 0, unknown: 0, keep: 0, total: groups.size, unit: "characters", characters: [] }
  for (const [name, group] of groups) {
    const states = group.rows.map(row => row.assessment?.status || "unknown")
    const complete = group.expected.every(id => group.rows.some(row => row.id === id))
    const mainExcluded = group.rows.length > 0 && group.rows.every(row => row.assessment?.code === "main-not-recommended")
    const status = states.includes("keep") ? "keep" : states.length > 0 && states.every(state => state === "fodder") &&
      (complete || mainExcluded) ? "fodder" : "unknown"
    result[status]++
    result.characters.push({ name, status })
  }
  return result
}

export function presentCandidateProjection(projection, candidates) {
  if (!projection || projection.state === "computing") return projection
  const byName = new Map(candidates.map(candidate => [candidate.name, candidate]))
  const rows = (projection.rows || []).filter(row => byName.has(row.name)).map(row => ({ ...row, ...byName.get(row.name) }))
  for (const candidate of candidates.filter(candidate => !rows.some(row => row.name === candidate.name))) {
    const reason = candidate.profileIds.length ? "评分计算失败" : "缺少评分规则"
    rows.push({ ...candidate, id: `unavailable:${candidate.name}`, label: reason, scoreUnavailable: true, top20: null, top80: null,
      assessment: candidate.mainRule || { status: "unknown", label: "待定", code: "score-unavailable", reason } })
  }
  const group = row => row.setMatch ? row.setMatch.count === 4 ? 0 : 1 : row.training ? 2 : 3
  rows.sort((a, b) => group(a) - group(b) || (b.setMatch?.usageRate || 0) - (a.setMatch?.usageRate || 0) ||
    (b.top20 ?? -Infinity) - (a.top20 ?? -Infinity) || a.name.localeCompare(b.name, "zh-CN") || a.id.localeCompare(b.id))
  return { ...projection, rows, candidateCharacters: candidates.length,
    assessmentSummary: projection.modelVersion || projection.state === "ready" ? summarizeCharacterAssessments(rows, candidates) : null,
    state: rows.length && (projection.state === "ready" || projection.modelVersion && rows.every(row => row.scoreUnavailable)) ? "ready" : projection.state,
    counts: { set: candidates.filter(row => row.setMatch).length, training: candidates.filter(row => row.training).length,
      main: candidates.filter(row => row.mainMatch).length } }
}

export function createStrongboxSession(options, customProfiles = [], io = file) {
  const account = createAccountStore(options.userIdentifier, io).snapshot()
  const capacity = inventoryPressure(options.artifactCountEstimate)
  const catalog = recordedCharacterCatalog(account.characters, customProfiles, loadCharacterSearch(io))
  const store = createTrainingStore(options.userIdentifier, io)
  let selected = store.read().filter(name => catalog.some(row => row.name === name))
  let flags = { showSetCharacters: true, showTrainingCharacters: true, matchMainStat: false, respectExistingSets: true }
  let revision = 0
  return {
    controls: () => ({ accountId: account.accountId, revision, selected, flags, capacity,
      catalog: catalog.map(({ record, ...row }) => row) }),
    assessmentRecords: () => Object.fromEntries(catalog.map(row => [row.name, JSON.parse(JSON.stringify(row.record))])),
    candidates: artifact => matchStrongboxCandidates(artifact, catalog, selected, flags),
    update(data) {
      // 兼容旧版消息未携带新选项；显式false保留，错误类型仍拒绝。
      const supplied = { ...data?.flags }
      if (!Object.hasOwn(supplied, "respectExistingSets")) supplied.respectExistingSets = flags.respectExistingSets
      if (!data || !Array.isArray(data.characters) || data.characters.some(name => typeof name !== "string") ||
        !data.flags || Object.keys(flags).some(key => typeof supplied[key] !== "boolean")) throw new Error("候选筛选设置格式错误")
      const next = [...new Set(data.characters)]
      if (next.some(name => !catalog.some(row => row.name === name))) throw new Error("只能选择当前账号已录入的角色")
      if (JSON.stringify(next) !== JSON.stringify(selected)) store.save(next, catalog, { allowEmpty: true })
      selected = next
      flags = Object.fromEntries(Object.keys(flags).map(key => [key, supplied[key]]))
      revision++
      return this.controls()
    }
  }
}
