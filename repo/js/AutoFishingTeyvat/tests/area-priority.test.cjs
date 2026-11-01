const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const ui = JSON.parse(fs.readFileSync(path.join(root, 'settings.json'), 'utf8'));
const allRoutes = { block_fight: true, block_tsurumi: true, block_gcm: false };
const NOW = Date.UTC(2026, 10, 1, 12);
const region = value => value.split('-')[0];
const pointName = value => value.split('-').slice(0, 3).join('-');
const plain = value => JSON.parse(JSON.stringify(value));

async function scenario(settings = {}, { archive, random = () => 0, now = NOW } = {}) {
    const messages = [];
    let reads = 0;
    let rolls = 0;
    class FixedDate extends Date {
        constructor(...args) { super(...(args.length ? args : [now])); }
        static now() { return now; }
    }
    const math = Object.create(Math);
    math.random = () => { rolls++; return random(); };
    const context = vm.createContext({ settings, Date: FixedDate, Math: math,
        file: {
            readPathSync: () => archive ? ['assets\\archive.json'] : [],
            readTextSync: name => {
                assert.equal(name, 'assets/archive.json');
                reads++;
                return JSON.stringify(archive);
            }
        },
        log: {
            info: message => messages.push(message), warn: message => messages.push(message),
            error: message => { throw new Error(message); }
        }
    });
    const code = source.replace('await main();', `globalThis.api = {
        raw: pathing_filter, strategy: get_region_strategy, cdCal,
        plan: (cooldown = false, debug = false, uid = 'fixture') => prepare_paths(pathing_filter(), cooldown, debug, uid),
        main
    };`).replace('// 调整分辨率和dpi，适应键鼠配置',
        'globalThis.result = {paths: path_filter, resume: path_continue}; return;\n        // stop before BGI operations');
    assert.notEqual(code, source);
    await vm.runInContext(code, context, { timeout: 1000 });
    return { api: context.api, context, messages, reads: () => reads, rolls: () => rolls };
}

test('设置合并为一个三策略下拉框及一个地区多选', () => {
    const mode = ui.find(item => item.name === 'path_region_mode');
    assert.equal(mode.type, 'select');
    assert.deepEqual(mode.options, ['地区筛选', '地区优先', '随机化']);
    assert.equal(mode.default, '地区筛选');
    assert.equal(ui.find(item => item.name === 'path_sort_area').type, 'multi-checkbox');
    assert.equal(ui.some(item => item.name === 'path_priority_area'), false);
});

test('地区筛选只保留勾选地区，留空保持全图原顺序', async () => {
    const baseline = Array.from((await scenario()).api.raw());
    assert.deepEqual(Array.from((await scenario({ path_region_mode: '地区筛选' })).api.plan()), baseline);
    const filtered = Array.from((await scenario({ path_region_mode: '地区筛选', path_sort_area: ['璃月', '蒙德'] })).api.plan());
    assert.deepEqual(filtered, baseline.filter(p => ['璃月', '蒙德'].includes(region(p))));
});

test('地区优先按点击顺序分组，其余地区及组内顺序完整保留', async () => {
    const priorities = ['稻妻', '璃月', '蒙德'];
    const baseline = Array.from((await scenario()).api.raw());
    const result = await scenario({ path_region_mode: '地区优先', path_sort_area: priorities });
    const actual = Array.from(result.api.plan());
    assert.deepEqual(actual, priorities.flatMap(area => baseline.filter(p => region(p) === area))
        .concat(baseline.filter(p => !priorities.includes(region(p)))));
    assert.ok(result.messages.some(m => m.includes('1.稻妻 → 2.璃月 → 3.蒙德')));
    for (const areas of [['稻妻', '蒙德'], ['稻妻', '蒙德', '璃月']]) {
        const scenarioResult = await scenario({ path_region_mode: '地区优先', path_sort_area: areas });
        assert.deepEqual([...new Set(Array.from(scenarioResult.api.plan()).map(region))].slice(0, areas.length), areas);
    }
});

test('旧筛选和优先配置可兼容，新策略忽略过期优先字段', async () => {
    const legacy = await scenario({ path_sort_area: [], path_priority_area: ['至冬', '霜月'] });
    assert.deepEqual(plain(legacy.api.strategy()), { mode: '地区优先', areas: ['至冬', '霜月'] });
    const filtered = await scenario({ path_sort_area: ['璃月'], path_priority_area: ['稻妻'] });
    assert.ok(Array.from(filtered.api.plan()).every(p => region(p) === '璃月'));
    const explicit = await scenario({ path_region_mode: '地区优先', path_sort_area: [], path_priority_area: ['至冬'] });
    assert.deepEqual(Array.from(explicit.api.plan()), Array.from((await scenario()).api.raw()));
});

test('随机化用 Fisher–Yates 重排全部或选定地区，不丢失不重复', async () => {
    for (const areas of [[], ['璃月', '蒙德']]) {
        const result = await scenario({ ...allRoutes, path_region_mode: '随机化', path_sort_area: areas });
        const baseline = Array.from(result.api.raw());
        const actual = Array.from(result.api.plan());
        assert.deepEqual(actual, baseline.slice(1).concat(baseline[0]));
        assert.deepEqual([...actual].sort(), [...baseline].sort());
        assert.equal(new Set(actual).size, actual.length);
        assert.equal(result.rolls(), actual.length - 1);
    }
});

