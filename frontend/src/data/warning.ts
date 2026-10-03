import type { EntryRow } from './types'

/**
 * 预警阈值领域：阈值配置、水位异常判定、巡检待办生成共用同一份口径。
 * 配置列表、配置面板、水位异常判定、巡检入口任何一处都不允许再单独写比较规则。
 */

// 蓝、黄、橙、红四级预警，级别值递增；冲突时一律取命中的最高级（红 > 橙 > 黄 > 蓝）。
export const WARNING_LEVELS = ['蓝色', '黄色', '橙色', '红色'] as const
export type WarningLevel = (typeof WARNING_LEVELS)[number]

export const WARNING_MODULE = 'warning'
export const WATERLEVEL_MODULE = 'waterlevel'
export const INSPECTION_MODULE = 'inspection'

export const WARNING_STATUS = {
  draft: '草稿',
  active: '已生效',
  adjusted: '已调整',
  disabled: '已停用',
} as const

// 只有「已生效」参与判定；草稿未发布、已调整已被新版取代、已停用即彻底失效（停用口径统一在此）。
export function isActiveConfig(row: EntryRow): boolean {
  return String(row.status) === WARNING_STATUS.active
}

export const THRESHOLD_FIELDS = ['蓝色阈值', '黄色阈值', '橙色阈值', '红色阈值'] as const
export const THRESHOLD_FIELD_BY_LEVEL: Record<WarningLevel, (typeof THRESHOLD_FIELDS)[number]> = {
  蓝色: '蓝色阈值',
  黄色: '黄色阈值',
  橙色: '橙色阈值',
  红色: '红色阈值',
}

// 解析后的阈值表：空值表示该级未配置；数字才参与比较。
export type ThresholdSet = Partial<Record<WarningLevel, number>>

export function parseThreshold(raw: string | number | boolean | undefined): number | null {
  if (raw === undefined || raw === null) return null
  const text = String(raw).trim()
  if (text === '' || text === '—') return null
  const value = Number(text)
  return Number.isFinite(value) ? value : null
}

export function parseThresholds(row: EntryRow): ThresholdSet {
  const result: ThresholdSet = {}
  for (const level of WARNING_LEVELS) {
    const value = parseThreshold(row[THRESHOLD_FIELD_BY_LEVEL[level]])
    if (value !== null) result[level] = value
  }
  return result
}

export type ThresholdIssue = { field: string; message: string }

/**
 * 发布前校验：每级要么留空，要么必须是数字；只要填了，就必须严格满足 蓝 < 黄 < 橙 < 红。
 * 蓝黄橙红冲突（顺序颠倒、相等）直接拒绝发布，从根上杜绝各处按不同条件计算。
 */
export function validateThresholds(input: Record<string, string>): ThresholdIssue[] {
  const issues: ThresholdIssue[] = []
  const values: Partial<Record<WarningLevel, number>> = {}
  for (const level of WARNING_LEVELS) {
    const field = THRESHOLD_FIELD_BY_LEVEL[level]
    const text = (input[field] ?? '').trim()
    if (text === '') continue
    const value = Number(text)
    if (!Number.isFinite(value)) {
      issues.push({ field, message: `${field}必须是数字` })
      continue
    }
    values[level] = value
  }
  let previous: { level: WarningLevel; value: number } | null = null
  for (const level of WARNING_LEVELS) {
    const value = values[level]
    if (value === undefined) continue
    if (previous !== null && value <= previous.value) {
      issues.push({
        field: THRESHOLD_FIELD_BY_LEVEL[level],
        message: `${THRESHOLD_FIELD_BY_LEVEL[level]}必须大于${THRESHOLD_FIELD_BY_LEVEL[previous.level]}（${previous.value}），蓝黄橙红需严格递增`,
      })
    }
    previous = { level, value }
  }
  if (Object.keys(values).length === 0) {
    issues.push({ field: '蓝色阈值', message: '至少配置一级阈值后才能发布' })
  }
  return issues
}

/**
 * 级别判定：按红 → 橙 → 黄 → 蓝的优先级取第一个满足 value >= 阈值 的级别。
 * 这是配置面板预览、水位异常判定、巡检待办生成的唯一判定入口。
 */
export function evaluateLevel(value: number, thresholds: ThresholdSet): WarningLevel | null {
  for (let i = WARNING_LEVELS.length - 1; i >= 0; i -= 1) {
    const level = WARNING_LEVELS[i]
    const threshold = thresholds[level]
    if (threshold !== undefined && value >= threshold) return level
  }
  return null
}

