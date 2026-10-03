#!/usr/bin/env node
/**
 * 预警阈值链路验证：停用口径、冲突优先级、版本残留、并发发布、判定失败回退、归档留档。
 * 纯前端数据层在 node 下跑（无 window/localStorage 时回退 seed 内存库）。
 * 用 esbuild 把 TS + @ 别名即时打成临时 bundle 再加载。
 */
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import { writeFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const entry = join(root, 'scripts', '.verify-entry.ts')
writeFileSync(entry, `
export * from '@/data/warning-chain'
export { __resetStoreForTest, __resetKeysForTest, commitAll, allRows, listRows } from '@/data/local-store'
`)

const srcRoot = join(root, 'src')
let mod
try {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
    alias: { '@': srcRoot },
  })
  const out = join(root, 'scripts', '.verify-bundle.mjs')
  writeFileSync(out, result.outputFiles[0].text)
  mod = await import(pathToFileURL(out).href)
} finally {
  rmSync(entry, { force: true })
}

const {
  __resetStoreForTest,
  __resetKeysForTest,
  allRows,
  commitAll,
  listWarningConfigs,
  listRows,
  saveWarningDraft,
  publishWarning,
  adjustWarning,
  disableWarning,
  rejudgeAllOpen,
  activeConfigFor,
  evaluateLevel,
  validateThresholds,
  WATERLEVEL_KEY,
  INSPECTION_KEY,
} = mod

