/**
 * 通用回归基线（node:test）。
 *
 *   npm test          # 或 node --test scripts/tests/
 *
 * 这里放**与外部服务无关**的纯逻辑测试：不连网、不读真实数据目录、不碰用户的文件。
 * 需要真机的验证（进程守护、解析通道）在 scripts/pguard-smoke.mjs 与
 * scripts/parser-parity.mjs 里，那两个要单独跑。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { monthMarks, markOf } from '../../server/lib/school-calendar.mjs'
import { slugify, looksLikeFeed } from '../../server/lib/wiki-fetch.mjs'

/* ------------------------------------------------------- 校历：算法而非数据 --- */

/** 一份自造的校历，用来验算法（与任何真实学校无关） */
const SPEC = {
  version: 1,
  school: '示例大学',
  semesters: [
    {
      id: '2026-2027-1',
      name: '第一学期',
      start: '2026-09-07',
      end: '2027-01-15',
      weeks: 19,
      events: [
        { name: '报到', start: '2026-09-05', end: '2026-09-06', kind: 'register' },
        { name: '考试周', start: '2027-01-04', end: '2027-01-15', kind: 'exam' },
      ],
    },
  ],
  holidays: [{ name: '国庆节', start: '2026-10-01', end: '2026-10-07' }],
  workdays: [{ date: '2026-10-10', name: '调休上课' }],
}

test('开学第一天算第 1 教学周', () => {
  const m = markOf('2026-09-07', SPEC)
  assert.equal(m.week, 1)
  assert.equal(m.suspend, false)
})

test('周末返回 rest：不上课，且不带教学周号（教学周号只在工作日算）', () => {
  const sat = markOf('2026-09-12', SPEC)
  assert.equal(sat.kind, 'rest')
  assert.equal(sat.suspend, true)
  assert.equal(sat.week, null)
})

test('法定节假日停课', () => {
  const m = markOf('2026-10-02', SPEC)
  assert.equal(m.suspend, true)
  assert.equal(m.kind, 'holiday')
})

test('调休上班的周末照常上课', () => {
  const m = markOf('2026-10-10', SPEC)
  assert.equal(m.suspend, false)
  assert.equal(m.kind, 'workday')
})

test('考试周由校历事件给出，并默认停课', () => {
  const m = markOf('2027-01-05', SPEC)
  assert.equal(m.kind, 'exam')
  assert.equal(m.suspend, true)
})

test('空校历不炸：退回「不上课」而不是抛异常', () => {
  const empty = { version: 1, semesters: [], holidays: [], workdays: [] }
  const m = markOf('2026-09-07', empty)
  assert.equal(m.week, null)
})

test('monthMarks 覆盖整月每一天', () => {
  const r = monthMarks('2026-10', SPEC)
  assert.equal(Object.keys(r.days).length, 31)
})

/* ------------------------------------------------------------ 抓取：纯函数 --- */

test('slugify 保留中文、压掉标点与空格', () => {
  assert.equal(slugify('Hello, World!'), 'hello-world')
  assert.equal(slugify('知识库（上）：入门 / 进阶'), '知识库-上-入门-进阶')
  assert.equal(slugify('  Trim  Me  '), 'trim-me')
  assert.equal(slugify(''), 'article')
  assert.equal(slugify('', 'feed'), 'feed')
})

test('looksLikeFeed 认后缀、路径与 Content-Type', () => {
  assert.equal(looksLikeFeed('https://example.com/feed'), true)
  assert.equal(looksLikeFeed('https://example.com/rss'), true)
  assert.equal(looksLikeFeed('https://example.com/blog.atom'), true)
  assert.equal(looksLikeFeed('https://example.com/a/b.xml'), true)
  assert.equal(looksLikeFeed('https://example.com/x', 'application/rss+xml'), true)
  assert.equal(looksLikeFeed('https://example.com/posts/1'), false)
})
