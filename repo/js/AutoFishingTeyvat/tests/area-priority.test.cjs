const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const ui = JSON.parse(fs.readFileSync(path.join(root, 'settings.json'), 'utf8'));
const areas = ui.find(item => item.name === 'path_sort_area').options;
const region = value => value.split('-')[0];

async function getPaths(settings = {}, raw = false) {
    const messages = [];
    const context = vm.createContext({ settings, log: {
        info: value => messages.push(value),
        error: value => { throw new Error(value); }
    } });
    let code = source.replace('// 读取要继续的路径',
        'globalThis.result = path_filter; return;\n        // 读取要继续的路径');
    assert.notEqual(code, source, 'Stop main before any game operations');
    if (raw) code = code.replace('await main();', 'globalThis.result = pathing_filter();');
    await vm.runInContext(code, context, { timeout: 1000 });
    return { paths: Array.from(context.result), messages };
}

test('原生多选覆盖全部地区，默认不排序', () => {
    const priority = ui.find(item => item.name === 'path_priority_area');
    assert.equal(priority.type, 'multi-checkbox');
    assert.deepEqual(priority.options, areas);
    assert.deepEqual(priority.default, []);
});
test('未配置和全部取消时保持原筛选顺序', async () => {
    for (const settings of [{}, { path_sort_area: ['璃月'] }, { path_sort_fish: ['雷鸣仙'] }]) {
        const original = (await getPaths(settings, true)).paths;
        assert.deepEqual((await getPaths(settings)).paths, original);
        assert.deepEqual((await getPaths({ ...settings, path_priority_area: [] })).paths, original);
    }
});
test('优先地区按次序执行，剩余钓点完整保留且顺序稳定', async () => {
    const priorities = ['稻妻', '璃月', '蒙德'];
    const original = (await getPaths({}, true)).paths;
    const { paths, messages } = await getPaths({ path_priority_area: priorities });
    const expected = priorities.flatMap(area => original.filter(p => region(p) === area))
        .concat(original.filter(p => !priorities.includes(region(p))));
    assert.deepEqual(paths, expected);
    assert.deepEqual([...paths].sort(), [...original].sort());
    assert.ok(messages.some(m => m.includes('1.稻妻 → 2.璃月 → 3.蒙德')));
});
test('取消中间项后顺位前移，重选排到最后', async () => {
    for (const priorities of [['稻妻', '蒙德'], ['稻妻', '蒙德', '璃月']]) {
        const { paths } = await getPaths({ path_priority_area: priorities });
        assert.deepEqual([...new Set(paths.map(region))].slice(0, priorities.length), priorities);
    }
});
test('原地区、鱼类、鱼饵、兑换材料及调试筛选保留相同钓点', async () => {
    for (const settings of [
        { path_sort_area: ['璃月', '枫丹'] },
        { path_sort_fish: ['金赤假龙'] },
        { path_sort_bait: ['温火饵'] },
        { path_sort_fish: ['花鳉'], path_sort_bait: ['温火饵'] },
        { path_sort_material: '⚔渔获⚔（稻妻武器）', path_sort_area: ['枫丹'] },
        { path_select: '稻妻-垂钓点-神无冢九条阵屋东南-GCM' },
        { path_sort_area: ['不存在'] }
    ]) {
        const original = (await getPaths(settings, true)).paths;
        const sorted = (await getPaths({ ...settings, path_priority_area: ['稻妻', '蒙德', '璃月'] })).paths;
        assert.deepEqual([...sorted].sort(), [...original].sort());
    }
    const { paths } = await getPaths({ path_sort_area: ['璃月'], path_priority_area: ['蒙德'] });
    assert.ok(paths.length > 0 && paths.every(p => region(p) === '璃月'));
});
test('全地区排序与无效、重复优先项不会丢失钓点', async () => {
    const original = (await getPaths({}, true)).paths;
    const priorities = [...areas].reverse();
    const { paths } = await getPaths({ path_priority_area: priorities });
    assert.deepEqual(paths, priorities.flatMap(area => original.filter(p => region(p) === area)));
    assert.deepEqual((await getPaths({ path_priority_area: ['无效', '稻妻', '稻妻', '璃月'] })).paths,
        (await getPaths({ path_priority_area: ['稻妻', '璃月'] })).paths);
});
