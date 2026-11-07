import { identityAliases } from "./character-names.js"
import { cleanCharacterRecord } from "./account-data-quality.js"
function clone(value) { return JSON.parse(JSON.stringify(value)) }

export function accountFileName(value) {
  const id = String(value || "").trim().normalize("NFKC")
  if (!id || id.length > 40 || /[\u0000-\u001f]/.test(id)) throw new Error("请填写1～40字的用户标识（可用UID）")
  // 编码全部字符，避免 Windows 大小写折叠、路径字符、保留文件名导致串账号。
  const key = /^\d{8,12}$/.test(id) ? `uid-${id}`
    : "id-" + Array.from({ length: id.length }, (_, i) => id.charCodeAt(i).toString(16).padStart(4, "0")).join("")
  return { id, path: `data/accounts/${key}.json` }
}

export function characterKey(identity) {
  const value = `${identity.kind === "mannequin" ? "mannequin" : identity.element || ""}:${identity.kind === "traveler" ? "旅行者" : identity.displayName}`
  return "char-" + Array.from({ length: value.length }, (_, i) => value.charCodeAt(i).toString(16).padStart(4, "0")).join("")
}

export function mergeCharacter(previous, incoming) {
  const merged = { ...(previous || {}), ...incoming,
    slots: { ...(previous?.slots || {}) }, recommendations: { ...(previous?.recommendations || {}) } }
  for (const [slot, next] of Object.entries(incoming.slots || {})) {
    const old = previous?.slots?.[slot]
    // 同字段的可靠新数据覆盖旧值；失败观察不把已确认装备静默清空。
    merged.slots[slot] = next.status === "equipped" || !(old?.equippedArtifact || old?.lastVerifiedArtifact) ? next : {
      ...next, equippedArtifact: null, lastVerifiedArtifact: old.equippedArtifact || old.lastVerifiedArtifact, baselineStale: true,
      lastVerifiedAt: old.lastVerifiedAt || old.observedAt
    }
  }
  for (const [slot, next] of Object.entries(incoming.recommendations || {})) {
    if (next.status === "ok") merged.recommendations[slot] = next
    else merged.recommendations[slot] = { ...next,
      previousVerified: previous?.recommendations?.[slot]?.status === "ok" ? previous.recommendations[slot]
        : previous?.recommendations?.[slot]?.previousVerified || null }
  }
  if (incoming.setRecommendations && !incoming.setRecommendations.complete && previous?.setRecommendations?.complete) {
    merged.setRecommendations = { ...(incoming.setRecommendations || { complete: false }),
      previousVerified: previous.setRecommendations }
  }
  return merged
}

export function createAccountStore(userId, io = file) {
  const account = accountFileName(userId)
  const validate = value => {
    if (!value || value.schemaVersion !== 1 || value.accountId !== account.id ||
        !value.characters || typeof value.characters !== "object" || Array.isArray(value.characters) ||
        !Number.isInteger(value.revision)) throw new Error("账号文件格式或用户标识不匹配")
    return value
  }
  const candidates = []
  let existing = false
  const companion = suffix => account.path.replace(/\.json$/, `.${suffix}.json`)
  for (const path of [account.path, companion("pending"), companion("backup")]) {
    if (!io.isExists(path)) continue
    existing = true
    try { candidates.push(validate(JSON.parse(io.readTextSync(path)))) } catch { /* 尝试其他完整副本 */ }
  }
  if (existing && !candidates.length) throw new Error(`账号文件损坏，请先检查 ${account.path}，未覆盖原文件`)
  let data = candidates.sort((a, b) => b.revision - a.revision)[0] || {
    schemaVersion: 1, accountId: account.id, revision: 0, characters: {}, createdAt: new Date().toISOString()
  }
  let committed = clone(data)
  data = { ...data, characters: Object.fromEntries(Object.entries(data.characters).map(([key, record]) => [key, cleanCharacterRecord(record)])) }
  const checkedWrite = (path, value) => {
    const content = JSON.stringify(value, null, 2)
    if (!io.writeTextSync(path, content, false)) throw new Error(`账号文件写入失败：${path}`)
    if (io.readTextSync(path) !== content) throw new Error(`账号文件回读校验失败：${path}`)
  }
  return {
    path: account.path,
    snapshot: () => clone(data),
    identityRecords: () => Object.fromEntries(Object.entries(data.characters).map(([key, value]) => [key, { identity: clone(value.identity) }])),
    bindUid(uid) {
      if (!uid) return
      if (/^\d{8,12}$/.test(account.id) && account.id !== uid) throw new Error("填写的UID与当前游戏UID不符，已停止录入")
      if (data.observedUid && data.observedUid !== uid) throw new Error("此用户标识已绑定其他账号UID，请换用正确标识")
      data.observedUid = uid
    },
    saveCharacter(record) {
      const name = value => String(value || "").normalize("NFKC").replace(/\s/g, "")
      const names = new Set(identityAliases(record.identity).map(name))
      const special = kind => ["mannequin", "wanderer", "traveler"].includes(kind)
      const matches = Object.entries(data.characters).filter(([, value]) =>
        names.has(name(value.identity?.displayName)) &&
        (name(value.identity?.displayName) === name(record.identity.displayName) ||
          !(special(record.identity.kind) && value.identity.kind === "regular" || record.identity.kind === "regular" && special(value.identity.kind))) &&
        (record.identity.kind === "mannequin" && value.identity.kind === "mannequin" ||
          !record.identity.element || !value.identity.element || record.identity.element === value.identity.element))
      matches.sort((a, b) => String(a[1].capturedAt || "").localeCompare(String(b[1].capturedAt || "")))
      const previous = matches.at(-1)
      const identity = { ...record.identity, element: record.identity.element || previous?.[1].identity.element || "",
        aliases: [...new Set([...matches.flatMap(([, value]) => identityAliases(value.identity)), ...identityAliases(record.identity)])] }
      const key = characterKey(identity)
      let merged = data.characters[key]
      for (const [, value] of matches) merged = mergeCharacter(merged, value)
      data.characters[key] = cleanCharacterRecord(mergeCharacter(merged, { ...record, identity }))
      if (record.identity.kind === "mannequin" && previous && previous[1].identity.element !== identity.element && !Object.keys(record.slots || {}).length) {
        data.characters[key].needsRefresh = true
        data.characters[key].complete = false
      }
      for (const [oldKey] of matches) if (oldKey !== key) delete data.characters[oldKey]
    },
    checkpoint(scan) {
      for (const key of Object.keys(data.characters)) data.characters[key] = cleanCharacterRecord(data.characters[key])
      const next = { ...data, revision: data.revision + 1, updatedAt: new Date().toISOString(), scan: clone(scan) }
      // BGI 写文件接口没有文件替换事务。用已回读的 pending 与 backup 保留可恢复副本。
      checkedWrite(companion("pending"), next)
      if (committed.revision) checkedWrite(companion("backup"), committed)
      checkedWrite(account.path, next)
      data = next
      committed = clone(next)
    }
  }
}
