import type {
  Course, ImportBatch, Override, Semester, SessionRule, UserEntry, ChangeEntry, Task, TaskPhoto, Prefs, WidgetStyle,
} from './types'
import { WIDGET_STYLES, defaultPrefs } from './types'
import type { Snapshot } from './engine'
import type { NormalizedCourse, ImportDiff } from './importer'
import { diffImport, matchImport, pairRules } from './importer'
import { BUILTIN_RULES, type RuleManifest } from './rules'

/* 本地权威存储。真相全部在内存 State，持久化通过 Persistence 适配器：
   Web 用 localStorage，Capacitor 换 SQLite 适配器，接口不变。 */

/** 往期学期：整份快照原样封存，只用于查看与导出 */
export interface SemesterArchive extends Snapshot {
  archivedAt: number
}

/** 持久化结构版本，`hydrate` 按它做一次性迁移 */
export const STATE_VERSION = 2

export interface State {
  version?: number
  semester: Semester | null
  archives: SemesterArchive[]
  courses: Course[]
  rules: SessionRule[]
  overrides: Override[]
  entries: UserEntry[]
  batches: ImportBatch[]
  changes: ChangeEntry[]
  userEditedCourseIds: string[]
  savedRules: RuleManifest[]
  tasks: Task[]
  prefs: Prefs
}

export function emptyState(): State {
  return {
    version: STATE_VERSION,
    semester: null, archives: [], courses: [], rules: [], overrides: [], entries: [],
    batches: [], changes: [], userEditedCourseIds: [], savedRules: [...BUILTIN_RULES], tasks: [],
    prefs: defaultPrefs(),
  }
}

/** 只保留当前 Prefs 有的字段；旧版本的本地通知偏好（静音时段、每日摘要等）在这里丢掉 */
function hydratePrefs(raw: unknown): Prefs {
  const d = defaultPrefs()
  const p = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const nums = (v: unknown, fallback: number[]) => (Array.isArray(v) && v.every((x) => typeof x === 'number') ? (v as number[]) : fallback)
  const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback)
  return {
    classRemind: bool(p.classRemind, d.classRemind),
    taskRemind: bool(p.taskRemind, d.taskRemind),
    classLead: typeof p.classLead === 'number' && p.classLead > 0 ? p.classLead : d.classLead,
    earlyLead: typeof p.earlyLead === 'number' ? p.earlyLead : d.earlyLead,
    taskLeads: nums(p.taskLeads, d.taskLeads),
    examDays: nums(p.examDays, d.examDays),
    widgetStyle: (WIDGET_STYLES as readonly string[]).includes(p.widgetStyle as string) ? (p.widgetStyle as WidgetStyle) : d.widgetStyle,
    name: typeof p.name === 'string' ? p.name : d.name,
    avatar: typeof p.avatar === 'string' ? p.avatar : d.avatar,
    wall: typeof p.wall === 'string' ? p.wall : d.wall,
  }
}

/** 读回时的兜底：持久化里的数组字段缺了/不是数组，一律当空数组，别让一处损坏带走整份数据 */
const asArray = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : [])

/** weeksMask 读回：历史上有字符串、数字；都不是就返回 null，交给调用方丢掉这一条 */
function maskOf(v: unknown): bigint | null {
  if (typeof v === 'bigint') return v
  if (typeof v === 'number' && Number.isFinite(v)) return BigInt(Math.trunc(v))
  if (typeof v === 'string' && /^\d+$/.test(v)) return BigInt(v)
  return null
}

/** 从持久化读回的原始对象补齐类型：周次位掩码转 bigint，新字段补默认值。
    **这里的容错是数据安全的一部分**：任何一处抛异常，调用方（load）会整份丢弃，
    用户看到的就是课表全没了。所以字段缺失按空处理、坏规则单条丢弃、坏学期视为没有学期。 */
