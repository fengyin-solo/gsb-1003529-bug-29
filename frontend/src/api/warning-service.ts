import {
  appendAudit,
  fail,
  listAudit,
  acquirePublishLock,
  releasePublishLock,
  listRows,
  transaction,
  type AuditEntry,
} from '@/data/store'
import {
  ARCHIVE_TIME_FIELD,
  AUTO_TODO_CONFIG_ID,
  AUTO_TODO_LEVEL,
  AUTO_TODO_MARKER,
  AUTO_TODO_STATION,
  FROZEN_LEVEL_FIELD,
  INSPECTION_MODULE,
  THRESHOLD_FIELD_BY_LEVEL,
  WARNING_LEVELS,
  WARNING_MODULE,
  WARNING_STATUS,
  WATERLEVEL_MODULE,
  WATER_MONITOR_TYPE,
  configKey,
  evaluateLevel,
  findActiveConfig,
  isActiveConfig,
  isArchived,
  isOpenTodo,
  judgeWaterRow,
  levelRank,
  parseThreshold,
  parseThresholds,
  reachesInspection,
  validateThresholds,
  type WarningLevel,
} from '@/data/warning'
import type { ActionResult, EntryRow } from '@/data/types'

/**
 * 阈值配置 → 水位异常判定 → 巡检待办 的唯一业务编排层。
 * 统一口径：
 *  1. 只有「已生效」配置参与判定，停用/已调整/草稿一律不生效；
 *  2. 冲突优先级 红 > 橙 > 黄 > 蓝，四处（列表/面板/判定/巡检入口）共用 evaluateLevel；
 *  3. 发布在一个多模块事务内完成：任一水位判定失败，阈值、统计、巡检待办整体回退；
 *  4. 同一 站点+监测类型 并发发布只接受一个版本（内存互斥锁 + 事务内乐观校验）；
 *  5. 反复发布不残留：旧版本转为「已调整」，未关闭的联动待办按新版统一对齐/回收。
 */

export type ThresholdDraft = {
  id: number
  站点编号: string
  监测类型: string
  蓝色阈值: string
  黄色阈值: string
  橙色阈值: string
  红色阈值: string
}

export function thresholdDraft(row: EntryRow): ThresholdDraft {
  return {
    id: row.id,
    站点编号: String(row['站点编号'] ?? ''),
    监测类型: String(row['监测类型'] ?? ''),
    蓝色阈值: String(row['蓝色阈值'] ?? ''),
    黄色阈值: String(row['黄色阈值'] ?? ''),
    橙色阈值: String(row['橙色阈值'] ?? ''),
    红色阈值: String(row['红色阈值'] ?? ''),
  }
}

function levelText(level: WarningLevel | null): string {
  return level ? `${level}预警` : '正常'
}

function nextId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

function nextRecordNo(rows: EntryRow[], prefix: string): string {
  const max = rows.reduce((maxNum, row) => {
    const match = /(\d+)$/.exec(String(row['记录编号'] ?? ''))
    return match ? Math.max(maxNum, Number(match[1])) : maxNum
  }, 0)
  return `${prefix}-${String(max + 1).padStart(4, '0')}`
}

/**
 * 发布生效：草稿（含停用后重新调整生成的草稿）成为唯一生效版本。
 * 步骤全部在同一事务里：阈值切换 → 本站点水位逐条重判 → 联动待办对齐，任一失败整体回退。
 */
