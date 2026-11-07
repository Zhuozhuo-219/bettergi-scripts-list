const ELEMENTS = { anemo: "风", geo: "岩", electro: "雷", dendro: "草", hydro: "水", pyro: "火", cryo: "冰", multi: "" }
const clean = value => String(value || "").normalize("NFKC").replace(/\s/g, "")
const prose = value => clean(value).replace(/[^\p{L}\p{N}]/gu, "")
const CONFUSIONS = ["菈拉啦", "涅湿湼捏", "妲姐奶", "绮绫", "堇瑾"]
export const TRAVELER_ELEMENTS = ["风", "岩", "雷", "草", "水", "火", "冰"]
export function travelerDisplayName(element) { return TRAVELER_ELEMENTS.includes(element) ? `旅行者（${element}）` : null }
export function normalizeTravelerLabel(value) {
  const match = clean(value).match(/^旅行者(?:[（(]([风岩雷草水火冰])[）)]|[·・]([风岩雷草水火冰]))$/u)
  return match ? travelerDisplayName(match[1] || match[2]) : value
}
function travelerElement(value) { return clean(normalizeTravelerLabel(value)).match(/^旅行者（([风岩雷草水火冰])）$/u)?.[1] || "" }

export function editDistance(left, right, weighted = false) {
  const a = [...left], b = [...right]
  let row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 0; i < a.length; i++) {
    const next = [i + 1]
    for (let j = 0; j < b.length; j++) {
      const cost = a[i] === b[j] ? 0 : weighted && CONFUSIONS.some(group => group.includes(a[i]) && group.includes(b[j])) ? 0.2 : 1
      next.push(Math.min(next[j] + 1, row[j + 1] + 1, row[j] + cost))
    }
    row = next
  }
  return row[b.length]
}

export function loadCharacterNames(io = file) {
  const dictionary = JSON.parse(io.readTextSync("assets/character-names.json"))
  const descriptions = JSON.parse(io.readTextSync("assets/custom-character-descriptions.json")).descriptions
  if (dictionary.schemaVersion !== 1 || !Array.isArray(dictionary.characters) || !dictionary.characters.length) throw new Error("角色名称字典格式错误")
  return { dictionary, descriptions }
}

export function matchCharacterName(value, dictionary, element = "") {
  const raw = clean(value)
  const exact = dictionary.characters.find(row => row.name === raw)
  if (exact) return { raw, name: exact.name, element: ELEMENTS[exact.element] || "", kind: exact.kind, id: exact.id, distance: 0, cost: 0, method: "exact" }
  // 仅用于标准名称字典；简介确认的自定义姓名在调用前单独处理，保留合法英文字母。
  const sanitized = raw.replace(/[a-z]/gi, "")
  if (sanitized !== raw && sanitized) {
    const result = matchCharacterName(sanitized, dictionary, element)
    if (result.method === "exact" || result.method === "nearest") return { ...result, raw, sanitized }
  }
  if ([...raw].length < 2) return { raw, name: raw, method: "unmatched" }
  const matches = dictionary.characters.filter(row => row.kind === "regular" &&
    (!element || !ELEMENTS[row.element] || ELEMENTS[row.element] === element)).map(row => ({
      ...row, distance: editDistance(raw, row.name), cost: editDistance(raw, row.name, true)
    })).filter(row => row.distance <= (raw.length >= 5 ? 2 : 1) && row.cost <= 1)
    .sort((a, b) => a.cost - b.cost || a.distance - b.distance)
  if (!matches.length || matches[1] && matches[1].cost - matches[0].cost < 0.15) {
    return { raw, name: raw, method: matches.length ? "ambiguous" : "unmatched", candidates: matches.slice(0, 3).map(row => row.name) }
  }
  const best = matches[0]
  return { raw, name: best.name, element: ELEMENTS[best.element] || "", kind: best.kind, id: best.id,
    distance: best.distance, cost: best.cost, method: "nearest" }
}

function lcs(left, right) {
  let row = Array(right.length + 1).fill(0)
  for (const char of left) {
    const next = [0]
    for (let i = 0; i < right.length; i++) next.push(char === right[i] ? row[i] + 1 : Math.max(next[i], row[i + 1]))
    row = next
  }
  return row[right.length]
}

