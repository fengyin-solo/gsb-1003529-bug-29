import { MODULE_BY_KEY } from '@/data/modules'
import {
  allRows,
  listRows,
  reloadCache,
  resetRows,
  saveRows,
} from '@/data/local-store'
import {
  closeTodosForWater,
  INSPECTION_KEY,
  WATERLEVEL_KEY,
  WARNING_KEY,
} from '@/data/warning-chain'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// 阈值链路三个模块在通用字段之外多出的快照字段，导出清单时一并带上。
const EXTRA_EXPORT_FIELDS: Record<string, string[]> = {
  [WARNING_KEY]: ['版本号', '生效时间', '停用时间', '更新时间'],
  [WATERLEVEL_KEY]: ['预警级别', '触发配置版本号', '判定时间'],
  [INSPECTION_KEY]: ['待办来源', '水位记录ID', '预警级别', '配置版本号'],
}

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

// 水位记录动作后的链路同步：
// - 开放态（已采集/待审核）异常与否只认统一判定快照「预警级别」，不由动作名推断。
// - 进入终态（已通过/异常值）即归档：结论冻结、自动巡检待办闭环，当时级别留档。
function syncWaterAfterAction(rows: EntryRow[], index: number, target: string, action: string): void {
  const row = rows[index]
  if (target === '异常值') {
    rows[index] = { ...row, abnormal: true }
    closeTodosForWater(Number(row.id), target)
    return
  }
  if (target === '已通过') {
    rows[index] = { ...row, abnormal: false }
    closeTodosForWater(Number(row.id), target)
    return
  }
  // 提交审核等开放流转：异常标记跟随统一判定结果。
  rows[index] = { ...row, abnormal: Boolean(row.预警级别) }
}

// 巡检记录的异常口径：发现故障才算异常；完成巡检、确认处置都清掉异常。
function syncInspectionAfterAction(rows: EntryRow[], index: number, target: string): void {
  const row = rows[index]
  rows[index] = {
    ...row,
    abnormal: target === '发现故障',
    pending: target === '待巡检' || target === '发现故障',
  }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  // 预警阈值的三个动作走统一领域链路（版本校验、事务重判），不允许走通用流转。
  if (key === WARNING_KEY) {
    return {
      ok: false,
      message: '预警阈值动作必须经过发布/停用统一链路，请在预警阈值页面操作',
    }
  }
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  // 写前重读最新数据，避免拿旧缓存覆盖别的标签页的改动。
  const rows = [...(reloadCache()[key] ?? [])]
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  rows[index] = updated

  if (key === WATERLEVEL_KEY) {
    syncWaterAfterAction(rows, index, target, action)
  } else if (key === INSPECTION_KEY) {
    syncInspectionAfterAction(rows, index, target)
  }

  saveRows(key, rows)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const extraFields = EXTRA_EXPORT_FIELDS[key] ?? []
  const fields = [...meta.fields, ...extraFields.filter((field) => !meta.fields.includes(field))]
  const header = ['编号', ...fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `﻿${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
