/**
 * 打印纸的「每页多高、纸什么方向」—— 两份册子（数学做题本 / 英语每日一句）共用。
 *
 * 为什么不在 CSS 里写死：纸张方向只能在 `@page` 里说，而 **`@page` 不认 CSS 变量**，
 * 每页高度又跟着方向变（A4 竖放打印区 270mm、横放 186mm，都是 297/210 减上下 12mm 边距）。
 * 写错成整张纸的高度就会溢到第二页、不写则页码停在半页 —— 所以按当前方向拼好挂到 head 上，
 * 挂在各页 scoped 样式之后，同优先级下靠后者生效。
 */
import { computed, onUnmounted, watch, type Ref } from 'vue'

export type Orient = 'landscape' | 'portrait'

/** 把「纸张方向 → @page + 每页高度」这段样式接管起来；返回拼好的 CSS（调试用） */
export function sheetPageCss(orient: Ref<Orient>) {
  const css = computed(() => {
    const land = orient.value === 'landscape'
    const pageH = land ? '186mm' : '270mm'
    const blank = land ? '52mm' : '150mm'
    const blankWithSol = land ? '26mm' : '60mm'
    return [
      `@page { size: A4 ${land ? 'landscape' : 'portrait'}; margin: 12mm 14mm; }`,
      '@media print {',
      `  .ztb-page { min-height: ${pageH} !important; }`,
      `  .ztb-page__blank { min-height: ${blank} !important; }`,
      `  .ztb-page.has-solution .ztb-page__blank { min-height: ${blankWithSol} !important; }`,
      '}',
    ].join('\n')
  })

  let styleEl: HTMLStyleElement | null = null
  watch(
    css,
    (v) => {
      if (!styleEl) {
        styleEl = document.createElement('style')
        styleEl.id = 'ztb-page-size'
        document.head.appendChild(styleEl)
      }
      styleEl.textContent = v
    },
    { immediate: true },
  )
  onUnmounted(() => {
    styleEl?.remove()
    styleEl = null
  })
  return css
}
