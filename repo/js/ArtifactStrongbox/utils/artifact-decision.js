export function loadDecisionDatabase() {
  const database = JSON.parse(file.readTextSync("assets/decision-rules.json"))
  if (database.schemaVersion !== 1 || !Array.isArray(database.rules)) {
    throw new Error("取舍数据库格式错误：需要 schemaVersion: 1 和 rules 数组")
  }
  return database
}

/**
 * 后续在此接入套装/角色需求/词条数据库。
 * 约定 status: keep（保留）/ fodder（可作素材）/ unknown（人工判断）。
 * 当前尚未实现规则执行，即使填入 rules 也不会输出可作素材。
 */
export function evaluateArtifact(artifact, database) {
  return {
    status: "unknown",
    label: "待人工判断",
    reasons: [
      ...(artifact.warnings.length ? ["部分识别信息需要核对"] : []),
      "请结合游戏详情，手动确认是否保留"
    ]
  }
}