export function hydrate(s: State): State {
  s.rules = asArray<SessionRule>(s.rules).filter((r) => {
    const m = r ? maskOf(r.weeksMask) : null
    if (m == null) return false
    r.weeksMask = m
    return true
  })
  s.courses = asArray<Course>(s.courses).filter((c) => !!c && typeof c.id === 'string')
  s.overrides = asArray<Override>(s.overrides).filter((o) => !!o && typeof o.ruleId === 'string')
  s.entries = asArray<UserEntry>(s.entries).filter((e) => !!e && typeof e.id === 'string')
  s.batches = asArray(s.batches)
  s.changes = asArray(s.changes)
  s.userEditedCourseIds = Array.isArray(s.userEditedCourseIds) ? s.userEditedCourseIds.filter((x) => typeof x === 'string') : []
  s.archives = asArray<SemesterArchive>(s.archives).filter((a) => !!a?.semester)
  for (const a of s.archives) {
    a.rules = asArray<SessionRule>(a.rules).filter((r) => {
      const m = r ? maskOf(r.weeksMask) : null
      if (m == null) return false
      r.weeksMask = m
      return true
    })
    a.courses = asArray<Course>(a.courses)
    a.overrides = asArray<Override>(a.overrides)
    a.entries = asArray<UserEntry>(a.entries)
  }
  if (!s.savedRules || !Array.isArray(s.savedRules) || s.savedRules.length === 0) s.savedRules = [...BUILTIN_RULES]
  s.tasks = asArray<Task>(s.tasks).filter((t) => !!t && typeof t.id === 'string')
  for (const t of s.tasks) if (!Array.isArray(t.photos)) t.photos = []
  s.prefs = hydratePrefs(s.prefs)
  /* 学期缺 timeGrid / startDate 的，后面的排课和画轴都会崩，直接当没有学期（进引导页，数据还在） */
  if (s.semester && (!Array.isArray(s.semester.timeGrid) || typeof s.semester.startDate !== 'string')) s.semester = null
  if ((s.version ?? 1) < 2) {
    // v1 身份键带 星期|起始节，去掉后才能和新导入对上
    const strip = (c: Course) => { c.identityKey = c.identityKey.replace(/\|\d+\|\d+$/, '') }
    s.courses.forEach(strip)
    for (const a of s.archives) a.courses.forEach(strip)
  }
  const dropOrphans = (snap: Pick<Snapshot, 'rules' | 'overrides'>) => {
    const ruleIds = new Set(snap.rules.map((r) => r.id))
    snap.overrides = snap.overrides.filter((o) => ruleIds.has(o.ruleId))
  }
  dropOrphans(s)
  s.archives.forEach(dropOrphans)
  s.version = STATE_VERSION
  return s
}

export interface Persistence {
  load(): State | null
  save(s: State): void
}

export const serializeState = (s: State): string => JSON.stringify(s, (_, v) => (typeof v === 'bigint' ? v.toString() : v))

/** 读回并迁移。结构版本升级时先把迁移前的原文交给 backup 留底，迁移出错还能找回 */
export function restoreState(raw: string, backup?: (json: string, fromVersion: number) => void): State {
  const parsed = JSON.parse(raw) as State
  const v = parsed.version ?? 1
  if (v < STATE_VERSION) backup?.(raw, v)
  return hydrate(parsed)
}

const KEY = 'timetable.v1'

export const localStoragePersistence: Persistence = {
  load() {
    let raw: string | null = null
    try {
      raw = localStorage.getItem(KEY)
    } catch {
      return null // 隐私模式 / 存储被禁：连读都读不到，只能从空开始
    }
    if (!raw) return null
    try {
      return restoreState(raw, (json, v) => localStorage.setItem(`${KEY}.bak.v${v}`, json))
    } catch {
      /* 解析失败：先把原文另存一份。否则下一次 save 就会用空状态把这份仅存的数据覆盖掉，
         用户连事后抢救的机会都没有。 */
      try {
        localStorage.setItem(`${KEY}.corrupt.${Date.now()}`, raw)
      } catch {
        /* 存不下就只能放弃备份 */
      }
      return null
    }
  },
  save(s) {
    try {
      localStorage.setItem(KEY, serializeState(s))
    } catch {
      /* 配额满或被禁：吞掉异常，别让未捕获的 rejection 把整页带崩；内存里的状态仍然是对的 */
    }
  },
}

