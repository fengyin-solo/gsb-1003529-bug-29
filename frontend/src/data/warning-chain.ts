import {
  commitAll,
  listRows,
  reloadCache,
} from './local-store'
import type { ActionResult, EntryRow } from './types'

/**
 * 预警阈值 → 水位异常判定 → 巡检待办 的统一链路。
 *
 * 口径（配置列表、配置面板、异常判定、巡检入口四处必须一致）：
 * 1. 生效口径：仅「已生效」的配置参与判定；草稿、已调整、已停用一律不生效，
 *    停用即时生效，旧级别不会残留。
 * 2. 冲突优先级：蓝 < 黄 < 橙 < 红 必须严格递增；判定时取「满足条件的最高级别」，
 *    红 > 橙 > 黄 > 蓝。只有这一个入口算级别，任何页面不得自己写条件。
 * 3. 版本口径：同一「站点编号 + 监测类型」为一个配置组，只有版本号最大的已生效配置生效；
 *    新版发布后旧版自动被替代，反复发布不会残留上一版阈值。并发发布靠组版本号乐观锁，
 *    只接受一个版本。
 * 4. 事务口径：发布/停用一次事务内改 配置 + 水位判定 + 巡检待办 + 留档，
 *    任一判定失败整体回退，统计与待办一起回滚。
 * 5. 归档口径：已归档记录（水位「已通过/异常值」、巡检「已处置」）重算时不改结论，
 *    当时的级别、配置版本号、判定时间原样留档。
 */

export const WARNING_KEY = 'warning'
export const WATERLEVEL_KEY = 'waterlevel'
export const INSPECTION_KEY = 'inspection'
export const AUDIT_KEY = 'warningAudit'

export const LEVEL_ORDER = ['蓝色', '黄色', '橙色', '红色'] as const
export type WarningLevel = (typeof LEVEL_ORDER)[number]

export const LEVEL_FIELDS: Record<WarningLevel, string> = {
  蓝色: '蓝色阈值',
  黄色: '黄色阈值',
  橙色: '橙色阈值',
  红色: '红色阈值',
}

const STATUS_DRAFT = '草稿'
const STATUS_ACTIVE = '已生效'
const STATUS_ADJUSTED = '已调整'
const STATUS_DISABLED = '已停用'

