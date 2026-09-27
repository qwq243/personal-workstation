/**
 * 工作站的 MCP server（Streamable HTTP，挂在本边车的 /mcp 上）。
 *
 * 目的：让智能体（任意 MCP 客户端）能读写工作站的数据 ——
 * 读今日看板、加计划、写笔记、查余额、读写词单、读写知识库、读写规划台、操作语音随记。
 * 与「MCP 只是另一条读取通道」不同，这里也提供写能力，因为看板的价值就在于被自动记录。
 *
 * 工具表只覆盖**本项目自带的能力**：任何依赖特定机构私有接口或使用者本机服务的工具都不在这里。
 * 想加自己的数据源，照下面 TOOLS 与 HANDLERS 各加一条即可（两边名字必须一致）。
 *
 * 实现方式是 JSON-RPC 2.0 的子集：initialize / tools/list / tools/call (+ ping)。
 * 同时兼容无状态调用（每次 POST 直接回结果），不强制 session。
 */
import * as dashboard from './lib/dashboard.mjs'
import * as plan from './lib/plan.mjs'
import * as pguard from './lib/pguard.mjs'
import * as procscan from './lib/procscan.mjs'
import * as newapi from './lib/newapi.mjs'
import * as ai from './lib/ai.mjs'
import * as vocab from './lib/vocab.mjs'
import * as wiki from './lib/wiki.mjs'
import * as wikiQueue from './lib/wiki-queue.mjs'
import * as memo from './lib/memo.mjs'

const SERVER_INFO = { name: 'workstation', version: '0.1.0' }

/* ------------------------------------------------------------ 工具表 --- */

