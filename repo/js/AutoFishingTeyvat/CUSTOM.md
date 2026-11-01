# 地区优先定制版的维护

此分支基于 babalae/bettergi-scripts-list，保留原始目录结构，便于合并上游。

- 源码：`E:\BetterGI-Dev\bettergi-scripts-list\repo\js\AutoFishingTeyvat`
- 分支：`custom/fishing-area-priority`；`main` 跟随 `upstream/main`
- 官方原版：`E:\BetterGI\User\JsScript\AutoFishingTeyvat`，继续由官方订阅维护
- 独立定制版：`E:\BetterGI\User\JsScript\AutoFishingTeyvat_Custom`
- Git 仓库、提交和备份位于订阅目录外，不会被 BGI 更新脚本时清除
- 当前为本地 Git 分支，未在 GitHub 创建 Fork，也未向父仓库推送

## 设置地区优先顺序

在 BGI 的「自动钓鱼」配置组中打开定制版设置，依次勾选「优先钓鱼点地区」。
例如依次勾选稻妻、璃月，先执行这两个地区，再继续其余地区。若要遍历全部地区，
请把原来的「地区筛选」留空；该筛选仍会排除未选地区。

BGI 原生复选框保存点击顺序，但不显示顺位数字。取消后顺位前移，重选排到最后。
脚本运行日志会列出编号顺序。保留原有跑图、钓鱼、冷却和路线开关逻辑。

## 同步上游并部署

在独立源码目录打开 PowerShell，不要在官方订阅目录打开终端后让 BGI 更新该目录。
部署需要已安装 Git、Node.js，并且 BetterGI 已从托盘退出。

```powershell
Set-Location 'E:\BetterGI-Dev\bettergi-scripts-list\repo\js\AutoFishingTeyvat'
node maintenance/manage.cjs sync
node maintenance/manage.cjs deploy --bgi-root 'E:\BetterGI'
```

`sync` 在工作区干净且位于定制分支时，先创建本地备份分支，再 fetch 和 rebase
`upstream/main`，最后运行测试及资源校验。遇到冲突会停止，需要人工解决后执行
`git rebase --continue`，或用 `git rebase --abort` 返回同步前状态；不要部署冲突代码。
新增钓点可以随上游同步，修改同一行时无法保证自动合并。

`deploy` 先验证，再备份现有定制目录；只复制定制版，不覆盖官方目录。
保留 `assets/archive.json` 冷却记录及配置组参数，依据上次部署清单清理已移除文件。
首次安装如需将引用原版的配置组切到定制版，加 `--switch-groups`；其余任务不变。
备份位于 `E:\BetterGI-Dev\backups`，部署来源提交记录在定制目录的 `.custom-deployment.json`。

源码变更后先测试并提交再部署：

```powershell
node maintenance/manage.cjs verify
git add -- .
git commit -m "Update custom fishing behavior"
node maintenance/manage.cjs deploy --bgi-root 'E:\BetterGI'
```

定制目录不是官方订阅目标，不要使用官方订阅链接覆盖它。

## 回退

退出 BetterGI 后，可从最近部署备份恢复定制目录中的文件及 `ScriptGroup` 配置文件。
仅回到官方版时，在 BGI 配置组中把任务换为原版「提瓦特自动钓鱼（全流程+自选）」。
源码回退可从 `backup/fishing-area-priority-*` 分支或恢复目录内的 Git bundle 取得，
不要在部署目录内保存唯一的源码副本。

## 网络及远程备份

本机源码仓库单独配置了 HTTP 代理 `http://127.0.0.1:7897`，未修改全局 Git 设置。
若代理端口改变，在源码仓库执行 `git config http.proxy <新地址>`；不再需要代理时执行
`git config --unset http.proxy`。上游 push URL 被设置为 `DISABLED`，避免误推父仓库。

以后在自己的 GitHub 账户 Fork 父仓库后，可以额外设置自己的远程：

```powershell
git remote add origin https://github.com/<你的用户名>/bettergi-scripts-list.git
git push -u origin custom/fishing-area-priority
```

日常更新使用上面的 `sync`；上游远程保持 `upstream`，自己的远程使用 `origin`。
冷却记录及本机配置不应提交到 GitHub。