export function publishConfig(draftId: number): ActionResult {
  const before = listRows(WARNING_MODULE)
  const draft = before.find((row) => Number(row.id) === draftId)
  if (!draft) {
    return { ok: false, message: `没有找到编号为 ${draftId} 的预警阈值配置` }
  }
  const stationCode = String(draft['站点编号'] ?? '')
  const monitorType = String(draft['监测类型'] ?? WATER_MONITOR_TYPE)

  const input: Record<string, string> = {}
  for (const level of WARNING_LEVELS) input[THRESHOLD_FIELD_BY_LEVEL[level]] = String(draft[THRESHOLD_FIELD_BY_LEVEL[level]] ?? '')
  const issues = validateThresholds(input)
  if (issues.length > 0) {
    appendAudit(auditBase('发布生效', draft, '失败', `发布前校验未通过：${issues.map((item) => item.message).join('；')}`))
    return { ok: false, message: issues.map((item) => item.message).join('；') }
  }

  const lockKey = `${stationCode}::${monitorType}`
  if (!acquirePublishLock(lockKey)) {
    appendAudit(auditBase('发布生效', draft, '失败', '同一站点+监测类型有发布正在处理，并发发布只接受一个版本，本次请求被拒绝'))
    return { ok: false, message: '该站点监测类型的阈值正在发布中，请稍后刷新查看结果，勿重复发布' }
  }

  try {
    // 进入事务前再快照一次身份信息，供失败留档使用。
    const result = transaction(
      [WARNING_MODULE, WATERLEVEL_MODULE, INSPECTION_MODULE],
      (data) => {
        const warningRows = data[WARNING_MODULE]
        const target = warningRows.find((row) => Number(row.id) === draftId)
        if (!target) fail('定位配置', `配置（${draftId}）在发布过程中被移除`)

        // 乐观校验：只有草稿/停用后重编草稿可发布；已生效/已调整不可重复发布。
        const status = String(target.status)
        if (status === WARNING_STATUS.active) fail('状态校验', '该版本已生效，请勿重复发布')
        if (status === WARNING_STATUS.adjusted) fail('状态校验', '该版本已被新版本取代，不能重复发布')
        if (status !== WARNING_STATUS.draft && status !== WARNING_STATUS.disabled) {
          fail('状态校验', `当前状态「${status}」不允许发布`)
        }

        // 事务内二次唯一性校验：并发情况下只有第一个提交能看到“无其他生效版本”。
        const currentActive = findActiveConfig(warningRows, stationCode, monitorType)
        if (currentActive && Number(currentActive.id) === target.id) {
          fail('并发校验', '该版本已被并发请求发布，请刷新后查看')
        }

        const version = Number(target['版本号'] ?? currentActive?.['版本号'] ?? 0) + 1
        const publishTime = new Date().toISOString()

        // 旧生效版本统一转为「已调整」——停用口径与取代口径在此分清：
        // 被新版取代 = 已调整（留痕）；人工停用 = 已停用；只有已生效参与判定，旧阈值不再残留。
        for (const row of warningRows) {
          if (isActiveConfig(row) && configKey(row) === `${stationCode}::${monitorType}`) {
            row.status = WARNING_STATUS.adjusted
            row.pending = false
            row.abnormal = false
            row['生效状态'] = WARNING_STATUS.adjusted
          }
        }

        target.status = WARNING_STATUS.active
        target.pending = false
        target.abnormal = false
        target['版本号'] = version
        target['最近发布时间'] = publishTime
        target['生效状态'] = WARNING_STATUS.active

        // 按新版重算本站点水位记录（已归档记录结论冻结，不重算）。
        // 非「水位」类型的阈值暂不驱动水位判定与巡检待办，避免不同监测类型互相串口径。
        const waterRows = data[WATERLEVEL_MODULE]
        const affectsWater = monitorType === WATER_MONITOR_TYPE
        const affectedLevels: Array<{ recordNo: string; value: number | null; level: WarningLevel | null; archived: boolean }> = []
        if (affectsWater) {
          for (const row of waterRows) {
            if (String(row['站点编号'] ?? '') !== stationCode) continue
            if (isArchived(row)) {
              affectedLevels.push({
                recordNo: String(row['记录编号'] ?? row.id),
                value: parseThreshold(row['当前水位']),
                level: judgeWaterRow(row, warningRows).level,
                archived: true,
              })
              continue
            }
            const value = parseThreshold(row['当前水位'])
            if (value === null) {
              // 任一判定失败：抛错，事务整体回退，阈值/统计/待办都不会半写入。
              fail('水位异常判定', `水位记录 ${row['记录编号'] ?? row.id} 的当前水位不是数字，无法按新阈值判定`)
            }
            const verdict = evaluateLevel(value as number, parseThresholds(target))
            row.abnormal = verdict !== null
            affectedLevels.push({ recordNo: String(row['记录编号'] ?? row.id), value, level: verdict, archived: false })
          }
        }

        // 联动巡检待办：未归档记录达到黄色及以上的每站一个未关闭待办；
        // 已归档记录的结论属于历史，不再驱动新待办。级别变化就更新，回落到蓝色/正常就回收。
        const inspectionRows = data[INSPECTION_MODULE]
        const expectedLevel = affectsWater
          ? pickTodoLevel(affectedLevels.filter((item) => !item.archived))
          : null
        if (affectsWater) reconcileTodos(inspectionRows, stationCode, target, expectedLevel)

        return { version, publishTime, affectedLevels, expectedLevel, configCode: String(target['配置编号'] ?? draftId) }
      },
    )

    appendAudit({
      action: '发布生效',
      configCode: result.configCode,
      stationCode,
      monitorType,
      version: result.version,
      result: '成功',
      detail:
        `v${result.version} 发布成功；水位重判：` +
        result.affectedLevels
          .map((item) => `${item.recordNo} ${item.archived ? '已归档不重算' : `=${item.value}→${levelText(item.level)}`}`)
          .join('，') +
        `；联动待办：${result.expectedLevel ? `保留/更新为${result.expectedLevel}预警核查` : '无黄色及以上预警，未关闭待办已回收'}`,
    })
    return { ok: true, message: `${stationCode} ${monitorType}阈值 v${result.version} 已发布，水位判定与巡检待办已同步` }
  } catch (error) {
    const stage = error && typeof error === 'object' && 'stage' in error ? String((error as { stage: unknown }).stage) : '未知环节'
    const message = error && typeof error === 'object' && 'message' in error ? String((error as { message: unknown }).message) : '发布失败'
    appendAudit(auditBase('发布生效', draft, '失败', `${stage}失败，已整体回退：${message}`))
    return { ok: false, message: `发布失败（${stage}），阈值、统计与巡检待办已整体回退：${message}` }
  } finally {
    releasePublishLock(lockKey)
  }
}