export const memoryPersistence = (): Persistence => {
  let mem: string | null = null
  return {
    load: () => (mem ? restoreState(mem) : null),
    save: (s) => {
      mem = serializeState(s)
    },
  }
}

let seq = 0
export const uid = () => `${Date.now().toString(36)}${(seq++).toString(36)}`

export class Store {
  state: State
  private listeners = new Set<() => void>()
  private saveQueued = false

  constructor(private persistence: Persistence) {
    this.state = persistence.load() ?? emptyState()
  }

  subscribe(fn: () => void) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /** 内存优先更新 + 微任务合批持久化（借鉴 lexicon SyncEngine） */
  private commit() {
    for (const fn of this.listeners) fn()
    if (this.saveQueued) return
    this.saveQueued = true
    queueMicrotask(() => {
      this.saveQueued = false
      this.persistence.save(this.state)
    })
  }

  snapshot(): Snapshot | null {
    const s = this.state
    if (!s.semester) return null
    return { semester: s.semester, courses: s.courses, rules: s.rules, overrides: s.overrides, entries: s.entries }
  }

  /** 整份数据清空，回到刚安装的状态 */
  reset() {
    this.state = emptyState()
    this.commit()
  }

  setSemester(sem: Semester) {
    this.state = { ...this.state, semester: sem }
    this.commit()
  }

  /** 开始新学期：当前学期连课程一起封存进往期，课表清空；作息、待办、规则与偏好保留 */
  startSemester(next: Semester) {
    const cur = this.snapshot()
    const archives = cur && (cur.courses.length > 0 || cur.entries.length > 0)
      ? [...this.state.archives.filter((a) => a.semester.id !== cur.semester.id), { ...cur, archivedAt: Date.now() }]
      : this.state.archives
    this.state = {
      ...this.state,
      semester: next,
      archives,
      courses: [], rules: [], overrides: [], entries: [], changes: [], userEditedCourseIds: [],
    }
    this.commit()
  }

  removeArchive(semesterId: string) {
    this.state = { ...this.state, archives: this.state.archives.filter((a) => a.semester.id !== semesterId) }
    this.commit()
  }

  addOverride(ov: Override) {
    this.state = { ...this.state, overrides: [...this.state.overrides.filter((o) => !(o.ruleId === ov.ruleId && o.date === ov.date)), ov] }
    this.commit()
  }

  removeOverride(ruleId: string, date: string) {
    this.state = { ...this.state, overrides: this.state.overrides.filter((o) => !(o.ruleId === ruleId && o.date === date)) }
    this.commit()
  }

  addEntry(en: UserEntry) {
    this.state = { ...this.state, entries: [...this.state.entries, en] }
    this.commit()
  }

  removeEntry(id: string) {
    this.state = { ...this.state, entries: this.state.entries.filter((e) => e.id !== id) }
    this.commit()
  }

  /** 改常规安排（每周生效），记一条变更 */
  editSessionRule(ruleId: string, patch: Partial<Pick<SessionRule, 'weekday' | 'startPeriod' | 'endPeriod' | 'location' | 'teacher'>>) {
    const before = this.state.rules.find((r) => r.id === ruleId)
    if (!before) return
    const changes: ChangeEntry[] = Object.entries(patch)
      .filter(([k, v]) => before[k as keyof SessionRule] !== v)
      .map(([k, v]) => ({
        id: uid(), at: Date.now(), actor: 'user', target: ruleId, field: k,
        from: String(before[k as keyof SessionRule] ?? ''), to: String(v ?? ''),
      }))
    this.state = {
      ...this.state,
      rules: this.state.rules.map((r) => (r.id === ruleId ? { ...r, ...patch } : r)),
      changes: [...this.state.changes, ...changes],
      userEditedCourseIds: [...new Set([...this.state.userEditedCourseIds, before.courseId])],
    }
    this.commit()
  }