test('随机化先排除目标昼夜都冷却的点，保留半冷却、过期、无记录和其他账号的点', async () => {
    const settings = { ...allRoutes, path_region_mode: '随机化', path_sort_area: ['璃月'] };
    const baseline = Array.from((await scenario(settings)).api.raw());
    const record = {};
    const fresh = NOW - 1000;
    const expired = NOW - 4 * 86400000;
    record[pointName(baseline[0])] = { Daytime: fresh, Nighttime: fresh };
    record[pointName(baseline[1])] = { Daytime: fresh, Nighttime: null };
    record[pointName(baseline[2])] = { Daytime: expired, Nighttime: expired };
    const archive = { fixture: record, otherAccount: { [pointName(baseline[3])]: { Daytime: fresh, Nighttime: fresh } } };
    const result = await scenario(settings, { archive });
    const actual = Array.from(result.api.plan(true));
    assert.deepEqual([...actual].sort(), baseline.slice(1).sort());
    assert.deepEqual(archive.fixture, record);
});

test('随机化按目标鱼所需时段检查 CD，不用无关时段的空闲状态放行', async () => {
    for (const [fish, session, other] of [['水晶宴', 'Daytime', 'Nighttime'], ['擒霞客', 'Nighttime', 'Daytime']]) {
        const settings = { ...allRoutes, path_region_mode: '随机化', path_sort_area: ['璃月'], path_sort_fish: [fish] };
        const baseline = Array.from((await scenario(settings)).api.raw());
        assert.ok(baseline.length > 1);
        const archive = { fixture: { [pointName(baseline[0])]: { [session]: NOW, [other]: null } } };
        const actual = Array.from((await scenario(settings, { archive })).api.plan(true));
        assert.deepEqual([...actual].sort(), baseline.slice(1).sort());
    }
});

test('关闭 CD 不读取记录；不同账号互相独立', async () => {
    const settings = { ...allRoutes, path_region_mode: '随机化' };
    const baseline = Array.from((await scenario(settings)).api.raw());
    const archive = { fixture: Object.fromEntries(baseline.map(p => [pointName(p), { Daytime: NOW, Nighttime: NOW }])) };
    const disabled = await scenario(settings, { archive });
    assert.equal(disabled.api.plan(false).length, baseline.length);
    assert.equal(disabled.reads(), 0);
    const unknownAccount = await scenario(settings, { archive });
    assert.equal(unknownAccount.api.plan(true, false, 'other').length, baseline.length);
});

test('全部冷却时列表为空，没有可用点时不抽随机数', async () => {
    const settings = { ...allRoutes, path_region_mode: '随机化' };
    const baseline = Array.from((await scenario(settings)).api.raw());
    const archive = { fixture: Object.fromEntries(baseline.map(p => [pointName(p), { Daytime: NOW, Nighttime: NOW }])) };
    const result = await scenario(settings, { archive });
    assert.equal(result.api.plan(true).length, 0);
    assert.equal(result.rolls(), 0);
});

test('冷却到期边界立即可用', async () => {
    const settings = { ...allRoutes, path_region_mode: '随机化' };
    const baseline = Array.from((await scenario(settings)).api.raw());
    const recorded = new Date(NOW);
    recorded.setHours(0, 0, 0, 0);
    recorded.setDate(recorded.getDate() - 3);
    const archive = { fixture: { [pointName(baseline[0])]: { Daytime: recorded.getTime(), Nighttime: recorded.getTime() } } };
    const boundary = (await scenario()).api.cdCal('Daytime', { Daytime: recorded.getTime() });
    const result = await scenario(settings, { archive, now: boundary });
    assert.equal(result.api.plan(true).length, baseline.length);
});

test('随机化遵守战斗、键鼠和鹤观路线开关，调试模式保持单点直达', async () => {
    const result = await scenario({ path_region_mode: '随机化', block_gcm: true });
    assert.ok(Array.from(result.api.plan()).every(p => !['战斗', 'GCM'].includes(p.split('-')[5]) && !p.includes('鹤观')));
    const debug = await scenario({ path_region_mode: '随机化', block_gcm: true,
        path_select: '稻妻-垂钓点-神无冢九条阵屋东南-GCM' });
    const paths = Array.from(debug.api.plan(true, true));
    assert.equal(paths.length, 1);
    assert.equal(debug.rolls(), 0);
    assert.equal(debug.reads(), 0);
});

test('兑换材料仍按新地区范围筛选，优先模式覆盖全图', async () => {
    const material = { path_sort_material: '⚔渔获⚔（稻妻武器）' };
    for (const mode of ['地区筛选', '随机化']) {
        const result = await scenario({ ...allRoutes, ...material, path_region_mode: mode, path_sort_area: ['稻妻'] });
        const paths = Array.from(result.api.plan());
        assert.ok(paths.length > 0 && paths.every(p => region(p) === '稻妻'));
    }
    const result = await scenario({ ...material, path_region_mode: '地区优先', path_sort_area: ['稻妻'] });
    assert.ok(Array.from(result.api.plan()).some(p => region(p) !== '稻妻'));
});

test('随机化在 main 中生成顺序并忽略固定续跑起点', async () => {
    const result = await scenario({ ...allRoutes, path_region_mode: '随机化', fishing_cd: false,
        path_continue: '璃月-垂钓点-珉林奥藏山-普通' });
    await result.api.main();
    assert.equal(result.context.result.resume, '无(默认)');
    assert.ok(result.messages.some(m => m.includes('已忽略固定续跑起点')));
    assert.ok(result.context.result.paths.length > 0);
});
