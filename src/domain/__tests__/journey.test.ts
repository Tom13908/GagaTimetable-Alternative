import { describe, expect, it, vi, afterEach } from 'vitest'
import type { Course, Semester, SessionRule } from '../types'
import { weeksToMask } from '../weeks'
import { occurrencesOn } from '../engine'
import { Store, emptyState, hydrate, localStoragePersistence, memoryPersistence, restoreState, serializeState } from '../store'
import { buildAxis } from '../time-axis'

/* 真实使用里会撞到的坑：本地数据半坏、删课、清空节次、跨年学期。
   这些都不该让 App 打不开或整份课表消失。 */

const sem = (over: Partial<Semester> = {}): Semester => ({
  id: 's1', name: '2026 秋季', startDate: '2026-08-31', totalWeeks: 16,
  timeGrid: [
    { index: 1, start: 480, end: 525 }, { index: 2, start: 535, end: 580 },
    { index: 3, start: 600, end: 645 }, { index: 4, start: 655, end: 700 },
  ],
  vacations: [], holidays: false, examWeeks: [], ...over,
})

const course = (id: string, name: string): Course =>
  ({ id, semesterId: 's1', name, color: '#4FA3A1', identityKey: `${name}|`, hidden: false, source: 'manual' })

const rule = (id: string, courseId: string, weeks: number[]): SessionRule =>
  ({ id, courseId, weekday: 1, startPeriod: 1, endPeriod: 2, weeksMask: weeksToMask(weeks), location: '教三 302' })

afterEach(() => vi.unstubAllGlobals())

describe('本地数据半坏时不许整份丢', () => {
  it('一条规则的 weeksMask 坏了：只丢这条规则，学期和课程都还在', () => {
    const raw = serializeState({
      ...emptyState(), semester: sem(), courses: [course('c1', '高等数学')],
      rules: [rule('r1', 'c1', [1, 2]), { id: 'r2', courseId: 'c1', weekday: 3, startPeriod: 3, endPeriod: 4, weeksMask: 'abc' as unknown as bigint }],
    })
    const s = restoreState(raw)
    expect(s.semester?.name).toBe('2026 秋季')
    expect(s.courses).toHaveLength(1)
    expect(s.rules).toHaveLength(1)
    expect(s.rules[0].weeksMask).toBe(weeksToMask([1, 2]))
  })

  it('rules / courses 是 null 或缺失：当成空数组，不抛', () => {
    const raw = JSON.stringify({ ...emptyState(), semester: sem(), rules: null, courses: null, overrides: undefined })
    const s = restoreState(raw)
    expect(s.rules).toEqual([])
    expect(s.courses).toEqual([])
    expect(s.overrides).toEqual([])
  })

  it('学期缺 timeGrid：视为没有学期（进引导页），课程数据仍在 state 里', () => {
    const raw = JSON.stringify({ ...emptyState(), semester: { id: 's1', name: '坏学期' }, courses: [course('c1', '高数')] })
    const s = restoreState(raw)
    expect(s.semester).toBeNull()
    expect(s.courses).toHaveLength(1)
  })

  it('localStorage 里是坏 JSON：返回 null，但把原文另存一份，别让下一次保存覆盖掉', () => {
    const box = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => box.get(k) ?? null,
      setItem: (k: string, v: string) => void box.set(k, v),
    })
    box.set('timetable.v1', '{ 这不是 JSON')
    expect(localStoragePersistence.load()).toBeNull()
    const corrupt = [...box.keys()].filter((k) => k.startsWith('timetable.v1.corrupt.'))
    expect(corrupt).toHaveLength(1)
    expect(box.get(corrupt[0])).toBe('{ 这不是 JSON')
  })

  it('hydrate 对已经合法的数据不做多余改动', () => {
    const st = { ...emptyState(), semester: sem(), courses: [course('c1', '高数')], rules: [rule('r1', 'c1', [1, 2, 3])] }
    const s = hydrate(JSON.parse(JSON.stringify(st, (_, v) => (typeof v === 'bigint' ? v.toString() : v))))
    expect(s.rules).toHaveLength(1)
    expect(s.rules[0].weeksMask).toBe(weeksToMask([1, 2, 3]))
  })
})