  setPrefs(patch: Partial<Prefs>) {
    this.state = { ...this.state, prefs: { ...this.state.prefs, ...patch } }
    this.commit()
  }

  addTask(t: Task) {
    this.state = { ...this.state, tasks: [...this.state.tasks, t] }
    this.commit()
  }

  editTask(id: string, patch: Partial<Task>) {
    this.state = { ...this.state, tasks: this.state.tasks.map((t) => (t.id === id ? { ...t, ...patch } : t)) }
    this.commit()
  }

  removeTask(id: string) {
    this.state = { ...this.state, tasks: this.state.tasks.filter((t) => t.id !== id) }
    this.commit()
  }

  addPhotos(taskId: string, photos: TaskPhoto[]) {
    this.editTask(taskId, {
      photos: [...(this.state.tasks.find((t) => t.id === taskId)?.photos ?? []), ...photos],
    })
  }

  removePhoto(taskId: string, photoId: string) {
    const t = this.state.tasks.find((x) => x.id === taskId)
    if (!t) return
    this.editTask(taskId, { photos: (t.photos ?? []).filter((p) => p.id !== photoId) })
  }

  setCourseHidden(courseId: string, hidden: boolean) {
    this.state = {
      ...this.state,
      courses: this.state.courses.map((c) => (c.id === courseId ? { ...c, hidden } : c)),
    }
    this.commit()
  }

  setCourseSticker(courseId: string, sticker: string | undefined) {
    this.state = {
      ...this.state,
      courses: this.state.courses.map((c) => {
        if (c.id !== courseId) return c
        const { sticker: _, ...rest } = c
        return sticker === undefined ? rest : { ...rest, sticker }
      }),
    }
    this.commit()
  }

  editCourse(courseId: string, patch: Partial<Pick<Course, 'name' | 'teacher' | 'teacherPhone' | 'color' | 'credit' | 'category'>>) {
    const before = this.state.courses.find((c) => c.id === courseId)
    if (!before) return
    const changes: ChangeEntry[] = Object.entries(patch)
      .filter(([k, v]) => before[k as keyof Course] !== v)
      .map(([k, v]) => ({
        id: uid(), at: Date.now(), actor: 'user', target: courseId, field: k,
        from: String(before[k as keyof Course] ?? ''), to: String(v ?? ''),
      }))
    this.state = {
      ...this.state,
      courses: this.state.courses.map((c) => (c.id === courseId ? { ...c, ...patch } : c)),
      changes: [...this.state.changes, ...changes],
      userEditedCourseIds: [...new Set([...this.state.userEditedCourseIds, courseId])],
    }
    this.commit()
  }

  saveRule(rule: RuleManifest) {
    const exists = this.state.savedRules.some((r) => r.id === rule.id)
    this.state = {
      ...this.state,
      savedRules: exists
        ? this.state.savedRules.map((r) => (r.id === rule.id ? rule : r))
        : [...this.state.savedRules, rule],
    }
    this.commit()
  }

  removeRule(id: string) {
    if (id.startsWith('builtin-')) return
    this.state = { ...this.state, savedRules: this.state.savedRules.filter((r) => r.id !== id) }
    this.commit()
  }

  restoreCourse(courseId: string) {
    this.state = {
      ...this.state,
      courses: this.state.courses.map((c) => (c.id === courseId ? { ...c, removedByImport: false, hidden: false } : c)),
    }
    this.commit()
  }

