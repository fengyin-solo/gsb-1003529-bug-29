<template>
  <section class="page" data-module="warning">
    <header class="page-head">
      <div>
        <h2>预警阈值管理</h2>
        <p class="page-desc">
          维护蓝黄橙红四级阈值。统一口径：仅「已生效」参与判定，冲突按 红&gt;橙&gt;黄&gt;蓝 取最高级；
          停用即彻底失效，发布在同一事务内联动水位判定与巡检待办，任一失败整体回退。
        </p>
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
      <button class="btn ghost" type="button" @click="exportRows">导出阈值清单</button>
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
          <td v-for="column in columns" :key="column">{{ formatCell(row, column) }}</td>
          <td>
            {{ row.status }}
            <span v-if="activeKeyOf(row) && row.status === '已生效'" class="tag tag-active">判定中</span>
          </td>
          <td class="row-actions">
            <button
              v-for="action in actionsFor(row)"
              :key="action"
              class="link"
              :class="{ danger: action === '停用配置' }"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无预警阈值配置，可先在已生效配置上「调整阈值」生成草稿</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条预警阈值记录</span>
      <span v-if="noticeMessage" class="ok-text">{{ noticeMessage }}</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <!-- 阈值配置面板：与列表、水位判定、巡检入口共用同一份比较规则（evaluateLevel） -->
    <div v-if="panelOpen && form" class="modal-mask" @click.self="closePanel">
      <div class="modal">
        <h3 class="modal-title">阈值配置面板 · {{ form.sourceId === null ? '新草稿' : `来源 ${panelSourceCode}` }}</h3>
        <div class="form-grid">
          <label class="form-item">
            <span>站点编号</span>
            <input v-model="form.站点编号" :disabled="form.sourceId !== null" placeholder="如 ST01" />
          </label>
          <label class="form-item">
            <span>监测类型</span>
            <input v-model="form.监测类型" :disabled="form.sourceId !== null" placeholder="如 水位" />
          </label>
          <label v-for="level in thresholdLevels" :key="level" class="form-item">
            <span>{{ level }}阈值（需严格递增）</span>
            <input v-model="form[thresholdField(level)]" inputmode="decimal" :placeholder="`达到 ${level} 预警的水位`" />
          </label>
        </div>
        <p class="panel-hint">
          面板预览（与水位异常判定同口径）：输入试算水位
          <input v-model="previewValue" class="inline-input" inputmode="decimal" placeholder="如 31.2" />
          → 判定结果
          <strong :class="previewLevel ? `level-${previewLevel}` : 'level-normal'">
            {{ previewLevel ? `${previewLevel}预警` : '正常 / 无预警' }}
          </strong>
        </p>
        <ul v-if="panelIssues.length" class="issue-list">
          <li v-for="(issue, index) in panelIssues" :key="index" class="error-text">{{ issue }}</li>
        </ul>
        <div class="modal-actions">
          <button class="btn" type="button" @click="closePanel">取消</button>
          <button class="btn primary" type="button" :disabled="saving" @click="savePanel">
            {{ saving ? '保存中…' : '保存草稿' }}
          </button>
        </div>
      </div>
    </div>

    <!-- 审计留档：发布/停用/回退/归档判定结论都可追溯 -->
    <section class="audit-block">
      <h3 class="block-title">阈值发布与判定留档（最近 {{ auditRows.length }} 条）</h3>
      <table class="data-table">
        <thead>
          <tr>
            <th>时间</th><th>动作</th><th>配置</th><th>站点/类型</th><th>版本</th><th>结果</th><th>说明</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="entry in auditRows" :key="entry.id">
            <td>{{ formatTime(entry.time) }}</td>
            <td>{{ entry.action }}</td>
            <td>{{ entry.configCode }}</td>
            <td>{{ entry.stationCode }} / {{ entry.monitorType }}</td>
            <td>{{ entry.version === null ? '—' : `v${entry.version}` }}</td>
            <td :class="entry.result === '成功' ? 'ok-text' : 'error-text'">{{ entry.result }}</td>
            <td class="audit-detail">{{ entry.detail }}</td>
          </tr>
        </tbody>
      </table>
      <p class="page-desc">
        历史调阈值口径（已留档）：已归档水位记录不重算，冻结归档时级别；未归档记录在每次发布时按新版本统一重判。
      </p>
    </section>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
} from '@/api/local-service'
import {
  disableConfig,
  listWarningAudit,
  publishConfig,
  saveAdjustment,
  thresholdDraft,
  type ThresholdDraft,
} from '@/api/warning-service'
import type { AuditEntry } from '@/data/store'
import {
  THRESHOLD_FIELDS,
  WARNING_LEVELS,
  WARNING_STATUS,
  evaluateLevel,
  validateThresholds,
  type WarningLevel,
} from '@/data/warning'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('warning')
const columns = ["配置编号", "站点编号", "监测类型", "蓝色阈值", "黄色阈值", "橙色阈值", "红色阈值", "版本号", "最近发布时间", "生效状态"]
const filterFields = columns.slice(0, 3)
const thresholdLevels = WARNING_LEVELS

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const noticeMessage = ref('')
const filters = ref<Record<string, string>>({})
const auditRows = ref<AuditEntry[]>([])

