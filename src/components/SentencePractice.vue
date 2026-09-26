<script setup lang="ts">
/**
 * 英语每日一句 · 练习卡片（每日看板与「英语学习 → 每日一句」页共用）。
 * 规则（2026-09-26 定稿）：指针做完才走 —— 写翻译 → 核对 → 三档自评，走完才推到下一句；
 * 没做就停在当前句。每天做没做按日期记在边车 progress.json，卡片底部有最近 7 天的记号。
 * 词汇在翻译前就给（与纸上顺序一致：原句 → 词汇 → 你的翻译 → 参考答案）。
 */
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '@/core/sidecar'
import { ElMessage } from 'element-plus'

/** more：右上角给一个「英语学习 ›」入口（看板上用；页面自己用时不传） */
const props = defineProps<{ more?: boolean }>()
const router = useRouter()

const data = ref<any>(null)
const loading = ref(true)
const translation = ref('')
const checked = ref(false)
const submitting = ref(false)
/** 词汇默认收起（先自己读原句，需要提示再点开）—— 2026-09-26 用户定 */
const showVocab = ref(false)

const RATING_LIST: { key: 'good' | 'half' | 'lost'; label: string }[] = [
  { key: 'good', label: '读懂了' },
  { key: 'half', label: '半懂' },
  { key: 'lost', label: '没读懂' },
]

async function load() {
  loading.value = true
  try {
    const r = await api.englishDaily()
    data.value = r.ok ? r.data : { ok: false, error: r.error ?? '加载失败' }
  } finally {
    loading.value = false
  }
}

async function rate(key: 'good' | 'half' | 'lost') {
  if (!data.value?.item || submitting.value) return
  submitting.value = true
  try {
    const r = await api.englishDailyComplete(data.value.item.day, key)
    if (r.ok) {
      ElMessage.success(key === 'lost' ? '已打卡。这句没读懂，回头再翻翻' : '已打卡，下一句见')
      translation.value = ''
      checked.value = false
      showVocab.value = false
      await load()
    } else {
      ElMessage.error(r.error ?? '打卡失败')
    }
  } finally {
    submitting.value = false
  }
}

defineExpose({ load })
load()
</script>

<template>
  <div class="ws-card block">
    <div class="block__head">
      <span class="block__title"><el-icon><Reading /></el-icon> 英语每日一句</span>
      <div class="ws-row" style="gap: 8px">
        <span v-if="data?.ok" class="ws-dim">
          已完成 {{ data.completedCount }}/{{ data.total }}<template v-if="data.streak"> · 连续 {{ data.streak }} 天</template>
        </span>
        <el-button v-if="props.more" size="small" text type="primary" @click="router.push('/vocab/daily')">英语学习 ›</el-button>
      </div>
    </div>

    <el-skeleton v-if="loading && !data" :rows="3" animated />
    <div v-else-if="!data?.ok" class="muted-line">{{ data?.error ?? '加载失败' }}</div>
    <div v-else-if="data.finished" class="muted-line">全部 {{ data.total }} 句都完成了。句库有更新时编译进句库，指针会自动接上。</div>

    <template v-else>
      <div class="ed-head">
        <span class="ed-day">Day {{ data.item.day }}</span>
        <span v-if="data.item.source" class="ed-src">真题 {{ data.item.source }}</span>
      </div>
      <p class="ed-text">{{ data.item.text }}</p>

      <div v-if="data.item.vocab.length" class="ed-vocabwrap">
        <button type="button" class="ed-vocab-toggle" @click="showVocab = !showVocab">
          <el-icon class="ed-vocab-toggle__icon"><ArrowDown v-if="showVocab" /><ArrowRight v-else /></el-icon>
          <span>词汇 {{ data.item.vocab.length }} 个</span>
          <span class="ws-dim">{{ showVocab ? '收起' : '点击显示' }}</span>
        </button>
        <div v-if="showVocab" class="ed-vocab">
          <span v-for="(v, i) in data.item.vocab" :key="i" class="ed-word">
            <b>{{ v.term || v.meaning }}</b><i v-if="v.pos"> {{ v.pos }}</i><span v-if="v.term && v.meaning"> {{ v.meaning }}</span>
          </span>
        </div>
      </div>

      <el-input
        v-model="translation"
        type="textarea"
        :rows="2"
        :maxlength="300"
        resize="none"
        placeholder="你的翻译（先自己写，再核对）"
        class="ed-input"
      />

      <div v-if="!checked" class="ed-actions">
        <el-button type="primary" size="small" @click="checked = true">核对答案</el-button>
        <span class="ws-dim ed-hint">核对后选「读懂了 / 半懂 / 没读懂」，就记今天的打卡并展示下一句</span>
      </div>

      <template v-else>
        <div class="ed-sec">
          <div class="ed-sec__label">参考译文</div>
          <div class="ed-ref">{{ data.item.refTranslation || '—' }}</div>
        </div>
        <div v-if="data.item.structure.length" class="ed-sec">
          <div class="ed-sec__label">结构划分</div>
          <div class="ed-pre">{{ data.item.structure.join('\n') }}</div>
        </div>
        <div v-if="data.item.grammar.length" class="ed-sec">
          <div class="ed-sec__label">语法重点</div>
          <div class="ed-pre">{{ data.item.grammar.join('\n') }}</div>
        </div>
        <div class="ed-rate">
          <span class="ws-dim ed-hint">今天这句练得怎么样？</span>
          <el-button
            v-for="r in RATING_LIST"
            :key="r.key"
            size="small"
            :type="r.key === 'good' ? 'primary' : 'default'"
            :loading="submitting"
            @click="rate(r.key)"
          >
            {{ r.label }}
          </el-button>
        </div>
      </template>

      <div class="ed-foot">
        <span class="ws-dim">
          每天一句 · 剩 {{ data.plan.remaining }} 句 · 预计 {{ data.plan.projectedFinish.slice(5) }} 完成
          <template v-if="data.todayDone"> · 今天已打卡 ✓</template>
        </span>
        <span class="ed-dots" title="最近 7 天做没做">
          <i v-for="d in data.last7" :key="d.date" :class="{ 'is-done': d.done }" />
        </span>
      </div>
    </template>
  </div>
