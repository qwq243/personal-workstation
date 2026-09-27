/**
 * 统一轮询助手：把散落在各页面的裸 `setInterval` 收成一件事。
 *
 * 之前各页各写各的 —— 间隔、清理、页面藏起来之后还跑不跑都不一致。这里统一：
 *   - `setInterval` 本体，间隔由调用方给；
 *   - 默认 `pauseWhenHidden`：页面不可见就停，回到前台**立刻补一次**再继续（不再后台空转）；
 *   - 组件内调用时随作用域销毁自动停（`onScopeDispose`），不靠调用方记得清 timer；
 *   - 回调抛错（同步 throw / 异步 reject）只吞掉，不打断定时器。
 *
 * 用法（组件内）：
 *   const poll = usePolling(load, 5000, { immediate: true })
 *   onMounted(() => poll.start())
 *   // 需要按条件轮询（只在录音中、只在某 tab 打开时）就自己掌握 start() / stop() 的时机
 *
 * 组件外也能调用：拿不到 effect scope 时只提供 start / stop，不注册自动清理，由调用方自己收尾。
 */
import { getCurrentScope, onScopeDispose } from 'vue'

export interface UsePollingOptions {
  /** 默认 false：start() 之后先等一个间隔，还是立刻先跑一次 */
  immediate?: boolean
  /** 默认 true：页面不可见时暂停，回到前台立刻补一次 */
  pauseWhenHidden?: boolean
  /** 可选兜底：间隔比它大就干脆不轮询（默认不限制） */
  maxMs?: number
}

export interface PollingHandle {
  /** 开始轮询；重复调用无副作用（不会叠出第二个定时器） */
  start(): void
  /** 停止轮询并摘掉 visibilitychange 监听 */
  stop(): void
  /** 是否处于「已 start 未 stop」。页面隐藏时被临时挂起也算 true（它还会回来） */
  running(): boolean
}

export function usePolling(
  fn: () => void | Promise<void>,
  intervalMs: number,
  opts: UsePollingOptions = {},
): PollingHandle {
  const { immediate = false, pauseWhenHidden = true, maxMs } = opts
  /** 间隔比 maxMs 还大 = 调用方自己都嫌久，那就一拍都不跑（只提醒一次） */
  const overMax = typeof maxMs === 'number' && intervalMs > maxMs

  let timer: ReturnType<typeof setInterval> | null = null
  /** 调用方意图：start 过且没 stop */
  let wanted = false
  let warned = false

  const hasDom = typeof document !== 'undefined'
  const isHidden = () => hasDom && document.visibilityState === 'hidden'

  function tick() {
    try {
      const out: unknown = fn()
      // 异步 reject 也接住，否则会冒成 unhandledrejection
      if (out && typeof (out as PromiseLike<unknown>).then === 'function') {
        void Promise.resolve(out).catch(() => {})
      }
    } catch {
      /* 调用方自己兜底：这里只保证下一拍还在 */
    }
  }

  function arm() {
    if (timer !== null) return
    timer = setInterval(tick, intervalMs)
  }

  function disarm() {
    if (timer === null) return
    clearInterval(timer)
    timer = null
  }

  function onVisibility() {
    if (!wanted) return
    if (isHidden()) {
      disarm()
    } else {
      tick() // 回到前台立刻补一次
      arm()
    }
  }

  function start() {
    if (overMax) {
      if (!warned) {
        warned = true
        console.warn(`[polling] 间隔 ${intervalMs}ms 大于 maxMs ${maxMs}ms，已跳过轮询`)
      }
      return
    }
    if (wanted) return
    wanted = true
    if (pauseWhenHidden && hasDom) document.addEventListener('visibilitychange', onVisibility)
    if (pauseWhenHidden && isHidden()) return // 藏着的页面不点灯，等 visibilitychange 时补
    if (immediate) tick()
    arm()
  }

  function stop() {
    wanted = false
    disarm()
    if (hasDom) document.removeEventListener('visibilitychange', onVisibility)
  }

  // 组件内调用：随作用域销毁自动停；组件外（没有 scope）只给 start / stop
  if (getCurrentScope()) onScopeDispose(stop)

  return { start, stop, running: () => wanted }
}
