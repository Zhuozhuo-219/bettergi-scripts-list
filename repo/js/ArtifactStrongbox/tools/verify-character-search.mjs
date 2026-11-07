import assert from 'node:assert/strict'
import fs from 'node:fs'
import crypto from 'node:crypto'
import vm from 'node:vm'
import { loadCharacterSearch, searchKeysForName } from '../utils/character-search.js'
import { trainingCatalog } from '../utils/training-characters.js'
const read = path => fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8')
const dictionary = JSON.parse(read('assets/character-search.json'))
const index = loadCharacterSearch({ readTextSync: read })
assert.equal(dictionary.nameDictionarySha256, crypto.createHash('sha256').update(read('assets/character-names.json')).digest('hex'))
for (const row of JSON.parse(read('assets/character-names.json')).characters) assert.ok(index[row.name]?.pinyin, row.name)
for (const [name, key] of [['纳西妲', 'nxd'], ['菈乌玛', 'lwm'], ['伊涅芙', 'ynf'], ['白术', 'baizhu'],
  ['白术', 'baishu'], ['重云', 'chongyun'], ['行秋', 'xingqiu'], ['八重神子', 'bachongshenzi'], ['旅行者（冰）', 'lvxingzhebing']]) {
  assert.ok(searchKeysForName(name, index).includes(key), `${name}: ${key}`)
}
assert.deepEqual(searchKeysForName('自定义名字'), ['自定义名字'])
assert.throws(() => loadCharacterSearch({ readTextSync: () => '{"schemaVersion":2}' }), /格式/)
const catalog = trainingCatalog([], { nahida: { identity: { displayName: '纳西妲', element: '草' } } }, index)
assert.equal(catalog.find(row => row.name === '纳西妲').element, '草')
assert.ok(catalog.find(row => row.name === '纳西妲').searchKeys.includes('naxida'))
// 独立选择窗口也按元素分组，并执行真实拼音/首字母搜索。
const elements = new Map()
const element = () => ({ value: '', children: [], scrollTop: 0, replaceChildren(...children) { this.children = children }, append(...children) { this.children.push(...children) } })
const byId = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id) }
const window = { htmlMask: {} }
const html = read('assets/training-characters.html')
vm.runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], { window, document: {
  getElementById: byId, createElement: element, createTextNode: value => ({ textContent: value }) } })
window.htmlMask.onMessage({ url: '/training', data: { catalog, accountId: 'test', selected: [], unsupported: [] } })
assert.equal(byId('list').children.length, 7, '七元素分组而非长表混排')
for (const query of ['nxd', 'NA XIDA', '菈乌玛', 'lwm']) {
  byId('search').value = query; byId('search').oninput()
  assert.equal(byId('list').children.length, 1, query)
  assert.equal(byId('list').children[0].children[1].children.length, 1, query)
}
byId('search').value = ''; byId('search').oninput()
byId('element-tabs').children.find(button => button.textContent === '冰').onclick()
assert.equal(byId('list').children.length, 1)
console.log('通过：134项持久化搜索索引、字典哈希、多音字/生僻字、旅行者及独立选择窗口的七元素/中文/全拼/首字母搜索。')
