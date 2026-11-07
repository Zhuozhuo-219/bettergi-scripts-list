# 开发维护说明

当前实现：0.9.3。文档整理：2026-10-29。用户操作见 [README](../README.md)，发布范围见 [RELEASE](../RELEASE.md)。

## 文件分工

不移动运行文件，保持BGI导入路径、资源路径和保存目录兼容。

| 文件／目录 | 职责 |
| --- | --- |
| `main.js` | 启动模式、截图轮询、候选与预测服务、HTML通信、停止清理 |
| `manifest.json`／`settings.json` | BGI发现入口、版本、保留目录与自定义设置 |
| `assets/strongbox-mask.html` | 日常三合一遮罩、来源筛选、选人、三色计数与评分表 |
| `assets/training-characters.html` | 独立培养角色选择窗口 |
| `utils/artifact-reader.js` | 三合一坐标、OCR、字段解析 |
| `utils/artifact-enhancement.js` | 五星词条档位、强化次数与剩余节点 |
| `utils/projection-model.js` | 输入校验、+20主词条、原评分适配与角色条件 |
| `utils/artifact-projection.js` | 可复现模拟、降序分位、缓存与取消；保留开发用最高分搜索，日常不运行 |
| `utils/character-assessment.js` | 主词条范围、现装／套装约束、三情景取舍和容量提示 |
| `utils/strongbox-candidates.js` | 录入角色目录、候选来源并集、遮罩控制和角色计数 |
| `utils/mask-interaction.js` | F7切换交互与点击穿透 |
| `utils/account-reader.js` | 角色属性、装备者、推荐面板及套装弹窗OCR |
| `utils/account-capture.js` | 导航、重试、身份核验、五部位录入、循环与中断保存 |
| `utils/account-data-quality.js` | 完整性、清洗与跳过条件 |
| `utils/account-store.js` | 按标识保存、覆盖、回读、备份恢复 |
| `utils/character-names.js`／`utils/character-search.js` | 姓名归一化与离线搜索 |
| `utils/account-name-migration.js` | 历史名称修正与备份 |
| `utils/training-characters.js` | 按账号保存培养名单及独立选择模式 |
| `utils/run-logger.js` | 按账号／运行保存JSON事件分片 |
| `utils/vendor/` | 原评分快照、来源哈希及上游许可 |
| `assets/account-capture-actions.json` | 从录制整理的动作与按钮坐标 |
| `assets/character-names.json`／`character-search.json` | 姓名字典与持久化拼音索引 |
| `assets/custom-character-descriptions.json` | 特殊自定义角色简介匹配资料 |
| `assets/character-profiles.json` | 手工角色条件／权重分支，当前不预填推测规则 |
| `assets/decision-rules.json`／`utils/artifact-decision.js` | 历史策略占位；添加JSON条目不会执行新规则，不是当前三色评估入口 |
| `assets/images/main-ui.png` | 首次C之前确认大世界的派蒙模板，属于运行必需资源 |
| `data/` | 用户运行数据，账号与日志不是内置测试样本 |
| `tools/`／`reference-images/` | 开发验证、预览、OCR样本和参考图，运行无需这些目录 |

## 离线验证

开发者在项目根目录执行：

```powershell
node tools/verify-all.mjs
# 或
npm test
```

覆盖字段解析、模拟、账号隔离与归属、导航重试与循环、名称字典、旅行者、候选来源、搜索、主词条、现装套装开关、三色判断及角色计数。测试使用内存文件系统，不向真实账号注入样本。

BGI环境没有Node依赖；Node仅用于开发。Python工具按脚本自身导入安装依赖，例如可选的RapidOCR、Pillow、numpy、pypinyin，不应将开发虚拟环境带入分发包。

## 常用辅助工具

| 命令／脚本 | 用途与写入范围 |
| --- | --- |
| `node tools/preview-strongbox.mjs <用户标识> 2600` | 只读加载账号生成 `tools/previews/` 中的HTML预览，使用开发示例物品；不是实测截图 |
| 上一命令末尾加 `ignore-sets` | 预览关闭套装限制的状态 |
| `node tools/inspect-flat-weights.mjs` | 原规则中固定攻击力与百分比攻击的折算实例 |
| `tools/audit-weights.mjs` | 原始权重核验 |
| `tools/normalize-account-recording.mjs` | 从工作区最新键鼠录制重建动作JSON，会改动动作资产；不要用于仅验证发布文件 |
| `tools/build-character-search.py` | 重建拼音索引，会改动搜索资产 |
| `tools/extract-account-reference-ocr.py`／`extract-custom-name-ocr.py`／`compare-traveler-ocr.py` | 开发OCR输出与预处理对照，需要参考图和可选Python依赖 |
| `tools/migrate-account-names.mjs` | 历史账号数据维护工具；执行前阅读参数与备份行为，不作为日常启动步骤 |

预览可能嵌入账号角色资料，即使页面标题隐藏UID，也不应直接当作匿名发布图。参考图、OCR fixtures及迁移记录保留在本地，整理文档时不重建或覆盖。

## 坐标与识别约定

BGI坐标以游戏捕获区域左上角为原点，x向右、y向下。三合一详情区域为 `(984,182,492,818)`；角色右侧主识别范围为 `(1460,110,460,970)`，左上元素／名称标题作辅助证据。子区域使用整张捕获图的绝对坐标。

`setGameMetrics` 不等于截图缩放接口。当前代码检查捕获尺寸为1920×1080。调整布局必须同时核查截图、点击、OCR裁剪与参考样本，不能仅改变一个区域数值。

## 数据与兼容性

- 账号记录是当前角色装备的观察快照，不是实时整背包数据库；历史核验物品不冒充当前装备。
- 三色评估和旧分位数是两个尺度；不可直接用旧绝对分替代相对现装判据。
- 套装约束模式必须进入缓存键；同一素材的随机样本不应随模式或候选角色改变。
- `manifest.saved_files` 涉及用户数据与自定义资产，更新时保持兼容，不通过打包清理用户资料。
- 原评分快照的来源与修改在 `utils/vendor/provenance.json`，分发时保留 `LICENSE-miao.txt`。主项目的完整授权范围不能由上游MIT声明代替。

## 接口参考

以下为开发参考链接，本次文档整理未重新核验在线接口内容；实现以当前代码和实际BGI环境为准。

- [脚本结构与配置](https://www.bettergi.com/dev/js/create.html)
- [图像识别与OCR](https://www.bettergi.com/dev/js/rec.html)
- [全局方法与输入](https://www.bettergi.com/dev/js/global.html)
- [HTML遮罩](https://www.bettergi.com/dev/js/htmlMask.html)
- [文件读写](https://www.bettergi.com/dev/js/file.html)
