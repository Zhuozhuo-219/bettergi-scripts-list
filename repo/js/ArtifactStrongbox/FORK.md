# Fork 中的圣遗物三合一脚本

源码位于 `repo/js/ArtifactStrongbox`，与自动钓鱼定制版共用 `custom/fishing-area-priority` 分支。
该分支名称沿用最初的钓鱼功能，现可同时保存多个个人脚本；main 继续跟随官方。

本次导入基于本机 0.9.3。main.js、utils、assets、运行设置及默认评分规则保持原样。
运行目录仍为 `E:\BetterGI\User\JsScript\ArtifactStrongbox`。

## 源码与个人数据

- 不上传账号、培养名单、运行日志、姓名迁移备份、参考截图和生成预览。
- 开发文档和 OCR 回归样本中的 UID、昵称已换成演示内容；对应测试同步修改。
- 不分发原始私人参考图，公开样本的 sha256 是占位值，不用作真实账号迁移证据。
- `--traveler-reference` 遇到脱敏样本会停止；需要在本机重新生成真实证据后才能迁移。
- 真实用户目录保持原样；本次导入不改变现有账号数据和 BGI 设置。
- 保留 utils/vendor 的来源记录和 MIT 许可，不新增全项目统一许可证。

## 提交与同步

在 `E:\bettergi-scripts-list` 执行。每步成功后再继续：

```powershell
node repo/js/ArtifactStrongbox/tools/verify-all.mjs
git add -- repo/js/ArtifactStrongbox
git commit -m "Update artifact strongbox"
git push origin custom/fishing-area-priority
```

获取官方更新仍使用已有 sync 命令，它合并整个父仓库，不仅限于钓鱼目录：

```powershell
node repo/js/AutoFishingTeyvat/maintenance/manage.cjs sync
git push origin custom/fishing-area-priority
```

官方目前没有同路径脚本，因此不会为此脚本提供独立功能更新。以后如官方加入同名目录，
合并可能需要处理冲突。

## 部署

从托盘退出 BetterGI 后，在仓库根目录执行：

```powershell
node repo/js/ArtifactStrongbox/tools/deploy.mjs --bgi-root 'E:\BetterGI'
```

工具先验证源码并备份旧目录，再逐文件复制代码。
已有 decision-rules.json、character-profiles.json、data/accounts、data/logs、data/name-migrations
根据 saved_files 保留，不用源码默认值覆盖；配置组参数保存在 BGI 中，也不更改。
备份位于 `E:\BetterGI-Dev\backups`。本次仅导入源码，不在运行中的 BGI 中部署或启动任务。

BGI 的官方 CNB 订阅不包含此个人脚本。Fork 的 main 和定制分支也不是 BGI 使用的 release 发布分支。
当前继续采用官方订阅加个人源码部署，完整说明见仓库根目录的「自定义脚本维护.md」。