let passed = 0
let failed = 0
function check(name, condition, detail = '') {
  if (condition) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    console.error(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`)
  }
}

function water(id) {
  return listRows(WATERLEVEL_KEY).find((row) => Number(row.id) === id)
}
function todoFor(waterId) {
  return listRows(INSPECTION_KEY).find(
    (row) => String(row.待办来源) === '阈值判定' && Number(row.水位记录ID) === waterId && String(row.status) === '待巡检',
  )
}
function findConfig(code) {
  return listWarningConfigs().find((row) => String(row.配置编号) === code)
}
function updateRows(key, mutate) {
  commitAll({ ...allRows(), [key]: mutate(listRows(key).map((row) => ({ ...row }))) })
}

// 场景 0：纯函数口径 —— 蓝黄橙红冲突时取最高级别；阈值必须严格递增
console.log('场景0：统一冲突优先级')
{
  const t = { 蓝色: 10, 黄色: 12, 橙色: 14, 红色: 16 }
  check('15 → 橙色（同时越过蓝黄，取高级别）', evaluateLevel(15, t) === '橙色')
  check('16 → 红色（边界含等号）', evaluateLevel(16, t) === '红色')
  check('9.9 → 无级别', evaluateLevel(9.9, t) === null)
  check('非递增阈值校验失败', validateThresholds({ 蓝色阈值: 14, 黄色阈值: 14, 橙色阈值: 12, 红色阈值: 10 }) !== null)
  check('缺级阈值校验失败', validateThresholds({ 蓝色阈值: 10, 黄色阈值: '', 橙色阈值: 12, 红色阈值: 14 }) !== null)
}

// 场景 1：停用后旧级别立即失效，统计与待办一起回退
console.log('场景1：停用口径（旧级别不残留）')
__resetStoreForTest()
{
  check('初始 ST-01 生效配置为 WARN-0002@v2', activeConfigFor(listWarningConfigs(), 'ST-01', '水位')?.配置编号 === 'WARN-0002')
  check('初始 WATE-0002(27) 为红色', water(2).预警级别 === '红色')
  check('初始红色待办存在', Boolean(todoFor(2)))
  const before = listRows(INSPECTION_KEY).length
  const result = disableWarning(findConfig('WARN-0002').id)
  check('停用成功', result.ok, result.message)
  check('停用后无生效配置', activeConfigFor(listWarningConfigs(), 'ST-01', '水位') === null)
  check('停用后开放记录级别清空（旧级别不残留）', water(1).预警级别 === '' && water(2).预警级别 === '')
  check('停用后开放记录 abnormal 复位', water(1).abnormal === false && water(2).abnormal === false)
  check('停用后阈值待办撤回', !todoFor(1) && !todoFor(2))
  check('已处置的归档待办未被删除', listRows(INSPECTION_KEY).length === before - 2)
  check('停用动作已留档', listRows('warningAudit').some((row) => String(row.动作) === '停用配置' && String(row.配置编号) === 'WARN-0002'))
}

// 场景 2：反复发布只保留一个版本，不残留上一版阈值
console.log('场景2：版本残留 / 重复发布')
__resetStoreForTest()
{
  const activeBefore = activeConfigFor(listWarningConfigs(), 'ST-02', '水位')
  check('ST-02 初始只有 WARN-0004@v2 生效', activeBefore?.配置编号 === 'WARN-0004' && Number(activeBefore.版本号) === 2)
  check('旧版 WARN-0003 为已调整', findConfig('WARN-0003').status === '已调整')
  const adj = adjustWarning(findConfig('WARN-0004').id)
  check('调整生成草稿', adj.ok, adj.message)
  const pub = publishWarning(adj.draftId, adj.draftVersion - 1)
  check('v3 发布成功', pub.ok, pub.message)
  const activeAfter = activeConfigFor(listWarningConfigs(), 'ST-02', '水位')
  check('发布后生效的是 v3', Number(activeAfter.版本号) === 3)
  check('v2 被标记已调整', findConfig('WARN-0004').status === '已调整')
  check('全组在效配置只有一条', listWarningConfigs().filter((row) => String(row.站点编号) === 'ST-02' && row.status === '已生效').length === 1)
  check('29 在 v3 口径下仍为蓝色', water(4).预警级别 === '蓝色')

  // 抬高蓝色阈值到 29.5：旧版 28 的口径必须不再影响判定
  const adj2 = adjustWarning(Number(activeAfter.id))
  const draft2 = listWarningConfigs().find((row) => Number(row.id) === adj2.draftId)
  const save = saveWarningDraft({
    id: Number(draft2.id), 站点编号: 'ST-02', 监测类型: '水位',
    蓝色阈值: '29.5', 黄色阈值: '30', 橙色阈值: '32', 红色阈值: '34',
  })
  check('抬高蓝色阈值草稿保存成功', save.ok, save.message)
  const pub2 = publishWarning(Number(draft2.id), Number(draft2.版本号) - 1)
  check('v4 发布成功', pub2.ok, pub2.message)
  check('29 回落为无预警（上一版阈值不残留）', water(4).预警级别 === '', `实际=${water(4).预警级别}`)
  check('对应待巡检待办撤回', !todoFor(4))
  check('归档记录 WATE-0003 仍保留橙色/v1 结论', water(3).预警级别 === '橙色' && Number(water(3).触发配置版本号) === 1)
}

// 场景 3：并发发布只接受一个版本（旧基线被拒）
console.log('场景3：并发发布乐观锁')
__resetStoreForTest()
{
  // 两个面板都在组版本 v2 时打开，各自生成同版本草稿 v3 且都持基线 v2
  const a = adjustWarning(findConfig('WARN-0002').id)
  const b = adjustWarning(findConfig('WARN-0002').id)
  check('两份调整草稿都能生成', a.ok && b.ok)
  const pubA = publishWarning(a.draftId, 2)
  check('A 持打开时基线(v2)发布成功', pubA.ok, pubA.message)
  check('A 发布后生效版本为 v3', Number(activeConfigFor(listWarningConfigs(), 'ST-01', '水位').版本号) === 3)
  // B 的发布请求晚到：v3 已生效，它手里仍是基线 v2，必须整单拒绝
  const pubBStale = publishWarning(b.draftId, 2)
  check('B 持旧基线(v2)发布被拒', !pubBStale.ok && /版本/.test(pubBStale.message), pubBStale.message)
  check('被拒后生效版本仍是 v3', Number(activeConfigFor(listWarningConfigs(), 'ST-01', '水位').版本号) === 3)
  check('被拒发布未产生第二条在效配置', listWarningConfigs().filter((r) => String(r.站点编号) === 'ST-01' && r.status === '已生效').length === 1)
  // B 刷新面板：看到 v3 已生效，基于最新版本重新调整出 v4 再发布
  const refreshed = adjustWarning(activeConfigFor(listWarningConfigs(), 'ST-01', '水位').id)
  const pubBFresh = publishWarning(refreshed.draftId, 3)
  check('B 刷新基线(v3)后发布成功', pubBFresh.ok, pubBFresh.message)
  check('最终生效为 v5 且在效配置仍只有一条', Number(activeConfigFor(listWarningConfigs(), 'ST-01', '水位').版本号) === 5
    && listWarningConfigs().filter((r) => String(r.站点编号) === 'ST-01' && r.status === '已生效').length === 1)
}

// 场景 4：任一判定失败，配置、统计与待办一起回退
console.log('场景4：判定失败整体回退')
__resetStoreForTest()
{
  const configBefore = listWarningConfigs().map((r) => `${r.id}:${r.status}@v${r.版本号}`).join('|')
  const waterBefore = listRows(WATERLEVEL_KEY).map((r) => `${r.id}:${r.预警级别 ?? ''}`).join('|')
  const inspBefore = listRows(INSPECTION_KEY).map((r) => `${r.id}:${r.status}`).join('|')
  const auditsBefore = listRows('warningAudit').length

  const adj = adjustWarning(findConfig('WARN-0002').id)
  const draft = listWarningConfigs().find((r) => Number(r.id) === adj.draftId)
  // 把一条 ST-01 开放水位改成非数值，制造判定失败
  updateRows(WATERLEVEL_KEY, (rows) => rows.map((r) => (Number(r.id) === 2 ? { ...r, 当前水位: '设备离线' } : r)))

  const pub = publishWarning(Number(draft.id), Number(draft.版本号) - 1)
  check('发布因非数值水位失败', !pub.ok && /不是有效数值/.test(pub.message), pub.message)
  check('旧版 WARN-0002 仍是唯一在效配置', activeConfigFor(listWarningConfigs(), 'ST-01', '水位')?.配置编号 === 'WARN-0002')
  check('除新草稿外配置状态全部不变', listWarningConfigs()
    .filter((r) => Number(r.id) !== Number(draft.id))
    .map((r) => `${r.id}:${r.status}@v${r.版本号}`).join('|')
    === configBefore.split('|').filter((s) => !s.startsWith(`${draft.id}:`)).join('|'))
  check('草稿未被切换为生效', listWarningConfigs().find((r) => Number(r.id) === draft.id)?.status === '草稿')
  check('水位判定快照未被半成品改写', listRows(WATERLEVEL_KEY).map((r) => `${r.id}:${r.预警级别 ?? ''}`).join('|') === waterBefore)
  check('巡检待办回退', listRows(INSPECTION_KEY).map((r) => `${r.id}:${r.status}`).join('|') === inspBefore)
  check('失败发布不写留档', listRows('warningAudit').length === auditsBefore)
}

// 场景 5：无生效配置的站点不判定；全量重判不改归档
console.log('场景5：无配置站点 & 全量重判')
// 只重置数据模块：场景 4 之后的配置表不动（WARN-0002 仍在效），这里验证全量重判口径。
__resetKeysForTest([WATERLEVEL_KEY, INSPECTION_KEY, 'warningAudit'])
{
  check('ST-99(99) 无配置 → 无级别、无待办', water(5).预警级别 === '' && !todoFor(5))
  const result = rejudgeAllOpen()
  check('全量重判成功', result.ok, result.message)
  check('重判后 ST-99 仍无级别', water(5).预警级别 === '')
  check('重判后归档 WATE-0003 橙色/v1 不变', water(3).预警级别 === '橙色' && Number(water(3).触发配置版本号) === 1)
  check('重判后开放 WATE-0001 仍为黄色/v2', water(1).预警级别 === '黄色' && Number(water(1).触发配置版本号) === 2)
}

rmSync(join(root, 'scripts', '.verify-bundle.mjs'), { force: true })
console.log(`\n结果：${passed} 通过，${failed} 失败`)
process.exit(failed === 0 ? 0 : 1)
