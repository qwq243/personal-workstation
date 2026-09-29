/**
 * 数学排版：把库内三种「数学写法」排成可读公式。
 *
 * 库内常见写法是 Unicode 数学斜体与裸上下标，极少用 $ 定界符；三种都支持：
 *   1. Unicode 数学斜体：𝐴𝐵𝐶…𝑎𝑏𝑐…𝟎𝟏𝟐…（𝐴 = U+1D434，𝑎 = U+1D44E，𝟎 = U+1D7CE）
 *      —— 来自 MinerU/OCR，显示成方块或错位，这里转 ASCII 斜体；
 *   2. 裸上下标：e^{r₁x}、∫_0^{+∞}、r²、x²、Δ、α —— 给 ^{} _{} 排成真上下标，
 *      并把整段「像公式」的串（含字母/数字/^/_/{}/+-=()）排成斜体；
 *   3. $...$ / $$...$$ 真 LaTeX（以后写入的）：走 katex.renderToString，throwOnError:false
 *      —— 渲染失败就回退成裸文本，不会把整页搞崩。
 *
 * 为什么不全交给 katex.render：库内没有 $ 定界符的历史数据占绝大多数，
 * 全文都是「中文里夹着公式段」；对整段做 KaTeX 会连中文一起报错。这里做的是**段内 token 级排版**：
 * 先按 inline() 的转义后文本走，只在「公式 token」上动手，中文、代码、链接、双链不动。
 */
import katex from 'katex'

/* Unicode 数学字母数字 → ASCII（𝐴→A, 𝑎→a, 𝟎→0；𝐴𝐵 是 BMP 外字符，成对出现） */
const MATH_LETTER: Record<string, string> = {}
// A-Z: U+1D434..U+1D44D, a-z: U+1D44E..U+1D467, 0-9: U+1D7CE..U+1D7D7
for (let i = 0; i < 26; i++) {
  MATH_LETTER[String.fromCodePoint(0x1d434 + i)] = String.fromCharCode(65 + i)
  MATH_LETTER[String.fromCodePoint(0x1d44e + i)] = String.fromCharCode(97 + i)
}
for (let i = 0; i < 10; i++) MATH_LETTER[String.fromCodePoint(0x1d7ce + i)] = String(i)

/** 单个字符（含 BMP 外）转 ASCII；不是数学斜体就原样返回 */
function demathChar(ch: string): string {
  return MATH_LETTER[ch] ?? ch
}

/** 把字符串里的 Unicode 数学斜体全转成 ASCII（其它字符不动） */
export function demath(s: string): string {
  return Array.from(s).map(demathChar).join('')
}

/* ---------------------------------------------------------- 上下标 --- */

/**
 * 把 ^{...} _{...} ^x _0 排成 <sup>/<sub>；多重嵌套（如 e^{r₁x}）只展开一层，
 * 内层 {} 递归处理 —— 够覆盖 e^{αx}、∫_0^{+∞}、x^{(4)} 这类。
 * 输入是**已转义**的文本（esc() 之后），所以 < > & 已经是实体，不会被当 HTML。
 */
export function supsub(esc: string): string {
  // ^ 或 _ 后跟 {...} 或单字符（字母/数字/希腊/±/括号）
  return esc.replace(
    /([\^_])(\{([^{}]*)\}|([A-Za-z0-9α-ωΑ-Ω+\-−∞()′″]))/g,
    (_m, op, _all, braced, single) => {
      const inner = braced ?? single ?? ''
      const tag = op === '^' ? 'sup' : 'sub'
      return `<${tag} class="wmd__ss">${supsub(inner)}</${tag}>`
    },
  )
}

/* ---------------------------------------------------------- 公式段 --- */

/**
 * 一段文本里「像公式」的 token：含字母（含希腊）或 ∫∑∏√ 开头 + 数字/运算符/^/_/{}/()/上下标字符。
 * 下标上标 Unicode（₀₁₂₃…⁰¹²³…）也属于公式的一部分（e^{r₁x}、C₁、r² 都靠它连着）。
 * 中文、代码、链接、双链永远不进这个匹配。
 */
const SUBSUP = '₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎ₐₑₒₓₔₕₖₗₘₙₚₛₜ⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ⁿ'
const FORMULA_TOKEN = new RegExp(
  `[A-Za-zα-ωΑ-Ω∫∑∏√][A-Za-z0-9α-ωΑ-Ω+\\-−=×·±≈≠≤≥∈⊂∪∩∂∇∞√∫∑∏(){}[\\]^_${SUBSUP}′″°%.|/\\\\,;:]*[A-Za-z0-9α-ωΑ-Ω)\\]}′″${SUBSUP}]|[A-Za-zα-ωΑ-Ω](?=[^_A-Za-z0-9\\u4e00-\\u9fff])`,
  'g',
)