export function configGroup(row: EntryRow): string {
  return `${String(row.站点编号 ?? '')}||${String(row.监测类型 ?? '')}`
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function nowText(): string {
  return new Date().toISOString()
}

function todayText(): string {
  return nowText().slice(0, 10)
}

/** 解析一条配置的四级阈值，任一级别缺失或非数值都视为无效。 */
export function readThresholds(row: EntryRow): Record<WarningLevel, number> | null {
  const values = LEVEL_ORDER.map((level) => toNumber(row[LEVEL_FIELDS[level]]))
  if (values.some((value) => value === null)) {
    return null
  }
  return {
    蓝色: values[0] as number,
    黄色: values[1] as number,
    橙色: values[2] as number,
    红色: values[3] as number,
  }
}

/**
 * 阈值校验：所有面板保存、发布都走这一处。
 * 要求为有限数值且 0 ≤ 蓝 < 黄 < 橙 < 红。
 */
export function validateThresholds(row: EntryRow): string | null {
  const names: Record<WarningLevel, string> = {
    蓝色: '蓝色阈值',
    黄色: '黄色阈值',
    橙色: '橙色阈值',
    红色: '红色阈值',
  }
  const values: number[] = []
  for (const level of LEVEL_ORDER) {
    const parsed = toNumber(row[LEVEL_FIELDS[level]])
    if (parsed === null) {
      return `${names[level]}必须填写数值`
    }
    if (parsed < 0) {
      return `${names[level]}不能小于 0`
    }
    values.push(parsed)
  }
  for (let i = 1; i < values.length; i += 1) {
    if (!(values[i - 1] < values[i])) {
      return `阈值必须严格递增（蓝 < 黄 < 橙 < 红），${LEVEL_ORDER[i - 1]}阈值 ${values[i - 1]} 不小于 ${LEVEL_ORDER[i]}阈值 ${values[i]}`
    }
  }
  return null
}

/**
 * 唯一的异常级别计算口径：取「达到阈值的最高级别」，未达蓝色阈值返回 null（正常）。
 */
export function evaluateLevel(value: number, thresholds: Record<WarningLevel, number>): WarningLevel | null {
  if (value >= thresholds.红色) {
    return '红色'
  }
  if (value >= thresholds.橙色) {
    return '橙色'
  }
  if (value >= thresholds.黄色) {
    return '黄色'
  }
  if (value >= thresholds.蓝色) {
    return '蓝色'
  }
  return null
}

/** 配置组当前版本：取组内最大版本号。面板据此做乐观锁。 */
export function groupRevision(rows: EntryRow[], group: string): number {
  return rows.reduce(
    (max, row) => (configGroup(row) === group ? Math.max(max, Number(row.版本号) || 0) : max),
    0,
  )
}

/**
 * 配置组「已发布」版本：草稿尚未发布，不代表线上已被推进，并发乐观锁只看这个。
 * 两个面板同时基于 v2 各拟一版草稿（v3、v4）时，已发布版本仍是 v2，先到的那份应放行。
 * 面板打开时记录这个值作为发布基线。
 */
export function publishedRevision(rows: EntryRow[], group: string): number {
  return rows.reduce(
    (max, row) =>
      configGroup(row) === group && String(row.status) !== STATUS_DRAFT
        ? Math.max(max, Number(row.版本号) || 0)
        : max,
    0,
  )
}

/**
 * 唯一的生效配置口径：同组只取版本号最大、状态为「已生效」且阈值合法的一条。
 * 草稿/已调整/已停用都不参与；旧版本即使还挂着「已生效」也被更大版本压过，不会残留。
 */
export function activeConfigFor(
  rows: EntryRow[],
  station: string,
  monitorType: string,
): EntryRow | null {
  const group = `${station}||${monitorType}`
  let picked: EntryRow | null = null
  for (const row of rows) {
    if (String(row.status) !== STATUS_ACTIVE || configGroup(row) !== group) {
      continue
    }
    if (readThresholds(row) === null) {
      continue
    }
    if (picked === null || (Number(row.版本号) || 0) > (Number(picked.版本号) || 0)) {
      picked = row
    }
  }
  return picked
}

export function listWarningConfigs(): EntryRow[] {
  return listRows(WARNING_KEY)
}

export function listAudits(): EntryRow[] {
  return listRows(AUDIT_KEY)
}

function nextId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

function nextSerial(rows: EntryRow[], field: string, prefix: string): string {
  let max = 0
  for (const row of rows) {
    const value = String(row[field] ?? '')
    const matched = value.match(/(\d+)$/)
    if (matched && value.startsWith(prefix)) {
      max = Math.max(max, Number(matched[1]))
    }
  }
  return `${prefix}-${String(max + 1).padStart(4, '0')}`
}

function appendAudit(
  snapshot: Record<string, EntryRow[]>,
  entry: Omit<EntryRow, 'id' | 'status' | 'pending' | 'abnormal'>,
): void {
  const audits = [...(snapshot[AUDIT_KEY] ?? [])]
  audits.push({
    id: nextId(audits),
    status: '已留档',
    pending: false,
    abnormal: false,
    ...entry,
  })
  snapshot[AUDIT_KEY] = audits
}

/**
 * 水位记录是否已归档：已通过 / 异常值 是终态。
 * 归档记录重算时结论冻结，只保留当时的级别快照与配置版本。
 */
function isWaterArchived(row: EntryRow): boolean {
  const status = String(row.status)
  return status === '已通过' || status === '异常值'
}

/**
 * 同步一条水位记录对应的自动巡检待办：
 * - 开放记录（已采集/待审核）：有级别就保证有「待巡检」待办，级别变化就更新待办内容；
 *   无级别就移除该待办（停用/发布重判后旧级别失效，待办一起回退）。
 * - 归档记录（已通过/异常值）：其名下未处置的自动待办按记录处置闭环，不删除、留档当时结论。
 * 手工创建的巡检行（待办来源不是阈值判定）不动。
 */
function syncInspectionTodo(
  snapshot: Record<string, EntryRow[]>,
  water: EntryRow,
  level: WarningLevel | null,
  archived: boolean,
): void {
  const inspections = [...(snapshot[INSPECTION_KEY] ?? [])]
  const refId = Number(water.id)
  const linkedIndex = inspections.findIndex(
    (item) => String(item.待办来源) === '阈值判定' && Number(item.水位记录ID) === refId,
  )

  if (archived) {
    if (linkedIndex >= 0 && String(inspections[linkedIndex].status) === '待巡检') {
      const record = inspections[linkedIndex]
      inspections[linkedIndex] = {
        ...record,
        status: '已处置',
        pending: false,
        abnormal: false,
        处理措施: `水位记录归档（${String(water.status)}），自动待办同步关闭，触发级别保留：${String(record.预警级别) || '无'}`,
      }
    }
    snapshot[INSPECTION_KEY] = inspections
    return
  }

  if (level === null) {
    if (linkedIndex >= 0 && String(inspections[linkedIndex].status) === '待巡检') {
      inspections.splice(linkedIndex, 1)
    }
    snapshot[INSPECTION_KEY] = inspections
    return
  }

  const config = activeConfigFor(snapshot[WARNING_KEY] ?? [], String(water.站点编号), '水位')
  const configVersion = config ? Number(config.版本号) : null
  const payload = {
    预警级别: level,
    配置版本号: configVersion,
    发现问题: `${level}预警：当前水位 ${String(water.当前水位)} 达到${level}阈值`,
  }

  if (linkedIndex >= 0) {
    const current = inspections[linkedIndex]
    if (String(current.status) === '待巡检') {
      inspections[linkedIndex] = { ...current, ...payload }
    }
  } else {
    inspections.push({
      id: nextId(inspections),
      status: '待巡检',
      pending: true,
      abnormal: true,
      记录编号: nextSerial(inspections, '记录编号', 'INSP'),
      站点编号: water.站点编号,
      巡检日期: todayText(),
      巡检人员: '待指派',
      检查项目: '水位预警现场核查',
      发现问题: payload.发现问题,
      处理措施: '',
      巡检状态: '待巡检',
      待办来源: '阈值判定',
      水位记录ID: refId,
      预警级别: level,
      配置版本号: configVersion,
    })
  }
  snapshot[INSPECTION_KEY] = inspections
}

/**
 * 重算一个配置组覆盖的全部开放水位记录（停用即传 null 配置）。
 * 在传入的事务快照上原地修改；任一水位值无法解析为数值就抛错，由外层整体回退。
 */
function rejudgeGroup(
  snapshot: Record<string, EntryRow[]>,
  station: string,
  monitorType: string,
): { judged: number; alarms: number; todos: number } {
  // 只有「水位」监测类型的配置驱动水位异常判定；其他类型（如雨量）配置不碰水位。
  if (monitorType !== '水位') {
    return { judged: 0, alarms: 0, todos: 0 }
  }
  const waters = [...(snapshot[WATERLEVEL_KEY] ?? [])]
  const config = activeConfigFor(snapshot[WARNING_KEY] ?? [], station, monitorType)
  const thresholds = config ? readThresholds(config) : null
  let judged = 0
  let alarms = 0

  waters.forEach((water, index) => {
    if (String(water.站点编号) !== station) {
      return
    }
    const archived = isWaterArchived(water)
    if (archived) {
      // 已归档：结论留档，只保证待办闭环，不重算级别。
      syncInspectionTodo(snapshot, water, null, true)
      return
    }
    judged += 1
    const rawValue = water.当前水位
    const value = toNumber(rawValue)
    if (value === null) {
      throw new Error(
        `水位记录 ${String(water.记录编号)} 的当前水位「${String(rawValue)}」不是有效数值，无法完成异常判定`,
      )
    }
    const level = thresholds ? evaluateLevel(value, thresholds) : null
    waters[index] = {
      ...water,
      预警级别: level ?? '',
      触发配置版本号: config ? Number(config.版本号) : null,
      判定时间: nowText(),
      abnormal: level !== null,
    }
    if (level !== null) {
      alarms += 1
    }
    syncInspectionTodo(snapshot, waters[index], level, false)
  })

  snapshot[WATERLEVEL_KEY] = waters
  const todos = (snapshot[INSPECTION_KEY] ?? []).filter(
    (item) => String(item.待办来源) === '阈值判定' && String(item.status) === '待巡检',
  ).length
  return { judged, alarms, todos }
}

function fail(message: string): ActionResult {
  return { ok: false, message }
}

function runTransaction(
  mutate: (snapshot: Record<string, EntryRow[]>) => ActionResult & { audit?: Omit<EntryRow, 'id' | 'status' | 'pending' | 'abnormal'> },
): ActionResult {
  // 强制重读最新提交，避免拿着旧缓存发布把别人版本盖掉。
  const base = reloadCache()
  const snapshot: Record<string, EntryRow[]> = JSON.parse(JSON.stringify(base))
  let result: ActionResult & { audit?: Omit<EntryRow, 'id' | 'status' | 'pending' | 'abnormal'> }
  try {
    result = mutate(snapshot)
  } catch (error) {
    // 判定阶段抛错：快照从未提交，配置、统计与待办一起回退（保持 base 不动）。
    return fail(error instanceof Error ? error.message : '发布过程中判定失败，已全部回退')
  }
  if (!result.ok) {
    return result
  }
  if (result.audit) {
    appendAudit(snapshot, result.audit)
  }
  // 全部判定通过后唯一提交点：一次写入，四个模块一起生效或一起不动。
  commitAll(snapshot)
  return { ok: true, message: result.message }
}

export type WarningDraft = {
  id: number | null
  站点编号: string
  监测类型: string
  蓝色阈值: string
  黄色阈值: string
  橙色阈值: string
  红色阈值: string
}

/** 面板保存草稿（新建或继续编辑草稿）：阈值校验与发布同一套口径。 */
export function saveWarningDraft(input: WarningDraft): ActionResult {
  return runTransaction((snapshot) => {
    const configs = [...(snapshot[WARNING_KEY] ?? [])]
    const candidate: EntryRow = {
      id: input.id ?? -1,
      status: STATUS_DRAFT,
      pending: true,
      abnormal: false,
      配置编号: '',
      站点编号: input.站点编号.trim(),
      监测类型: input.监测类型.trim(),
      蓝色阈值: input.蓝色阈值,
      黄色阈值: input.黄色阈值,
      橙色阈值: input.橙色阈值,
      红色阈值: input.红色阈值,
      生效状态: STATUS_DRAFT,
      版本号: 0,
      更新时间: nowText(),
    }
    if (!candidate.站点编号 || !candidate.监测类型) {
      return fail('站点编号与监测类型不能为空')
    }
    const invalid = validateThresholds(candidate)
    if (invalid) {
      return fail(invalid)
    }
    const group = configGroup(candidate)
    if (input.id !== null) {
      const index = configs.findIndex((row) => Number(row.id) === input.id)
      if (index < 0) {
        return fail(`没有找到编号为 ${input.id} 的配置`)
      }
      if (String(configs[index].status) !== STATUS_DRAFT) {
        return fail('只有草稿状态的配置可以继续编辑，请对在效配置使用「调整阈值」')
      }
      candidate.配置编号 = configs[index].配置编号
      candidate.版本号 = configs[index].版本号
      configs[index] = candidate
    } else {
      candidate.id = nextId(configs)
      candidate.配置编号 = nextSerial(configs, '配置编号', 'WARN')
      candidate.版本号 = groupRevision(configs, group) + 1
      configs.push(candidate)
    }
    snapshot[WARNING_KEY] = configs
    return {
      ok: true,
      message: `草稿 ${String(candidate.配置编号)} 已保存，版本 v${Number(candidate.版本号)}，尚未发布不影响判定`,
    }
  })
}

/**
 * 发布生效：
 * - 只有草稿可发布；已生效/已调整配置再发布必须走「调整阈值」产生的新草稿。
 * - expectedRevision 为面板打开时该组「已发布」版本号；期间有别人发布把它推高时整单拒绝
 *   （只接受一个版本）。并发草稿各自占用的草稿版本号不算已发布推进，先到的请求正常放行。
 * - 发布通过后同组旧版（含在效版）统一标记「已调整」，仅新版生效。
 * - 同一事务内重算该组水位、同步巡检待办；任一判定失败全部回退。
 */
export function publishWarning(id: number, expectedRevision: number | null): ActionResult {
  return runTransaction((snapshot) => {
    const configs = [...(snapshot[WARNING_KEY] ?? [])]
    const index = configs.findIndex((row) => Number(row.id) === id)
    if (index < 0) {
      return fail(`没有找到编号为 ${id} 的预警阈值配置`)
    }
    const draft = configs[index]
    if (String(draft.status) !== STATUS_DRAFT) {
      return fail(`配置当前为「${String(draft.status)}」，只有草稿可以发布生效`)
    }
    const group = configGroup(draft)
    const version = Number(draft.版本号) || groupRevision(configs, group) + 1
    // 面板基线落后于「已发布」版本，说明期间已有别的发布生效，整单拒绝；
    // 新建/调整草稿的基线恰为上一已发布版本（等于 published），属正常时序，放行。
    const published = publishedRevision(configs, group)
    const expected = expectedRevision ?? published
    if (expected < published) {
      return fail(
        `配置组在编辑期间已被其他发布改动（编辑基线 v${expected}，当前已发布 v${published}），请刷新面板后基于最新版本重新发布`,
      )
    }
    // 已有更新版本在效时，不允许发布旧草稿，避免把新阈值盖掉。
    const newerActive = configs.some(
      (row) =>
        configGroup(row) === group &&
        Number(row.id) !== id &&
        String(row.status) === STATUS_ACTIVE &&
        (Number(row.版本号) || 0) > version,
    )
    if (newerActive) {
      return fail(`同组已存在更新的已生效版本，旧草稿 v${version} 不能发布；请基于最新版本重新调整`)
    }
    const invalid = validateThresholds(draft)
    if (invalid) {
      return fail(invalid)
    }

    const station = String(draft.站点编号)
    const monitorType = String(draft.监测类型)
    // 先切配置状态，再让重算读到唯一新版。
    const replaced: EntryRow[] = []
    configs.forEach((row, rowIndex) => {
      if (configGroup(row) === group && Number(row.id) !== id) {
        if (String(row.status) === STATUS_ACTIVE || String(row.status) === STATUS_ADJUSTED) {
          replaced.push(row)
          configs[rowIndex] = {
            ...row,
            status: STATUS_ADJUSTED,
            生效状态: STATUS_ADJUSTED,
            pending: false,
          }
        }
      }
    })
    configs[index] = {
      ...draft,
      status: STATUS_ACTIVE,
      生效状态: STATUS_ACTIVE,
      pending: false,
      版本号: version,
      生效时间: nowText(),
      更新时间: nowText(),
    }
    snapshot[WARNING_KEY] = configs

    // 重算在同一事务快照内；抛错即整体放弃提交。
    const summary = rejudgeGroup(snapshot, station, monitorType)

    return {
      ok: true,
      message:
        `配置 ${String(draft.配置编号)} v${version} 已发布生效，旧版本即刻失效；` +
        `重判开放水位 ${summary.judged} 条、其中预警 ${summary.alarms} 条，阈值待办 ${summary.todos} 条`,
      audit: {
        时间: nowText(),
        动作: '发布生效',
        配置编号: draft.配置编号,
        站点编号: station,
        监测类型: monitorType,
        版本号: version,
        替代版本: replaced.map((row) => `v${Number(row.版本号)}`).join('、'),
        蓝色阈值: draft.蓝色阈值,
        黄色阈值: draft.黄色阈值,
        橙色阈值: draft.橙色阈值,
        红色阈值: draft.红色阈值,
        重判记录数: summary.judged,
        预警记录数: summary.alarms,
        阈值待办数: summary.todos,
        结果: '成功',
      },
    }
  })
}

/**
 * 停用配置：即时从生效口径摘除，旧级别不再参与任何判定；
 * 同事务重算该站点水位（回到无阈值口径）并撤回对应待巡检待办，失败整体回退。
 */
export function disableWarning(id: number): ActionResult {
  return runTransaction((snapshot) => {
    const configs = [...(snapshot[WARNING_KEY] ?? [])]
    const index = configs.findIndex((row) => Number(row.id) === id)
    if (index < 0) {
      return fail(`没有找到编号为 ${id} 的预警阈值配置`)
    }
    const target = configs[index]
    const status = String(target.status)
    if (status === STATUS_DISABLED) {
      return fail('该配置已经停用，不用重复操作')
    }
    const wasActive = status === STATUS_ACTIVE
    configs[index] = {
      ...target,
      status: STATUS_DISABLED,
      生效状态: STATUS_DISABLED,
      pending: false,
      停用时间: nowText(),
      更新时间: nowText(),
    }
    snapshot[WARNING_KEY] = configs

    const station = String(target.站点编号)
    const monitorType = String(target.监测类型)
    // 停用的即便不是当前在效版，也统一重算一次，保证该站点判定只听现存生效配置。
    const summary = wasActive ? rejudgeGroup(snapshot, station, monitorType) : { judged: 0, alarms: 0, todos: 0 }

    return {
      ok: true,
      message: wasActive
        ? `配置 ${String(target.配置编号)} v${Number(target.版本号)} 已停用，旧级别即刻失效；重判开放水位 ${summary.judged} 条，撤回失效待办`
        : `配置 ${String(target.配置编号)} v${Number(target.版本号)} 已停用（原本未生效，不影响判定）`,
      audit: {
        时间: nowText(),
        动作: '停用配置',
        配置编号: target.配置编号,
        站点编号: station,
        监测类型: monitorType,
        版本号: Number(target.版本号),
        蓝色阈值: target.蓝色阈值,
        黄色阈值: target.黄色阈值,
        橙色阈值: target.橙色阈值,
        红色阈值: target.红色阈值,
        重判记录数: summary.judged,
        预警记录数: summary.alarms,
        阈值待办数: summary.todos,
        结果: '成功',
      },
    }
  })
}

/**
 * 调整阈值：不直接改在效配置，而是复制一版新草稿（版本号在组内 +1）。
 * 新版发布前线上仍按旧版判定，发布后旧版被整体替代，不会出现两版阈值并存。
 */
export function adjustWarning(id: number): ActionResult & { draftId?: number; draftVersion?: number } {
  let draftId: number | null = null
  let draftVersion = 0
  const result = runTransaction((snapshot) => {
    const configs = [...(snapshot[WARNING_KEY] ?? [])]
    const index = configs.findIndex((row) => Number(row.id) === id)
    if (index < 0) {
      return fail(`没有找到编号为 ${id} 的预警阈值配置`)
    }
    const source = configs[index]
    const status = String(source.status)
    if (status === STATUS_DISABLED) {
      return fail('已停用的配置不能调整，请新建配置')
    }
    if (status === STATUS_DRAFT) {
      return fail('该配置还是草稿，直接在面板编辑即可')
    }
    const group = configGroup(source)
    const nextVersion = groupRevision(configs, group) + 1
    const draft: EntryRow = {
      id: nextId(configs),
      status: STATUS_DRAFT,
      pending: true,
      abnormal: false,
      配置编号: nextSerial(configs, '配置编号', 'WARN'),
      站点编号: source.站点编号,
      监测类型: source.监测类型,
      蓝色阈值: source.蓝色阈值,
      黄色阈值: source.黄色阈值,
      橙色阈值: source.橙色阈值,
      红色阈值: source.红色阈值,
      生效状态: STATUS_DRAFT,
      版本号: nextVersion,
      来源配置编号: source.配置编号,
      更新时间: nowText(),
    }
    configs.push(draft)
    snapshot[WARNING_KEY] = configs
    draftId = Number(draft.id)
    draftVersion = nextVersion
    return {
      ok: true,
      message: `已基于 ${String(source.配置编号)} v${Number(source.版本号)} 生成调整草稿 ${String(draft.配置编号)} v${nextVersion}，发布前线上仍按旧版判定`,
    }
  })
  return { ...result, draftId: draftId ?? undefined, draftVersion: draftVersion || undefined }
}

/** 对全部站点重判开放水位（水位页「重新判定」入口）；归档记录结论冻结。 */
export function rejudgeAllOpen(): ActionResult {
  return runTransaction((snapshot) => {
    const stations = new Set(
      (snapshot[WATERLEVEL_KEY] ?? []).map((row) => String(row.站点编号)),
    )
    let judged = 0
    let alarms = 0
    for (const station of stations) {
      const summary = rejudgeGroup(snapshot, station, '水位')
      judged += summary.judged
      alarms += summary.alarms
    }
    const todos = (snapshot[INSPECTION_KEY] ?? []).filter(
      (item) => String(item.待办来源) === '阈值判定' && String(item.status) === '待巡检',
    ).length
    return {
      ok: true,
      message: `已按当前生效配置重新判定：开放水位 ${judged} 条、预警 ${alarms} 条、阈值待办 ${todos} 条；已归档记录结论保留`,
      audit: {
        时间: nowText(),
        动作: '重新判定',
        配置编号: '全部',
        站点编号: '全部',
        监测类型: '水位',
        版本号: null,
        重判记录数: judged,
        预警记录数: alarms,
        阈值待办数: todos,
        结果: '成功',
      },
    }
  })
}

/** 水位记录进入归档终态时，关闭其名下自动待办并保留当时级别。 */
export function closeTodosForWater(waterId: number, finalStatus: string): void {
  const base = reloadCache()
  const snapshot: Record<string, EntryRow[]> = JSON.parse(JSON.stringify(base))
  const waters = snapshot[WATERLEVEL_KEY] ?? []
  const water = waters.find((row) => Number(row.id) === waterId)
  if (water) {
    syncInspectionTodo(
      snapshot,
      { ...water, status: finalStatus },
      String(water.预警级别) ? (water.预警级别 as WarningLevel) : null,
      true,
    )
    commitAll(snapshot)
  }
}

export type WarningStats = {
  groupCount: number
  activeCount: number
  disabledCount: number
  monthAdjustCount: number
  draftCount: number
}

export function warningStats(): WarningStats {
  const rows = listRows(WARNING_KEY)
  const groups = new Set(rows.map((row) => configGroup(row)))
  const monthPrefix = todayText().slice(0, 7)
  return {
    groupCount: groups.size,
    activeCount: rows.filter((row) => String(row.status) === STATUS_ACTIVE).length,
    disabledCount: rows.filter((row) => String(row.status) === STATUS_DISABLED).length,
    monthAdjustCount: rows.filter(
      (row) =>
        String(row.status) === STATUS_ADJUSTED &&
        String(row.更新时间 ?? '').startsWith(monthPrefix),
    ).length,
    draftCount: rows.filter((row) => String(row.status) === STATUS_DRAFT).length,
  }
}

export type WaterStats = {
  todayCount: number
  alarmCount: number
  pendingReviewCount: number
}

export function waterStats(): WaterStats {
  const rows = listRows(WATERLEVEL_KEY)
  const today = todayText()
  return {
    todayCount: rows.filter((row) => String(row.观测时间) === today).length,
    alarmCount: rows.filter((row) => !isWaterArchived(row) && Boolean(row.预警级别)).length,
    pendingReviewCount: rows.filter((row) => String(row.status) === '待审核').length,
  }
}

export type InspectionStats = {
  monthCount: number
  inspectedStations: number
  pendingFaults: number
  pendingTodos: number
}

export function inspectionStats(): InspectionStats {
  const rows = listRows(INSPECTION_KEY)
  const monthPrefix = todayText().slice(0, 7)
  return {
    monthCount: rows.filter((row) => String(row.巡检日期 ?? '').startsWith(monthPrefix)).length,
    inspectedStations: new Set(
      rows.filter((row) => row.status !== '待巡检').map((row) => String(row.站点编号)),
    ).size,
    pendingFaults: rows.filter((row) => String(row.status) === '发现故障').length,
    pendingTodos: rows.filter((row) => String(row.status) === '待巡检').length,
  }
}

// 页面状态徽标与动作入口统一从这里取，避免各页面自己判断状态。
export function availableActions(row: EntryRow): string[] {
  switch (String(row.status)) {
    case STATUS_DRAFT:
      return ['发布生效', '调整阈值(编辑)']
    case STATUS_ACTIVE:
      return ['调整阈值', '停用配置']
    case STATUS_ADJUSTED:
      return ['调整阈值', '停用配置']
    case STATUS_DISABLED:
      return []
    default:
      return []
  }
}
