import { SEED_AUDIT, SEED_ROWS } from './seed'
import type { EntryRow } from './types'

/**
 * 本地持久化 + 多模块事务。
 * 阈值发布会同时改写 预警阈值 / 水位记录 / 巡检记录 三个模块，
 * 任何一步判定失败都要整体回退：先在内存快照上改，全部成功才一次性落库。
 */

const STORAGE_KEY = 'hydrology-monitor-station:entries'
const AUDIT_STORAGE_KEY = 'hydrology-monitor-station:warning-audit'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export function readEntries(): Record<string, EntryRow[]> {
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
    return { ...fallback, ...parsed }
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readEntries()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  commit({ [key]: rows })
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

/**
 * 多模块事务：在数据快照上执行 mutate；mutate 抛错（任何一条判定失败）即丢弃快照，
 * 缓存与 localStorage 都不会被写脏，统计口径（看板/列表）和巡检待办一起回退。
 */
export function commit(
  patch: Record<string, EntryRow[]>,
): { entries: Record<string, EntryRow[]>; audit: AuditEntry[] } {
  const snapshot = clone(allRows())
  for (const [key, rows] of Object.entries(patch)) {
    snapshot[key] = clone(rows)
  }
  const next = snapshot
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
  return { entries: allRows(), audit: readAudit() }
}

export type MutationError = {
  stage: string
  message: string
}

export function transaction<T>(
  keys: string[],
  mutate: (draft: Record<string, EntryRow[]>) => T,
): T {
  const snapshot = clone(allRows())
  const draft: Record<string, EntryRow[]> = {}
  for (const key of keys) draft[key] = clone(snapshot[key] ?? [])
  try {
    const result = mutate(draft)
    // mutate 全部成功后才把涉及的模块一起落库；落库动作本身只有一个写入点。
    commit(Object.fromEntries(keys.map((key) => [key, draft[key]])))
    return result
  } catch (error) {
    // 失败：快照直接丢弃，不调用 commit，三个模块维持事务前状态。
    cache = snapshot
    if (error && typeof error === 'object' && 'stage' in error) throw error
    const message = error instanceof Error ? error.message : '事务执行失败，已整体回退'
    throw { stage: '未知环节', message } as MutationError
  }
}

export function fail(stage: string, message: string): never {
  throw { stage, message } as MutationError
}

// ---- 审计留档：阈值发布/停用/归档判定/回退都留痕，结论与当时口径可追溯 ----

export type AuditEntry = {
  id: number
  time: string
  action: string
  configCode: string
  stationCode: string
  monitorType: string
  version: number | null
  result: '成功' | '失败'
  detail: string
}

function seedAudit(): AuditEntry[] {
  return clone(SEED_AUDIT)
}

export function readAudit(): AuditEntry[] {
  const fallback = seedAudit()
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(AUDIT_STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(AUDIT_STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as AuditEntry[]
    return Array.isArray(parsed) ? parsed : fallback
  } catch {
    return fallback
  }
}

let auditCache: AuditEntry[] | null = null

function allAudit(): AuditEntry[] {
  if (auditCache === null) auditCache = readAudit()
  return auditCache
}

export function appendAudit(entry: Omit<AuditEntry, 'id' | 'time'>): AuditEntry[] {
  const rows = allAudit()
  const next: AuditEntry[] = [
    {
      id: rows.reduce((max, item) => Math.max(max, item.id), 0) + 1,
      time: new Date().toISOString(),
      ...entry,
    },
    ...rows,
  ]
  auditCache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(AUDIT_STORAGE_KEY, JSON.stringify(next))
  }
  return next
}

export function listAudit(limit = 50): AuditEntry[] {
  return allAudit().slice(0, limit)
}

// ---- 发布互斥：同一 站点+监测类型 同时只允许一个发布动作进入事务 ----

const inFlightPublishKeys = new Set<string>()

export function acquirePublishLock(key: string): boolean {
  if (inFlightPublishKeys.has(key)) return false
  inFlightPublishKeys.add(key)
  return true
}

export function releasePublishLock(key: string): void {
  inFlightPublishKeys.delete(key)
}
