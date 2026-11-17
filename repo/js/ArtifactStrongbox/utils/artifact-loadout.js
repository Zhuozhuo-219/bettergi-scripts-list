import { SLOTS } from "./artifact-reader.js"

// 每个部位只保留每类套装的最高分，枚举五部位。other类不贡献要求的套装件数。
function bestLoadout(choices, required) {
  let best = null
  function visit(slot, counts, total, items) {
    if (slot === choices.length) {
      if (required.some(rule => (counts[rule.name] || 0) < rule.count)) return
      if (!best || total > best.score) best = { score: total, items }
      return
    }
    for (const choice of choices[slot]) {
      visit(slot + 1, { ...counts, [choice.setName]: (counts[choice.setName] || 0) + 1 }, total + choice.score, [...items, choice])
    }
  }
  visit(0, {}, 0, [])
  return best
}

export function observedLoadoutThreshold(candidate, baselineItems, inventory, required, scoreItem) {
  const choices = SLOTS.map((slot, index) => {
    const groups = new Map()
    // 固定每个部位现有主词条以保持加性比较可比，未收录主词条替代先不使用。
    for (const item of inventory.filter(item => item.slot === slot && item.input.mainKey === baselineItems[index].input.mainKey)) {
      const category = required.some(rule => rule.name === item.setName) ? item.setName : "other"
      const choice = { ...item, score: scoreItem(item) }
      if (!groups.has(category) || groups.get(category).score < choice.score) groups.set(category, choice)
    }
    return [...groups.values()]
  })
  if (choices.some(items => !items.length)) return null
  const without = bestLoadout(choices, required)
  const forced = choices.map((items, i) => SLOTS[i] === candidate.slot ? [{ ...candidate, score: 0 }] : items)
  const withCandidate = bestLoadout(forced, required)
  if (!without || !withCandidate) return null
  return { threshold: without.score - withCandidate.score, items: withCandidate.items,
    baselineTotal: without.score, companionTotal: withCandidate.score, scope: "已录入装备的可行组合" }
}
