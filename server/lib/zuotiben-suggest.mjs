/**
 * 推荐同类题 —— 把「做题本」和「题库池」接起来。
 *
 * 用户 2026-09-27 的要求，原话拆成三条：
 *   ① 让智能体看得见我今天的作答情况 → `zuotiben.review()`
 *   ② 推荐同类的题目 → 这里
 *   ③ 去除我还没有学过的题目，再出一些我来选 → 按 `scope.chapters` 过滤 + 排除已做过
 *
 * 设计上刻意**不在这里做「智能」**：不猜考点、不排序打分、不用模型。
 * 这里只做过滤（章 / 关键词 / 去重）并把**原文、答案、解析、溯源**原样交出去。
 * 选哪几道、要不要改写成做题本的排版，是调用方（智能体）的事 ——
 * 放在这儿猜，猜错了用户看到的就是一堆不相关的题。
 */
import * as kaproblems from './kaproblems.mjs'
import * as zuotiben from './zuotiben.mjs'

/**
 * @param {object} o
 * @param {'wrong'|'scope'|'all'} [o.basis='scope']
 *   wrong＝按**做错那几题所在的章**找同类（要「再练几道」时用）；
 *   scope＝按**已学范围**铺开找；all＝不按章限制（谨慎用，会混进没学的）。
 * @param {number[]} [o.chapters]  显式指定章，优先级最高
 * @param {string[]} [o.keywords]  题干或解析里出现任一即可（用来收窄到「同一类」）
 * @param {boolean}  [o.excludeDone=true] 排掉做题本里已经做过的题
 * @param {boolean}  [o.needSolution=true] 只要解析齐全的（解析缺的推出去是坑）
 * @param {number}   [o.limit=8]
 */
export function suggestProblems({
  basis = 'scope',
  chapters,
  keywords = [],
  excludeDone = true,
  needSolution = true,
  limit = 8,
} = {}) {
  const scope = zuotiben.getScope()
  const review = zuotiben.review({})

  let chs = Array.isArray(chapters) && chapters.length ? chapters.map(Number) : []
  let why = ''
  if (!chs.length && basis === 'wrong') {
    chs = review.wrongChapters
    why = chs.length
      ? `按你**做错的那几题所在的章**（第 ${chs.join('、')} 章）找同类`
      : '做题本里还没有带出处的错题，改用已学范围'
  }
  if (!chs.length && basis !== 'all') {
    chs = scope.chapters
    why = chs.length
      ? `按**已学范围**（第 ${chs.join('、')} 章）找`
      : '已学范围还没设（`set_problem_scope`），先不限章'
  }
  if (basis === 'all') why = why || '不限章（可能有还没学的内容，自己看一眼）'

  const exclude = excludeDone ? zuotiben.doneIds() : []
  const picked = kaproblems.search({
    chapters: chs.length ? chs : undefined,
    keywords,
    exclude,
    needSolution,
    limit: Math.max(1, Math.min(50, Number(limit) || 8)),
  })

  return {
    ok: true,
    basis,
    chapters: chs,
    keywords,
    excluded: exclude.length,
    why: why + (excludeDone && exclude.length ? `；已排掉做过的 ${exclude.length} 道` : ''),
    scope,
    /** 题库池没配 / 文件不在时的原因（空串＝配好了）；调用方拿它解释「为什么没挑出题」 */
    poolHint: kaproblems.poolHint(),
    /** 直接可用的候选题：题干/选项/答案/解析/溯源都在，挑中哪几道就原样喂给 add_problems */
    candidates: picked,
    total: picked.length,
  }
}

/** 题库总览（有哪些章、每章多少题、解析齐不齐） */
export function poolInfo() {
  return { ...kaproblems.info(), chapters: kaproblems.listChapters(), scope: zuotiben.getScope() }
}
