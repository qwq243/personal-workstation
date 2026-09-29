/**
 * 答案回填题干。
 *
 * 规矩（2026-09-27 用户定）：**答案直接写在题干原本的空位里，不要再单独列一行「答案」**——
 * 选择题填进「（　）」，填空题填到「______」上。收起答案时用原题干（就是印在纸上的那份）。
 *
 * 所以在页面上「展开答案」做的事情是：题干换成带答案的版本 + 底下给出标准解析。
 * 解析只讲过程，答案本身已经在题干里了，不重复出现。
 */

/** 去掉答案外面的括号：(A) → A；(B). → B；$4$ 原样 */
function bareAnswer(a: string): string {
  const t = String(a ?? '').trim()
  if (!t) return ''
  const m = /^[（(]\s*([A-D])\s*[）)]\.?$/.exec(t)
  return m ? m[1] : t
}

/** 题干的空位：全角/半角括号，里面是空或空白（`（　）` 中间那个是全角空格 U+3000） */
const CHOICE_BLANK = /[（(][\s\u3000]*[）)]/
/** 填空题的空位：三个以上下划线（半角或全角） */
const FILL_BLANK = /_{3,}|＿{3,}/

export interface AnswerableProblem {
  stem?: string
  answer?: string
  kind?: string
  options?: string[]
}

/**
 * 带答案的题干。没有答案、或者题干里找不到空位时，就在末尾用「→ 答案」补上
 * —— 宁可多一个箭头，也不要让「展开了却没答案」。
 */
export function stemWithAnswer(p: AnswerableProblem): string {
  const stem = String(p?.stem ?? '')
  const ans = bareAnswer(String(p?.answer ?? ''))
  if (!ans) return stem

  const isChoice = (p?.options?.length ?? 0) > 0 || p?.kind === 'choice'
  if (isChoice && CHOICE_BLANK.test(stem)) return stem.replace(CHOICE_BLANK, `（${ans}）`)

  if (FILL_BLANK.test(stem)) return stem.replace(FILL_BLANK, ans)

  return `${stem}　→　${ans}`
}
