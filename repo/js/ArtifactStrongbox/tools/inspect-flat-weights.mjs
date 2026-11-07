// 只读演示原评分固定攻击力换算；不读取账号或修改评分规则。
import { getAttrWeight, buildAttrs, getMaxMark, getMark, baseAttrMap } from '../utils/vendor/miao-score.js'
const character = '香菱', base = baseAttrMap[character]
const attrWeight = getAttrWeight(character, {}).attrWeight
const attrs = buildAttrs(attrWeight, base), config = { attrs, posMaxMark: getMaxMark(attrs) }
const artifact = { pos: 2, mainKey: 'mastery', mainValue: 187, subs: { cpct: 3.9, cdmg: 7.8, recharge: 6.5 } }
const score = fourth => getMark(config, 2, { ...artifact, subs: { ...artifact.subs, ...fourth } }, 'pyro')
const control = score({})
console.log(JSON.stringify({ character, source: 'Local ArtifactScore snapshot; controlled marginal score, not actual account equipment',
  baseAtk: base.atk, assumedWeaponBaseAtk: 520, atkWeight: attrWeight.atk,
  flatAtkCoefficient: attrs.atkPlus.mark, pctAtkCoefficient: attrs.atk.mark,
  flat19EquivalentAtkPct: 19 / (base.atk + 520) * 100,
  flat19Increment: score({ atkPlus: 19 }) - control,
  pct58Increment: score({ atk: 5.8 }) - control,
  flat19ToPct58Ratio: (score({ atkPlus: 19 }) - control) / (score({ atk: 5.8 }) - control)
}, null, 2))
