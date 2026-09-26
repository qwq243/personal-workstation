<script setup lang="ts">
/** 训练计划：诊断结果 + 按读/听/写拆开的每日安排。画像先用已知事实，简历页以后再补。 */
import { computed, reactive, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useVocabStore } from './store'
import { GOAL_LABEL, SKILL_LABEL, type VocabSkill } from './types'

const store = useVocabStore()
const router = useRouter()
const d = computed(() => store.plan.diagnosis)

/** 候选值只是「常见填法」，选完存的是字符串本身 —— 见 types.ts 的 LearnerProfile */
const GRADES = [
  { value: '大一', label: '大一' },
  { value: '大二', label: '大二' },
  { value: '大三', label: '大三' },
  { value: '大四', label: '大四' },
  { value: '研一', label: '研一' },
  { value: '在读', label: '在读（其他）' },
]
const EXAMS = [
  { value: '四级', label: '四级' },
  { value: '六级', label: '六级' },
  { value: '考研', label: '考研' },
  { value: '雅思', label: '雅思' },
  { value: '托福', label: '托福' },
]
const HABIT_LABEL: Record<string, string> = { daily: '每天听', often: '隔几天听', rarely: '很少听' }

const form = reactive({ grade: '', exams: [] as string[], listenHabit: '', note: '' })
watch(
  () => store.plan.profile,
  (p) => {
    form.grade = p?.grade ?? ''
    form.exams = Array.isArray(p?.exams) ? [...p.exams] : []
    form.listenHabit = p?.listenHabit ?? ''
    form.note = p?.note ?? ''
  },
  { immediate: true, deep: true },
)

/** 画像标签：只显示填过的，一个都没填就显示引导（不预设任何人的情况） */
const profileChips = computed(() => {
  const p = store.plan.profile ?? ({} as any)
  const out: string[] = []
  if (p.grade) out.push(p.grade)
  for (const e of p.exams ?? []) if (e) out.push(e)
  if (p.listenHabit && HABIT_LABEL[p.listenHabit]) out.push(HABIT_LABEL[p.listenHabit])
  return out
})

function saveProfile() {
  store.plan = {
    ...store.plan,
    profile: {
      grade: String(form.grade ?? '').trim(),
      exams: (form.exams ?? []).map((x) => String(x).trim()).filter(Boolean),
      listenHabit: String(form.listenHabit ?? '').trim(),
      note: String(form.note ?? '').trim(),
    },
  }
  ElMessage.success('已保存（画像会跟着词单一起同步到边车）')
}

function accColor(n: number) {
  if (n >= 80) return 'var(--ws-success)'
  if (n >= 60) return 'var(--ws-warn)'
  return 'var(--ws-danger)'
}

const skills = computed(() => (['reading', 'listening', 'writing'] as VocabSkill[]).map((k) => ({
  key: k,
  label: SKILL_LABEL[k],
  ...((d.value?.skills[k]) ?? { right: 0, wrong: 0, accuracy: 0 }),
})))