const TOOLS = [
  {
    name: 'get_dashboard',
    description: '读取工作站看板某一天的数据：计划、笔记、心情、复盘、连续记录天数。默认今天。',
    inputSchema: {
      type: 'object',
      properties: { date: { type: 'string', description: 'YYYY-MM-DD，默认今天' } },
    },
  },
  {
    name: 'get_overview',
    description: '一次拿到今天的全貌：看板计划与近况、背单词进度、校园日历（教学周/放假）、模型余额与今日花费。适合作为每天开工的第一条调用。',
    inputSchema: {
      type: 'object',
      properties: { date: { type: 'string', description: 'YYYY-MM-DD，默认今天' } },
    },
  },
  {
    name: 'add_plan',
    description: '给工作站看板加一条今日计划（会被前端展示并可勾选）。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '计划内容' },
        date: { type: 'string', description: 'YYYY-MM-DD，默认今天' },
        source: { type: 'string', description: '来源标记，例如 agent' },
      },
      required: ['text'],
    },
  },
  {
    name: 'update_plan',
    description: '勾选/取消或修改一条今日计划。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        text: { type: 'string' },
        done: { type: 'boolean' },
        date: { type: 'string' },
      },
      required: ['id'],
    },
  },
  {
    name: 'add_note',
    description: '往看板写一条记录（随手记或复盘），落在 server/data/dashboard.json，时间默认用录入时间。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        date: { type: 'string', description: 'YYYY-MM-DD，默认今天' },
        kind: { type: 'string', enum: ['jot', 'review'], description: 'jot=随手记（默认），review=复盘' },
        source: { type: 'string' },
      },
      required: ['text'],
    },
  },
  {
    name: 'set_day_review',
    description: '写入某天的复盘、明日重点、心情（1-5）。只覆盖传进来的字段。',
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string' },
        done: { type: 'string', description: '今天做了什么' },
        tomorrow: { type: 'string', description: '明天的重点' },
        mood: { type: 'number', description: '1-5' },
        moodNote: { type: 'string' },
      },
    },
  },
  {
    name: 'get_recent_days',
    description: '读最近 N 天的看板概览（计划数/完成数/笔记数/心情）与连续记录天数，用于看趋势。',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: '默认 14' } },
    },
  },
  {
    name: 'get_balance',
    description: '读 NewAPI 账户余额、各密钥累计花费、今日花费与最近请求日志。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'ai_summary',
    description: '用工作站的 AI 生成「今日要点 + 建议」。会自动汇总看板计划、词单进度、校园日历与模型花费作为上下文。',
    inputSchema: { type: 'object', properties: { date: { type: 'string' } } },
  },
  {
    name: 'ai_review',
    description: '用工作站的 AI 生成今日复盘草稿（按项目归类 + 指出原地打转 + 明日安排）。',
    inputSchema: { type: 'object', properties: { date: { type: 'string' } } },
  },
  {
    name: 'list_vocab_lists',
    description: '列出工作站背单词的所有词单（名称、词数、来源、示例词）。录词前先看这个，避免建重复词单。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_vocab_words',
    description: '读词单里的词条（英文、音标、词性、释义）。listId 可传词单 id 或名称；q 可搜词或释义；不传 listId 则查全部词单。',
    inputSchema: {
      type: 'object',
      properties: {
        listId: { type: 'string', description: '词单 id 或名称；留空=全部词单' },
        q: { type: 'string', description: '关键词（匹配英文或中文释义）' },
        limit: { type: 'number', description: '最多返回多少条，默认 200' },
      },
    },
  },
  {
    name: 'add_vocab_words',
    description:
      '往背单词词单里录入词条（用户复习完单词后由智能体录入的主要入口）。' +
      '两种给法任选：text 传多行文本（每行一个词，支持「conceal 隐藏」「conceal /kənˈsiːl/ v. 隐藏，隐瞒」「conceal | 隐藏 | 例句」等写法，服务端会解析、去重）；' +
      'words 传结构化数组 [{term, phonetic, pos, meaning, example}]，信息更全。' +
      'listId / listName 省略时：若只有一个词单就用它，否则新建一个（名称为 listName 或「未分类」）。' +
      '全库已有的同名词会自动跳过（不只看当前词单），缺释义/音标/例句时会补到已有词上，不会把词库越导越乱。录入前先调 get_vocab_review_advice。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '多行文本，每行一个词（与网页「批量粘贴」同格式）' },
        words: {
          type: 'array',
          description: '结构化词条数组，字段：term(必填)、phonetic、pos、meaning、example、exampleZh、note、tags',
          items: { type: 'object', properties: { term: { type: 'string' }, phonetic: { type: 'string' }, pos: { type: 'string' }, meaning: { type: 'string' }, example: { type: 'string' } } },
        },
        listId: { type: 'string', description: '目标词单 id 或名称' },
        listName: { type: 'string', description: '目标词单名称（不存在则新建）' },
        mode: { type: 'string', description: 'append（默认，追加）或 replace（清空后替换）' },
      },
    },
  },
  {
    name: 'remove_vocab_words',
    description: '从词单里删掉若干词条（按英文单词名或词条 id）。用于纠正录错的词。',
    inputSchema: {
      type: 'object',
      properties: {
        listId: { type: 'string', description: '词单 id 或名称' },
        words: { type: 'array', items: { type: 'string' }, description: '要删除的英文单词名或词条 id' },
      },
      required: ['listId', 'words'],
    },
  },
  {
    name: 'create_vocab_list',
    description: '新建一个背单词词单，可同时把词录进去（text 或 words，同 add_vocab_words）。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '词单名，如「2026-09-13 复习」' },
        description: { type: 'string' },
        text: { type: 'string', description: '多行文本（可选）' },
        words: { type: 'array', items: { type: 'object' }, description: '结构化词条（可选）' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_vocab_progress',
    description: '读背单词学情：词单/词数、已掌握数、累计作答与正确率、今日到期队列计数、错题排行。判断今天该复习哪些词时优先用 get_vocab_review_advice。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_vocab_review_advice',
    description:
      '【智能体每日入口】根据 SuperMemo-2 遗忘曲线给出今天的复习建议：到期多少、建议练几词、建议新导入上限、缺释义、跨词单重复。' +
      '用户甩来一组新词时：先调这个，再 add_vocab_words；到期堆积超过 recommend.skipImportIfDueOver 时先别录新词。',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: '返回的到期词条数，默认 15' } },
    },
  },
  {
    name: 'get_vocab_due',
    description: '列出今天该复习的词（逾期 → 学习中 → 新词），含间隔天数与到期说明。网页「到期优先」出题用的是同一套队列。',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '默认 20' },
        includeNew: { type: 'boolean', description: '是否把新词排进队列，默认 true' },
      },
    },
  },
  {
    name: 'get_vocab_sessions',
    description:
      '读练习历史与进行中的检查点。默认最近 10 场：词单、对错、是否中途退出。includeAnswers=true 时附每题作答（给定/正确答案/时间），用于复盘溯源。',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '默认 10，最多 50' },
        includeAnswers: { type: 'boolean', description: '是否带逐题作答，默认 false' },
      },
    },
  },
  {
    name: 'dedupe_vocab',
    description:
      '整理词库：清掉本词单重复和跨词单重复，学情合并到保留的那一份。默认 dryRun=true 只报告不改；确认后再传 dryRun=false。',
    inputSchema: {
      type: 'object',
      properties: { dryRun: { type: 'boolean', description: '默认 true，只报告' } },
    },
  },
  {
    name: 'get_plan',
    description:
      '读规划台（长期目标）：关键日期倒计时（考试、报名截止…含剩余天数）、项目推进（优先级/状态/截止/进度/下一步清单）、备考板块。写每日复盘时先读它，才知道「今天该推进什么、哪个截止快到」。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'update_project',
    description:
      '更新规划台里的一个项目（按 id 或名称匹配，匹配不到就用 name 新建）。可改进度/状态/优先级/截止日期/阶段/备注，也可追加或勾选「下一步」清单。写复盘时把「这个项目今天推进到哪」落进这里。',
    inputSchema: {
      type: 'object',
      properties: {
        idOrName: { type: 'string', description: '项目 id 或名称' },
        name: { type: 'string', description: '新建时的项目名；更新时传它等于改名' },
        priority: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'], description: 'P0 最急' },
        status: { type: 'string', enum: ['active', 'waiting', 'paused', 'done'], description: 'active=推进中 waiting=等外部反馈 paused=暂停 done=已完成' },
        deadline: { type: 'string', description: 'YYYY-MM-DD；空串表示没有硬截止' },
        progress: { type: 'number', description: '0-100' },
        stage: { type: 'string', description: '当前阶段，一句话' },
        note: { type: 'string' },
        addNext: { type: 'array', items: { type: 'string' }, description: '追加到「下一步」清单' },
        doneNext: { type: 'array', items: { type: 'string' }, description: '标记为已完成，按条目 id 或原文匹配' },
      },
      required: ['idOrName'],
    },
  },
  {
    name: 'update_prep',
    description:
      '更新规划台的备考板块（按 prepId 定位，先 get_plan 看有哪些）：改阶段与备注、追加或勾选清单条目。用来把「今天推进到哪一章、单词背了哪些」落到备考进度上。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '备考板块 id 或名称，如 kaoyan / cet4' },
        stage: { type: 'string' },
        note: { type: 'string' },
        addItems: { type: 'array', items: { type: 'string' }, description: '追加清单条目' },
        doneItems: { type: 'array', items: { type: 'string' }, description: '标记完成，按条目 id 或原文匹配' },
      },
      required: ['id'],
    },
  },
  {
    name: 'set_goal_date',
    description:
      '改规划台里的关键日期（考试 / 报名截止）。自己推算的日期，官方通知一发布就用这个工具把日期改准、把 official 置 true。',
    inputSchema: {
      type: 'object',
      properties: {
        idOrName: { type: 'string', description: '时间点 id 或名称（先 get_plan 看现有哪些）' },
        name: { type: 'string' },
        date: { type: 'string', description: 'YYYY-MM-DD' },
        time: { type: 'string', description: '如 09:00，可空' },
        kind: { type: 'string', enum: ['exam', 'deadline'], description: 'exam=考试 deadline=报名/材料截止' },
        official: { type: 'boolean', description: 'true=官方公告值，false=推算值' },
        note: { type: 'string' },
      },
      required: ['idOrName', 'date'],
    },
  },
  {
    name: 'get_ports',
    description:
      '读本机端口与连接（netstat）：谁在监听哪个端口、属主进程是谁、是不是受保护进程。' +
      '「谁占着我的 5278 / 某个服务端口」这类问题用这个。只读。',
    inputSchema: {
      type: 'object',
      properties: {
        listenOnly: { type: 'boolean', description: '只看 LISTENING，默认 true' },
        q: { type: 'string', description: '按端口号 / 进程名 / 地址过滤' },
      },
    },
  },
  {
    name: 'get_agent_sessions',
    description:
      '读本机的「智能体会话」：哪些 CLI 智能体在跑（claude / codex / gemini / cursor … 以及配置里额外加的客户端（procscan.agentExtras））、' +
      '每个会话（以智能体进程为根的子树，到 shell 为止）里有哪些进程、各占多少内存。只读。' +
      '**结束进程/会话不开放给智能体**，那要在面板上由人点确认。',
    inputSchema: { type: 'object', properties: {} },
  },

  /* ---- 知识库 ---- */
  {
    name: 'get_wiki_status',
    description:
      '知识库（页面在 #/wiki）的总览：页面数与类型分布、原始资料份数、还没编译的料、最近一次操作日期。' +
      '想知道「库里有什么、有没有新料进来」先调这个。只读。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'search_wiki',
    description:
      '在知识库里检索页面（标题加权 + 中文二元切分的词法检索，返回路径、标题、片段与分数）。' +
      '问「库里哪一页讲过审美」这类问题用它；要基于库内容组织成段回答用 ask_wiki。只读。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '查询词' },
        topK: { type: 'number', description: '返回条数，默认 8' },
        includeContent: { type: 'boolean', description: '连正文一起返回（默认 false，只给片段）' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_wiki_page',
    description:
      '读知识库里的一页：正文、frontmatter、双链出链与反链（谁引用过它）。path 或 slug 任给一个。只读。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对路径，如 wiki/concepts/ai-aesthetics.md' },
        slug: { type: 'string', description: '页面 slug（不带目录与 .md）' },
      },
    },
  },
  {
    name: 'write_wiki_page',
    description:
      '写知识库页面（只允许写 wiki/ 下的 .md；raw/ 是原始资料，只进不改）。写前会自动备份旧版本到 server/data/wiki-backups/。' +
      '新建页面时请按 schema.md 给 frontmatter（type/title/tags/related），正文用 [[slug]] 互链。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对路径，如 wiki/concepts/xxx.md' },
        content: { type: 'string', description: '完整文件内容（含 frontmatter）' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'fetch_wiki_source',
    description:
      '把一个外部链接（X/Twitter 长文或推文）抓成原始资料，落到知识库 raw/sources/ 里，之后可用 ingest_wiki_source 编译成页面。' +
      '只新增文件、不覆盖已有的（要覆盖得显式带 overwrite）。图片不下载，只保留原图链接。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '形如 https://x.com/<用户>/status/<id>' },
        slug: { type: 'string', description: '文件名（不给就用标题推导）' },
        overwrite: { type: 'boolean', description: '同名文件已存在时是否覆盖，默认 false' },
      },
      required: ['url'],
    },
  },
  {
    name: 'ingest_wiki_source',
    description:
      '把 raw/ 里的一份资料「编译」成 wiki 页面：模型按 schema.md 产出 source/concept/entity 页面并更新 index.md 与 log.md。' +
      '默认只新建页面、不重写已有页面；dryRun=true 时只回计划不落盘 —— 建议先 dryRun 看一眼。',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'raw/ 下的相对路径，如 raw/sources/xxx.md' },
        dryRun: { type: 'boolean', description: '只回计划不写盘，默认 false' },
      },
      required: ['source'],
    },
  },
  {
    name: 'get_wiki_lint',
    description:
      '知识库结构体检：死链、孤立页、缺 frontmatter、index.md 未同步、raw 里有料没编译。只报不改。只读。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'ask_wiki',
    description:
      '基于知识库里已有的页面回答问题：先检索命中页面、把它喂给模型，并要求回答标注依据。' +
      '库里没有的内容它会说没有（不拿常识冒充库里的结论）。',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string' },
        topK: { type: 'number', description: '喂给模型的页面数，默认 6' },
      },
      required: ['question'],
    },
  },
  {
    name: 'get_wiki_queue',
    description: '读知识库的入库队列与源目录监听状态：每条料的进度（解析→编译）、失败的写明了原因。只读。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'add_wiki_to_queue',
    description:
      '把一份料排进知识库的入库队列（由边车依次「抽文本 → 编译成 wiki 页面」）：' +
      'kind=file 给本地文件路径（支持 pdf/docx/xlsx/pptx/md/txt/html/csv），kind=url 给 X 链接，' +
      'kind=raw 给已在 raw/ 里的源文件（只编译不解析）。ingest=false 时只入库为原始资料、不编译。',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['file', 'url', 'raw'] },
        target: { type: 'string', description: '本地路径 / 链接 / raw 相对路径' },
        title: { type: 'string', description: '显示名（默认用文件名）' },
        ingest: { type: 'boolean', description: '是否顺带编译，默认 true' },
      },
      required: ['kind', 'target'],
    },
  },
  {
    name: 'run_wiki_queue',
    description: '立刻跑一轮入库队列（默认最多 3 条）。会在后台依次抽文本并调模型编译，可能耗时几十秒到几分钟。',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: '这一轮最多处理几条，默认 3' } },
    },
  },
  {
    name: 'get_wiki_search',
    description:
      '知识库混合检索（词法 + 语义）：语义那侧要嵌入端点可用且建过索引。' +
      '要「找词」用 search_wiki（纯词法、快、可解释），要「找意思」用这个。只读。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        topK: { type: 'number', description: '默认 8' },
        mode: { type: 'string', enum: ['auto', 'semantic'], description: 'auto=融合，semantic=只走向量' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_wiki_projects',
    description: '列出知识库（可多库）：每库的目录、页面数、当前是否在用。只读。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'start_memo',
    description:
      '给一段音频起「语音随记」任务：转写 → 自动起标题写摘要 → 落成一条记录（页面 #/memo）。' +
      '后端是一个 OpenAI 兼容的转写端点（本机 whisper 网关或云端都行，见 server/lib/asr.mjs）。' +
      '音频里**必须有人声**，纯音乐 / 纯环境音会得到空结果。' +
      '这是长时间动作：**立刻返回 jobId**，之后用 get_memo_job 轮询，别在一个请求里等完。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '音频文件的绝对路径（先上传或自己放好）' },
        name: { type: 'string', description: '显示名（默认取文件名）' },
      },
      required: ['path'],
    },
  },
  {
    name: 'get_memo_job',
    description: '查一个随记任务：status=running/done/error，转写完成后会带上落成的记录。轮询用，只读。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'start_memo 返回的 jobId' } },
      required: ['id'],
    },
  },
  {
    name: 'list_memos',
    description: '语音随记的记录列表（含转写字数、时长与摘要片段）。只读。',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '列几条，默认 10' },
      },
    },
  },
  {
    name: 'read_memo',
    description: '读一条语音随记的全文：标题、摘要、要点/待办等栏目、带时间轴的转写原文。只读。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '记录 id；不给就返回最近一条' },
      },
    },
  },
]

