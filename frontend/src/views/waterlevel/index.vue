<template>
  <section class="page" data-module="waterlevel">
    <header class="page-head">
      <div>
        <h2>水位监测管理</h2>
        <p class="page-desc">
          维护水位记录，异常判定统一走预警阈值领域：按站点唯一生效配置、红&gt;橙&gt;黄&gt;蓝取最高级；
          停用配置不参与，已归档记录沿用冻结结论。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" @click="exportRows">导出水位监测清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>预警级别（统一判定）</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] === '' || row[column] === undefined ? '—' : row[column] }}</td>
          <td>
            <span v-if="verdictOf(row).level" :class="['level-badge', `level-${verdictOf(row).level}`]">
              {{ verdictOf(row).level }}预警
            </span>
            <span v-else class="muted-text">正常</span>
            <span v-if="verdictOf(row).frozen" class="tag tag-frozen" title="归档时冻结，历史调阈值不重算">已冻结</span>
          </td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actionsFor(row)"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无水位监测数据</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条水位监测记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { listRows } from '@/data/store'
import {
  WARNING_MODULE,
  isArchived,
  judgeWaterRow,
  type WarningLevel,
  type WaterVerdict,
} from '@/data/warning'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('waterlevel')
const columns = ["记录编号", "站点编号", "观测时间", "当前水位", "警戒水位", "保证水位", "水位变幅", "记录状态"]
const statuses = ["已采集", "待审核", "已通过", "异常值", "已归档"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

const verdictCache = new Map<number, WaterVerdict>()

function verdicts(): Map<number, WaterVerdict> {
  const warningRows = listRows(WARNING_MODULE)
  const map = new Map<number, WaterVerdict>()
  for (const row of rows.value) map.set(row.id, judgeWaterRow(row, warningRows))
  return map
}

function verdictOf(row: EntryRow): WaterVerdict {
  return verdictCache.get(row.id) ?? { level: null, activeConfigId: null, frozen: false }
}

function levelCount(level: WarningLevel): number {
  let count = 0
  for (const row of rows.value) {
    if (verdictOf(row).level === level) count += 1
  }
  return count
}

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

// 统计与行内级别来自同一次判定，杜绝「列表显示异常、统计没算上」之类的口径偏差。
const stats = computed(() => {
  const abnormal = rows.value.filter((row) => verdictOf(row).level !== null).length
  const pending = rows.value.filter((row) => row.pending).length
  return [
    { label: '记录总数', value: rows.value.length },
    { label: '超警戒（黄及以上）', value: rows.value.filter((row) => {
      const level = verdictOf(row).level
      return level !== null && level !== '蓝色'
    }).length },
    { label: '红色预警', value: levelCount('红色') },
    { label: '异常记录数（含蓝）', value: abnormal },
    { label: '待处理记录', value: pending },
  ]
})

function actionsFor(row: EntryRow): string[] {
  if (isArchived(row)) return []
  const base = ["提交审核", "确认通过", "标记异常"]
  return String(row.status) === '已通过' ? [...base, "归档记录"] : base
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  const payload = listEntries(meta.key, filters.value)
  rows.value = payload.items
  total.value = payload.total
  verdictCache.clear()
  for (const [id, verdict] of verdicts()) verdictCache.set(id, verdict)
}

onMounted(reload)
</script>