</template>

<style scoped>
.ed-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.ed-day {
  font-size: 12px;
  font-weight: 700;
  color: var(--ws-accent);
  background: var(--ws-accent-soft);
  border-radius: 999px;
  padding: 1px 9px;
}
.ed-src {
  font-size: 11.5px;
  color: var(--ws-text-3);
}
.ed-text {
  margin: 0 0 8px;
  font-size: 14.5px;
  line-height: 1.75;
  color: var(--ws-text);
}
.ed-vocabwrap {
  margin-bottom: 10px;
}
.ed-vocab-toggle {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 1px 8px 1px 6px;
  margin-left: -2px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--ws-text-2);
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  transition: background 0.14s ease, color 0.14s ease;
}
.ed-vocab-toggle:hover {
  background: var(--ws-accent-soft);
  color: var(--ws-accent);
}
.ed-vocab-toggle__icon {
  font-size: 12px;
}
.ed-vocab {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 6px;
  margin-top: 6px;
}
.ed-word {
  font-size: 12px;
  line-height: 1.5;
  padding: 1px 7px;
  border-radius: 5px;
  background: var(--ws-panel-2);
  border: 1px solid var(--ws-border);
  color: var(--ws-text-2);
}
.ed-word b {
  font-weight: 650;
  color: var(--ws-text);
}
.ed-word i {
  font-style: normal;
  color: var(--ws-text-3);
  font-size: 11px;
}
.ed-input {
  margin-bottom: 8px;
}
.ed-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}
.ed-hint {
  font-size: 11.5px;
}
.ed-sec + .ed-sec {
  margin-top: 10px;
}
.ed-sec__label {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--ws-text-3);
  letter-spacing: 0.04em;
  margin-bottom: 4px;
}
.ed-ref {
  font-size: 13.5px;
  line-height: 1.7;
  padding: 8px 11px;
  border-radius: var(--ws-radius-sm);
  background: var(--ws-accent-soft);
  color: var(--ws-text);
}
.ed-pre {
  font-size: 12.5px;
  line-height: 1.7;
  white-space: pre-line;
  color: var(--ws-text-2);
  padding: 6px 0 0 11px;
  border-left: 2px solid var(--ws-border);
}
.ed-rate {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px dashed var(--ws-border);
}
.ed-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-top: 12px;
  font-size: 11.5px;
}
.ed-dots {
  display: flex;
  gap: 4px;
  flex: none;
}
.ed-dots i {
  width: 7px;
  height: 7px;
  border-radius: 99px;
  background: var(--ws-border);
}
.ed-dots i.is-done {
  background: var(--ws-success);
}
</style>
