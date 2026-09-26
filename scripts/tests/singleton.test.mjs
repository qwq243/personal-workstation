/**
 * 单实例闸的匹配规则 —— 这条规则出错的代价是**误杀别人**，所以必须有测试盯着。
 *
 * 背景（真踩过）：同一台机器上放着两份 checkout（一份在用、一份在改）时，
 * 如果匹配用的是 `server/index.mjs` 这种通用片段，后启动的那份会把先启动的那份
 * 当成「旧的自己」收掉 —— 而两份其实是两个不同的项目。
 *
 * 所以规则是：命令行里必须出现**本项目入口的绝对路径**才算「自己」。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { isSelfInstance } from '../../server/lib/singleton.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SELF = path.join(ROOT, 'server', 'index.mjs')

test('本项目自己的边车算自己（反斜杠路径）', () => {
  assert.equal(isSelfInstance(`C:\\node\\node.exe ${SELF}`), true)
})

test('本项目自己的边车算自己（正斜杠路径）', () => {
  assert.equal(isSelfInstance(`node ${SELF.replace(/\\/g, '/')}`), true)
})

test('同目录名的「兄弟 checkout」不算自己（这就是那个坑）', () => {
  const sibling = SELF.replace(`${path.sep}workstation${path.sep}`, `${path.sep}workstation-oss${path.sep}`)
  // 只有真的换掉了目录名才测（本仓库自己就可能是那个带后缀的名字）
  if (sibling === SELF) return
  assert.equal(isSelfInstance(`node ${sibling}`), false)
})

test('别的 node 服务一律不算自己', () => {
  assert.equal(isSelfInstance('C:\\node\\node.exe C:\\elsewhere\\dist\\index.js'), false)
  assert.equal(isSelfInstance('node server.mjs'), false)
  assert.equal(isSelfInstance(''), false)
  assert.equal(isSelfInstance(undefined), false)
})

test('只有文件名片段（没有本项目路径）不算自己', () => {
  // 曾经就是这样放宽的，于是两份 checkout 互相误杀
  assert.equal(isSelfInstance('node C:\\other-project\\server\\index.mjs'), false)
})
