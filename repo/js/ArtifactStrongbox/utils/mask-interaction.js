// HtmlMask穿透为整个窗口开关，CSS pointer-events不能跨过宿主窗口。
// 用F7在游戏操作与遮罩勾选/滚动之间切换；全局监听须在结束时释放。
export function createMaskInteraction(id, bridge = htmlMask, Hook = KeyMouseHook) {
  let interactive = false, down = false
  const hook = new Hook()
  const keyName = value => String(typeof value === "object" ? value.keyCode ?? value.KeyCode ?? value.code ?? value.Code : value)
  const setInteractive = value => {
    interactive = Boolean(value)
    bridge.setClickThrough(id, !interactive)
    bridge.send?.(id, "/interaction", JSON.stringify({ interactive }))
  }
  try {
    hook.onKeyDown(value => {
      if (!["F7", "118"].includes(keyName(value)) || down) return
      down = true
      if (bridge.exists(id)) setInteractive(!interactive)
    }, true)
    hook.onKeyUp(value => { if (["F7", "118"].includes(keyName(value))) down = false }, true)
    setInteractive(false)
  } catch (error) { hook.dispose(); throw error }
  return { get interactive() { return interactive }, setInteractive, dispose() { hook.dispose() } }
}