function pickTodoLevel(
  levels: Array<{ level: WarningLevel | null }>,
): WarningLevel | null {
  let picked: WarningLevel | null = null
  for (const item of levels) {
    if (item.level && reachesInspection(item.level)) {
      if (picked === null || levelRank(item.level) > levelRank(picked)) picked = item.level
    }
  }
  return picked
}

/**
 * 对齐本次发布配置名下的巡检待办：
 * - 只回收/更新归属本配置（configId）的未关闭联动待办，绝不动到其他配置/站点的待办；
 * - 级别不足黄色则删除（回落/停用即回收），级别变化则原地更新，仍超标且无待办则新建；
 * - 已处置（非待巡检）的待办作为现场处置历史保留，不回改、不删除。
 */
function reconcileTodos(
  inspectionRows: EntryRow[],
  stationCode: string,
  config: EntryRow,
  expectedLevel: WarningLevel | null,
): void {
  const open: EntryRow[] = []
  for (let i = inspectionRows.length - 1; i >= 0; i -= 1) {
    const row = inspectionRows[i]
    const belongsToConfig = Number(row[AUTO_TODO_CONFIG_ID]) === Number(config.id)
    const belongsToKey =
      isOpenTodo(row) &&
      String(row[AUTO_TODO_STATION] ?? row['站点编号']) === stationCode &&
      String(row['监测类型'] ?? WATER_MONITOR_TYPE) === WATER_MONITOR_TYPE
    if (belongsToConfig || belongsToKey) {
      open.push(row)
      inspectionRows.splice(i, 1)
    }
  }
  if (expectedLevel === null) return
  const existing = open[0]
  const publishTime = String(config['最近发布时间'] ?? new Date().toISOString())
  if (existing) {
    existing[AUTO_TODO_LEVEL] = expectedLevel
    existing[AUTO_TODO_CONFIG_ID] = config.id
    existing['关联配置'] = String(config['配置编号'] ?? '')
    existing['巡检日期'] = publishTime.slice(0, 10)
    existing['检查项目'] = `${expectedLevel}水位预警现场核查`
    existing['发现问题'] = `当前水位达到${expectedLevel}预警（配置 ${config['配置编号'] ?? ''} v${config['版本号'] ?? ''}）`
    inspectionRows.push(existing)
    return
  }
  inspectionRows.push({
    id: nextId(inspectionRows),
    status: '待巡检',
    pending: true,
    abnormal: true,
    记录编号: nextRecordNo(inspectionRows, 'INSP-AUTO'),
    站点编号: stationCode,
    巡检日期: publishTime.slice(0, 10),
    巡检人员: '待分派',
    检查项目: `${expectedLevel}水位预警现场核查`,
    发现问题: `当前水位达到${expectedLevel}预警（配置 ${config['配置编号'] ?? ''} v${config['版本号'] ?? ''}）`,
    处理措施: '',
    巡检状态: '待巡检',
    来源: '阈值联动',
    关联配置: String(config['配置编号'] ?? ''),
    监测类型: WATER_MONITOR_TYPE,
    [AUTO_TODO_MARKER]: true,
    [AUTO_TODO_CONFIG_ID]: config.id,
    [AUTO_TODO_STATION]: stationCode,
    [AUTO_TODO_LEVEL]: expectedLevel,
  })
}

