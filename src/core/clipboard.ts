/**
 * 剪贴板：全站唯一入口，三层兜底。
 *
 * 为什么不能只用 `navigator.clipboard`（2026-09-30 踩的坑）：
 * 手机从局域网地址、或者「主机名 + 端口」这种裸地址进来时，这个页面是
 * **非安全上下文** —— 不是 https、也不是 localhost。Chromium 在这个上下文里不给
 * `navigator.clipboard`（它是 undefined，不是「被拒绝」），于是所有只写了这一条路的
 * 复制按钮在手机上齐刷刷报「浏览器拒绝了剪贴板权限」。
 *
 * 三层顺序是有讲究的：
 *   ① `navigator.clipboard.writeText` —— 安全上下文里的正路，唯一能后台写、不打断用户的；
 *   ② 临时 textarea + `document.execCommand('copy')` —— 已废弃但**不要权限**、
 *      非安全上下文照样能用。前面都失败才走它，所以现代浏览器不会退到这条老路；
 *   ③ 都失败（极少见：老 WebView / 只读模式）就把文本摊在一个**已全选**的文本框里，
 *      让用户长按复制 —— 比只弹一句「复制失败」有用得多（以前用户对着长直链只能自己敲）。
 *
 * 站内的复制按钮一律走这里，别再各页各写一份 —— 收口前好几个页面各写了一份，
 * 其中只有两份带了兜底，其余只要不在安全上下文里就必然失败。
 *
 * 注意 `ElMessage` / `ElMessageBox` 是**自动导入**的（vite 的 AutoImport + ElementPlusResolver），
 * 这里**不能**写显式 import —— 写了插件就不再注入组件样式，弹窗会变成无样式裸框。
 */
import { h } from 'vue'

/** 第 ② 层：临时 textarea + execCommand。成功返回 true */
function copyViaExecCommand(text: string): boolean {
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    // 固定定位 + 透明：不会在手机上把页面顶得跳一下，也不会被用户看见
    ta.style.position = 'fixed'
    ta.style.top = '0'
    ta.style.left = '0'
    ta.style.width = '1px'
    ta.style.height = '1px'
    ta.style.padding = '0'
    ta.style.border = 'none'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.focus()
    ta.select()
    try {
      // iOS 那套需要显式选区；桌面/安卓给了也无害
      ta.setSelectionRange(0, text.length)
    } catch {
      /* 有些浏览器对 readonly 的 selectionRange 会抛，忽略 */
    }
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return !!ok
  } catch {
    return false
  }
}

/** 第 ③ 层：弹一个已经全选的文本框，让用户长按复制。同样不抛异常 */
function showManualDialog(text: string) {
  try {
    void ElMessageBox({
      title: '手动复制一下',
      message: h('div', null, [
        h(
          'p',
          { style: 'margin:0 0 10px;font-size:12px;line-height:1.6;opacity:.7' },
          '这个地址不是 https，浏览器不让网页直接写剪贴板。下面已经全选，长按选中内容点「复制」即可。',
        ),
        h('textarea', {
          value: text,
          readonly: true,
          rows: 4,
          spellcheck: false,
          style:
            'width:100%;box-sizing:border-box;font:12px/1.6 ui-monospace,Menlo,Consolas,monospace;' +
            'padding:10px;border:1px solid var(--ws-border-strong,#d5d7de);border-radius:8px;' +
            'background:var(--ws-bg-soft,#f6f7f9);color:inherit;resize:vertical',
          onVnodeMounted: (vnode: any) => {
            const el = vnode.el as HTMLTextAreaElement | undefined
            try {
              el?.focus()
              el?.select()
            } catch {
              /* 选不上也不影响用户长按 */
            }
          },
        }),
      ]),
      showCancelButton: false,
      confirmButtonText: '知道了',
      customClass: 'ws-clip-fallback',
    })
  } catch {
    /* 连弹窗都失败就什么都不做：调用方的提示已经说了失败 */
  }
}

/**
 * 把文本写进剪贴板。**不弹任何提示、不抛异常** —— 返回是否成功，说话交给调用方。
 * 这是给「复制完还要做别的事」（打勾、翻页、切状态）的地方用的。
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  const s = String(text ?? '')
  if (!s) return false

  // ① 现代 API。注意 `navigator.clipboard` 在非安全上下文里是 undefined，
  //    所以要判存在性，别直接调（直接调拿到的是 TypeError，看起来像权限被拒）
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(s)
      return true
    }
  } catch {
    /* 权限被拒 / 没有用户手势 —— 落到下一层 */
  }

  // ② 老接口
  if (copyViaExecCommand(s)) return true

  // ③ 手选兜底
  showManualDialog(s)
  return false
}

/**
 * 复制 + 统一说法。全站复制按钮的默认用法（`okTip` 是可以省的口径）。
 * 失败时除了返回 false，还会弹出「已全选」的兜底框 —— 所以调用方**不用**再补一句错误提示。
 */
export async function copyText(text: string, okTip = '已复制'): Promise<boolean> {
  const label = String(text ?? '')
  if (!label) {
    ElMessage.warning('没有可复制的内容')
    return false
  }
  const ok = await copyToClipboard(label)
  if (ok) ElMessage.success(okTip)
  return ok
}