/* --------------------------------------------------------- 工具实现 --- */

const ok = (text, extra = {}) => ({ text, ...extra })

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

const HANDLERS = {
  async get_dashboard({ date }) {
    const d = dashboard.getDay(date)
    return ok(JSON.stringify(d, null, 2), { data: d })
  },

  async get_overview({ date }) {
    const d = date ?? dashboard.todayStr()
    const ctx = await ai.gatherContext(d)
    return ok(JSON.stringify(ctx, null, 2), { data: ctx })
  },

  async add_plan({ text, date, source }) {
    const plan = dashboard.addPlan(date ?? dashboard.todayStr(), text, { source: source ?? 'agent' })
    return ok(`已加入今日计划：${text}（id=${plan.id}）`, { data: plan })
  },

  async update_plan({ id, text, done, date }) {
    const patch = {}
    if (typeof text === 'string') patch.text = text
    if (typeof done === 'boolean') patch.done = done
    const plan = dashboard.updatePlan(date ?? dashboard.todayStr(), id, patch)
    return plan ? ok(`已更新计划 ${id}`, { data: plan }) : ok(`没找到计划 ${id}`, { error: true })
  },

  async add_note({ text, date, kind }) {
    const d = date ?? dashboard.todayStr()
    if (kind === 'review') {
      const day = dashboard.getDay(d)
      const next = dashboard.patchDay(d, { done: [day.done, text].filter(Boolean).join('\n') })
      return ok(`已记到看板复盘（${d}）：${text}`, { data: next })
    }
    const note = dashboard.addNote(d, text, { source: 'mcp' })
    return ok(`已记到看板随手记（${d}）：${text}`, { data: note })
  },

  async set_day_review({ date, done, tomorrow, mood, moodNote }) {
    const patch = {}
    if (typeof done === 'string') patch.done = done
    if (typeof tomorrow === 'string') patch.tomorrow = tomorrow
    if (typeof mood === 'number') patch.mood = mood
    if (typeof moodNote === 'string') patch.moodNote = moodNote
    const d = dashboard.patchDay(date ?? dashboard.todayStr(), patch)
    return ok('已写入看板', { data: d })
  },

  async get_recent_days({ limit }) {
    const days = dashboard.recentDays(Number(limit) || 14)
    return ok(JSON.stringify({ streak: dashboard.streak(), days }, null, 2), { data: { streak: dashboard.streak(), days } })
  },









  async get_balance() {
    const s = await newapi.summary()
    const b = s.balance
    const lines = [
      b.ok ? `余额 ¥${b.quotaYuan}（累计已用 ¥${b.usedYuan}，请求 ${b.requestCount}）` : `余额读取失败：${b.error}`,
      s.todaySpend?.ok ? `今日花费 ¥${s.todaySpend.totalYuan}：${s.todaySpend.items.slice(0, 6).map((i) => `${i.name} ¥${i.yuan}`).join('，')}` : '',
    ].filter(Boolean)
    return ok(lines.join('\n'), { data: s })
  },










  async ai_summary({ date }) {
    const r = await ai.dailySummary({ date })
    if (!r.ok) return ok(`AI 生成失败：${r.error} ${r.detail ?? ''}`, { error: true })
    return ok(r.content, { data: { content: r.content, model: r.model } })
  },

  async ai_review({ date }) {
    const r = await ai.reviewDraft({ date })
    if (!r.ok) return ok(`AI 生成失败：${r.error} ${r.detail ?? ''}`, { error: true })
    return ok(r.content, { data: { content: r.content, model: r.model } })
  },

  /* ------------------------------------------------------------ 背单词 --- */

  async list_vocab_lists() {
    const r = vocab.listSummaries()
    const lines = r.lists.map(
      (l) => `- ${l.name}（${l.words} 词 · ${l.source}）${l.sample.length ? `　例：${l.sample.join(' / ')}` : ''}`,
    )
    return ok(`共 ${r.count} 个词单：\n${lines.join('\n') || '（还没有词单）'}`, { data: r })
  },

  async get_vocab_words({ listId, q, limit }) {
    const r = vocab.searchWords({ listId, q, limit: Number(limit) || 200 })
    const lines = r.words.map((w) => `${w.term}${w.phonetic ? ` /${w.phonetic}/` : ''} ${w.pos ?? ''} ${w.meaning}`.replace(/\s+/g, ' ').trim())
    const where = listId ? `词单「${listId}」` : '全部词单'
    return ok(`${where} 命中 ${r.count} 条：\n${lines.join('\n') || '（没有匹配的词）'}`, { data: r })
  },

  async add_vocab_words({ text, words, listId, listName, mode }) {
    const r = vocab.addWords({ text, words, listId, listName, mode, source: 'agent' })
    if (!r.ok) return ok(`录入失败：${r.error}`, { error: true, data: r })
    const lines = [
      `${r.created ? '已新建词单' : '已写入词单'}「${r.listName}」（id=${r.listId}）`,
      `新增 ${r.added} 条${r.skippedDuplicate ? `，本词单重复 ${r.skippedDuplicate}` : ''}${r.skippedGlobal ? `，全库已有 ${r.skippedGlobal}` : ''}${r.enriched ? `，补全已有词 ${r.enriched} 处` : ''}${r.skippedInvalid ? `，忽略无效行 ${r.skippedInvalid}` : ''}`,
      `该词单现有 ${r.totalWords} 条`,
      r.bare ? `提醒：其中 ${r.bare} 条没有释义，只能做拼写练习，建议补一下 meaning` : '',
      r.conflict ? `注意：词单在别处也被改过，对方那一版已存为 ${r.conflict.copy}（可人工比对）` : '',
    ].filter(Boolean)
    return ok(lines.join('\n'), { data: r })
  },

  async remove_vocab_words({ listId, words }) {
    const r = vocab.removeWords({ listId, wordIds: Array.isArray(words) ? words : [words] })
    return r.ok
      ? ok(`已从「${listId}」删除 ${r.removed} 条，剩余 ${r.totalWords} 条`, { data: r })
      : ok(`删除失败：${r.error}`, { error: true, data: r })
  },

  async create_vocab_list({ name, description, text, words }) {
    const r = vocab.createList({ name, description, text, words, source: 'import' })
    return ok(`已新建词单「${r.list.name}」（id=${r.list.id}），录入 ${r.added} 条${r.skipped ? `，跳过重复 ${r.skipped}` : ''}`, {
      data: { listId: r.list.id, name: r.list.name, added: r.added, totalWords: r.list.words.length },
    })
  },

  async get_vocab_review_advice({ limit }) {
    const r = vocab.reviewAdvice({ limit: Number(limit) || 15 })
    const extra = []
    if (r.queue.length) {
      extra.push('今日队列：')
      for (const w of r.queue.slice(0, 10)) extra.push(`  - ${w.term}  ${w.meaning}  [${w.due} · ${w.listName}]`)
    }
    return ok([r.advice, ...extra].filter(Boolean).join('\n'), { data: r })
  },

  async get_vocab_due({ limit, includeNew }) {
    const r = vocab.dueQueue({ limit: Number(limit) || 20, includeNew: includeNew !== false })
    const lines = r.words.map((w) => `${w.term}  ${w.meaning}  ${w.due}  interval=${w.interval}d`)
    return ok(`队列 ${r.count} 条（到期 ${r.counts.dueToday} / 新词 ${r.counts.new}）：\n${lines.join('\n') || '（空）'}`, { data: r })
  },

  async get_vocab_sessions({ limit, includeAnswers }) {
    const r = vocab.listSessions({ limit: Number(limit) || 10, includeAnswers: includeAnswers === true })
    const lines = []
    if (r.active) lines.push(`进行中：${r.active.listName} 已答 ${r.active.answered}/${r.active.planned}`)
    for (const s of r.sessions) {
      const when = s.finishedAt || s.startedAt ? new Date(s.finishedAt || s.startedAt).toLocaleString('zh-CN') : ''
      lines.push(`${when}  ${s.listName}  ${s.correct}/${s.total}${s.status === 'abandoned' ? '（中途退出）' : ''}`)
    }
    return ok(lines.join('\n') || '还没有练习记录', { data: r })
  },

  async dedupe_vocab({ dryRun }) {
    const r = vocab.dedupeLists({ dryRun: dryRun !== false })
    const head = r.dryRun ? `预览：将清理 ${r.removed} 条重复` : `已清理 ${r.removed} 条重复`
    const body = r.report.slice(0, 15).map((x) => `  - ${x.term} @ ${x.from}：${x.action}`)
    return ok([head, ...body].join('\n') || head, { data: r })
  },

  async get_vocab_progress() {
    const p = vocab.progressSummary()
    const lines = [
      `${p.lists} 个词单 / ${p.totalWords} 个词条（去重后 ${p.uniqueTerms}）；已掌握 ${p.mastered} 个，新词 ${p.untouched} 个`,
      `今日到期 ${p.due?.dueToday ?? 0}（逾期 ${p.due?.overdue ?? 0} + 学习中 ${p.due?.learning ?? 0}），稳固 ${p.due?.mature ?? 0}`,
      `累计作答 ${p.answered} 次，正确率 ${p.accuracy}%，练习 ${p.sessions} 场${p.lastSessionAt ? `（最近 ${new Date(p.lastSessionAt).toLocaleString('zh-CN')}）` : ''}`,
    ]
    if (p.wrongTop.length) {
      lines.push(`错题排行（前 ${Math.min(10, p.wrongTop.length)} 条）：`)
      for (const w of p.wrongTop.slice(0, 10)) {
        lines.push(`  - ${w.term} ${w.meaning ? `(${w.meaning})` : ''} 错 ${w.wrong} / 对 ${w.right}，连对 ${w.streak}`)
      }
    } else {
      lines.push('还没有错题记录。')
    }
    return ok(lines.join('\n'), { data: p })
  },

  /* ------------------------------------------------------------ 规划台 --- */

  async get_plan() {
    const p = plan.panel()
    const when = (d) => (d === null ? '日期未定' : d < 0 ? `已过 ${-d} 天` : d === 0 ? '就是今天' : `还有 ${d} 天`)
    const lines = [`规划台（今天 ${p.today}）`, '', '关键日期：']
    for (const e of p.hero) lines.push(`  ★ ${e.name} ${e.date || '—'}（${when(e.daysLeft)}${e.official ? '' : '，推算值'}）`)
    for (const e of p.milestones) lines.push(`    ${e.name} ${e.date || '—'}（${when(e.daysLeft)}${e.official ? '' : '，推算值'}）`)

    lines.push('', `项目（${p.projects.length} 个，按优先级排）：`)
    if (!p.projects.length) lines.push('  （空）')
    for (const r of p.projects) {
      const dl = r.deadline ? `，截止 ${r.deadline}（${when(r.daysLeft)}）` : ''
      lines.push(`  - [${r.priority} / ${r.status}] ${r.name} ${r.progress}%${dl}${r.stage ? ` · ${r.stage}` : ''}`)
      for (const n of r.next.filter((x) => !x.done)) lines.push(`      待办：${n.text}`)
    }

    lines.push('', '备考：')
    for (const s of p.prep) {
      lines.push(`  - ${s.name}（${s.done}/${s.total}，${s.progress}%）阶段：${s.stage || '未填'}`)
      for (const it of s.items.filter((x) => !x.done)) lines.push(`      待办：${it.text}`)
    }
    return ok(lines.join('\n'), { data: p })
  },

  async update_project(a = {}) {
    const { idOrName, ...rest } = a ?? {}
    const r = plan.upsertProject({ ...rest, id: idOrName })
    if (!r.ok) return ok(`更新失败：${r.error}`, { error: true })
    const p = r.project
    const open = p.next.filter((n) => !n.done).length
    return ok(`已更新项目「${p.name}」：${p.priority}/${p.status} ${p.progress}%${p.stage ? ` · ${p.stage}` : ''}；下一步还剩 ${open} 条`, {
      data: p,
    })
  },

  async update_prep(a = {}) {
    const r = plan.updatePrep(a ?? {})
    if (!r.ok) return ok(`更新失败：${r.error}`, { error: true })
    const s = r.prep.find((x) => x.id === a.id || x.name === a.id)
    return s
      ? ok(`已更新备考「${s.name}」：${s.done}/${s.total}（${s.progress}%）${s.stage ? ` · ${s.stage}` : ''}`, { data: s })
      : ok('已更新备考', { data: r.prep })
  },

  async set_goal_date(a = {}) {
    const { idOrName, ...rest } = a ?? {}
    const r = plan.upsertExam({ ...rest, id: idOrName })
    if (!r.ok) return ok(`更新失败：${r.error}`, { error: true })
    const e = r.exam
    const hit = r.exams.find((x) => x.id === e.id)
    const left = hit && hit.daysLeft !== null ? `（还有 ${hit.daysLeft} 天）` : ''
    return ok(`已更新「${e.name}」：${e.date}${left}${e.official ? '，官方值' : '，推算值'}`, { data: e })
  },





  async get_ports(a = {}) {
    const r = await procscan.listPorts({ onlyListen: a.listenOnly !== false, q: a.q || '', limit: 80 })
    if (!r.items.length) return ok('没有匹配的端口/连接', { data: r })
    const lines = r.items.map(
      (x) =>
        `${String(x.port).padStart(6)} ${x.state.padEnd(11)} ${x.name}${x.pid ? `(${x.pid})` : ''}${x.exposed ? ' · 对外' : ''}${x.blocked ? ' · 受保护' : ''}`,
    )
    return ok(`端口/连接（共 ${r.total} 条，显示 ${r.shown} 条）：
${lines.join('\n')}`, { data: r })
  },

  async get_agent_sessions() {
    const r = await procscan.listAgents()
    if (!r.total) {
      return ok('现在没有识别到在跑的智能体会话（名单：claude/codex/gemini/cursor… + 配置里的 agentExtras）', { data: r })
    }
    const lines = []
    for (const s of r.sessions) {
      lines.push(`${s.agent} · 根 ${s.rootName}(${s.rootPid}) · ${s.count} 个进程 · ${Math.round(s.ws / 1024 ** 2)} MB`)
      for (const m of s.members.slice(0, 8)) {
        lines.push(`   ${'  '.repeat(m.depth)}${m.name}(${m.pid}) ${Math.round(m.ws / 1024 ** 2)} MB${m.blocked ? ` [受保护: ${m.blockReason}]` : ''}`)
      }
      if (s.members.length > 8) lines.push(`   …还有 ${s.members.length - 8} 个`)
    }
    return ok(lines.join('\n'), { data: r })
  },


  /* ---------------------------------------------------------- 知识库 --- */

  async get_wiki_status() {
    const s = wiki.status()
    if (!s.exists) {
      return ok(`知识库目录不存在：${s.root || '(未配置)'} —— 改 config.json 的 wiki.dir`, { data: s, error: true })
    }
    const byType = Object.entries(s.pages.byType)
      .map(([k, v]) => `${k} ${v}`)
      .join(' · ')
    const lines = [
      `库：${s.root}`,
      `页面 ${s.pages.total}（${byType || '空'}）· 原始资料 ${s.sources} 份 · 双链 ${s.backlinks} 条`,
      `还没编译的料：${s.rawPending} 份${s.rawPending ? '（在 #/wiki 的「入库」里点一下即可）' : ''}`,
      `最近一次记录：${s.lastLog || '无'}`,
    ]
    return ok(lines.join('\n'), { data: s })
  },

  async search_wiki(a = {}) {
    const r = wiki.search(String(a.query ?? ''), { topK: Number(a.topK) || 8, includeContent: a.includeContent === true })
    if (!r.ok) return ok(r.error, { error: true })
    if (!r.results.length) return ok(`库里没有匹配「${r.query}」的页面`, { data: r })
    const lines = r.results.map((x, i) => `${i + 1}. ${x.title}（${x.path}｜${x.type}｜分 ${x.score}）\n   ${x.snippet}`)
    return ok(`命中 ${r.total} 页，取前 ${r.results.length}：\n${lines.join('\n')}`, { data: r })
  },

  async get_wiki_page(a = {}) {
    let rel = String(a.path ?? '')
    if (!rel && a.slug) {
      const hit = wiki.pageBySlug(String(a.slug))
      if (!hit) return ok(`没有 slug 为 ${a.slug} 的页面`, { error: true })
      rel = hit.path
    }
    const r = wiki.pageDetail(rel)
    if (!r.ok) return ok(r.error, { error: true })
    const head = [
      `${r.page?.title ?? rel}（${r.page?.type ?? '?'}｜${rel}${r.page?.updated ? `｜更新 ${r.page.updated}` : ''}）`,
      r.backlinks.length ? `被引用：${r.backlinks.map((b) => b.title).join('、')}` : '被引用：无',
      r.outlinks.length ? `链接到：${r.outlinks.map((o) => `${o.title}${o.exists ? '' : '(缺)'}`).join('、')}` : '',
    ].filter(Boolean)
    return ok(`${head.join('\n')}\n\n${r.content}`, { data: r })
  },

  async write_wiki_page(a = {}) {
    const r = await wiki.writePage(String(a.path ?? ''), String(a.content ?? ''))
    if (!r.ok) return ok(`写不了：${r.error}`, { data: r, error: true })
    const lint = wiki.lint()
    const mine = lint.items.filter((i) => i.path === r.path)
    const tail = mine.length ? `\n体检提示：${mine.map((i) => i.title).join('；')}` : ''
    return ok(`已写入 ${r.path}（${r.chars} 字）${r.backedUp ? `，旧版备份在 ${r.backedUp}` : ''}${tail}`, { data: r })
  },

  async fetch_wiki_source(a = {}) {
    const r = await wiki.fetchSource(String(a.url ?? ''), { slug: a.slug, overwrite: a.overwrite === true })
    if (!r.ok) return ok(`抓取失败：${r.error}`, { data: r, error: true })
    return ok(
      `已抓到 raw/${r.path.replace(/^raw\//, '')}（${r.chars} 字，${r.images} 张图只留链接，镜像 ${r.via}）\n` +
        `下一步：ingest_wiki_source("${r.path}", { dryRun: true }) 先看编译计划`,
      { data: r },
    )
  },

  async ingest_wiki_source(a = {}) {
    const r = await wiki.ingest(String(a.source ?? ''), { dryRun: a.dryRun === true })
    if (!r.ok) return ok(`入库失败：${r.error}`, { data: r, error: true })
    const head = r.dryRun ? '（演练：只给计划，没有写盘）' : '（已写盘）'
    const lines = [
      `编译 ${r.source} ${head}`,
      ...r.plan.pages.map((p) => `· 新建 ${p.path}（${p.type}｜${p.title}｜${p.chars} 字）`),
      ...(r.written?.length ? [`实际写入：${r.written.join('、')}`] : []),
      ...(r.plan.skipped ?? []).length ? [`跳过：${r.plan.skipped.map((s) => `${s.path}（${s.reason}）`).join('；')}`] : [],
      ...(r.indexAdded?.length ? [`index.md 补条目：${r.indexAdded.join('、')}`] : []),
      ...(r.warnings?.length ? [`注意：${r.warnings.join('；')}`] : []),
    ]
    return ok(lines.join('\n'), { data: r })
  },

  async get_wiki_lint() {
    const r = wiki.lint()
    if (!r.total) return ok('知识库结构没问题：没有死链、孤立页，索引也是同步的', { data: r })
    const lines = r.items.map((i) => `${i.severity === 'warn' ? '⚠' : '·'} ${i.title}\n   ${i.detail}`)
    return ok(`体检发现 ${r.total} 项（${Object.entries(r.counts).map(([k, v]) => `${k} ${v}`).join(' · ')}）：\n${lines.join('\n')}`, { data: r })
  },

  async ask_wiki(a = {}) {
    const r = await wiki.ask(String(a.question ?? ''), { topK: Number(a.topK) || 6 })
    if (!r.ok) return ok(`问答失败：${r.error}`, { data: r, error: true })
    const refs = r.references?.length ? `\n\n参考：${r.references.map((x) => `${x.title}(${x.path})`).join('、')}` : ''
    return ok(`${r.answer}${refs}`, { data: r })
  },

  async get_wiki_queue() {
    const q = wikiQueue.list({ limit: 50 })
    const w = wikiQueue.status()
    const lines = [
      `监听：${w.enabled ? `开（每 ${w.intervalMin} 分钟，自动编译${w.autoIngest ? '开' : '关'}）` : '关'} · 目录 ${w.dirsResolved.join('、')} · 上次扫描 ${w.lastScan || '还没扫过'}`,
      `队列：共 ${q.total} 条${Object.keys(q.counts).length ? `（${Object.entries(q.counts).map(([k, v]) => `${k} ${v}`).join(' · ')}）` : ''}${q.running ? ' · 正在跑' : ''}`,
    ]
    for (const it of q.items.slice(0, 12)) {
      lines.push(`· [${it.status}] ${it.title} ← ${it.target}${it.message ? ` — ${it.message}` : ''}`)
    }
    return ok(lines.join('\n'), { data: { queue: q, watch: w } })
  },

  async add_wiki_to_queue(a = {}) {
    const r = wikiQueue.add({ kind: a.kind, target: a.target, title: a.title, ingest: a.ingest !== false })
    if (!r.ok) return ok(`入队失败：${r.error}`, { data: r, error: true })
    return ok(
      r.duplicate
        ? `队列里已经有这条了（${r.item.status}）：${r.item.title}`
        : `已入队：${r.item.title}（kind=${r.item.kind}）—— 需要真正开始时调 run_wiki_queue`,
      { data: r },
    )
  },

  async run_wiki_queue(a = {}) {
    const r = await wikiQueue.run({ limit: Number(a.limit) || 3 })
    if (!r.ok) return ok(`跑不了：${r.error}`, { data: r, error: true })
    if (!r.processed) return ok('队列里没有待处理的条目', { data: r })
    const after = wikiQueue.list({ limit: 20 })
    const lines = after.items.slice(0, r.processed).map((i) => `· [${i.status}] ${i.title}${i.message ? ` — ${i.message}` : ''}`)
    return ok(`处理了 ${r.processed} 条：\n${lines.join('\n')}`, { data: { result: r, queue: after } })
  },

  async get_wiki_search(a = {}) {
    const mode = a.mode === 'semantic' ? 'semantic' : 'auto'
    const r = await wiki.searchHybrid(String(a.query ?? ''), { topK: Number(a.topK) || 8, mode })
    if (!r.ok) return ok(`检索失败：${r.error}`, { data: r, error: true })
    if (!r.results?.length) return ok(`没有命中「${r.query}」（模式 ${r.mode}）`, { data: r })
    const lines = r.results.map((x, i) => {
      const why = r.mode === 'hybrid' ? `词法#${x.lexicalRank ?? '-'} 语义${x.semanticScore ?? '-'}` : `分 ${x.score}`
      return `${i + 1}. ${x.title}（${x.path}｜${why}）\n   ${String(x.snippet ?? '').slice(0, 160)}`
    })
    return ok(`命中 ${r.total} 页（模式 ${r.mode}）：\n${lines.join('\n')}`, { data: r })
  },

  async get_wiki_projects() {
    const r = wiki.projects()
    const lines = r.projects.map((p) => `${p.active ? '▶ ' : '  '}${p.name}（${p.dir}）${p.exists ? `${p.pages} 页` : '目录不存在'}${p.isLibrary ? '' : ' · 不是知识库目录'}`)
    return ok(`当前库：${r.active}\n${lines.join('\n')}`, { data: r })
  },



  async start_memo(a = {}) {
    const r = memo.startTranscribe({ path: a.path, name: a.name, source: 'mcp' })
    if (!r.ok) return ok(`起不了转写任务：${r.error}`, { data: r, error: true })
    const job = r.job
    return ok(
      `已起转写任务 ${job.id}（${job.name}）。\n` +
        `转写与总结在后台跑，用 get_memo_job 轮询 ${job.id} 取结果（转写完会带上记录 id）。`,
      { data: r },
    )
  },

  async get_memo_job(a = {}) {
    const r = memo.jobStatus(a.id)
    if (!r.ok) return ok(`查不到：${r.error}`, { data: r, error: true })
    const j = r.job
    if (j.status === 'running') {
      return ok(`任务 ${j.id} 还在跑（已 ${j.elapsedSec} 秒）。稍后再查一次。`, { data: r })
    }
    if (j.status !== 'done') {
      return ok(`任务 ${j.id} 结束于 ${j.status}：${j.error ?? '（没给原因）'}`, { data: r, error: true })
    }
    return ok(
      `任务 ${j.id} 完成：${j.chars} 字，转写耗时 ${Math.round((j.asrMs ?? 0) / 1000)} 秒，记录 id=${j.recordId}。\n` +
        `用 read_memo 读全文。`,
      { data: r },
    )
  },

  async list_memos(a = {}) {
    const records = memo.list({ limit: Number(a.limit) || 10 })
    const lines = records.map(
      (r) => `· ${r.title}（${r.chars} 字｜${new Date(r.startedAt).toLocaleString('zh-CN')}｜id=${r.id}）`,
    )
    const head = records.length
      ? `共 ${records.length} 条记录：\n${lines.join('\n')}`
      : '还没有随记记录。用 start_memo 给一段音频起转写任务。'
    return ok(head, { data: { records } })
  },

  async read_memo(a = {}) {
    const id = a.id ?? memo.list({ limit: 1 })[0]?.id
    if (!id) return ok('还没有任何随记记录。', { data: { records: [] } })
    const record = memo.get(String(id))
    if (!record) return ok(`没有这条记录：${id}`, { error: true })
    const sections = (record.sections ?? [])
      .map((s) => `${s.title}：\n${s.items.map((i) => `- ${i}`).join('\n')}`)
      .join('\n\n')
    const transcript = (record.segments ?? [])
      .map((s) => `[${Math.floor(s.start / 60)}:${String(Math.round(s.start % 60)).padStart(2, '0')}] ${s.text}`)
      .join('\n')
    const text =
      `# ${record.title}\n\n` +
      `时间：${new Date(record.startedAt).toLocaleString('zh-CN')}｜时长 ${record.durationSec} 秒｜${record.chars} 字\n` +
      (record.summary ? `\n摘要：${record.summary}\n` : '') +
      (sections ? `\n${sections}\n` : '') +
      `\n转写原文：\n${transcript}`
    return ok(text, { data: record })
  },
}

