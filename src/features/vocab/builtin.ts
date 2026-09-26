/**
 * 内置示例词单（30 个通用高频词）。
 *
 * 为什么是「示例」而不是「某次复习的词」：内置词单是**出厂数据**，会跟着代码一起分发，
 * 所以只能是无版权顾虑的自写内容（释义与例句都是自己写的），不能是任何人的私人词表、
 * 也不能是某本教材的摘录。想换成自己的词，用「词单管理 → 导入」把文本贴进来即可。
 */
import type { VocabWord, WordList } from './types'

/** 稳定 id：不带日期 —— 日期进 id 会让「换一份示例词」变成换一个 id，老进度就找不着了 */
const BUILTIN_ID = 'builtin-sample'

interface RawWord {
  term: string
  phonetic?: string
  pos?: string
  meaning: string
  example?: string
  exampleZh?: string
  note?: string
}

const RAW: RawWord[] = [
  {
    term: 'approach',
    phonetic: 'əˈprəʊtʃ',
    pos: 'v./n.',
    meaning: '接近；着手处理；方法、途径',
    example: 'We need a different approach to the problem.',
    exampleZh: '我们需要用另一种思路来处理这个问题。',
    note: 'an approach to sth：to 是介词，后面跟名词或动名词',
  },
  {
    term: 'available',
    phonetic: 'əˈveɪləbl',
    pos: 'adj.',
    meaning: '可获得的；有空的',
    example: 'The report is available on the intranet.',
    exampleZh: '这份报告在内网上可以查到。',
    note: '常作表语：be available to sb / be available for sth',
  },
  {
    term: 'benefit',
    phonetic: 'ˈbenɪfɪt',
    pos: 'n./v.',
    meaning: '好处、益处；使受益',
    example: 'Both sides benefit from the arrangement.',
    exampleZh: '双方都从这个安排中受益。',
    note: 'benefit from sth 从…中受益；beneficial 是它的形容词',
  },
  {
    term: 'capacity',
    phonetic: 'kəˈpæsəti',
    pos: 'n.',
    meaning: '容量；能力',
    example: 'The hall has a seating capacity of 800.',
    exampleZh: '这个礼堂可容纳 800 人就座。',
    note: '区分 ability（人的能力）与 capacity（容量或承载能力）',
  },
  {
    term: 'consequence',
    phonetic: 'ˈkɒnsɪkwəns',
    pos: 'n.',
    meaning: '结果、后果',
    example: 'He was unaware of the consequences of his decision.',
    exampleZh: '他没有意识到自己这个决定的后果。',
    note: 'as a consequence of = 由于；consequently 因此',
  },
  {
    term: 'considerable',
    phonetic: 'kənˈsɪdərəbl',
    pos: 'adj.',
    meaning: '相当大的、相当多的',
    example: 'The project took a considerable amount of time.',
    exampleZh: '这个项目花了相当多的时间。',
    note: '别和 considerate（体贴的）混',
  },
  {
    term: 'contribute',
    phonetic: 'kənˈtrɪbjuːt',
    pos: 'v.',
    meaning: '贡献；促成；投稿',
    example: 'Regular exercise contributes to better sleep.',
    exampleZh: '规律运动有助于改善睡眠。',
    note: 'contribute to sth 促成某事；contribution 名词',
  },
  {
    term: 'decline',
    phonetic: 'dɪˈklaɪn',
    pos: 'v./n.',
    meaning: '下降；婉拒',
    example: 'Sales declined sharply in the second quarter.',
    exampleZh: '第二季度销售额大幅下滑。',
    note: '既是「下降」也是「谢绝」，看宾语判断',
  },
  {
    term: 'demonstrate',
    phonetic: 'ˈdemənstreɪt',
    pos: 'v.',
    meaning: '证明；演示；示威',
    example: 'The study demonstrates a clear link between the two.',
    exampleZh: '这项研究证明了两者之间存在明确关联。',
    note: 'demonstrate that… 引导从句；demonstration 名词',
  },
  {
    term: 'distinguish',
    phonetic: 'dɪˈstɪŋɡwɪʃ',
    pos: 'v.',
    meaning: '区分、辨别',
    example: 'It is hard to distinguish the original from the copy.',
    exampleZh: '很难把原件和复制品区分开。',
    note: 'distinguish A from B；distinguish between A and B',
  },
  {
    term: 'efficient',
    phonetic: 'ɪˈfɪʃnt',
    pos: 'adj.',
    meaning: '高效的、效率高的',
    example: 'The new process is far more efficient.',
    exampleZh: '新流程的效率高得多。',
    note: '形容「省时省力」；effective 强调「有效果」',
  },
  {
    term: 'emphasize',
    phonetic: 'ˈemfəsaɪz',
    pos: 'v.',
    meaning: '强调、着重',
    example: 'She emphasized the need for careful planning.',
    exampleZh: '她强调了仔细规划的必要性。',
    note: '英式也写 emphasise；名词 emphasis',
  },
  {
    term: 'establish',
    phonetic: 'ɪˈstæblɪʃ',
    pos: 'v.',
    meaning: '建立、确立；证实',
    example: 'The company was established in 1998.',
    exampleZh: '这家公司成立于 1998 年。',
    note: 'establish a link / a reputation 都很常见',
  },
  {
    term: 'estimate',
    phonetic: 'ˈestɪmeɪt',
    pos: 'v./n.',
    meaning: '估计、估算',
    example: 'They estimate the cost at around two million.',
    exampleZh: '他们估计成本在两百万左右。',
    note: 'estimate sth at…；名词重音在前，动词重音在后',
  },
  {
    term: 'evidence',
    phonetic: 'ˈevɪdəns',
    pos: 'n.',
    meaning: '证据、迹象',
    example: 'There is little evidence to support that claim.',
    exampleZh: '几乎没有证据支持那个说法。',
    note: '不可数：a piece of evidence，不能说 an evidence',
  },
  {
    term: 'factor',
    phonetic: 'ˈfæktə',
    pos: 'n.',
    meaning: '因素、要素',
    example: 'Cost was the deciding factor.',
    exampleZh: '成本是决定性因素。',
    note: 'a key / major / contributing factor',
  },
  {
    term: 'identify',
    phonetic: 'aɪˈdentɪfaɪ',
    pos: 'v.',
    meaning: '识别、确认；找出',
    example: 'We need to identify the cause of the failure.',
    exampleZh: '我们需要找出失败的原因。',
    note: 'identify with sb 表示「认同某人」',
  },
  {
    term: 'impact',
    phonetic: 'ˈɪmpækt',
    pos: 'n./v.',
    meaning: '影响、冲击',
    example: 'The policy had an immediate impact on prices.',
    exampleZh: '这项政策对价格立刻产生了影响。',
    note: 'have an impact on sth；比 effect 语气强',
  },
  {
    term: 'indicate',
    phonetic: 'ˈɪndɪkeɪt',
    pos: 'v.',
    meaning: '表明、指示',
    example: 'The figures indicate a gradual recovery.',
    exampleZh: '这些数字显示正在逐步复苏。',
    note: 'indicate that…；indication 名词',
  },
  {
    term: 'involve',
    phonetic: 'ɪnˈvɒlv',
    pos: 'v.',
    meaning: '涉及、包含；使参与',
    example: 'The job involves a lot of travelling.',
    exampleZh: '这份工作需要经常出差。',
    note: 'be involved in sth 参与某事',
  },
  {
    term: 'maintain',
    phonetic: 'meɪnˈteɪn',
    pos: 'v.',
    meaning: '维持、保持；保养；坚持认为',
    example: 'They maintain that the decision was correct.',
    exampleZh: '他们坚持认为那个决定是正确的。',
    note: 'maintain that… 有「坚持声称」的语气',
  },
  {
    term: 'obtain',
    phonetic: 'əbˈteɪn',
    pos: 'v.',
    meaning: '获得、取得',
    example: 'You must obtain permission first.',
    exampleZh: '你必须先获得许可。',
    note: '比 get 正式，多用于书面',
  },
  {
    term: 'occur',
    phonetic: 'əˈkɜː',
    pos: 'v.',
    meaning: '发生；出现；想到',
    example: 'The accident occurred late at night.',
    exampleZh: '事故发生在深夜。',
    note: 'It occurred to me that… 我突然想到…；双写 r',
  },
  {
    term: 'particular',
    phonetic: 'pəˈtɪkjələ',
    pos: 'adj.',
    meaning: '特定的；特别的、讲究的',
    example: 'No particular reason — I just felt like it.',
    exampleZh: '没什么特别的原因，就是突然想这么做。',
    note: 'in particular = 尤其；be particular about 对…挑剔',
  },
  {
    term: 'reduce',
    phonetic: 'rɪˈdjuːs',
    pos: 'v.',
    meaning: '减少、降低',
    example: 'We must reduce waste at the source.',
    exampleZh: '我们必须从源头减少浪费。',
    note: 'reduce sth by 20% 减少了 20%；reduce sth to 20% 降到 20%',
  },
  {
    term: 'require',
    phonetic: 'rɪˈkwaɪə',
    pos: 'v.',
    meaning: '需要；要求',
    example: 'This task requires a great deal of patience.',
    exampleZh: '这项任务需要极大的耐心。',
    note: 'require sb to do sth；requirement 名词',
  },
  {
    term: 'significant',
    phonetic: 'sɪɡˈnɪfɪkənt',
    pos: 'adj.',
    meaning: '重要的；显著的',
    example: 'There was a significant improvement in scores.',
    exampleZh: '成绩有显著提升。',
    note: '写作里常用来替换 important 或 big',
  },
  {
    term: 'similar',
    phonetic: 'ˈsɪmələ',
    pos: 'adj.',
    meaning: '相似的、类似的',
    example: 'The two designs look similar at first glance.',
    exampleZh: '这两个设计乍一看很像。',
    note: 'be similar to sth（用 to，不用 with）',
  },
  {
    term: 'specific',
    phonetic: 'spəˈsɪfɪk',
    pos: 'adj.',
    meaning: '具体的、明确的；特定的',
    example: 'Could you be more specific about the timeline?',
    exampleZh: '时间安排你能说得更具体些吗？',
    note: 'specify 动词；specification 规格',
  },
  {
    term: 'various',
    phonetic: 'ˈveəriəs',
    pos: 'adj.',
    meaning: '各种各样的',
    example: 'We tried various methods before it worked.',
    exampleZh: '试了好几种方法才成功。',
    note: '只作定语，不能作表语；variety 名词',
  },
]

function makeId(index: number): string {
  return `${BUILTIN_ID}-${String(index + 1).padStart(2, '0')}`
}

export const BUILTIN_WORDS: VocabWord[] = RAW.map((r, i) => ({
  id: makeId(i),
  term: r.term,
  phonetic: r.phonetic,
  pos: r.pos,
  meaning: r.meaning,
  example: r.example,
  exampleZh: r.exampleZh,
  note: r.note,
  tags: ['sample'],
}))

/** 出厂示例词单：可以直接用，也可以导进来当格式样例 */
export function makeBuiltinList(): WordList {
  const now = Date.now()
  return {
    id: BUILTIN_ID,
    name: `示例词单（${RAW.length} 词）`,
    description: '出厂自带的一小份通用高频词，用来试功能。换成自己的词单不会影响它的进度记录。',
    words: BUILTIN_WORDS.map((w) => ({ ...w })),
    createdAt: now,
    updatedAt: now,
    source: 'builtin',
  }
}

export const BUILTIN_LIST_ID = BUILTIN_ID
