<template>
  <section class="page" data-module="warning">
    <header class="page-head">
      <div>
        <h2>预警阈值管理</h2>
        <p class="page-desc">统一维护蓝/黄/橙/红四级阈值：仅「已生效」且版本号最新的配置参与水位异常判定，停用即时摘除，发布在一个事务内重判并同步巡检待办。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记预警阈值配置</button>
        <button class="btn" type="button" @click="exportRows">导出预警阈值清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in statCards" :key="item.label" class="stat-card">
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
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>
            {{ row.status }}
            <span v-if="isActive(row)" class="legend-item">判定生效中</span>
          </td>
          <td class="row-actions">
            <button
              v-for="action in availableActions(row)"
              :key="action"
              class="link"
              type="button"
              @click="runRowAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无预警阈值数据，可先登记预警阈值配置</td>
        </tr>
      </tbody>
    </table>

    <h3 class="section-title">阈值发布与停用留档</h3>
    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in auditColumns" :key="column">{{ column }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in auditRows" :key="String(row.id)">
          <td v-for="column in auditColumns" :key="column">{{ row[column] ?? '—' }}</td>
        </tr>
        <tr v-if="!auditRows.length">
          <td :colspan="auditColumns.length" class="empty-state">暂无发布/停用留档</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条配置记录（含历史版本）；口径：蓝 &lt; 黄 &lt; 橙 &lt; 红，判定取达到阈值的最高级别</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <div v-if="panel.open" class="panel-mask" @click.self="closePanel">
      <form class="config-panel" @submit.prevent="submitPanel(true)">
        <h3 class="section-title">{{ panel.id === null ? '登记预警阈值配置（草稿）' : '编辑阈值草稿' }}</h3>
        <p class="panel-hint">
          草稿不参与判定；发布时若配置组已被其他发布推进到新版本，会整单拒绝。
          <template v-if="panel.groupRevision > 0">当前组版本基线：v{{ panel.groupRevision }}</template>
        </p>
        <label class="panel-field">
          <span>站点编号</span>
          <input v-model="panel.站点编号" :disabled="panel.id !== null" placeholder="如 ST-01" />
        </label>
        <label class="panel-field">
          <span>监测类型</span>
          <input v-model="panel.监测类型" :disabled="panel.id !== null" placeholder="如 水位" />
        </label>
        <label v-for="field in thresholdFields" :key="field" class="panel-field">
          <span>{{ field }}</span>
          <input v-model="panel[field]" inputmode="decimal" :placeholder="`填写${field}`" />
        </label>
        <p v-if="panelError" class="error-text">{{ panelError }}</p>
        <div class="panel-actions">
          <button class="btn" type="button" @click="closePanel">取消</button>
          <button class="btn" type="button" @click="submitPanel(false)">保存草稿</button>
          <button class="btn primary" type="submit">发布生效</button>
        </div>
      </form>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import { downloadEntries, listEntries } from '@/api/local-service'
import { listRows } from '@/data/local-store'
import {
  adjustWarning,
  AUDIT_KEY,
  availableActions,
  disableWarning,
  publishWarning,
  publishedRevision,
  saveWarningDraft,
  warningStats,
  WARNING_KEY,
} from '@/data/warning-chain'
import type { ActionResult, EntryRow } from '@/data/types'

const columns = ["配置编号", "站点编号", "监测类型", "蓝色阈值", "黄色阈值", "橙色阈值", "红色阈值", "版本号", "生效时间", "停用时间", "生效状态"]
const auditColumns = ["时间", "动作", "配置编号", "站点编号", "监测类型", "版本号", "替代版本", "重判记录数", "预警记录数", "阈值待办数", "结果"]
const statuses = ["草稿", "已生效", "已调整", "已停用"]
const thresholdFields = ["蓝色阈值", "黄色阈值", "橙色阈值", "红色阈值"] as const

const rows = ref<EntryRow[]>([])
const auditRows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = ["配置编号", "站点编号", "监测类型"]

type PanelState = {
  open: boolean
  id: number | null
  groupRevision: number
  站点编号: string
  监测类型: string
  蓝色阈值: string
  黄色阈值: string
  橙色阈值: string
  红色阈值: string
}

const panel = reactive<PanelState>({
  open: false,
  id: null,
  groupRevision: 0,
  站点编号: '',
  监测类型: '水位',
  蓝色阈值: '',
  黄色阈值: '',
  橙色阈值: '',
  红色阈值: '',
})
const panelError = ref('')

const statCards = computed(() => {
  const stats = warningStats()
  return [
    { label: '配置组总数', value: stats.groupCount },
    { label: '生效配置', value: stats.activeCount },
    { label: '停用配置', value: stats.disabledCount },
    { label: '待发布草稿', value: stats.draftCount },
    { label: '本月调整版本', value: stats.monthAdjustCount },
  ]
})

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function isActive(row: EntryRow): boolean {
  return String(row.status) === '已生效'
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(WARNING_KEY)
}