export function identifyByDescription(value, descriptions) {
  const text = prose(value)
  if (text.length < 16) return null
  const anchors = {
    mannequin: ["魔女托付给你和派蒙的人偶", "善于探索千星奇域", "中封存的奥秘"],
    wanderer: ["身份成谜的流浪人士", "衣着打扮像是修验者", "言行却并不是修验者应有的模样"],
    traveler: ["从世界之外漂流而来的旅行者", "被神带走血亲", "踏上寻找七神之路"]
  }
  for (const [kind, template] of Object.entries(descriptions)) {
    const expected = prose(template)
    const score = lcs(expected, text) / expected.length
    const hits = anchors[kind].filter(anchor => lcs(anchor, text) / anchor.length >= 0.7).length
    if (score >= 0.66 && hits >= 2) return { kind, score: Number(score.toFixed(3)), anchors: hits, description: value }
  }
  return null
}

export function identityAliases(identity) {
  return [...new Set([identity?.displayName, identity?.baseName, identity?.customName, identity?.rawDisplayName, ...(identity?.aliases || [])].filter(Boolean).map(clean))]
}

export function createNameNormalizer(dictionary, descriptions, getRecords = () => ({})) {
  let activeIdentity = null
  const aliasRecords = name => Object.values(getRecords()).filter(record => identityAliases(record.identity).includes(clean(name)))
  function normalizeIdentity(identity) {
    const rawHeader = identity.rawNames?.header ?? identity.headerName ?? ""
    const rawPanel = identity.rawNames?.panel ?? identity.panelName ?? ""
    const rawDisplay = identity.rawNames?.display ?? identity.displayName ?? ""
    const rawName = rawPanel || rawHeader || rawDisplay
    const special = identifyByDescription(identity.description || "", descriptions)
    const originalNames = [...new Set([rawHeader, rawPanel, rawDisplay].filter(Boolean))]
    const aliases = aliasRecords(rawName).filter(record => ["wanderer", "mannequin", "traveler"].includes(record.identity.kind))
    const aliasKinds = new Set(aliases.map(record => record.identity.kind))
    const directTraveler = dictionary.characters.some(row => row.kind === "traveler" && row.name === rawName) || travelerElement(rawName)
    const kind = special?.kind || (aliasKinds.size === 1 ? aliases[0].identity.kind : null) || (directTraveler ? "traveler" : null)
    if (kind) {
      const element = kind === "traveler" ?
        (identity.headerNormalized || identity.header || "").match(/^(风|岩|雷|草|水|火|冰)元素/)?.[1] || identity.element || travelerElement(rawName) : identity.element
      let canonical = kind === "wanderer" ? "流浪者" : kind === "traveler" ? travelerDisplayName(element) : null
      if (kind === "mannequin") {
        const dolls = Object.values(getRecords()).filter(record => record.identity.kind === "mannequin")
        const matching = dolls.filter(record => identityAliases(record.identity).includes(rawName))
        const matchingNames = [...new Set(matching.map(record => record.identity.displayName))]
        if (matchingNames.length === 1) canonical = matchingNames[0]
        else if (!matching.length) canonical = ["人偶A", "人偶B"].find(name => !dolls.some(record => record.identity.displayName === name))
      }
      // 同一帧已由简介确认类型时，左右一字OCR差异可用右侧姓名复核；跨角色的别名仍只做精确匹配。
      const conflict = Boolean(rawHeader && rawPanel && rawHeader !== rawPanel &&
        (!special || editDistance(rawHeader, rawPanel) > 1))
      const exactOther = dictionary.characters.find(row => row.name === rawName && row.kind === "regular")
      const aliasCollision = !special && Boolean(exactOther)
      return { ...identity, displayName: canonical || (kind === "traveler" ? "旅行者" : rawName), kind, element,
        baseName: kind === "traveler" ? "旅行者" : canonical, customName: rawName,
        aliases: [rawName, ...(kind === "traveler" ? ["旅行者"] : [])], rawDisplayName: rawName, rawNames: { header: rawHeader, panel: rawPanel, display: rawDisplay },
        headerName: rawHeader ? canonical || rawHeader : "", panelName: rawPanel ? canonical || rawPanel : "",
        verified: Boolean(canonical && !conflict && !aliasCollision && (special || identity.verified)),
        conflicts: conflict || !canonical || aliasCollision, candidates: [],
        nameNormalization: { method: special ? "description" : "known-custom-alias", special },
        rejectionReason: !canonical ? kind === "traveler" ? "旅行者当前元素未读全，不能沿用历史元素" : "两个人偶槽位已占用或别名存在歧义" : conflict ? "自定义名称左右原文不一致"
          : aliasCollision ? "自定义别名与标准角色重名，需要简介复核" : "" }
    }
    const element = identity.element || (identity.headerNormalized || identity.header || "").match(/^(风|岩|雷|草|水|火|冰)元素/)?.[1] || ""
    const h = matchCharacterName(rawHeader, dictionary, element), p = matchCharacterName(rawPanel, dictionary, element)
    const rank = result => result.method === "exact" ? 2 : result.method === "nearest" ? 1 : 0
    const selected = rank(h) > rank(p) ? h : p.name ? p : h
    const dictionaryPreferred = rank(selected) > 0
    // 精确字典 > 唯一近似字典 > 未匹配原文；同等级的两个不同字典名仍需复核。
    const conflicts = Boolean(h.name && p.name && h.name !== p.name && rank(h) === rank(p))
    const usable = result => Boolean(result.name && (rank(result) > 0 || !/[a-z]/i.test(result.name)))
    const name = selected.name || rawDisplay
    const verified = Boolean(!conflicts && usable(selected) &&
      (selected === p && identity.attributeEvidence || selected === h && identity.rosterEvidence || identity.verified))
    const acceptedAlias = value => !dictionaryPreferred || matchCharacterName(value, dictionary, element).name === name
    return { ...identity, displayName: name, headerName: h.name, panelName: p.name,
      rawDisplayName: rawDisplay, rawNames: { header: rawHeader, panel: rawPanel, display: rawDisplay },
      aliases: originalNames.filter(acceptedAlias), kind: selected.kind || identity.kind || "unresolved",
      element: !conflicts ? selected.element || identity.element : "",
      conflicts, verified,
      candidates: (identity.candidates || []).map(candidate => {
        const result = matchCharacterName(candidate.name, dictionary, element)
        return { ...candidate, name: result.name, element: result.element || candidate.element }
      }).filter(candidate => (!dictionaryPreferred || conflicts || candidate.name === name) &&
        (!/[a-z]/i.test(candidate.name) || dictionary.characters.some(row => row.name === candidate.name))),
      nameNormalization: { method: "dictionary", header: h, panel: p,
        selectedSource: selected === p ? "panel" : "header", dictionaryPreferred },
      rejectionReason: conflicts ? "字典匹配后左右身份仍不一致" : verified ? "" : !usable(selected) ? "姓名含未匹配字母，需要重试或简介确认自定义身份" : identity.rejectionReason || "缺少角色页面证据" }
  }
  function normalizeOwner(raw) {
    if (!raw) return { name: null, raw, method: "missing" }
    const records = aliasRecords(raw)
    const aliases = [...new Set(records.map(record => record.identity.displayName))]
    const match = matchCharacterName(raw, dictionary)
    const travelerOnly = records.length > 0 && records.every(record => record.identity.kind === "traveler")
    if (activeIdentity?.kind === "traveler" && (travelerOnly || !records.length && (match.kind === "traveler" || travelerElement(raw)))) {
      if (match.method === "exact" && match.kind === "regular") return { name: null, raw, method: "ambiguous-alias" }
      return { name: activeIdentity.displayName, raw, method: "traveler-current-element" }
    }
    if (aliases.length > 1 || aliases.length === 1 && match.method === "exact" && match.name !== aliases[0]) return { name: null, raw, method: "ambiguous-alias" }
    return aliases.length === 1 ? { name: aliases[0], raw, method: "account-alias" } : match
  }
  return { identity: normalizeIdentity, owner: normalizeOwner, setActiveIdentity(identity) { activeIdentity = identity } }
}