const statusSummary = computed(() =>
  (["草稿", "已生效", "已调整", "已停用"] as string[]).map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

// 统计直接从同一批数据实时计算，列表、看板、状态图使用一致口径。
const stats = computed(() => [
  { label: '配置总数', value: rows.value.length },
  { label: '已生效数（参与判定）', value: rows.value.filter((row) => String(row.status) === WARNING_STATUS.active).length },
  {
    label: '本月调整数（已被新版取代）',
    value: rows.value.filter((row) => {
      if (String(row.status) !== WARNING_STATUS.adjusted) return false
      return String(row['最近发布时间'] ?? '').startsWith(currentMonth())
    }).length,
  },
])

function currentMonth(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

function activeKeyOf(row: EntryRow): string {
  return `${String(row['站点编号'] ?? '')}::${String(row['监测类型'] ?? '')}`
}

function actionsFor(row: EntryRow): string[] {
  const status = String(row.status)
  if (status === WARNING_STATUS.draft) return ['发布生效', '调整阈值']
  if (status === WARNING_STATUS.active) return ['调整阈值', '停用配置']
  if (status === WARNING_STATUS.adjusted) return ['调整阈值']
  if (status === WARNING_STATUS.disabled) return ['调整阈值（重新编制）']
  return []
}

function formatCell(row: EntryRow, column: string): string {
  if (column === '版本号') {
    const v = row['版本号']
    return v === undefined || v === '' || v === null ? '草稿' : `v${v}`
  }
  if (column === '最近发布时间') return String(row[column] ?? '') ? formatTime(String(row[column])) : '—'
  return String(row[column] ?? '—')
}

function formatTime(token: string): string {
  if (!token) return ''
  const date = new Date(token)
  if (Number.isNaN(date.getTime())) return token
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function thresholdField(level: WarningLevel): (typeof THRESHOLD_FIELDS)[number] {
  return THRESHOLD_FIELDS[WARNING_LEVELS.indexOf(level)]
}

// ---- 配置面板 ----

type PanelForm = ThresholdDraft & { sourceId: number | null }

const panelOpen = ref(false)
const saving = ref(false)
const panelSourceCode = ref('')
const form = ref<PanelForm | null>(null)
const previewValue = ref('')

function openPanel(source: EntryRow | null) {
  errorMessage.value = ''
  noticeMessage.value = ''
  if (source) {
    panelSourceCode.value = String(source['配置编号'] ?? source.id)
    form.value = { ...thresholdDraft(source), sourceId: source.id }
  } else {
    panelSourceCode.value = ''
    form.value = {
      id: 0,
      sourceId: null,
      站点编号: '',
      监测类型: '水位',
      蓝色阈值: '',
      黄色阈值: '',
      橙色阈值: '',
      红色阈值: '',
    }
  }
  previewValue.value = ''
  panelOpen.value = true
}

function closePanel() {
  panelOpen.value = false
  form.value = null
}

const panelIssues = computed<string[]>(() => {
  if (!form.value) return []
  const issues = validateThresholds({
    蓝色阈值: form.value.蓝色阈值,
    黄色阈值: form.value.黄色阈值,
    橙色阈值: form.value.橙色阈值,
    红色阈值: form.value.红色阈值,
  })
  if (form.value.sourceId === null && (form.value.站点编号.trim() === '' || form.value.监测类型.trim() === '')) {
    issues.unshift({ field: '站点编号', message: '站点编号与监测类型不能为空' })
  }
  return issues.map((item) => item.message)
})

const previewLevel = computed<WarningLevel | null>(() => {
  if (!form.value) return null
  const value = Number(previewValue.value)
  if (previewValue.value.trim() === '' || !Number.isFinite(value)) return null
  return evaluateLevel(value, {
    蓝色: parsePanel('蓝色阈值'),
    黄色: parsePanel('黄色阈值'),
    橙色: parsePanel('橙色阈值'),
    红色: parsePanel('红色阈值'),
  })
})

function parsePanel(field: keyof ThresholdDraft): number | undefined {
  const raw = String(form.value?.[field] ?? '').trim()
  if (raw === '') return undefined
  const value = Number(raw)
  return Number.isFinite(value) ? value : undefined
}

function savePanel() {
  if (!form.value) return
  saving.value = true
  try {
    const result = saveAdjustment(form.value)
    if (!result.ok) {
      errorMessage.value = result.message
      return
    }
    noticeMessage.value = result.message
    closePanel()
    reload()
  } finally {
    saving.value = false
  }
}

// ---- 行动作 ----

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  noticeMessage.value = ''
  if (action === '调整阈值' || action === '调整阈值（重新编制）') {
    openPanel(row)
    return
  }
  let result
  if (action === '发布生效') {
    result = publishConfig(Number(row.id))
  } else if (action === '停用配置') {
    if (!window.confirm(`确认停用配置 ${row['配置编号']}？停用后旧级别立即失效，该站点未关闭的联动巡检待办将一并回收。`)) {
      return
    }
    result = disableConfig(Number(row.id))
  } else {
    return
  }
  if (!result.ok) {
    errorMessage.value = result.message
  } else {
    noticeMessage.value = result.message
  }
  reload()
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function reload() {
  const payload = listEntries(meta.key, filters.value)
  rows.value = payload.items
  total.value = payload.total
  auditRows.value = listWarningAudit(20)
}

onMounted(reload)
</script>
