const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { deployToRoot, safeJoin, migrateRegionSettings } = require('../maintenance/manage.cjs');

test('部署路径拒绝越出目标目录', () => {
    assert.throws(() => safeJoin(os.tmpdir(), '../outside'));
    assert.throws(() => safeJoin(os.tmpdir(), '.'));
});

test('独立部署保留冷却记录、其他文件及原版，切换配置组保留所有参数', () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'fishing-maintenance-'));
    const bgi = path.join(fixture, 'BetterGI');
    const jsRoot = path.join(bgi, 'User', 'JsScript');
    const original = path.join(jsRoot, 'AutoFishingTeyvat');
    const custom = path.join(jsRoot, 'AutoFishingTeyvat_Custom');
    const groups = path.join(bgi, 'User', 'ScriptGroup');
    fs.mkdirSync(path.join(original, 'assets'), { recursive: true });
    fs.mkdirSync(groups, { recursive: true });
    fs.writeFileSync(path.join(bgi, 'BetterGI.exe'), 'fixture');
    fs.writeFileSync(path.join(original, 'main.js'), 'original sentinel');
    const record = JSON.stringify({ fixture: { cooldown: true } });
    fs.writeFileSync(path.join(original, 'assets', 'archive.json'), record);
    const settings = { path_priority_area: ['稻妻', '璃月'], fishing_cd: true, time_out_whole: '360' };
    const originalGroup = { name: 'fixture', projects: [{
        name: 'original', folderName: 'AutoFishingTeyvat', type: 'Javascript',
        jsScriptSettingsObject: settings, status: 'Enabled'
    }, { folderName: 'OtherScript', type: 'Javascript', keep: true }] };
    const groupFile = path.join(groups, 'fixture.json');
    fs.writeFileSync(groupFile, JSON.stringify(originalGroup));
    const first = deployToRoot(bgi, true, path.join(fixture, 'backups'));
    const changed = JSON.parse(fs.readFileSync(groupFile, 'utf8'));
    assert.equal(changed.projects[0].folderName, 'AutoFishingTeyvat_Custom');
    assert.deepEqual(changed.projects[0].jsScriptSettingsObject, {
        path_region_mode: '地区优先', path_sort_area: ['稻妻', '璃月'], fishing_cd: true, time_out_whole: '360'
    });
    assert.deepEqual(changed.projects[1], originalGroup.projects[1]);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(first.backup, 'ScriptGroup', 'fixture.json'))), originalGroup);
    assert.equal(fs.readFileSync(path.join(custom, 'assets', 'archive.json'), 'utf8'), record);
    assert.equal(fs.readFileSync(path.join(original, 'main.js'), 'utf8'), 'original sentinel');
    const updatedRecord = JSON.stringify({ fixture: 'new cooldown state' });
    fs.writeFileSync(path.join(custom, 'assets', 'archive.json'), updatedRecord);
    fs.writeFileSync(path.join(custom, 'local-note.txt'), 'keep');
    fs.writeFileSync(path.join(custom, 'old-upstream.json'), '{}');
    const metadata = path.join(custom, '.custom-deployment.json');
    const old = JSON.parse(fs.readFileSync(metadata));
    old.files.push('old-upstream.json');
    fs.writeFileSync(metadata, JSON.stringify(old));
    const second = deployToRoot(bgi, true, path.join(fixture, 'backups'));
    assert.equal(fs.readFileSync(path.join(custom, 'assets', 'archive.json'), 'utf8'), updatedRecord);
    assert.equal(fs.readFileSync(path.join(custom, 'local-note.txt'), 'utf8'), 'keep');
    assert.equal(fs.existsSync(path.join(custom, 'old-upstream.json')), false);
    assert.equal(fs.existsSync(path.join(second.backup, 'AutoFishingTeyvat_Custom', 'old-upstream.json')), true);
    assert.deepEqual(second.changedGroups, []);
    assert.ok(JSON.parse(fs.readFileSync(path.join(custom, 'settings.json'))).some(s => s.name === 'path_region_mode'));
    // 临时目录保留在系统 TEMP，避免维护测试进行递归删除。
});

test('迁移保留旧筛选范围与优先顺序，已有新策略不覆盖', () => {
    const filtered = { path_sort_area: ['璃月'], path_priority_area: ['稻妻'], fishing_cd: false };
    assert.deepEqual(migrateRegionSettings(filtered), {
        path_sort_area: ['璃月'], path_region_mode: '地区筛选', fishing_cd: false
    });
    assert.deepEqual(filtered.path_priority_area, ['稻妻']);
    const configured = { path_region_mode: '随机化', path_sort_area: ['稻妻'] };
    assert.equal(migrateRegionSettings(configured), configured);
    assert.deepEqual(migrateRegionSettings(), { path_region_mode: '地区筛选', path_sort_area: [] });
});

test('已有定制配置不切换脚本也迁移，原版和已迁移参数保持不变', () => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'fishing-migration-'));
    const bgi = path.join(fixture, 'BetterGI');
    const groups = path.join(bgi, 'User', 'ScriptGroup');
    fs.mkdirSync(groups, { recursive: true });
    fs.writeFileSync(path.join(bgi, 'BetterGI.exe'), 'fixture');
    const projects = [
        { type: 'Javascript', folderName: 'AutoFishingTeyvat_Custom', jsScriptSettingsObject: {
            path_sort_area: [], path_priority_area: ['至冬', '霜月'], time_out_whole: '360'
        } },
        { type: 'Javascript', folderName: 'AutoFishingTeyvat', jsScriptSettingsObject: { path_sort_area: ['璃月'] } },
        { type: 'Javascript', folderName: 'AutoFishingTeyvat_Custom', jsScriptSettingsObject: {
            path_region_mode: '随机化', path_sort_area: ['纳塔'], fishing_cd: false
        } }
    ];
    const file = path.join(groups, 'fixture.json');
    fs.writeFileSync(file, JSON.stringify({ projects }));
    const result = deployToRoot(bgi, false, path.join(fixture, 'backups'));
    const actual = JSON.parse(fs.readFileSync(file)).projects;
    assert.deepEqual(actual[0].jsScriptSettingsObject, {
        path_region_mode: '地区优先', path_sort_area: ['至冬', '霜月'], time_out_whole: '360'
    });
    assert.deepEqual(actual.slice(1), projects.slice(1));
    assert.equal(fs.existsSync(path.join(result.backup, 'ScriptGroup', 'fixture.json')), true);
});
