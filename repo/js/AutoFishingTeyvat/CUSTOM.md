# 地区优先定制版：分支、更新与个人数据

忘记日常命令时，可直接打开仓库根目录的 [自动钓鱼维护.md](../../../自动钓鱼维护.md)。

## 三个目录分别做什么

| 位置 | 用途 |
| --- | --- |
| `E:\bettergi-scripts-list` | 你的 Fork 的本地源码仓库；以后统一在这里修改、提交和同步 |
| `E:\BetterGI\User\JsScript\AutoFishingTeyvat` | 官方原版的运行目录，由官方订阅更新 |
| `E:\BetterGI\User\JsScript\AutoFishingTeyvat_Custom` | 定制版的运行目录，由本仓库的部署脚本更新 |

之前的 `E:\BetterGI-Dev\bettergi-scripts-list` 保留为旧源码备份，后续使用新仓库。
Git 的提交保存源码；BGI 的配置和冷却记录留在运行目录，由本地备份保护。

## 分支与远程

| 名称 | 含义 |
| --- | --- |
| `origin` | 你的 Fork：`https://github.com/Zhuozhuo-219/bettergi-scripts-list.git` |
| `upstream` | 官方父仓库：`https://github.com/babalae/bettergi-scripts-list.git` |
| `main` | 官方基线，跟随 `upstream/main`，不放定制改动 |
| `custom/fishing-area-priority` | 地区优先等定制功能，推送到你的 Fork 同名分支 |

一个仓库可以有多个分支，切换分支会改变工作目录中的源码。
日常保持在 `custom/fishing-area-priority` 即可，不必来回切换 main。
提交身份为 `Zhuozhuo-219 <zhuoz219@gmail.com>`，推送时使用已登录的 GitHub 凭据。
上游 push URL 为 `DISABLED`，个人更改只向 `origin` 推送。

## 第一次上传定制分支

```powershell
Set-Location 'E:\bettergi-scripts-list'
git switch custom/fishing-area-priority
git push -u origin custom/fishing-area-priority
```

`commit` 是保存到本机 Git 历史，`push` 是上传 GitHub。
第一次推送后，在 GitHub 的分支下拉框选择 `custom/fishing-area-priority` 才能看到定制代码。
main 页面继续显示官方代码是正常的，无需把定制分支合并到 main。

## 日常获取官方更新

在没有未提交修改时逐步执行，当前一步成功后再执行下一步：

```powershell
Set-Location 'E:\bettergi-scripts-list'
git switch custom/fishing-area-priority
node repo/js/AutoFishingTeyvat/maintenance/manage.cjs sync
git push origin custom/fishing-area-priority
```

`sync` 先创建本地备份分支，获取 upstream/main，把官方更新合并进定制分支，
更新本地 main，最后运行测试和资源校验。使用 merge 保留已发布提交历史，普通 push 即可。
不必先在 GitHub 点击「Sync fork」，定制分支直接从 upstream 获取官方更新。
如需让 GitHub 的 main 也跟随本地官方基线，成功同步后可另行执行 `git push origin main`。

发生冲突时 sync 会停止，不要继续推送或部署。处理冲突后执行：

```powershell
git add -- repo/js/AutoFishingTeyvat
git merge --continue
node repo/js/AutoFishingTeyvat/maintenance/manage.cjs verify
```

也可用 `git merge --abort` 撤销本次合并。更新同一段代码时可能需要人工处理，无法保证自动合并。
如果冲突涉及其他目录，也要逐一检查并暂存对应文件。

## 部署到 BGI，保留个人数据

退出 BetterGI 后，在仓库根目录执行：

```powershell
node repo/js/AutoFishingTeyvat/maintenance/manage.cjs deploy --bgi-root 'E:\BetterGI'
```

部署先备份整个定制目录，默认备份位置为 `E:\BetterGI-Dev\backups`。
部署保留定制目录的 assets/archive.json，不复制源码冷却文件。
旧版地区筛选和优先设置会备份后迁移到统一地区策略，其余个人参数保留。
只更新 AutoFishingTeyvat_Custom，不替换官方原版。部署来源记录在 `.custom-deployment.json`。
现有「自动钓鱼」配置组已指向定制版，不需要再次加 `--switch-groups`。
仅在首次安装、明确要将所有引用原版的配置组切到定制版时才使用该选项。

## 冷却记录和个人设置在哪里

- 冷却记录：`E:\BetterGI\User\JsScript\AutoFishingTeyvat_Custom\assets\archive.json`
- 地区优先顺序、超时、开关等设置：`E:\BetterGI\User\ScriptGroup\自动钓鱼.json` 中的 jsScriptSettingsObject
- 源码的 settings.json 定义设置界面，不是你当前勾选值的存档
- 两个脚本目录的冷却文件互相独立，重新获取原版不会自动继承定制版记录

manifest.json 的 saved_files 声明了冷却文件，但更新异常仍可能导致丢失。
本维护脚本先备份、保留记录、逐文件部署，不依赖删除整个目录来更新。
冷却记录及配置组包含个人账号信息，只在本地备份，不提交到 GitHub。
源码已忽略 assets/archive.json。

在「钓鱼点地区策略」下拉框中选择模式，三种模式共用一组「地区选择」复选框：

| 模式 | 地区选择的含义 |
| --- | --- |
| 地区筛选 | 只执行勾选地区，留空表示全部地区 |
| 地区优先 | 按点击顺序优先执行勾选地区，然后继续其他地区；留空保持原顺序 |
| 随机化 | 只在勾选地区内随机执行可用钓点，留空在全部地区内随机 |

原生复选框不显示顺位数字，优先顺序会写入日志。
随机化遵守鱼类、鱼饵或兑换材料筛选及路线开关；冷却统计开启时，先排除目标时段均冷却的点。
只冷却白天但夜晚仍需钓鱼时会保留；只需要白天的目标则只看白天 CD。
关闭冷却统计后不按记录排除钓点。可用性在任务开始时计算，运行时仍使用原有冷却复核。
随机化模式会忽略固定续跑起点，避免随机打乱后漏掉起点之前的点。

旧设置自动迁移：旧地区筛选为空且设有优先地区时，转为「地区优先」并保留点击顺序；
有旧地区筛选时，转为「地区筛选」以保留执行范围。已配置的新策略不会再次覆盖。
冷却文件不参与迁移，所有其他个人参数保留。

## 以后修改脚本如何提交

只编辑仓库中的 repo/js/AutoFishingTeyvat；直接修改 BGI 运行目录会在下次部署时被覆盖。
在仓库根目录执行：

```powershell
git switch custom/fishing-area-priority
node repo/js/AutoFishingTeyvat/maintenance/manage.cjs verify
git diff -- repo/js/AutoFishingTeyvat
git add -- repo/js/AutoFishingTeyvat
git commit -m "描述这次修改"
git push origin custom/fishing-area-priority
```

每一步成功后再继续。代码提交并验证后，退出 BGI 执行 deploy。
源码同步、提交和推送本身不改动游戏运行文件，也不会执行游戏任务。

## 回退与网络

同步前有 backup/fishing-area-priority-* 备份分支；早期 Git bundle 和原版快照在
`E:\BetterGI-Dev\recovery-20261101`。运行文件和配置可从最近部署备份恢复。

本机此仓库使用代理 http://127.0.0.1:7897，未修改全局 Git 设置。
代理改变后使用 `git config http.proxy <新地址>`，不需要代理时用 `git config --unset http.proxy`。
