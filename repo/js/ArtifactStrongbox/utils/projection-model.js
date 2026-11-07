import scoreData, { getAttrWeight, buildAttrs, getMaxMark, getMark, baseAttrMap } from "./vendor/miao-score.js"
import { getSubStatKey, getSubStatRolls, estimateSubStatRolls } from "./artifact-enhancement.js"
import { travelerDisplayName } from "./character-names.js"

export const MODEL_VERSION = "miao-local-0.4.0"
const SLOTS = ["生之花", "死之羽", "时之沙", "空之杯", "理之冠"]
const MAIN_KEYS = {
  "生命值": "hp", "攻击力": "atk", "防御力": "def", "元素精通": "mastery",
  "元素充能效率": "recharge", "暴击率": "cpct", "暴击伤害": "cdmg", "治疗加成": "heal",
  "火元素伤害加成": "pyro", "水元素伤害加成": "hydro", "冰元素伤害加成": "cryo",
  "雷元素伤害加成": "electro", "风元素伤害加成": "anemo", "岩元素伤害加成": "geo",
  "草元素伤害加成": "dendro", "物理伤害加成": "phy"
}
// 五星 +20 主词条的游戏显示尺度，与原单件评分器使用的输入单位一致。
export const MAX_MAIN_VALUES = {
  hpPlus: 4780, atkPlus: 311, hp: 46.6, atk: 46.6, def: 58.3,
  mastery: 187, recharge: 51.8, cpct: 31.1, cdmg: 62.2, heal: 35.9,
  pyro: 46.6, hydro: 46.6, cryo: 46.6, electro: 46.6,
  anemo: 46.6, geo: 46.6, dendro: 46.6, phy: 58.3
}
const ALLOWED_MAIN = [
  ["hpPlus"], ["atkPlus"], ["hp", "atk", "def", "mastery", "recharge"],
  ["hp", "atk", "def", "mastery", "pyro", "hydro", "cryo", "electro", "anemo", "geo", "dendro", "phy"],
  ["hp", "atk", "def", "mastery", "cpct", "cdmg", "heal"]
]
const TRAVELER = { anemo: "风", geo: "岩", electro: "雷", dendro: "草", hydro: "水", pyro: "火", cryo: "冰" }
const WEIGHT_KEYS = new Set(["hp", "atk", "def", "mastery", "recharge", "cpct", "cdmg", "dmg", "phy", "heal"])
export const scoreRound = value => Math.round(value * 10) / 10

// 只验证属性名称、部位和单位，推荐行没有当前数值也能使用。
export function getMainStatKey(slot, stat) {
  const pos = SLOTS.indexOf(slot)
  let key = MAIN_KEYS[stat?.name]
  if (pos === 0 && stat?.name === "生命值" && stat.percent === false) key = "hpPlus"
  if (pos === 1 && stat?.name === "攻击力" && stat.percent === false) key = "atkPlus"
  if (pos < 0 || !ALLOWED_MAIN[pos].includes(key) || typeof stat?.percent !== "boolean") return ""
  const integer = ["hpPlus", "atkPlus", "mastery"].includes(key)
  return stat.percent === integer ? "" : key
}

export function validateProfileDatabase(database) {
  if (database?.schemaVersion !== 1 || !Array.isArray(database.profiles)) throw new Error("角色分支配置格式错误")
  const ids = new Set()
  const isObject = value => value && typeof value === "object" && !Array.isArray(value)
  return database.profiles.filter(profile => {
    if (!isObject(profile)) throw new Error("角色分支必须为对象")
    return profile.enabled !== false
  }).map(profile => {
    if (typeof profile.id !== "string" || !profile.id.trim() || ids.has(profile.id) ||
      !Object.hasOwn(scoreData.usefulAttr, profile.character)) throw new Error("角色分支名称、ID 或角色无效")
    ids.add(profile.id)
    if (profile.label !== undefined && typeof profile.label !== "string") throw new Error("分支标签必须为文字")
    const options = profile.options || {}
    if (profile.character === "旅行者" && !Object.hasOwn(TRAVELER, options.elem)) throw new Error("旅行者分支必须指定七种元素之一")
    if (!isObject(options) || (options.charAttrs !== undefined && !isObject(options.charAttrs)) ||
      (profile.weightOverrides !== undefined && !isObject(profile.weightOverrides))) throw new Error("角色条件与权重必须为对象")
    const allowedOptions = ["cons", "elem", "weaponName", "weaponAffix", "charAttrs", "artisSets"]
    if (Object.keys(options).some(key => !allowedOptions.includes(key))) throw new Error("角色分支包含不支持的条件")
    if (options.cons !== undefined && (!Number.isInteger(options.cons) || options.cons < 0 || options.cons > 6)) throw new Error("命座必须为 0～6")
    if (options.weaponAffix !== undefined && (!Number.isInteger(options.weaponAffix) || options.weaponAffix < 1 || options.weaponAffix > 5)) throw new Error("精炼必须为 1～5")
    if (options.weaponName !== undefined && typeof options.weaponName !== "string") throw new Error("武器名必须为文字")
    if (options.elem !== undefined && ![...Object.keys(TRAVELER), "cryo"].includes(options.elem)) throw new Error("元素条件无效")
    if (options.artisSets !== undefined && (!Array.isArray(options.artisSets) || options.artisSets.some(name => typeof name !== "string"))) throw new Error("套装条件必须为名称数组")
    for (const [key, value] of Object.entries(options.charAttrs || {})) {
      if (!["hp", "atk", "def", "mastery", "recharge", "cpct", "cdmg"].includes(key) || !Number.isFinite(value) || value < 0) throw new Error("角色面板条件无效")
    }
    for (const [key, value] of Object.entries(profile.weightOverrides || {})) {
      if (!WEIGHT_KEYS.has(key) || !Number.isFinite(value) || value < 0) throw new Error("自定义词条权重无效")
    }
    return { ...profile, options, label: profile.label || "手工分支" }
  })
}

