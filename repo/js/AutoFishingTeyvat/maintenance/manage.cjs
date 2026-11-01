const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

const scriptRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(scriptRoot, '../../..');
const prefix = 'repo/js/AutoFishingTeyvat';
const branch = 'custom/fishing-area-priority';
const folder = 'AutoFishingTeyvat_Custom';
const displayName = '提瓦特自动钓鱼（地区优先定制版）';
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

function run(command, args, options = {}) {
    const result = cp.spawnSync(command, args, {
        cwd: repoRoot, encoding: 'utf8', windowsHide: true, ...options
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${command} ${args.join(' ')}\n${result.stdout || ''}${result.stderr || ''}`);
    return result.stdout || '';
}
const git = (...args) => run('git', args).trim();

function safeJoin(root, relative) {
    const target = path.resolve(root, relative);
    const back = path.relative(root, target);
    if (!back || back === '..' || back.startsWith(`..${path.sep}`) || path.isAbsolute(back)) {
        throw new Error(`Unsafe deployment path: ${relative}`);
    }
    return target;
}

function assertNoLinks(root) {
    if (fs.lstatSync(root).isSymbolicLink()) throw new Error(`Link not supported: ${root}`);
    if (fs.statSync(root).isDirectory()) {
        for (const name of fs.readdirSync(root)) assertNoLinks(path.join(root, name));
    }
}

function atomicWrite(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(temporary, data);
    fs.renameSync(temporary, file);
}

function assertStopped() {
    const tasks = run('tasklist.exe', ['/FI', 'IMAGENAME eq BetterGI.exe', '/FO', 'CSV', '/NH']);
    if (/^"BetterGI\.exe",/im.test(tasks)) {
        throw new Error('请从托盘退出 BetterGI 后再部署，避免配置被运行中的程序回写。');
    }
}

function assertCleanBranch() {
    if (git('branch', '--show-current') !== branch) throw new Error(`请切到 ${branch} 分支。`);
    if (git('status', '--porcelain')) throw new Error('工作区有未提交修改，请先提交或自行暂存，再执行维护。');
    if (fs.existsSync(path.join(repoRoot, '.git', 'rebase-merge')) ||
        fs.existsSync(path.join(repoRoot, '.git', 'rebase-apply'))) {
        throw new Error('请先完成或中止现有 rebase。');
    }
}

function verify() {
    run(process.execPath, ['--check', path.join(scriptRoot, 'main.js')]);
    const testFiles = fs.readdirSync(path.join(scriptRoot, 'tests'))
        .filter(name => name.endsWith('.test.cjs')).map(name => path.join(scriptRoot, 'tests', name));
    process.stdout.write(run(process.execPath, ['--test', ...testFiles]));
    let count = 0;
    function inspect(directory) {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const file = path.join(directory, entry.name);
            if (entry.isDirectory()) inspect(file);
            else if (entry.name.endsWith('.json')) {
                JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
                count++;
            }
        }
    }
    inspect(path.join(scriptRoot, 'assets'));
    for (const name of ['manifest.json', 'settings.json']) JSON.parse(fs.readFileSync(path.join(scriptRoot, name), 'utf8'));
    console.log(`资源 JSON 校验通过：${count} 个。`);
}

function sync() {
    assertCleanBranch();
    const backupRef = `backup/fishing-area-priority-${stamp()}`;
    git('branch', backupRef, 'HEAD');
    console.log(`同步前分支备份：${backupRef}`);
    process.stdout.write(run('git', ['fetch', 'upstream', 'main']));
    try {
        git('merge-base', '--is-ancestor', 'main', 'upstream/main');
    } catch {
        throw new Error('本地 main 含有与上游分叉的提交，已停止；请先检查 main，避免覆盖个人修改。');
    }
    try {
        process.stdout.write(run('git', ['merge', '--no-edit', 'upstream/main']));
    } catch (error) {
        throw new Error(`${error.message}\n遇到冲突已停止。请解决后 git add 并 git merge --continue，或 git merge --abort；不会部署冲突代码。`);
    }
    git('branch', '-f', 'main', 'upstream/main');
    verify();
    console.log('上游同步并验证完成；请退出 BetterGI 后执行 deploy。');
}

// 独立于 CLI 的部署操作，测试使用临时安装目录验证保留记录和配置。
function deployToRoot(bgiRoot, switchGroups = false, backupBase) {
    bgiRoot = path.resolve(bgiRoot);
    backupBase ||= path.join(path.dirname(bgiRoot), 'BetterGI-Dev', 'backups');
    if (!fs.existsSync(path.join(bgiRoot, 'BetterGI.exe'))) throw new Error('目标目录缺少 BetterGI.exe。');
    const jsRoot = path.join(bgiRoot, 'User', 'JsScript');
    const target = safeJoin(jsRoot, folder);
    const backup = path.join(backupBase, stamp());
    fs.mkdirSync(backup, { recursive: true });
    if (fs.existsSync(target)) {
        assertNoLinks(target);
        fs.cpSync(target, path.join(backup, folder), { recursive: true });
    }
    const entries = run('git', ['ls-files', '-z', '--', `${prefix}/`]).split('\0').filter(Boolean);
    const files = entries.map(name => name.slice(prefix.length + 1)).filter(name =>
        !name.startsWith('tests/') && !name.startsWith('maintenance/') &&
        name !== '.gitignore' && name !== 'assets/archive.json');
    for (const name of ['main.js', 'settings.json', 'manifest.json']) {
        if (!files.includes(name)) throw new Error(`部署源缺少 ${name}`);
    }
    const previousFile = path.join(target, '.custom-deployment.json');
    const previous = fs.existsSync(previousFile) ? JSON.parse(fs.readFileSync(previousFile, 'utf8')) : { files: [] };
    fs.mkdirSync(target, { recursive: true });
    // 仅删除上次部署清单中已被上游移除的单个文件，先备份，不删除整个目录。
    for (const name of previous.files) {
        if (name === 'assets/archive.json' || files.includes(name)) continue;
        const stale = safeJoin(target, name);
        if (fs.existsSync(stale) && fs.statSync(stale).isFile()) fs.unlinkSync(stale);
    }
    for (const name of files) {
        const source = safeJoin(scriptRoot, name);
        if (fs.lstatSync(source).isSymbolicLink()) throw new Error(`部署源不能是链接：${name}`);
        atomicWrite(safeJoin(target, name), fs.readFileSync(source));
    }
    const manifestFile = path.join(target, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    manifest.name = displayName;
    atomicWrite(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
    const archive = path.join(target, 'assets', 'archive.json');
    const originalArchive = path.join(jsRoot, 'AutoFishingTeyvat', 'assets', 'archive.json');
    if (!fs.existsSync(archive) && fs.existsSync(originalArchive)) {
        atomicWrite(archive, fs.readFileSync(originalArchive));
    }
    const changedGroups = [];
    if (switchGroups) {
        const groupRoot = path.join(bgiRoot, 'User', 'ScriptGroup');
        for (const name of fs.readdirSync(groupRoot).filter(name => name.endsWith('.json'))) {
            const file = safeJoin(groupRoot, name);
            const data = fs.readFileSync(file, 'utf8');
            const group = JSON.parse(data.replace(/^\uFEFF/, ''));
            let changed = false;
            for (const project of group.projects || []) {
                if (project.type === 'Javascript' && project.folderName === 'AutoFishingTeyvat') {
                    project.folderName = folder;
                    project.name = displayName;
                    changed = true;
                }
            }
            if (changed) {
                atomicWrite(path.join(backup, 'ScriptGroup', name), data);
                const newline = data.includes('\r\n') ? '\r\n' : '\n';
                const bom = data.startsWith('\uFEFF') ? '\uFEFF' : '';
                atomicWrite(file, bom + (JSON.stringify(group, null, 2) + '\n').replace(/\n/g, newline));
                changedGroups.push(name);
            }
        }
    }
    atomicWrite(previousFile, JSON.stringify({
        branch, commit: git('rev-parse', 'HEAD'), upstream: git('rev-parse', 'upstream/main'),
        deployedAt: new Date().toISOString(), files
    }, null, 2) + '\n');
    return { target, backup, changedGroups, fileCount: files.length };
}

function main() {
    const args = process.argv.slice(2);
    const command = args.shift();
    if (command === 'verify') return verify();
    if (command === 'sync') return sync();
    if (command === 'deploy') {
        assertCleanBranch();
        assertStopped();
        verify();
        let bgiRoot = path.resolve(repoRoot, '..', '..', 'BetterGI');
        let switchGroups = false;
        while (args.length) {
            const flag = args.shift();
            if (flag === '--bgi-root' && args.length) bgiRoot = path.resolve(args.shift());
            else if (flag === '--switch-groups') switchGroups = true;
            else throw new Error(`Unknown argument: ${flag}`);
        }
        console.log(JSON.stringify(deployToRoot(bgiRoot, switchGroups), null, 2));
        return;
    }
    throw new Error('Usage: node maintenance/manage.cjs verify|sync|deploy [--bgi-root PATH] [--switch-groups]');
}

module.exports = { deployToRoot, safeJoin };
if (require.main === module) {
    try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
