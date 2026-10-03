import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
// v2：阈值/水位/巡检链路改造后结构变化（数值阈值、判定快照、待办来源），旧缓存不再兼容。
const STORAGE_KEY = 'hydrology-monitor-station:entries:v2'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    // 新播种的键也要补进老缓存，保证 seed 新增模块能出现。
    return { ...fallback, ...parsed }
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  commitAll(next)
}

// 事务提交点：阈值发布/停用要同时改配置、水位判定、巡检待办和留档，
// 只能在全部判定通过后一次性写进去；任何一步失败都不能留下半套数据。
export function commitAll(next: Record<string, EntryRow[]>): void {
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

// 并发发布防护：写操作开始前放弃内存缓存，强制重读最近一次提交。
// 多标签页场景下再配合 storage 事件让缓存失效。
// 没有 localStorage 的环境（如 node 验证脚本）内存库本身就是唯一事实源，不能重读播种把已提交改动冲掉。
export function reloadCache(): Record<string, EntryRow[]> {
  if (typeof window !== 'undefined' && window.localStorage) {
    cache = readStorage()
  } else if (cache === null) {
    cache = readStorage()
  }
  return cache
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('storage', (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) {
      cache = null
    }
  })
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

// 测试钩子：纯前端没有服务端，node 环境下直接重置内存库。
export function __resetStoreForTest(): void {
  cache = clone(SEED_ROWS)
}

// 测试钩子：重置指定模块（验证脚本需要在同一内存库里隔离每个场景）。
export function __resetKeysForTest(keys: string[]): void {
  const next = { ...allRows() }
  for (const key of keys) {
    next[key] = clone(SEED_ROWS[key] ?? [])
  }
  cache = next
}

export function storageKey(): string {
  return STORAGE_KEY
}