/** 停用配置：立即彻底失效（停用后旧级别不再生效），同事务重判水位并回收未关闭联动待办。 */
export function disableConfig(id: number): ActionResult {
  const target = listRows(WARNING_MODULE).find((row) => Number(row.id) === id)
  if (!target) return { ok: false, message: `没有找到编号为 ${id} 的预警阈值配置` }
  if (String(target.status) === WARNING_STATUS.disabled) {
    return { ok: false, message: '该配置已停用，不用重复操作' }
  }
  if (!isActiveConfig(target)) {
    appendAudit(auditBase('停用配置', target, '失败', `仅已生效配置可停用，当前为「${target.status}」`))
    return { ok: false, message: `只有「已生效」的配置才能停用，当前状态为「${target.status}」` }
  }
  const stationCode = String(target['站点编号'] ?? '')
  const monitorType = String(target['监测类型'] ?? '')
  try {
    const summary = transaction([WARNING_MODULE, WATERLEVEL_MODULE, INSPECTION_MODULE], (data) => {
      const row = data[WARNING_MODULE].find((item) => Number(item.id) === id)
      if (!row || !isActiveConfig(row)) fail('状态校验', '配置状态已变化，请刷新后重试')
      row.status = WARNING_STATUS.disabled
      row.pending = false
      row.abnormal = false
      row['生效状态'] = WARNING_STATUS.disabled

      const waterRows = data[WATERLEVEL_MODULE]
      const levels: string[] = []
      if (monitorType === WATER_MONITOR_TYPE) {
        for (const water of waterRows) {
          if (String(water['站点编号'] ?? '') !== stationCode || isArchived(water)) continue
          const value = parseThreshold(water['当前水位'])
          if (value === null) fail('水位异常判定', `水位记录 ${water['记录编号'] ?? water.id} 的当前水位不是数字，无法按停用后口径判定`)
          const verdict = judgeWaterRow(water, data[WARNING_MODULE])
          water.abnormal = verdict.level !== null
          levels.push(`${water['记录编号'] ?? water.id}→${levelText(verdict.level)}`)
        }
        // 停用后本站点无生效配置，联动待办失去阈值依据，未关闭的统一回收。
        reconcileTodos(data[INSPECTION_MODULE], stationCode, row, null)
      }
      return { levels, code: String(row['配置编号'] ?? id) }
    })
    appendAudit({
      action: '停用配置',
      configCode: summary.code,
      stationCode,
      monitorType,
      version: Number(target['版本号'] ?? null),
      result: '成功',
      detail: `配置已停用并彻底失效；水位重判：${summary.levels.join('，') || '本站点无未归档水位记录'}；未关闭联动待办已回收，已处置记录留痕`,
    })
    return { ok: true, message: '配置已停用，旧阈值立即失效，水位判定与巡检待办已同步' }
  } catch (error) {
    const stage = error && typeof error === 'object' && 'stage' in error ? String((error as { stage: unknown }).stage) : '未知环节'
    const message = error && typeof error === 'object' && 'message' in error ? String((error as { message: unknown }).message) : '停用失败'
    appendAudit(auditBase('停用配置', target, '失败', `${stage}失败，已整体回退：${message}`))
    return { ok: false, message: `停用失败（${stage}），已整体回退：${message}` }
  }
}

/**
 * 调整阈值：在配置面板里改草稿。已生效/已调整/已停用的配置不能原地改（避免旧版本被偷改导致口径漂移），
 * 统一生成/更新一条同 站点+监测类型 的草稿，发布后才取代当前版本。
 */
