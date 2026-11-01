const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const toolSource = fs.readFileSync(path.join(__dirname, '../maintenance/manage.cjs'));
const relativeTool = 'repo/js/AutoFishingTeyvat/maintenance/manage.cjs';

function git(cwd, ...args) {
    const result = cp.spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return result.stdout.trim();
}
function identity(cwd) {
    git(cwd, 'config', 'user.name', 'Sync Fixture');
    git(cwd, 'config', 'user.email', 'fixture@example.invalid');
    git(cwd, 'config', 'commit.gpgsign', 'false');
    git(cwd, 'config', 'core.autocrlf', 'false');
}
function setup() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fishing-sync-'));
    const upstream = path.join(root, 'upstream');
    const local = path.join(root, 'local');
    fs.mkdirSync(upstream);
    git(upstream, 'init', '-b', 'main');
    identity(upstream);
    const script = path.join(upstream, 'repo/js/AutoFishingTeyvat');
    for (const sub of ['maintenance', 'tests', 'assets']) fs.mkdirSync(path.join(script, sub), { recursive: true });
    fs.writeFileSync(path.join(upstream, relativeTool), toolSource);
    fs.writeFileSync(path.join(script, 'main.js'), "const mode = 'base';\n");
    fs.writeFileSync(path.join(script, 'manifest.json'), '{}');
    fs.writeFileSync(path.join(script, 'settings.json'), '[]');
    fs.writeFileSync(path.join(script, 'assets/base.json'), '{}');
    fs.writeFileSync(path.join(script, 'tests/fixture.test.cjs'), "require('node:test').test('fixture verification', () => {});\n");
    git(upstream, 'add', '.');
    git(upstream, 'commit', '-m', 'Base fixture');
    git(root, 'clone', '--quiet', upstream, local);
    identity(local);
    git(local, 'remote', 'rename', 'origin', 'upstream');
    git(local, 'switch', '-c', 'custom/fishing-area-priority');
    fs.writeFileSync(path.join(local, 'repo/js/AutoFishingTeyvat/main.js'), "const mode = 'custom';\n");
    git(local, 'add', '.');
    git(local, 'commit', '-m', 'Custom fixture');
    return { upstream, local, script, customCommit: git(local, 'rev-parse', 'HEAD') };
}
function sync(local) {
    return cp.spawnSync(process.execPath, [path.join(local, relativeTool), 'sync'], {
        cwd: local, encoding: 'utf8', windowsHide: true
    });
}

test('同步用 merge 保留定制提交并引入上游资源，拒绝覆盖分叉的 main', () => {
    const { upstream, local, script, customCommit } = setup();
    fs.writeFileSync(path.join(script, 'assets/new-point.json'), '{}');
    git(upstream, 'add', '.');
    git(upstream, 'commit', '-m', 'Upstream resource');
    const result = sync(local);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    git(local, 'merge-base', '--is-ancestor', customCommit, 'HEAD');
    git(local, 'merge-base', '--is-ancestor', 'upstream/main', 'HEAD');
    assert.equal(git(local, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ').length, 3);
    assert.equal(git(local, 'rev-parse', 'main'), git(local, 'rev-parse', 'upstream/main'));
    assert.equal(fs.readFileSync(path.join(local, 'repo/js/AutoFishingTeyvat/main.js'), 'utf8'), "const mode = 'custom';\n");
    assert.ok(fs.existsSync(path.join(local, 'repo/js/AutoFishingTeyvat/assets/new-point.json')));
    const previousHead = git(local, 'rev-parse', 'HEAD');
    git(local, 'switch', 'main');
    fs.writeFileSync(path.join(local, 'local-main-only.txt'), 'keep');
    git(local, 'add', '.');
    git(local, 'commit', '-m', 'Independent main work');
    const divergentMain = git(local, 'rev-parse', 'HEAD');
    git(local, 'switch', 'custom/fishing-area-priority');
    const rejected = sync(local);
    assert.notEqual(rejected.status, 0);
    assert.equal(git(local, 'rev-parse', 'main'), divergentMain);
    assert.equal(git(local, 'rev-parse', 'HEAD'), previousHead);
});

test('上游和定制修改同一行时停止同步，保留原提交且可中止合并', () => {
    const { upstream, local, script, customCommit } = setup();
    fs.writeFileSync(path.join(script, 'main.js'), "const mode = 'official';\n");
    git(upstream, 'add', '.');
    git(upstream, 'commit', '-m', 'Conflicting upstream work');
    const result = sync(local);
    assert.notEqual(result.status, 0);
    assert.equal(git(local, 'rev-parse', 'HEAD'), customCommit);
    assert.ok(git(local, 'ls-files', '-u'));
    git(local, 'merge', '--abort');
    assert.equal(git(local, 'status', '--porcelain'), '');
    assert.equal(fs.readFileSync(path.join(local, 'repo/js/AutoFishingTeyvat/main.js'), 'utf8'), "const mode = 'custom';\n");
});
