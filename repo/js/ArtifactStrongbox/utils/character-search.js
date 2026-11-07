const normalizeSearch = value => String(value || "").normalize("NFKC").toLowerCase().replace(/ü/g, "v")
  .normalize("NFD").replace(/[\u0300-\u036f\s'’·・（）()_-]/g, "")

export function loadCharacterSearch(io = file) {
  const path = "assets/character-search.json"
  if (io.isExists && !io.isExists(path)) return {}
  const raw = io.readTextSync(path)
  if (!raw) return {}
  const data = JSON.parse(raw)
  if (data.schemaVersion !== 1 || !data.entries || typeof data.entries !== "object") throw new Error("角色搜索字典格式错误")
  return data.entries
}

export function searchKeysForName(name, dictionary = {}) {
  const entry = dictionary[name]
  const keys = [name, entry?.pinyin, entry?.initials, ...(entry?.aliases || [])].filter(Boolean).map(normalizeSearch)
  return [...new Set(keys.flatMap(key => [key, key.replace(/v/g, "u")]))]
}
