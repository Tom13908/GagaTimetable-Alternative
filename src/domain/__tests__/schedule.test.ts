import { describe, expect, it } from 'vitest'
import type { TimeSlot } from '../types'
import {
  DAY_END, SEGMENT_BREAK, applyPlan, breakBefore, buildGrid, defaultPlan, draftFromGrid,
  gridFromDraft, inferDuration, invalidPeriods, naturalSegmentCount, planBreaks, planFromGrid,
  planSetCount, planSetDuration, planSetSegments, planSetStart, planTotal, resetEnd, segmentCapacity,
  segmentEnd, setDuration, setEnd, setStart, type DayPlan,
} from '../schedule'

/** 节次不重叠、不越 23:00 */
const inOrder = (grid: { start: number; end: number }[]) =>
  grid.every((s, i) => s.end <= DAY_END && (i === 0 || s.start >= grid[i - 1].end))

/** 段与段之间确实留出了午休 / 晚饭 */
const keepsBreaks = (plan: DayPlan) =>
  plan.segments.every((_, i) => i === 0 || segmentEnd(plan, i - 1) + SEGMENT_BREAK <= plan.segments[i].start)

const grid: TimeSlot[] = [480, 535, 600, 655, 840, 895, 960, 1015, 1140, 1195].map((s, i) => ({ index: i + 1, start: s, end: s + 45 }))

describe('draft <-> grid', () => {
  it('标准时长取众数，不同时长的节记为覆盖', () => {
    const g = [...grid, { index: 11, start: 1250, end: 1285 }]
    expect(inferDuration(g)).toBe(45)
    const d = draftFromGrid(g)
    expect(d.duration).toBe(45)
    expect(d.ends.slice(0, 10).every((e) => e == null)).toBe(true)
    expect(d.ends[10]).toBe(1285)
    expect(gridFromDraft(d)).toEqual(g)
  })

  it('乱序 index 也按序号排', () => {
    const d = draftFromGrid([...grid].reverse())
    expect(d.starts[0]).toBe(480)
  })
})

describe('setDuration', () => {
  it('自动的下课跟着变，单独改过的不动；覆盖值恰等于新时长就回自动', () => {
    let d = draftFromGrid(grid)
    d = setEnd(d, 0, 480 + 50)
    d = setDuration(d, 40)
    expect(gridFromDraft(d)[1].end).toBe(535 + 40)
    expect(gridFromDraft(d)[0].end).toBe(530)
    d = setDuration(d, 50)
    expect(d.ends[0]).toBeNull()
    expect(setDuration(d, 7).duration).toBe(20)
  })
})

describe('setStart', () => {
  it('只动这一节 / 之后一起平移', () => {
    const d = draftFromGrid(grid)
    const one = setStart(d, 4, 870, false)
    expect(one.starts[4]).toBe(870)
    expect(one.starts[5]).toBe(895)
    const all = setStart(d, 4, 870, true)
    expect(all.starts.slice(4)).toEqual([870, 925, 990, 1045, 1170, 1225])
    expect(all.starts.slice(0, 4)).toEqual(d.starts.slice(0, 4))
  })

  it('平移时覆盖的下课也一起走', () => {
    let d = draftFromGrid(grid)
    d = setEnd(d, 5, 895 + 60)
    d = setStart(d, 4, 850, true)
    expect(d.ends[5]).toBe(905 + 60)
  })
})

describe('setEnd / resetEnd / breaks / invalid', () => {
  it('单独改下课与恢复', () => {
    let d = draftFromGrid(grid)
    d = setEnd(d, 2, 650)
    expect(d.ends[2]).toBe(650)
    expect(breakBefore(d, 3)).toBe(5)
    expect(breakBefore(d, 0)).toBe(0)
    d = resetEnd(d, 2)
    expect(d.ends[2]).toBeNull()
    expect(setEnd(d, 2, 645).ends[2]).toBeNull()
    expect(setEnd(d, 2, 590).ends[2]).toBe(601)
  })

  it('重叠 / 倒序标出', () => {
    let d = draftFromGrid(grid)
    expect(invalidPeriods(d)).toEqual([])
    d = setStart(d, 1, 500, false)
    expect(invalidPeriods(d)).toEqual([1])
  })
})

