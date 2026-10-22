import type { Minutes, TimeSlot } from './types'

/*
 * 作息时间的编辑模型：每节只记开始时刻，下课 = 开始 + 标准时长；某节下课不同就单独记一个覆盖值。
 * 与 Semester.timeGrid 双向转换，timeGrid 仍是运行时唯一真相。
 *
 * 「一天怎么排」由 DayPlan 决定：段 = 一段连着上的课，段与段之间就是午休、晚饭。
 * 分 2 段是 上午 + 下午（中间午休），分 3 段再加 晚上（中间还夹一顿晚饭）。
 * 每段各自定「第 1 节开始」和「排几节」，所以午休、晚饭从几点到几点是用户说了算，
 * 程序只保证两件事：一段的课不排进下一段，段与段之间至少空 SEGMENT_BREAK 分钟。
 */

export const DEFAULT_DURATION = 45
export const DEFAULT_BREAK = 10
export const MIN_DURATION = 20
export const MAX_DURATION = 120
export const DURATION_STEP = 5

export interface ScheduleDraft {
  starts: Minutes[]
  duration: Minutes
  /** 与 starts 对齐；非 null 表示这节下课时刻单独改过 */
  ends: (Minutes | null)[]
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

/** 「1 小时 30 分」这种写法，课间与午休、晚饭都用它 */
export const spanText = (m: Minutes) => (m >= 60 ? `${Math.floor(m / 60)} 小时${m % 60 ? ` ${m % 60} 分` : ''}` : `${m} 分`)

/* ---------------- 逐节（Draft）：段内细调 ---------------- */

/** 出现次数最多的课长作为标准时长；平局取较短的 */
export function inferDuration(grid: TimeSlot[]): Minutes {
  const count = new Map<number, number>()
  for (const s of grid) {
    const d = s.end - s.start
    if (d > 0) count.set(d, (count.get(d) ?? 0) + 1)
  }
  let best = DEFAULT_DURATION
  let n = 0
  for (const [d, c] of [...count.entries()].sort((a, b) => a[0] - b[0])) {
    if (c > n) {
      best = d
      n = c
    }
  }
  return best
}

/** 段内的课间：出现次数最多的那段正间隔（超过 30 分钟算段界，不算课间） */
export function inferGap(grid: TimeSlot[]): Minutes {
  const slots = [...grid].sort((a, b) => a.index - b.index)
  const seen = new Map<number, number>()
  for (let i = 1; i < slots.length; i++) {
    const g = slots[i].start - slots[i - 1].end
    if (g > 0 && g <= 30) seen.set(g, (seen.get(g) ?? 0) + 1)
  }
  let best = DEFAULT_BREAK
  let n = 0
  for (const [g, c] of [...seen.entries()].sort((a, b) => a[0] - b[0])) {
    if (c > n) {
      best = g
      n = c
    }
  }
  return best
}

export function draftFromGrid(grid: TimeSlot[]): ScheduleDraft {
  const slots = [...grid].sort((a, b) => a.index - b.index)
  const duration = inferDuration(slots)
  return {
    starts: slots.map((s) => s.start),
    duration,
    ends: slots.map((s) => (s.end - s.start === duration ? null : s.end)),
  }
}

export function endOf(d: ScheduleDraft, i: number): Minutes {
  return d.ends[i] ?? d.starts[i] + d.duration
}

export function gridFromDraft(d: ScheduleDraft): TimeSlot[] {
  return d.starts.map((start, i) => ({ index: i + 1, start, end: endOf(d, i) }))
}

/** 改标准时长：没单独改过下课的节次自动跟着变；改过的保持不动 */
export function setDuration(d: ScheduleDraft, duration: Minutes): ScheduleDraft {
  duration = clamp(Math.round(duration / DURATION_STEP) * DURATION_STEP, MIN_DURATION, MAX_DURATION)
  if (duration === d.duration) return d
  /* 之前的覆盖值若恰好等于新时长，就不再算「单独改过」 */
  const ends = d.ends.map((e, i) => (e != null && e - d.starts[i] === duration ? null : e))
  return { ...d, duration, ends }
}

/**
 * 改某节开始。shiftLater 时之后的节次整体平移同样的分钟数（保持课间不变）；
 * 否则只动这一节，单独改过的下课时刻跟着平移，保证时长不变。
 */
export function setStart(d: ScheduleDraft, i: number, start: Minutes, shiftLater: boolean): ScheduleDraft {
  start = clamp(Math.round(start), 0, 24 * 60 - 1)
  const delta = start - d.starts[i]
  if (delta === 0) return d
  const starts = [...d.starts]
  const ends = [...d.ends]
  const last = shiftLater ? starts.length - 1 : i
  for (let k = i; k <= last; k++) {
    starts[k] = clamp(starts[k] + delta, 0, 24 * 60 - 1)
    if (ends[k] != null) ends[k] = clamp(ends[k]! + delta, starts[k] + 1, 24 * 60)
  }
  return { ...d, starts, ends }
}

/** 单独改某节下课；等于标准时长就回到自动 */
export function setEnd(d: ScheduleDraft, i: number, end: Minutes): ScheduleDraft {
  end = clamp(Math.round(end), d.starts[i] + 1, 24 * 60)
  const ends = [...d.ends]
  ends[i] = end - d.starts[i] === d.duration ? null : end
  return { ...d, ends }
}

export function resetEnd(d: ScheduleDraft, i: number): ScheduleDraft {
  if (d.ends[i] == null) return d
  const ends = [...d.ends]
  ends[i] = null
  return { ...d, ends }
}

/** 相邻节次的间隔；第 0 节为 0 */
export function breakBefore(d: ScheduleDraft, i: number): Minutes {
  return i === 0 ? 0 : d.starts[i] - endOf(d, i - 1)
}

/** 重叠 / 倒序的节次序号（从 0 起），用于标红 */
export function invalidPeriods(d: ScheduleDraft): number[] {
  const bad: number[] = []
  for (let i = 0; i < d.starts.length; i++) {
    if (endOf(d, i) <= d.starts[i]) bad.push(i)
    else if (i > 0 && d.starts[i] < endOf(d, i - 1)) bad.push(i)
  }
  return bad
}

/* ---------------- 一天分几段（DayPlan） ---------------- */

/** 段与段之间至少空这么久，才称得上「午休」「晚饭」 */
export const SEGMENT_BREAK = 60
/** 全天最晚结束时刻 */
export const DAY_END = 23 * 60
export const MIN_SEGMENTS = 2
export const MAX_SEGMENTS = 3

export type SegmentName = '上午' | '下午' | '晚上'

/** 段的先后顺序，分几段就取前几个 */
export const SEGMENT_NAMES: SegmentName[] = ['上午', '下午', '晚上']
/** 每段第 1 节的默认开始时刻 */
export const SEGMENT_STARTS: Minutes[] = [8 * 60, 14 * 60, 19 * 60]
/** 每段的默认节数：合计 10 节，与旧版「每天 10 节」生成的结果一模一样 */
export const SEGMENT_COUNTS = [4, 4, 2]
/** 段界两侧叫什么：上午→下午 是午休，下午→晚上 是晚饭 */
export const SEGMENT_BREAK_NAMES = ['午休', '晚饭']

export interface DaySegment {
  name: SegmentName
  /** 这一段的第 1 节开始时刻 */
  start: Minutes
  /** 这一段排几节 */
  count: number
}

export interface DayPlan {
  /** 每节多长 */
  duration: Minutes
  /** 段内相邻两节的间隔 */
  gap: Minutes
  segments: DaySegment[]
}

/** 段与段之间的空档 */
export interface DayBreak {
  name: string
  from: Minutes
  to: Minutes
  minutes: Minutes
}

export function defaultPlan(segmentCount: number = MAX_SEGMENTS, duration: Minutes = DEFAULT_DURATION, gap: Minutes = DEFAULT_BREAK): DayPlan {
  const n = clamp(Math.round(segmentCount), MIN_SEGMENTS, MAX_SEGMENTS)
  return {
    duration,
    gap,
    segments: SEGMENT_NAMES.slice(0, n).map((name, i) => ({ name, start: SEGMENT_STARTS[i], count: SEGMENT_COUNTS[i] })),
  }
}

/** 这一段实际排得出几节（用户填的节数还要受容量限制） */
export function segmentCountOf(plan: DayPlan, i: number): number {
  return Math.max(0, Math.min(plan.segments[i].count, segmentCapacity(plan, i)))
}

/** 这一段的最后一节下课；这一段没课就是它的起点 */
export function segmentEnd(plan: DayPlan, i: number): Minutes {
  const seg = plan.segments[i]
  const n = segmentCountOf(plan, i)
  return n === 0 ? seg.start : seg.start + (n - 1) * (plan.duration + plan.gap) + plan.duration
}

/** 这一段连排 count 节占多长（不含最后一个课间） */
function segmentSpan(plan: DayPlan, i: number): Minutes {
  const n = plan.segments[i].count
  return n === 0 ? plan.duration : n * (plan.duration + plan.gap) - plan.gap
}

/**
 * 这一段最多能排几节：不能排进下一段，且要给段之间留够 SEGMENT_BREAK 分钟；
 * 最后一段以 DAY_END 为限。
 */
export function segmentCapacity(plan: DayPlan, i: number): number {
  const seg = plan.segments[i]
  const next = plan.segments[i + 1]?.start
  const limit = next == null ? DAY_END : next - SEGMENT_BREAK
  if (limit - seg.start < plan.duration) return 0
  return Math.floor((limit - seg.start - plan.duration) / (plan.duration + plan.gap)) + 1
}

/** 按计划铺出整天的作息：一段一段来，每段按自己的节数排 */
export function buildGrid(plan: DayPlan): TimeSlot[] {
  const out: TimeSlot[] = []
  for (let i = 0; i < plan.segments.length; i++) {
    const seg = plan.segments[i]
    const n = segmentCountOf(plan, i)
    for (let k = 0; k < n; k++) {
      const start = seg.start + k * (plan.duration + plan.gap)
      out.push({ index: out.length + 1, start, end: Math.min(24 * 60, start + plan.duration) })
    }
  }
  return out
}

export function planTotal(plan: DayPlan): number {
  return plan.segments.reduce((n, _, i) => n + segmentCountOf(plan, i), 0)
}

/** 段与段之间的空档，就是午休、晚饭 */
export function planBreaks(plan: DayPlan): DayBreak[] {
  const out: DayBreak[] = []
  for (let i = 0; i + 1 < plan.segments.length; i++) {
    const from = segmentEnd(plan, i)
    const to = plan.segments[i + 1].start
    out.push({ name: SEGMENT_BREAK_NAMES[i] ?? '休息', from, to, minutes: to - from })
  }
  return out
}

/** 这份课表天然分成几段：间隔够 SEGMENT_BREAK 的算段界 */
export function naturalSegmentCount(grid: TimeSlot[]): number {
  const slots = [...grid].sort((a, b) => a.index - b.index)
  let n = 1
  for (let i = 1; i < slots.length; i++) if (slots[i].start - slots[i - 1].end >= SEGMENT_BREAK) n++
  return clamp(n, MIN_SEGMENTS, MAX_SEGMENTS)
}

/** 从现有课表反推计划：段界取相邻两节之间最长的几处间隔，段数由调用方说了算 */
export function planFromGrid(grid: TimeSlot[], segmentCount: number = MAX_SEGMENTS): DayPlan {
  const slots = [...grid].sort((a, b) => a.index - b.index)
  const want = clamp(Math.round(segmentCount), MIN_SEGMENTS, MAX_SEGMENTS)
  const duration = inferDuration(slots)
  if (slots.length === 0) return defaultPlan(want, duration)
  const cuts = new Set<number>()
  if (slots.length > 1) {
    const gaps: [number, number][] = []
    for (let i = 1; i < slots.length; i++) gaps.push([slots[i].start - slots[i - 1].end, i])
    gaps.sort((a, b) => b[0] - a[0] || a[1] - b[1])
    for (const [, at] of gaps.slice(0, Math.min(want, slots.length) - 1)) cuts.add(at)
  }
  const segments: DaySegment[] = []
  let from = 0
  for (let i = 1; i <= slots.length; i++) {
    if (i === slots.length || cuts.has(i)) {
      segments.push({
        name: SEGMENT_NAMES[segments.length] ?? SEGMENT_NAMES[SEGMENT_NAMES.length - 1],
        start: slots[from].start,
        count: i - from,
      })
      from = i
    }
  }
  return { duration, gap: inferGap(slots), segments }
}

/** 时长、段起点变动后，把各段节数收到装得下的范围内 */
function normalize(plan: DayPlan): DayPlan {
  return { ...plan, segments: plan.segments.map((s, i) => ({ ...s, count: clamp(s.count, 0, segmentCapacity(plan, i)) })) }
}

/** 段数：加一段就在后面接「晚上」，减一段就把最后一段去掉 */
export function planSetSegments(plan: DayPlan, count: number): DayPlan {
  const n = clamp(Math.round(count), MIN_SEGMENTS, MAX_SEGMENTS)
  if (n === plan.segments.length) return plan
  if (n < plan.segments.length) return normalize({ ...plan, segments: plan.segments.slice(0, n) })
  const lastEnd = segmentEnd(plan, plan.segments.length - 1)
  const at = plan.segments.length
  const start = clamp(Math.max(SEGMENT_STARTS[at], lastEnd + SEGMENT_BREAK), 0, DAY_END - plan.duration)
  return normalize({ ...plan, segments: [...plan.segments, { name: SEGMENT_NAMES[at], start, count: SEGMENT_COUNTS[at] ?? 2 }] })
}

/** 改某段的第 1 节开始：不能挤进上一段，也不能把自己的课挤出下一段的起点之前 */
export function planSetStart(plan: DayPlan, i: number, start: Minutes): DayPlan {
  const segments = plan.segments.map((s) => ({ ...s }))
  const min = i > 0 ? plan.segments[i - 1].start + segmentSpan(plan, i - 1) + SEGMENT_BREAK : 0
  const next = plan.segments[i + 1]?.start
  const limit = next == null ? DAY_END : next - SEGMENT_BREAK
  const max = limit - segmentSpan(plan, i)
  segments[i].start = clamp(Math.round(start), min, Math.max(min, max))
  return normalize({ ...plan, segments })
}

export function planSetCount(plan: DayPlan, i: number, count: number): DayPlan {
  const segments = plan.segments.map((s) => ({ ...s }))
  segments[i].count = clamp(Math.round(count), 0, segmentCapacity(plan, i))
  return { ...plan, segments }
}

export function planSetDuration(plan: DayPlan, duration: Minutes): DayPlan {
  const d = clamp(Math.round(duration / DURATION_STEP) * DURATION_STEP, MIN_DURATION, MAX_DURATION)
  return d === plan.duration ? plan : normalize({ ...plan, duration: d })
}

/** 把计划铺成逐节草稿；某一节的位置没变就保留它单独改过的下课时刻 */
export function applyPlan(draft: ScheduleDraft, plan: DayPlan): ScheduleDraft {
  const starts = buildGrid(plan).map((s) => s.start)
  const ends = starts.map((s, i) => {
    if (draft.starts[i] !== s) return null
    const e = draft.ends[i] ?? null
    return e != null && e - s === plan.duration ? null : e
  })
  return { duration: plan.duration, starts, ends }
}