  purgeCourse(courseId: string) {
    this.state = {
      ...this.state,
      courses: this.state.courses.filter((c) => c.id !== courseId),
      rules: this.state.rules.filter((r) => r.courseId !== courseId),
      overrides: this.state.overrides.filter((o) => this.state.rules.find((r) => r.id === o.ruleId)?.courseId !== courseId),
    }
    this.commit()
  }

  previewImport(incoming: NormalizedCourse[]): ImportDiff {
    return diffImport(this.state.courses, incoming, new Set(this.state.userEditedCourseIds), this.state.rules)
  }

  /** 事务式导入：全部计算完成后一次性替换状态。三方合并：
      - 用户改过的课保留用户字段，只更新排课规则
      - 规则尽量沿用旧 id（同星期同节次优先），挂在上面的 Override 和变更记录继续有效；
        没有接班规则的 Override 随课次一起去掉
      - 本次消失的标 removedByImport，不物理删除，规则和 Override 保留
      - UserEntry 永不触碰 */
  applyImport(incoming: NormalizedCourse[], batch: Omit<ImportBatch, 'added' | 'updated' | 'removed'>): ImportDiff {
    const diff = this.previewImport(incoming)
    const edited = new Set(this.state.userEditedCourseIds)
    const matched = matchImport(this.state.courses, incoming)
    const kept = new Set(matched.values())
    const importIds = new Set(this.state.courses.filter((c) => c.source === 'import').map((c) => c.id))

    const courses: Course[] = this.state.courses.filter((c) => c.source !== 'import')
    const rules: SessionRule[] = this.state.rules.filter((r) => !importIds.has(r.courseId))
    const liveRuleIds = new Set(rules.map((r) => r.id))
    let updated = 0

    for (const nc of incoming) {
      const ex = matched.get(nc)
      let course: Course
      let oldRules: SessionRule[] = []
      if (ex) {
        course = edited.has(ex.id)
          ? { ...ex, teacherPhone: ex.teacherPhone ?? nc.course.teacherPhone, removedByImport: false } // 保留用户值
          : { ...ex, ...nc.course, id: ex.id, semesterId: ex.semesterId, removedByImport: false }
        oldRules = this.state.rules.filter((r) => r.courseId === ex.id)
        updated++
      } else {
        course = { ...nc.course, id: uid(), semesterId: this.state.semester?.id ?? '' }
      }
      courses.push(course)
      const pairs = pairRules(oldRules, nc.rules)
      for (const r of nc.rules) {
        const id = pairs.get(r)?.id ?? uid()
        rules.push({ ...r, id, courseId: course.id })
        liveRuleIds.add(id)
      }
    }
    // 消失的：课、规则、Override 原样保留以便恢复
    for (const c of this.state.courses) {
      if (c.source !== 'import' || kept.has(c)) continue
      courses.push({ ...c, removedByImport: true, hidden: true })
      for (const r of this.state.rules) {
        if (r.courseId !== c.id) continue
        rules.push(r)
        liveRuleIds.add(r.id)
      }
    }
    const overrides = this.state.overrides.filter((o) => liveRuleIds.has(o.ruleId))

    const fullBatch: ImportBatch = {
      ...batch, added: diff.added.length, updated, removed: diff.removed.length,
    }
    this.state = { ...this.state, courses, rules, overrides, batches: [...this.state.batches, fullBatch] }
    this.commit()
    return diff
  }

  /** 回滚到某次导入前：删除该批次引入的课程与规则的最简实现——
      依赖批次时间戳之后 source=import 的内容整体重放。P0 先支持回滚最近一次。 */
  rollbackLastImport(prev: State) {
    this.state = prev
    this.commit()
  }

  cloneState(): State {
    return JSON.parse(JSON.stringify(this.state, (_, v) => (typeof v === 'bigint' ? v.toString() : v)), (k, v) =>
      k === 'weeksMask' ? BigInt(v) : v) as State
  }
}