describe('删除课程 / 清空节次', () => {
  it('删课带走它的规则和那几条单次调整', () => {
    const st = new Store(memoryPersistence())
    st.setSemester(sem())
    st.state = {
      ...st.state,
      courses: [course('c1', '高数'), course('c2', '英语')],
      rules: [rule('r1', 'c1', [1, 2]), rule('r2', 'c2', [1, 2])],
      overrides: [
        { id: 'o1', ruleId: 'r1', date: '2026-09-07', kind: 'cancelled', createdAt: 0 },
        { id: 'o2', ruleId: 'r2', date: '2026-09-07', kind: 'leave', createdAt: 0 },
      ],
    }
    st.purgeCourse('c1')
    expect(st.state.courses.map((c) => c.id)).toEqual(['c2'])
    expect(st.state.rules.map((r) => r.id)).toEqual(['r2'])
    expect(st.state.overrides.map((o) => o.id)).toEqual(['o2'])
  })

  it('节次全清空（timeGrid 为空）时展开不炸、画轴也不炸', () => {
    const s = sem({ timeGrid: [] })
    const snap = { semester: s, courses: [course('c1', '高数')], rules: [rule('r1', 'c1', [1])], overrides: [], entries: [] }
    expect(() => occurrencesOn(snap, '2026-08-31')).not.toThrow()
    expect(() => buildAxis([], undefined, new Map(), 0)).not.toThrow()
  })

  it('规则指向已不存在的课程：跳过，不抛', () => {
    const snap = { semester: sem(), courses: [] as Course[], rules: [rule('r1', 'ghost', [1])], overrides: [], entries: [] }
    expect(occurrencesOn(snap, '2026-08-31')).toEqual([])
  })
})

describe('学期切换与跨年', () => {
  it('12 月开学的学期，次年 1 月的课仍按周次算对', () => {
    const s = sem({ startDate: '2026-12-14', totalWeeks: 16 })
    const snap = { semester: s, courses: [course('c1', '高数')], rules: [{ ...rule('r1', 'c1', [1, 4]), weekday: 1 as const }], overrides: [], entries: [] }
    expect(occurrencesOn(snap, '2026-12-14')).toHaveLength(1) // 第 1 周周一
    expect(occurrencesOn(snap, '2027-01-04')).toHaveLength(1) // 第 4 周周一
    expect(occurrencesOn(snap, '2027-01-11')).toHaveLength(0) // 第 5 周，不在掩码里
  })

  it('开始新学期：旧学期连课带单次调整一起进归档，新学期的课表是空的', () => {
    const st = new Store(memoryPersistence())
    st.setSemester(sem())
    st.state = {
      ...st.state,
      courses: [course('c1', '高数')],
      rules: [rule('r1', 'c1', [1, 2])],
      overrides: [{ id: 'o1', ruleId: 'r1', date: '2026-09-07', kind: 'cancelled', createdAt: 0 }],
      entries: [{ id: 'e1', semesterId: 's1', name: '班会', kind: 'temp', weekday: 5, startPeriod: 3, endPeriod: 4, createdAt: 0 }],
    }
    st.startSemester(sem({ id: 's2', name: '2027 春', startDate: '2027-02-22' }))
    expect(st.state.courses).toEqual([])
    expect(st.state.rules).toEqual([])
    expect(st.state.overrides).toEqual([])
    expect(st.state.entries).toEqual([])
    expect(st.state.archives).toHaveLength(1)
    expect(st.state.archives[0].courses).toHaveLength(1)
    expect(st.state.archives[0].overrides).toHaveLength(1)
  })
})