describe('defaultPlan / buildGrid', () => {
  it('默认 3 段 10 节：上午 4 / 下午 4 / 晚上 2', () => {
    const plan = defaultPlan()
    expect(plan.segments.map((s) => [s.name, s.start, s.count])).toEqual([['上午', 480, 4], ['下午', 840, 4], ['晚上', 1140, 2]])
    expect(buildGrid(plan).map((s) => s.start)).toEqual([480, 535, 590, 645, 840, 895, 950, 1005, 1140, 1195])
    expect(planTotal(plan)).toBe(10)
    expect(inOrder(buildGrid(plan))).toBe(true)
    expect(keepsBreaks(plan)).toBe(true)
  })

  it('午休与晚饭就是段之间的空档', () => {
    expect(planBreaks(defaultPlan()).map((b) => [b.name, b.from, b.to, b.minutes])).toEqual([
      ['午休', 690, 840, 150],
      ['晚饭', 1050, 1140, 90],
    ])
  })

  it('分 2 段就没有晚饭，加回第 3 段又回到默认', () => {
    const two = planSetSegments(defaultPlan(), 2)
    expect(two.segments.map((s) => s.name)).toEqual(['上午', '下午'])
    expect(planBreaks(two)).toHaveLength(1)
    const twoGrid = buildGrid(two)
    expect(twoGrid[twoGrid.length - 1].start).toBe(1005)
    const three = planSetSegments(two, 3)
    expect(three.segments.map((s) => [s.name, s.start, s.count])).toEqual([['上午', 480, 4], ['下午', 840, 4], ['晚上', 1140, 2]])
  })
})

describe('每段能排几节', () => {
  it('由下一段的起点决定，多排的会被截回去，午休晚饭仍然留够', () => {
    const plan = defaultPlan()
    expect([0, 1, 2].map((i) => segmentCapacity(plan, i))).toEqual([5, 4, 4])
    const many = planSetCount(plan, 0, 20)
    expect(many.segments[0].count).toBe(5)
    expect(segmentEnd(many, 0)).toBe(745)
    const g = buildGrid(many)
    expect(inOrder(g)).toBe(true)
    expect(keepsBreaks(many)).toBe(true)
    /* 午休里没有课 */
    expect(g.every((s) => s.end <= 745 || s.start >= many.segments[1].start)).toBe(true)
  })

  it('每节时长变长，装不下的段自动收缩', () => {
    const plan = planSetDuration(defaultPlan(), 120)
    expect(plan.segments.map((s) => s.count)).toEqual([2, 1, 1])
    expect(inOrder(buildGrid(plan))).toBe(true)
    expect(keepsBreaks(plan)).toBe(true)
  })

  it('各段起点挪不出边界：不能挤进上一段，也不能把自己挤出下一段', () => {
    const plan = defaultPlan()
    /* 上午 4 节 08:00 起、占 3 小时 30 分，最晚只能挪到 09:30 */
    expect(planSetStart(plan, 0, 800).segments[0].start).toBe(570)
    /* 下午最早 12:30：上午 11:30 下课 + 1 小时午休 */
    expect(planSetStart(plan, 1, 600).segments[1].start).toBe(750)
    /* 晚上最早 17:30 下课 + 1 小时 */
    expect(planSetStart(plan, 2, 840).segments[2].start).toBe(1050 + 60)
  })
})

describe('planFromGrid / naturalSegmentCount', () => {
  it('段界落在那两处长间隔上，重铺时按统一课间展开', () => {
    const plan = planFromGrid(grid)
    expect(plan.segments.map((s) => [s.name, s.start, s.count])).toEqual([['上午', 480, 4], ['下午', 840, 4], ['晚上', 1140, 2]])
    expect(plan.duration).toBe(45)
    expect(plan.gap).toBe(10)
    const built = buildGrid(plan)
    expect(built.map((s) => s.start)).toEqual([480, 535, 590, 645, 840, 895, 950, 1005, 1140, 1195])
    expect(inOrder(built)).toBe(true)
    expect(keepsBreaks(plan)).toBe(true)
  })

  it('连着排的一天只算一段，段数下限 2、上限 3', () => {
    const compact: TimeSlot[] = [480, 535, 590, 645].map((s, i) => ({ index: i + 1, start: s, end: s + 45 }))
    expect(naturalSegmentCount(compact)).toBe(2)
    expect(naturalSegmentCount(grid)).toBe(3)
  })

  it('applyPlan：位置没变的节次保留单独改过的下课', () => {
    let d = draftFromGrid(grid)
    d = setEnd(d, 5, 895 + 30)
    const next = applyPlan(d, defaultPlan())
    expect(next.starts).toEqual(buildGrid(defaultPlan()).map((s) => s.start))
    expect(next.ends[5]).toBe(925)
    expect(next.ends[0]).toBeNull()
  })
})

describe('各种时长与段数都不重叠、都不占午休晚饭', () => {
  for (const duration of [20, 30, 45, 60, 90, 120]) {
    for (const segs of [2, 3]) {
      it(`${segs} 段 · 每节 ${duration} 分`, () => {
        const plan = planSetDuration(planSetSegments(defaultPlan(), segs), duration)
        const g = buildGrid(plan)
        expect(inOrder(g)).toBe(true)
        expect(keepsBreaks(plan)).toBe(true)
        expect(g).toHaveLength(planTotal(plan))
      })
    }
  }
})