function fmtDate(ts: number) {
  const x = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())} ${p(x.getHours())}:${p(x.getMinutes())}`
}
</script>

<template>
  <div class="ws-page ws-page--wide">
    <div class="ws-page-head">
      <div>
        <h1 class="ws-title"><el-icon style="color: var(--ws-accent)"><Flag /></el-icon>训练计划</h1>
        <p class="ws-subtitle">先摸底读 / 听 / 写，再按自己的目标拆。不是所有词都要会拼。</p>
      </div>
      <div class="ws-row">
        <el-button type="primary" @click="router.push('/vocab/study')">去做诊断</el-button>
        <el-button @click="router.push('/vocab/study')">开始练习</el-button>
      </div>
    </div>

    <div class="ws-card pad">
      <div class="h">目标画像</div>
      <div class="profile">
        <template v-if="profileChips.length">
          <span v-for="c in profileChips" :key="c" class="chip">{{ c }}</span>
        </template>
        <span v-else class="ws-dim" style="font-size: 13px">
          还没填。下面填一下年级 / 正在准备的考试 / 备注，训练计划会围着它排。
        </span>
      </div>
      <div class="profile-form">
        <el-select v-model="form.grade" size="small" style="width: 130px" placeholder="年级">
          <el-option v-for="g in GRADES" :key="g.value" :label="g.label" :value="g.value" />
        </el-select>
        <el-select
          v-model="form.exams"
          size="small"
          multiple
          collapse-tags
          style="min-width: 220px"
          placeholder="在准备的考试（可多选）"
        >
          <el-option v-for="e in EXAMS" :key="e.value" :label="e.label" :value="e.value" />
        </el-select>
        <el-select v-model="form.listenHabit" size="small" style="width: 150px" placeholder="听力习惯">
          <el-option label="每天听" value="daily" />
          <el-option label="隔几天听" value="often" />
          <el-option label="很少听" value="rarely" />
        </el-select>
        <el-button size="small" type="primary" @click="saveProfile">保存</el-button>
      </div>
      <el-input
        v-model="form.note"
        size="small"
        type="textarea"
        :rows="2"
        resize="none"
        style="margin-top: 8px"
        placeholder="备注（可选）：比如「某场考试临近」这类只对自己有意义的上下文"
      />
    </div>

    <div class="ws-card pad" style="margin-top: 16px">
      <div class="row-between">
        <div class="h" style="margin: 0">技能摸底</div>
        <span v-if="d" class="ws-dim">{{ d.listName }} · {{ fmtDate(d.at) }}</span>
      </div>
      <div v-if="!d" class="ws-empty" style="padding: 28px 0">
        还没做过读/听/写诊断。去练习页点「读/听/写诊断」—— 大约 24 题，阅读看词、听力只听发音、拼写默写。
      </div>
      <div v-else class="skill-grid">
        <div v-for="s in skills" :key="s.key" class="skill">
          <div class="skill__label">{{ s.label }}</div>
          <div class="skill__acc" :style="{ color: accColor(s.accuracy) }">{{ s.accuracy }}%</div>
          <div class="ws-dim">对 {{ s.right }} · 错 {{ s.wrong }}</div>
        </div>
      </div>
    </div>

    <div class="ws-card pad" style="margin-top: 16px">
      <div class="h">这周怎么练</div>
      <ol v-if="d" class="plan">
        <li v-for="(line, i) in d.plan" :key="i">{{ line }}</li>
      </ol>
      <ol v-else class="plan">
        <li>先做一轮读/听/写诊断，系统才知道你是「听得懂但不会写」，还是「会写但听不出来」。</li>
        <li>临近的考试把听力 + 拼写单独练；只要读得懂的词可以只要求认识，不必每个都会默写。</li>
        <li>每天听单词保留，但听完必须做「听音选义」，否则没有反馈。</li>
      </ol>
    </div>

    <div class="ws-card pad" style="margin-top: 16px">
      <div class="h">词的三档要求</div>
      <div class="goals">
        <div><b>{{ GOAL_LABEL.read }}</b><span>阅读里见过能懂就行 —— 阅读量大时靠的就是这批。练习只出看英选中 / 看中选英。</span></div>
        <div><b>{{ GOAL_LABEL.listen }}</b><span>听力材料和口语音标。会出听音选义，不强制默写。</span></div>
        <div><b>{{ GOAL_LABEL.write }}</b><span>作文、翻译、听写会用到。听 + 拼写 + 例句填空都练。</span></div>
      </div>
      <p class="ws-dim" style="margin-top: 10px">在词单管理的词条表里可以为每个词改档。默认：短语偏阅读，单词偏听懂。</p>
    </div>
  </div>
</template>

<style scoped>
.pad { padding: 20px 22px; }
.h { font-size: 14.5px; font-weight: 650; margin-bottom: 12px; }
.row-between { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
.profile { display: flex; flex-wrap: wrap; gap: 8px; }
.chip {
  padding: 4px 10px;
  border-radius: 99px;
  background: var(--ws-accent-soft);
  color: var(--ws-accent);
  font-size: 12.5px;
  font-weight: 600;
}
.skill-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
}
.skill {
  border: 1px solid var(--ws-border);
  border-radius: var(--ws-radius);
  padding: 14px 16px;
  background: var(--ws-panel-2);
}
.skill__label { font-size: 12.5px; color: var(--ws-text-2); }
.skill__acc { font-size: 28px; font-weight: 700; letter-spacing: -0.03em; line-height: 1.2; margin: 4px 0; }
.plan { margin: 0; padding-left: 18px; line-height: 1.75; color: var(--ws-text); }
.goals { display: flex; flex-direction: column; gap: 10px; }
.goals > div { display: flex; flex-direction: column; gap: 2px; }
.goals b { font-size: 13.5px; }
.goals span { font-size: 12.8px; color: var(--ws-text-2); }
@media (max-width: 700px) {
  .skill-grid { grid-template-columns: 1fr; }
}
</style>