export function saveAdjustment(input: ThresholdDraft & { sourceId: number | null }): ActionResult {
  const issues = validateThresholds({
    蓝色阈值: input.蓝色阈值,
    黄色阈值: input.黄色阈值,
    橙色阈值: input.橙色阈值,
    红色阈值: input.红色阈值,
  })
  if (input.站点编号.trim() === '' || input.监测类型.trim() === '') {
    issues.push({ field: '站点编号', message: '站点编号与监测类型不能为空' })
  }
  if (issues.length > 0) {
    return { ok: false, message: issues.map((item) => item.message).join('；') }
  }
  const result = transaction([WARNING_MODULE], (data) => {
    const rows = data[WARNING_MODULE]
    // 同一 key 只保留一条未发布草稿：反复调整改的是同一条，发布后不残留上一版草稿。
    let draft = rows.find(
      (row) =>
        String(row.status) === WARNING_STATUS.draft &&
        String(row['站点编号'] ?? '') === input.站点编号.trim() &&
        String(row['监测类型'] ?? '') === input.监测类型.trim(),
    )
    if (input.sourceId !== null) {
      const source = rows.find((row) => Number(row.id) === input.sourceId)
      if (source && String(source.status) === WARNING_STATUS.draft && !draft) draft = source
    }
    const base =
      input.sourceId !== null ? rows.find((row) => Number(row.id) === input.sourceId) : undefined
    const publishBase = findActiveConfig(rows, input.站点编号.trim(), input.监测类型.trim())
    const versionBase = publishBase ?? base
    const version = Number(versionBase?.['版本号'] ?? 0)

    if (!draft) {
      draft = {
        id: nextId(rows),
        status: WARNING_STATUS.draft,
        pending: true,
        abnormal: false,
        配置编号: nextRecordNo(rows, 'WARN'),
        站点编号: input.站点编号.trim(),
        监测类型: input.监测类型.trim(),
        蓝色阈值: '',
        黄色阈值: '',
        橙色阈值: '',
        红色阈值: '',
        版本号: version,
        最近发布时间: '',
        生效状态: WARNING_STATUS.draft,
      }
      rows.push(draft)
    }
    draft['站点编号'] = input.站点编号.trim()
    draft['监测类型'] = input.监测类型.trim()
    for (const level of WARNING_LEVELS) {
      draft[THRESHOLD_FIELD_BY_LEVEL[level]] = String(input[THRESHOLD_FIELD_BY_LEVEL[level]] ?? '').trim()
    }
    return { code: String(draft['配置编号']), version }
  })
  appendAudit({
    action: '调整阈值',
    configCode: result.code,
    stationCode: input.站点编号.trim(),
    monitorType: input.监测类型.trim(),
    version: null,
    result: '成功',
    detail: `草稿已保存（基于 v${result.version}，发布后成为 v${result.version + 1}），发布前不影响现行判定`,
  })
  return { ok: true, message: `调整已保存为草稿 ${result.code}，发布生效后才会替换当前版本` }
}

/** 归档水位记录：归档时按当时阈值冻结预警级别；之后调阈值不重算（结论见预警页审计留档）。 */
export function archiveWaterRow(id: number): ActionResult {
  const target = listRows(WATERLEVEL_MODULE).find((row) => Number(row.id) === id)
  if (!target) return { ok: false, message: `没有找到编号为 ${id} 的水位记录` }
  if (isArchived(target)) return { ok: false, message: '该记录已归档，结论已冻结' }
  try {
    const summary = transaction([WATERLEVEL_MODULE], (data) => {
      const row = data[WATERLEVEL_MODULE].find((item) => Number(item.id) === id)
      if (!row || isArchived(row)) fail('归档校验', '记录状态已变化，请刷新后重试')
      // 事务只挂了水位模块，判定所需的阈值配置必须从事务外的当前数据快照读取
      const verdict = judgeWaterRow(row, listRows(WARNING_MODULE))
      row[ARCHIVE_TIME_FIELD] = new Date().toISOString()
      row[FROZEN_LEVEL_FIELD] = verdict.level ?? ''
      row['记录状态'] = '已归档复核'
      row.status = '已归档'
      row.pending = false
      return { recordNo: String(row['记录编号'] ?? id), level: verdict.level, config: String(verdict.activeConfigId ?? '') }
    })
    appendAudit({
      action: '归档水位记录',
      configCode: summary.config ? `配置ID:${summary.config}` : '-',
      stationCode: String(target['站点编号'] ?? ''),
      monitorType: WATER_MONITOR_TYPE,
      version: null,
      result: '成功',
      detail: `${summary.recordNo} 已归档，预警级别冻结为「${levelText(summary.level)}」，历史阈值调整不再重算该记录`,
    })
    return { ok: true, message: `已归档，当时判定「${levelText(summary.level)}」已冻结留档` }
  } catch (error) {
    const stage = error && typeof error === 'object' && 'stage' in error ? String((error as { stage: unknown }).stage) : '未知环节'
    const message = error && typeof error === 'object' && 'message' in error ? String((error as { message: unknown }).message) : '归档失败'
    return { ok: false, message: `归档失败（${stage}）：${message}` }
  }
}

function auditBase(action: string, row: EntryRow, result: '成功' | '失败', detail: string) {
  return {
    action,
    configCode: String(row['配置编号'] ?? row.id),
    stationCode: String(row['站点编号'] ?? ''),
    monitorType: String(row['监测类型'] ?? ''),
    version: Number(row['版本号'] ?? null),
    result,
    detail,
  }
}

export function listWarningAudit(limit = 50): AuditEntry[] {
  return listAudit(limit)
}
