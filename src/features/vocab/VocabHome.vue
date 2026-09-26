<script setup lang="ts">
/** 背单词总览：数据看板 + 快捷入口 + 最近练习记录。 */
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { useVocabStore } from './store'
import { QUESTION_TYPES } from './types'

const store = useVocabStore()
const router = useRouter()

/** 全词库的掌握进度 */
const progress = computed(() => {
  const total = store.totalWords
  const mastered = store.masteredCount
  return { total, mastered, pct: total ? Math.round((mastered / total) * 100) : 0 }
})

const recent = computed(() => store.recentSessions.slice(0, 6))

/** 各题型正确率概览（从错题本 + 统计反推不出来，这里简单展示历史场次） */
const lastSession = computed(() => recent.value[0])

function fmtDate(ts: number) {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function fmtTime(s: number) {
  const m = Math.floor((s - 0) / 60)
  if (!m) return `${Math.round((s % 60) * 10) / 10}秒`
  return `${m}分${String(Math.round(s % 60)).padStart(2, '0')}秒`
}
</script>

<template>
  <div class="ws-page ws-page--wide">
    <div class="ws-page-head">
      <div>
        <h1 class="ws-title"><el-icon style="color: var(--ws-accent)"><Notebook /></el-icon>单词总览</h1>
        <p class="ws-subtitle">
          导入词单 → 到期复习 → 错题回看，按遗忘曲线排队列
          <el-tooltip :content="store.syncDetail" placement="bottom" :show-after="200">
            <span class="vocab-sync" :class="`vocab-sync--${store.syncState}`">
              <el-icon><Connection /></el-icon>&nbsp;{{ store.syncText }}
            </span>
          </el-tooltip>
        </p>
      </div>
      <div class="ws-row">
        <el-button size="large" @click="router.push('/vocab/lists')">
          <el-icon><Files /></el-icon>&nbsp;词单管理
        </el-button>
          <el-button type="primary" size="large" @click="router.push('/vocab/study')">
            <el-icon><VideoPlay /></el-icon>&nbsp;{{ store.active?.questions?.length ? '继续练习' : '开始练习' }}
          </el-button>
      </div>
    </div>

    <!-- 数据看板 -->
    <div class="board">
      <div class="stat-card">
        <div class="stat-card__label">词库总量</div>
        <div class="stat-card__value">{{ progress.total }}</div>
        <div class="stat-card__foot">{{ store.lists.length }} 个词单</div>
      </div>
      <div class="stat-card">
        <div class="stat-card__label">已掌握</div>
        <div class="stat-card__value" style="color: var(--ws-success)">{{ progress.mastered }}</div>
        <div class="stat-card__foot">间隔 ≥ 21 天，或连对 {{ store.settings.masterStreak }} 次</div>
      </div>
      <div class="stat-card">
        <div class="stat-card__label">累计作答</div>
        <div class="stat-card__value">{{ store.totalAnswered }}</div>
        <div class="stat-card__foot">{{ store.sessions.length }} 场练习</div>
      </div>
      <div class="stat-card">
        <div class="stat-card__label">总正确率</div>
        <div
          class="stat-card__value"
          :style="{ color: store.accuracy >= 80 ? 'var(--ws-success)' : store.accuracy >= 60 ? 'var(--ws-warn)' : 'var(--ws-danger)' }"
        >
          {{ store.accuracy }}%
        </div>
        <div class="stat-card__foot">错题 {{ store.wrongBook.length }} 个词</div>
      </div>
    </div>

    <!-- 掌握进度 -->
    <div class="ws-card pad">
      <div class="row-between">
        <b>今日复习队列</b>
        <span class="ws-dim">到期 {{ store.dueCounts.dueToday }} · 新词 {{ store.dueCounts.new }} · 已稳固 {{ store.dueCounts.mature }}</span>
      </div>
      <el-progress
        :percentage="progress.pct"
        :stroke-width="12"
        :color="progress.pct >= 80 ? 'var(--ws-success)' : progress.pct >= 40 ? 'var(--ws-warn)' : 'var(--ws-accent)'"
        style="margin-top: 14px"
      />
      <div class="due-row">
        <span>逾期 {{ store.dueCounts.overdue }}</span>
        <span>学习中 {{ store.dueCounts.learning }}</span>
        <span>新词 {{ store.dueCounts.new }}</span>
        <span>未到期 {{ store.dueCounts.upcoming }}</span>
        <span>稳固 {{ store.dueCounts.mature }}</span>
      </div>
    </div>

    <div class="two-col">
      <!-- 快捷练习 -->
      <div class="ws-card pad">
        <div class="h">快捷开始</div>
        <div class="quick">
          <button class="quick__item" @click="router.push('/vocab/study')">
            <el-icon class="quick__icon"><VideoPlay /></el-icon>
            <div>
              <div class="quick__t">到期复习</div>
              <div class="quick__d">按遗忘曲线排：逾期先练，再学新词</div>
            </div>
          </button>
          <button class="quick__item quick__item--danger" @click="router.push('/vocab/wrong')">
            <el-icon class="quick__icon"><WarningFilled /></el-icon>
            <div>
              <div class="quick__t">错题本（{{ store.wrongBook.length }}）</div>
              <div class="quick__d">集中回看、突破反复出错的词</div>
            </div>
          </button>
          <button class="quick__item" @click="router.push('/vocab/plan')">
            <el-icon class="quick__icon"><Flag /></el-icon>
            <div>
              <div class="quick__t">训练计划</div>
              <div class="quick__d">{{ store.plan.diagnosis ? '已有读/听/写摸底，按最弱那项拆练' : '先做诊断，再按读/听/写拆目标' }}</div>
            </div>
          </button>
        </div>

        <div class="h" style="margin-top: 22px">题型</div>
        <div class="types">
          <div v-for="t in QUESTION_TYPES" :key="t.value" class="type-chip" :title="t.hint">
            <span>{{ t.label }}</span>
            <span class="ws-dim">{{ t.hint }}</span>
          </div>
        </div>
      </div>

      <!-- 最近记录 -->
      <div class="ws-card pad">
        <div class="row-between">
          <b>最近练习</b>
          <span v-if="lastSession" class="ws-dim">最近一次 {{ fmtDate(lastSession.finishedAt) }}</span>
        </div>
        <div v-if="!recent.length" class="ws-empty" style="padding: 30px 0">还没有练习记录</div>
        <div v-else class="sessions">
          <div v-for="s in recent" :key="s.id" class="session">
            <div class="session__left">
              <div class="session__name">{{ s.listName }}</div>
              <div class="session__meta ws-dim">
                {{ fmtDate(s.finishedAt || s.updatedAt || s.startedAt) }} · {{ s.total }} 题
                <template v-if="s.status === 'abandoned'"> · 中途退出</template>
                <template v-else-if="s.finishedAt"> · {{ fmtTime((s.finishedAt - s.startedAt) / 1000) }}</template>
              </div>
            </div>
            <div class="session__score" :class="s.total ? (s.correct / s.total >= 0.8 ? 'ok' : s.correct / s.total >= 0.6 ? 'mid' : 'bad') : 'mid'">
              {{ s.total ? Math.round((s.correct / s.total) * 100) : 0 }}%
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 同步状态小标：数据存在边车（server/data/vocab/）时智能体也能读写；离线则退回纯浏览器存储 */
.vocab-sync {
  display: inline-flex;
  align-items: center;
  margin-left: 10px;
  padding: 1px 8px;
  border-radius: var(--ws-radius-pill);
  font-size: var(--ws-fs-xs);
  line-height: 18px;
  border: 1px solid var(--ws-border);
  color: var(--ws-text-2);
  cursor: default;
  vertical-align: middle;
}
.vocab-sync--online {
  color: var(--ws-success);
  border-color: color-mix(in srgb, var(--ws-success) 35%, transparent);
}
.vocab-sync--syncing {
  color: var(--ws-accent);
}
.vocab-sync--offline {
  color: var(--ws-warn);
  border-color: color-mix(in srgb, var(--ws-warn) 35%, transparent);
}
.pad {
  padding: 20px 22px;
}
.h {
  font-size: var(--ws-fs-md);
  font-weight: 650;
  margin-bottom: 14px;
}
.row-between {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 4px;
}
.due-row {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  margin-top: 10px;
  font-size: 12.5px;
  color: var(--ws-text-2);
}
.board {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(168px, 1fr));
  gap: 14px;
  margin-bottom: 18px;
}
.stat-card {
  border: 1px solid var(--ws-border);
  border-radius: var(--ws-radius-lg);
  background: var(--ws-panel);
  padding: 16px 18px;
  box-shadow: var(--ws-shadow-sm);
}
.stat-card__label {
  font-size: 12.5px;
  color: var(--ws-text-2);
}
.stat-card__value {
  font-size: 30px;
  font-weight: 700;
  letter-spacing: -0.02em;
  line-height: 1.2;
  margin-top: 5px;
  color: var(--ws-accent);
}
.stat-card__foot {
  font-size: 11.5px;
  color: var(--ws-text-3);
  margin-top: 3px;
}
.ws-card.pad {
  margin-bottom: 18px;
}
.two-col {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 18px;
}
@media (max-width: 900px) {
  .two-col {
    grid-template-columns: 1fr;
  }
}
.quick {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.quick__item {
  display: flex;
  align-items: center;
  gap: 13px;
  padding: 12px 14px;
  border-radius: var(--ws-radius);
  border: 1px solid var(--ws-border);
  background: var(--ws-panel-2);
  cursor: pointer;
  text-align: left;
  font: inherit;
  color: inherit;
  transition: all 0.14s ease;
}
.quick__item:hover {
  border-color: var(--ws-accent);
  background: var(--ws-accent-soft);
  transform: translateX(3px);
}
.quick__item--danger:hover {
  border-color: var(--ws-danger);
  background: var(--ws-danger-soft);
}
.quick__icon {
  font-size: 20px;
  color: var(--ws-accent);
  flex: 0 0 auto;
}
.quick__item--danger .quick__icon {
  color: var(--ws-danger);
}
.quick__t {
  font-size: 13.8px;
  font-weight: 600;
}
.quick__d {
  font-size: 12px;
  color: var(--ws-text-3);
  margin-top: 2px;
}
.types {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.type-chip {
  display: flex;
  flex-direction: column;
  padding: 9px 12px;
  border-radius: var(--ws-radius-sm);
  background: var(--ws-panel-2);
  border: 1px solid var(--ws-border);
}
.type-chip > span:first-child {
  font-size: 13px;
  font-weight: 600;
}
.type-chip > span:last-child {
  font-size: 11.5px;
}
.sessions {
  display: flex;
  flex-direction: column;
}
.session {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 11px 0;
}
.session + .session {
  border-top: 1px solid var(--ws-border);
}
.session__left {
  flex: 1;
  min-width: 0;
}
.session__name {
  font-size: 13.8px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.session__meta {
  font-size: 11.8px;
  margin-top: 2px;
}
.session__score {
  font-size: 17px;
  font-weight: 700;
  flex: 0 0 auto;
}
.session__score.ok {
  color: var(--ws-success);
}
.session__score.mid {
  color: var(--ws-warn);
}
.session__score.bad {
  color: var(--ws-danger);
}
</style>