/* --------------------------------------------------------- 协议处理 --- */

function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result }
}
function rpcError(id, code, message, data) {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } }
}

/** 处理一条 JSON-RPC 消息，返回响应对象（通知返回 null） */
export async function handleRpc(msg) {
  const { id, method, params } = msg ?? {}
  const isNotification = id === undefined || id === null

  switch (method) {
    case 'initialize':
      return rpcResult(id, {
        protocolVersion: params?.protocolVersion ?? '2024-11-05',
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          '工作站 MCP：读今日看板与余额，也能写入计划与笔记、生成 AI 总结、' +
          '读写背单词（每日先 get_vocab_review_advice；录词用 add_vocab_words，全库去重；到期队列 get_vocab_due；练习历史 get_vocab_sessions；整理重复 dedupe_vocab）、' +
          '以及读写规划台（get_plan / update_project / update_prep / set_goal_date）—— 长期项目进度、备考清单、关键日期倒计时都在那儿。' +
          '进程与端口速查看 get_ports 与 get_agent_sessions（只读）。进程守护引擎的开关与规则在页面「进程守护」里调，没开放成 MCP 工具。' +
          '本地知识库用 get_wiki_status / search_wiki / get_wiki_page / ask_wiki 读，' +
          'write_wiki_page 写页面，fetch_wiki_source + ingest_wiki_source 把外部文章（如 X 长文）抓进来并编译成 wiki 页，结构问题看 get_wiki_lint；' +
          '要批量导入本地 pdf/docx/xlsx/pptx 就 add_wiki_to_queue（kind=file）再 run_wiki_queue，进度用 get_wiki_queue 看；' +
          '找语义而非词面用 get_wiki_search，多库切换看 get_wiki_projects。' +
          '语音随记：start_memo 给一段音频起转写任务（立刻返回 jobId，别在一个请求里等），' +
          '用 get_memo_job 轮询到 done，再用 read_memo 读全文；还有 list_memos 列历史。' +
          '转写后端在设置里配（OpenAI 兼容的 /audio/transcriptions）。',
      })
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null
    case 'ping':
      return rpcResult(id, {})
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS })
    case 'tools/call': {
      const name = params?.name
      const args = params?.arguments ?? {}
      const handler = HANDLERS[name]
      if (!handler) return rpcError(id, -32602, `未知工具：${name}`)
      try {
        const out = await handler(args)
        const payload = {
          content: [{ type: 'text', text: out.text }],
          isError: out.error === true,
        }
        if (out.data !== undefined) {
          payload.structuredContent = out.data
        }
        return rpcResult(id, payload)
      } catch (err) {
        return rpcResult(id, {
          content: [{ type: 'text', text: `工具执行出错：${err.message}` }],
          isError: true,
        })
      }
    }
    case 'resources/list':
      return rpcResult(id, { resources: [] })
    case 'prompts/list':
      return rpcResult(id, { prompts: [] })
    default:
      if (isNotification) return null
      return rpcError(id, -32601, `不支持的方法：${method}`)
  }
}