export function getCharacterProfiles(customProfiles = []) {
  const profiles = []
  for (const character of Object.keys(scoreData.usefulAttr)) {
    if (character === "旅行者") {
      for (const [elem, label] of Object.entries(TRAVELER)) profiles.push({
        id: `default:旅行者:${elem}`, character, name: travelerDisplayName(label), label: "通用", options: { elem }
      })
    } else profiles.push({
      id: `default:${character}`, character, name: character, label: "通用",
      options: { elem: scoreData.charElemMap[character] || "" }
    })
  }
  for (const profile of customProfiles) profiles.push({
    ...profile, id: `custom:${profile.id}`, name: profile.character === "旅行者" ? travelerDisplayName(TRAVELER[profile.options.elem]) : profile.character,
    options: { elem: scoreData.charElemMap[profile.character] || "", ...profile.options }
  })
  return profiles
}

export function prepareProjectionInput(artifact) {
  const progress = artifact.enhancement
  if (!progress?.consistent) throw new Error("等级或四条词条状态需核对，暂不预测")
  const pos = SLOTS.indexOf(artifact.slot)
  const main = artifact.mainStat
  let mainKey = MAIN_KEYS[main?.name]
  if (pos === 0 && main?.name === "生命值" && !main.percent) mainKey = "hpPlus"
  if (pos === 1 && main?.name === "攻击力" && !main.percent) mainKey = "atkPlus"
  if (pos < 0 || !ALLOWED_MAIN[pos].includes(mainKey)) throw new Error("主词条与部位不匹配")
  const mainInteger = ["hpPlus", "atkPlus", "mastery"].includes(mainKey)
  if (!Number.isFinite(main.value) || main.value <= 0 || Boolean(main.percent) === mainInteger ||
    main.value > MAX_MAIN_VALUES[mainKey] + (mainInteger ? 0.51 : 0.051)) throw new Error("主词条数值或单位需核对")
  if (artifact.level === 20 && Math.abs(main.value - MAX_MAIN_VALUES[mainKey]) > (mainInteger ? 0.51 : 0.051)) throw new Error("满级主词条数值需核对")
  const stats = artifact.subStats
  if (stats.length !== 4) throw new Error("四条词条未完整读取")
  const keys = stats.map(getSubStatKey)
  if (keys.some(key => !getSubStatRolls(key)) || new Set(keys).size !== 4 || keys.includes(mainKey)) throw new Error("副词条重复或与主词条冲突")
  let possibleCounts = new Set([0])
  for (let i = 0; i < 4; i++) {
    const stat = stats[i]
    const percent = !keys[i].endsWith("Plus") && keys[i] !== "mastery"
    const estimate = estimateSubStatRolls(keys[i], stat.value,
      stat.activation === "pending" ? 1 : progress.completedNodes + 1)
    if (Boolean(stat.percent) !== percent || !estimate) throw new Error(`${stat.name}的数值或单位需核对`)
    possibleCounts = new Set([...possibleCounts].flatMap(sum => estimate.compatibleCounts.map(count => sum + count)))
  }
  const countBudgets = progress.completedNodes === 0 ? [4] : [3, 4].map(initial => initial + progress.completedNodes)
  if (!countBudgets.some(budget => possibleCounts.has(budget))) throw new Error("副词条累计次数与等级不一致，请核对")
  const values = stats.map(stat => stat.value)
  return {
    pos, mainKey, mainValue: MAX_MAIN_VALUES[mainKey], keys, values,
    names: stats.map(stat => stat.name), percent: stats.map(stat => stat.percent),
    rollTables: keys.map(getSubStatRolls), remainingUpgrades: progress.remainingUpgradeCount,
    activation: stats.filter(stat => stat.activation === "pending").map(stat => ({
      key: getSubStatKey(stat), name: stat.name, value: stat.value, percent: stat.percent
    })),
    setName: artifact.setName || "", level: artifact.level
  }
}

export function compileCharacterScorer(profile, input) {
  const artifact = { pos: input.pos, mainKey: input.mainKey, mainValue: input.mainValue,
    subs: Object.fromEntries(input.keys.map((key, index) => [key, input.values[index]])) }
  const options = { ...profile.options, artifacts: [artifact] }
  const selected = getAttrWeight(profile.character, options)
  const weights = { ...selected.attrWeight, ...profile.weightOverrides }
  const attrs = buildAttrs(weights, baseAttrMap[profile.character] || { hp: 14000, atk: 230, def: 700 })
  const config = { attrs, posMaxMark: getMaxMark(attrs) }
  const direct = subs => getMark(config, input.pos, { ...artifact, subs }, options.elem || "", 0)
  const intercept = direct({})
  const coefficients = input.keys.map(key => direct({ [key]: 1 }) - intercept)
  if (![intercept, ...coefficients].every(Number.isFinite) || coefficients.some(value => value < -1e-9)) throw new Error("评分权重异常")
  return {
    title: profile.weightOverrides ? `${profile.label}·自定权重` : selected.title,
    weights, coefficients, intercept,
    score: values => intercept + coefficients.reduce((sum, coefficient, index) => sum + coefficient * values[index], 0)
  }
}