/** 只含「a b x y n k」这类孤立单字母时不排（中文里当代号用，排斜体反而怪） */
function worthTypeset(tok: string): boolean {
  if (tok.length < 2) return false
  // 纯英文单词（the/and/or 之类）不算 —— 含数字/符号/希腊/上下标才排
  return new RegExp(`[0-9^_+\\-−=×·±≈≠≤≥∈∂∇∞√∫∑∏(){}[\\]′″α-ωΑ-Ω${SUBSUP}]`).test(tok)
}

/**
 * 对一段**已转义**的正文做数学排版：
 * Unicode 数学斜体转 ASCII → $...$ 走 KaTeX → 公式 token 包 <span class="wmd__math"> → ^{} _{} 展开。
 * 注意：esc() 之后 & > < 是实体（&gt; &lt; &amp;），里面的字母（gt/lt/amp/quot）
 * 会被 FORMULA_TOKEN 误当公式 —— 所以先把实体换成占位符，排版完再换回。
 * 调用方要保证：代码、链接、双链、图片已经先被替换成占位 token（里面是标签不是裸文本），
 * 这个函数只在「还有裸文本」的段上跑。
 */
export function typesetMath(esc: string): string {
  if (!esc) return esc
  // 0) HTML 实体保护：&gt; → \x01，排版完换回 —— 否则 &gt; 的 gt 会被排成斜体
  const ENT = '\x01'
  const entities: string[] = []
  let out = esc.replace(/&(?:[a-zA-Z]+|#\d+|#x[0-9a-fA-F]+);/g, (m) => {
    entities.push(m)
    return ENT
  })
  // 1) Unicode 数学斜体 → ASCII（𝐴𝐵𝑎𝑏𝟎𝟏）
  out = demath(out)
  // 2) $...$ / $$...$$ 真 LaTeX：先走 KaTeX（渲染出来的 HTML 不再过 token 排版，
  //    用占位符保护 —— 里面的 <span> 会被 FORMULA_TOKEN 当符号吃掉。
  //    占位符用「全角字母+数字」：不含 $ 也不含 ^_{} 这些公式字符，不会被后续匹配）
  const kStash: string[] = []
  out = out.replace(/\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$/g, (_m, block, inline) => {
    const tex = block ?? inline ?? ''
    let html = ''
    try {
      html = katex.renderToString(tex, { throwOnError: false, displayMode: !!block })
    } catch {
      html = tex
    }
    kStash.push(`<span class="wmd__katex">${html}</span>`)
    return `ＫＸ${kStash.length - 1}ＸＫ` // 全角占位：不撞 $ 也不撞公式 token
  })
  // 3) 公式 token 包斜体 span；^/_ 先展开成 sup/sub（展开后再包外层 span，
  //    否则 <sup> 里的 < > 会被 FORMULA_TOKEN 当符号吃掉）
  out = out.replace(FORMULA_TOKEN, (tok) => {
    if (!worthTypeset(tok)) return tok
    const withSS = supsub(tok)
    return `<span class="wmd__math">${withSS}</span>`
  })
  // 4) KaTeX 产物换回
  out = out.replace(/ＫＸ(\d+)ＸＫ/g, (_m, i) => kStash[Number(i)] ?? '')
  // 5) 实体换回（\x01 每次只代表一个实体，按出现顺序一一对应）
  let i = 0
  out = out.replace(new RegExp(ENT, 'g'), () => entities[i++] ?? ENT)
  return out
}

/* --------------------------------------------- 只渲染 $...$ 的轻量版 --- */

/**
 * 只把 `$...$` / `$$...$$` 交给 KaTeX，其余文本转义后原样输出。
 *
 * 为什么单独一个：typesetMath 那套「裸上下标 + 公式 token 斜体」是为知识库正文设计的
 * （中文里夹公式段），用在**普通英文文本**上会把 above-average 这种带连字符的词当公式排成斜体。
 * 做题本的「每日一句」册只需要把译文里的 `$80\%$` 这类显式 LaTeX 排出来，
 * 所以这里只认 `$` 定界符，别的什么都不动。
 *
 * breaks: 文本段里的换行转 `<br>`（结构划分那种逐行文本用）—— 不能靠 CSS 的
 * `white-space: pre-line` 代替：KaTeX 输出的 HTML 里 span 之间自带换行，pre-line 会把
 * 公式拆散，所以换行必须在**渲染前**就变成标签。
 */
export function renderDollarMath(text: string, opts: { breaks?: boolean } = {}): string {
  const escape = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return String(text ?? '')
    .split(/(\$\$[^$]+\$\$|\$[^$\n]+\$)/g)
    .map((seg, i) => {
      if (i % 2 !== 1) {
        const t = escape(seg)
        return opts.breaks ? t.replace(/\n/g, '<br>') : t
      }
      const block = seg.startsWith('$$')
      const tex = block ? seg.slice(2, -2) : seg.slice(1, -1)
      try {
        return `<span class="wmd__katex">${katex.renderToString(tex, { throwOnError: false, displayMode: block })}</span>`
      } catch {
        return escape(seg)
      }
    })
    .join('')
}