/**
 * HTTP 入口。GET 用来做能力探测/保活（有些客户端先 GET）。
 * 返回 'handled' 表示已自行写过响应。
 */
export async function handleMcp({ req, res, body, method, send }) {
  if (method === 'GET') {
    // SSE 形式的能力探测：直接回一个事件再结束，足够多数客户端识别
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      // CORS 由边车入口按 Origin 白名单统一设置，这里不要再写 '*'（那会覆盖白名单）
    })
    res.write(`event: endpoint\ndata: /mcp\n\n`)
    // 不主动关闭：MCP 客户端通常自己断开。30s 后兜底关闭。
    const t = setTimeout(() => res.end(), 30000)
    req.on('close', () => clearTimeout(t))
    return 'handled'
  }

  if (method === 'DELETE') {
    send(res, 200, { ok: true })
    return 'handled'
  }

  // POST：支持单条或批量
  const messages = Array.isArray(body) ? body : [body]
  const responses = []
  for (const m of messages) {
    const r = await handleRpc(m)
    if (r) responses.push(r)
  }
  if (!responses.length) {
    res.writeHead(202, { 'Cache-Control': 'no-store' })
    res.end()
    return 'handled'
  }

  // initialize 时给一个 session id，部分客户端会带回来
  const headers = {}
  const hasInit = messages.some((m) => m?.method === 'initialize')
  if (hasInit) {
    headers['Mcp-Session-Id'] = `ws-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  }
  send(res, 200, Array.isArray(body) ? responses : responses[0], headers)
  return 'handled'
}

export const MCP_TOOL_NAMES = TOOLS.map((t) => t.name)
