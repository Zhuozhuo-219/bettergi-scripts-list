import { createAccountStore, accountFileName } from "./account-store.js"
import { getCharacterProfiles } from "./projection-model.js"
import { normalizeTravelerLabel, travelerDisplayName } from "./character-names.js"
import { loadCharacterSearch, searchKeysForName } from "./character-search.js"

const ELEMENTS = { anemo: "风", geo: "岩", electro: "雷", dendro: "草", hydro: "水", pyro: "火", cryo: "冰" }

export function trainingCatalog(customProfiles = [], records = {}, searchDictionary = {}) {
  const owned = new Set(Object.values(records).map(record => record.identity?.kind === "traveler" || record.identity?.displayName === "旅行者"
    ? travelerDisplayName(record.identity.element) : normalizeTravelerLabel(record.identity?.displayName)).filter(Boolean))
  const groups = new Map()
  for (const profile of getCharacterProfiles(customProfiles)) {
    const name = profile.character === "旅行者" ? travelerDisplayName(ELEMENTS[profile.options.elem]) || "旅行者" : profile.character
    const recorded = Object.values(records).find(record => normalizeTravelerLabel(record.identity?.displayName) === name)
    if (!groups.has(name)) groups.set(name, { name, owned: owned.has(name), element: recorded?.identity.element || ELEMENTS[profile.options.elem] || "",
      searchKeys: searchKeysForName(name, searchDictionary), profileIds: [] })
    groups.get(name).profileIds.push(profile.id)
  }
  return [...groups.values()].sort((a, b) => Number(b.owned) - Number(a.owned) || a.name.localeCompare(b.name, "zh-CN"))
}

export function createTrainingStore(userIdentifier, io = file) {
  const account = accountFileName(userIdentifier)
  const path = account.path.replace(/\.json$/, ".training.json")
  const read = () => {
    if (!io.isExists(path)) return []
    const data = JSON.parse(io.readTextSync(path))
    if (data.schemaVersion !== 1 || data.accountId !== account.id || !Array.isArray(data.characters) ||
        data.characters.some(name => typeof name !== "string")) throw new Error(`拟培养角色文件格式错误：${path}`)
    return [...new Set(data.characters.map(normalizeTravelerLabel))]
  }
  return { path, read, save(names, catalog, { allowEmpty = false } = {}) {
    if (!Array.isArray(names) || names.some(name => typeof name !== "string" || !catalog.some(row => row.name === name))) {
      throw new Error("所选角色不在当前评分角色库中")
    }
    const characters = [...new Set(names)]
    if (!characters.length && !allowEmpty) throw new Error("请至少选择一位拟培养角色")
    const content = JSON.stringify({ schemaVersion: 1, accountId: account.id, characters, updatedAt: new Date().toISOString() }, null, 2)
    if (!io.writeTextSync(path, content, false) || io.readTextSync(path) !== content) throw new Error("拟培养角色保存失败")
    return characters
  } }
}

export async function resolveTrainingCharacters(options, customProfiles, cancellationToken) {
  const account = createAccountStore(options.userIdentifier).snapshot()
  const store = createTrainingStore(options.userIdentifier)
  const catalog = trainingCatalog(customProfiles, account.characters, loadCharacterSearch())
  const unsupported = [...new Set(Object.values(account.characters).map(record => record.identity?.displayName)
    .filter(name => name && !catalog.some(row => row.name === normalizeTravelerLabel(name) || name === "旅行者" && row.name.startsWith("旅行者（"))))]
  let selected = store.read()
  const available = new Set(catalog.map(row => row.name))
  const stale = selected.filter(name => !available.has(name))
  if (stale.length) log.info(`以下角色缺少当前评分规则，请重新选择：${stale.join("、")}`)
  if (options.selectTrainingCharacters === true || !selected.length || stale.length) {
    const id = htmlMask.show("assets/training-characters.html", `strongbox-training-${Date.now()}`)
    if (!id) throw new Error("无法打开拟培养角色选择窗口")
    try {
      htmlMask.setClickThrough(id, false)
      while (!cancellationToken.isCancellationRequested && htmlMask.exists(id)) {
        htmlMask.send(id, "/training", JSON.stringify({ accountId: account.accountId, catalog, selected, unsupported }))
        const message = await htmlMask.receive(id, 500)
        if (!message) continue
        let event
        try { event = JSON.parse(message) } catch { continue }
        if (event.url !== "/training/save") continue
        try {
          selected = store.save(event.data?.characters, catalog)
          log.info(`已保存${selected.length}位拟培养角色：${selected.join("、")}`)
          break
        } catch (error) { htmlMask.send(id, "/training/error", JSON.stringify({ message: error.message })) }
      }
      if (cancellationToken.isCancellationRequested || !htmlMask.exists(id)) return null
    } finally { if (htmlMask.exists(id)) htmlMask.close(id) }
  }
  return { characters: selected, profileIds: catalog.filter(row => selected.includes(row.name)).flatMap(row => row.profileIds) }
}