function openPanelFor(row?: EntryRow) {
  panelError.value = ''
  if (row) {
    panel.open = true
    panel.id = Number(row.id)
    panel.groupRevision = publishedRevision(listRows(WARNING_KEY), `${String(row.站点编号)}||${String(row.监测类型)}`)
    panel.站点编号 = String(row.站点编号 ?? '')
    panel.监测类型 = String(row.监测类型 ?? '')
    panel.蓝色阈值 = String(row.蓝色阈值 ?? '')
    panel.黄色阈值 = String(row.黄色阈值 ?? '')
    panel.橙色阈值 = String(row.橙色阈值 ?? '')
    panel.红色阈值 = String(row.红色阈值 ?? '')
    return
  }
  panel.open = true
  panel.id = null
  panel.groupRevision = 0
  panel.站点编号 = ''
  panel.监测类型 = '水位'
  panel.蓝色阈值 = ''
  panel.黄色阈值 = ''
  panel.橙色阈值 = ''
  panel.红色阈值 = ''
}

function openCreate() {
  openPanelFor()
}

function closePanel() {
  panel.open = false
  panelError.value = ''
}

function submitPanel(publish: boolean) {
  panelError.value = ''
  const saved = saveWarningDraft({
    id: panel.id,
    站点编号: panel.站点编号,
    监测类型: panel.监测类型,
    蓝色阈值: panel.蓝色阈值,
    黄色阈值: panel.黄色阈值,
    橙色阈值: panel.橙色阈值,
    红色阈值: panel.红色阈值,
  })
  if (!saved.ok) {
    panelError.value = saved.message
    return
  }
  // 保存后拿到刚写回的草稿行（新建时 id 由数据层分配）。
  reload()
  if (!publish) {
    errorMessage.value = saved.message
    closePanel()
    return
  }
  const group = `${panel.站点编号.trim()}||${panel.监测类型.trim()}`
  const draft = listRows(WARNING_KEY)
    .filter((row) => `${String(row.站点编号)}||${String(row.监测类型)}` === group && String(row.status) === '草稿')
    .sort((a, b) => Number(b.版本号) - Number(a.版本号))[0]
  if (!draft) {
    panelError.value = '草稿保存后未找到可发布版本'
    return
  }
  // 发布基线用面板打开时的已发布版本；并发发布把它推高后这里会被拒绝（整单不生效）。
  const result = publishWarning(Number(draft.id), panel.groupRevision || null)
  if (!result.ok) {
    panelError.value = result.message
    return
  }
  closePanel()
  errorMessage.value = result.message
  reload()
}

function runRowAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  let result: ActionResult & { draftId?: number }
  if (action === '发布生效') {
    result = publishWarning(Number(row.id), null)
  } else if (action === '调整阈值') {
    result = adjustWarning(Number(row.id))
    if (result.ok && result.draftId) {
      const draft = listRows(WARNING_KEY).find((item) => Number(item.id) === result.draftId)
      if (draft) {
        openPanelFor(draft)
      }
    }
  } else if (action === '调整阈值(编辑)') {
    openPanelFor(row)
    return
  } else if (action === '停用配置') {
    result = disableWarning(Number(row.id))
  } else {
    result = { ok: false, message: `未登记动作「${action}」` }
  }
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  errorMessage.value = result.message
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(WARNING_KEY, filters.value)
    // 配置列表按配置组、版本倒序展示，在效新版永远排在本组最前。
    rows.value = [...payload.items].sort((a, b) => {
      const ga = `${String(a.站点编号)}||${String(a.监测类型)}`
      const gb = `${String(b.站点编号)}||${String(b.监测类型)}`
      if (ga !== gb) {
        return ga < gb ? -1 : 1
      }
      return Number(b.版本号) - Number(a.版本号)
    })
    total.value = payload.total
    auditRows.value = [...listRows(AUDIT_KEY)].sort(
      (a, b) => String(b.时间).localeCompare(String(a.时间)),
    )
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '预警阈值列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.section-title { font-size: 15px; margin: 18px 0 8px; }
.panel-mask {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 20;
}
.config-panel {
  width: 460px;
  max-width: calc(100vw - 32px);
  background: #fff;
  border-radius: 10px;
  padding: 18px 20px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.panel-hint { margin: 0; font-size: 12px; color: var(--muted); }
.panel-field { display: flex; flex-direction: column; gap: 4px; font-size: 13px; }
.panel-field input { border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px; }
.panel-field input:disabled { background: #f1f5f9; color: var(--muted); }
.panel-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 6px; }
</style>