export function levelRank(level: WarningLevel): number {
  return WARNING_LEVELS.indexOf(level)
}

// 达到黄色及以上才生成巡检待办；蓝色仅预警展示，不下发现场任务。
export const INSPECTION_MIN_LEVEL: WarningLevel = '黄色'

export function reachesInspection(level: WarningLevel | null): boolean {
  return level !== null && levelRank(level) >= levelRank(INSPECTION_MIN_LEVEL)
}

export function configKey(row: Pick<EntryRow, string>): string {
  return `${String(row['站点编号'] ?? '')}::${String(row['监测类型'] ?? '')}`
}

/**
 * 取某站点、某监测类型当前唯一生效的配置版本。
 * 同一 key 只允许一个「已生效」版本（发布时事务内保证）；数据异常导致多条时取版本号/编号最大的一条兜底。
 */
export function findActiveConfig(
  rows: EntryRow[],
  stationCode: string,
  monitorType: string,
): EntryRow | null {
  const candidates = rows.filter(
    (row) =>
      isActiveConfig(row) &&
      String(row['站点编号'] ?? '') === stationCode &&
      String(row['监测类型'] ?? '') === monitorType,
  )
  if (candidates.length === 0) return null
  return candidates.reduce((best, row) => {
    const bestVersion = Number(best['版本号'] ?? best.id)
    const rowVersion = Number(row['版本号'] ?? row.id)
    return rowVersion > bestVersion ? row : best
  })
}

export const WATER_MONITOR_TYPE = '水位'

export function readWaterValue(row: EntryRow): number | null {
  return parseThreshold(row['当前水位'])
}

export const ARCHIVE_TIME_FIELD = '归档时间'

// 已归档记录：判定结论在归档那一刻冻结，历史阈值调整不再重算（结论见审计留档）。
export function isArchived(row: EntryRow): boolean {
  return String(row[ARCHIVE_TIME_FIELD] ?? '').trim() !== ''
}

export const FROZEN_LEVEL_FIELD = '归档时预警级别'

export type WaterVerdict = {
  level: WarningLevel | null
  activeConfigId: number | null
  frozen: boolean
}

/**
 * 一条水位记录的异常判定：
 * - 已归档：直接采用归档时冻结的级别，不随现行阈值重算；
 * - 未归档：按该站点「水位」类型唯一生效的配置实时判定，停用/被取代/草稿的配置一律不生效。
 */
export function judgeWaterRow(
  row: EntryRow,
  warningRows: EntryRow[],
): WaterVerdict {
  if (isArchived(row)) {
    const frozen = String(row[FROZEN_LEVEL_FIELD] ?? '').trim()
    return {
      level: (WARNING_LEVELS as readonly string[]).includes(frozen)
        ? (frozen as WarningLevel)
        : null,
      activeConfigId: null,
      frozen: true,
    }
  }
  const stationCode = String(row['站点编号'] ?? '')
  const active = findActiveConfig(warningRows, stationCode, WATER_MONITOR_TYPE)
  if (!active) return { level: null, activeConfigId: null, frozen: false }
  const value = readWaterValue(row)
  if (value === null) return { level: null, activeConfigId: active.id, frozen: false }
  return { level: evaluateLevel(value, parseThresholds(active)), activeConfigId: active.id, frozen: false }
}

export const AUTO_TODO_MARKER = '__autoWarningTodo'
export const AUTO_TODO_CONFIG_ID = '__warningConfigId'
export const AUTO_TODO_STATION = '__warningStation'
export const AUTO_TODO_LEVEL = '__warningLevel'

// 阈值联动生成的巡检待办：仍是巡检模块里的正式记录，用内部字段标记来源便于回收。
export function isAutoTodo(row: EntryRow): boolean {
  return Boolean(row[AUTO_TODO_MARKER])
}

export function isOpenTodo(row: EntryRow): boolean {
  return isAutoTodo(row) && String(row.status) === '待巡检'
}

export function todoStation(row: EntryRow): string {
  return String(row[AUTO_TODO_STATION] ?? row['站点编号'] ?? '')
}

export function todoLevel(row: EntryRow): WarningLevel | null {
  const raw = String(row[AUTO_TODO_LEVEL] ?? '')
  return (WARNING_LEVELS as readonly string[]).includes(raw) ? (raw as WarningLevel) : null
}
