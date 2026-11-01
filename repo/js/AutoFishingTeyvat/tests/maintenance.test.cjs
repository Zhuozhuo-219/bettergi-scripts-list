const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { deployToRoot, safeJoin } = require('../maintenance/manage.cjs');

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
    assert.deepEqual(changed.projects[0].jsScriptSettingsObject, settings);
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
    assert.ok(JSON.parse(fs.readFileSync(path.join(custom, 'settings.json'))).some(s => s.name === 'path_priority_area'));
    // 临时目录保留在系统 TEMP，避免维护测试进行递归删除。
});
