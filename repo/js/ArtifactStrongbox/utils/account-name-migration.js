import { characterKey, mergeCharacter } from "./account-store.js"
import { createNameNormalizer, identityAliases } from "./character-names.js"
import { ownershipObservation } from "./account-reader.js"
import { SLOTS } from "./artifact-reader.js"

export function migrateAccountNames(input, dictionary, descriptions, referenceEvidence = []) {
  const data = JSON.parse(JSON.stringify(input))
  const original = data.characters
  data.characters = {}
  const changes = [], unresolved = []
  const normalizer = createNameNormalizer(dictionary, descriptions, () => data.characters)
  for (const [oldKey, record] of Object.entries(original).sort((a, b) => String(a[1].capturedAt || "").localeCompare(String(b[1].capturedAt || "")))) {
    const before = record.identity.displayName
    const reference = referenceEvidence.find(row => row.uid && row.uid === (input.observedUid || input.accountId) &&
      row.identity.verified && row.identity.kind === "traveler" && row.identity.element === record.identity.element &&
      identityAliases(record.identity).includes(row.identity.customName))
    if (reference) {
      record.identity.description = reference.identity.description
      record.identity.referenceEvidence = { file: reference.file, sha256: reference.sha256, uid: reference.uid }
    }
    record.identity = normalizer.identity(record.identity)
    record.identity.aliases = [...new Set([...identityAliases(original[oldKey].identity), ...identityAliases(record.identity)])]
    const key = characterKey(record.identity)
    const previous = data.characters[key]
    const aliases = [...new Set([...identityAliases(previous?.identity), ...identityAliases(record.identity)])]
    data.characters[key] = mergeCharacter(previous, record)
    data.characters[key].identity.aliases = aliases
    if (before !== record.identity.displayName || oldKey !== key) changes.push({ oldKey, key, before, after: record.identity.displayName, merged: Boolean(previous) })
    if (record.identity.kind === "unresolved") unresolved.push(before)
  }
  let ownerCorrections = 0
  for (const record of Object.values(data.characters)) {
    normalizer.setActiveIdentity(record.identity)
    for (const observation of Object.values(record.slots || {})) {
      for (const field of ["selectedArtifact", "equippedArtifact", "lastVerifiedArtifact"]) {
        const artifact = observation[field]
        if (!artifact?.owner) continue
        const match = normalizer.owner(artifact.owner)
        if (match.name !== artifact.owner) ownerCorrections++
        artifact.ownerRaw ||= artifact.owner
        artifact.owner = match.name
        artifact.ownerNormalization = match
      }
      observation.observedOwnerRaw ||= observation.observedOwner
      if (observation.selectedArtifact) Object.assign(observation, ownershipObservation(record.identity, observation.selectedArtifact, observation.observedAt))
      else if (observation.observedOwner) observation.observedOwner = normalizer.owner(observation.observedOwner).name
    }
    record.complete = SLOTS.every(slot => record.slots?.[slot]?.status === "equipped") &&
      SLOTS.every(slot => record.recommendations?.[slot]?.status === "ok") && Boolean(record.setRecommendations?.complete)
  }
  if (data.scan?.visited) data.scan.visited = data.scan.visited.map(row => {
    const match = normalizer.owner(row.name)
    const identity = Object.values(data.characters).find(record => record.identity.displayName === match.name)?.identity
    return identity ? { ...row, name: identity.displayName, key: characterKey(identity), rawName: row.rawName || row.name } : row
  })
  return { data, changes, ownerCorrections, unresolved: [...new Set(unresolved)] }
}
