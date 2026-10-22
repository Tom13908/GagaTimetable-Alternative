import { describe, expect, it } from 'vitest'
import type { Course, Semester, SessionRule } from '../types'
import type { Snapshot } from '../engine'
import { weeksToMask } from '../weeks'
import { planCoursesForIcs } from '../calendar-plan'
import { buildIcs } from '../ics'
import { parseIcs } from '../importers/ics'

/* 备份恢复路径：导出 → 导入必须还原成一模一样的课表。
   这组用真实作息（45 分钟一节、课间 10 分钟），并且专门压调课、单双周换教室、座机号。 */

const sem: Semester = {
  id: 's1', name: '2026 秋季', startDate: '2026-08-31', totalWeeks: 16,
  timeGrid: [
    { index: 1, start: 480, end: 525 }, { index: 2, start: 535, end: 580 },
    { index: 3, start: 600, end: 645 }, { index: 4, start: 655, end: 700 },
    { index: 5, start: 840, end: 885 }, { index: 6, start: 895, end: 940 },
    { index: 7, start: 960, end: 1005 }, { index: 8, start: 1015, end: 1060 },
  ],
  vacations: [], holidays: false, examWeeks: [],
}

const mk = (id: string, name: string, color: string, teacher?: string, phone?: string): Course =>
  ({ id, semesterId: 's1', name, teacher, teacherPhone: phone, color, identityKey: id, hidden: false, source: 'import' })

const rule = (id: string, courseId: string, weekday: number, sp: number, ep: number, weeks: number[], location: string): SessionRule =>
  ({ id, courseId, weekday: weekday as SessionRule['weekday'], startPeriod: sp, endPeriod: ep, weeksMask: weeksToMask(weeks), location })

const snap: Snapshot = {
  semester: sem,
  courses: [
    mk('c1', '高等数学', '#4FA3A1', '王立群', '13800138000'),
    mk('c2', '移动应用开发', '#D98E5A'),
    mk('c3', '形式与政策', '#6C8EBF', '李四'),
  ],
  rules: [
    rule('r1', 'c1', 1, 1, 2, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16], '教三 302'),
    rule('r2', 'c2', 3, 3, 4, [1, 3, 5, 7, 9, 11, 13, 15], '信息楼A座 501'),
    rule('r4', 'c2', 3, 3, 4, [2, 4, 6, 8, 10, 12, 14, 16], '信息楼B座 203'),
    rule('r3', 'c3', 5, 5, 6, [1, 2, 4, 5, 6, 7, 8], '综合楼, 2-101'),
  ],
  overrides: [
    { id: 'o2', ruleId: 'r3', date: '2026-09-25', kind: 'moved', newDate: '2026-09-26', newStartPeriod: 3, newEndPeriod: 4, newLocation: '综合楼, 3-205', createdAt: 0 },
  ],
  entries: [],
}

const exportText = (s: Snapshot) => buildIcs(planCoursesForIcs(s), {
  name: s.semester.name,
  semester: { name: s.semester.name, startDate: s.semester.startDate, totalWeeks: s.semester.totalWeeks, timeGrid: s.semester.timeGrid },
  colors: new Map(s.courses.map((c) => [c.id, c.color])),
  now: new Date('2026-09-01T12:00:00'),
})

describe('ICS 备份恢复', () => {
  it('课名、教师、电话、地点、节次、周次、颜色全部还原', () => {
    const out = parseIcs(exportText(snap), sem)
    expect(out.diagnostics).toEqual([])
    const byName = Object.fromEntries(out.courses.map((c) => [`${c.name}@${c.weekday}-${c.startPeriod}`, c]))
    expect(byName['高等数学@1-1']).toMatchObject({
      teacher: '王立群', teacherPhone: '13800138000', location: '教三 302',
      startPeriod: 1, endPeriod: 2, weeks: '1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16', color: '#4FA3A1',
    })
    expect(byName['形式与政策@5-5']).toMatchObject({ teacher: '李四', location: '综合楼, 2-101', startPeriod: 5, endPeriod: 6, weeks: '1,2,5,6,7,8' })
  })

  /* 回归：调课事件导出后标题带「（调课）」，导入曾把它当成课名，备份恢复会多出一门课 */
  it('调课的那一次不带「（调课）」后缀，落在调整后的时间', () => {
    const out = parseIcs(exportText(snap), sem)
    expect(out.courses.map((c) => c.name)).not.toContain('形式与政策（调课）')
    expect(out.courses.find((c) => c.weekday === 6)).toMatchObject({
      name: '形式与政策', location: '综合楼, 3-205', startPeriod: 3, endPeriod: 4, weeks: '4',
    })
  })

  /* 回归：同一门课单双周在不同教室，合并成一条会让地点只剩第一个 */
  it('单双周换教室分成两条，各自周次与地点正确', () => {
    const out = parseIcs(exportText(snap), sem)
    const odd = out.courses.find((c) => c.location === '信息楼A座 501')
    const even = out.courses.find((c) => c.location === '信息楼B座 203')
    expect(odd?.weeks).toBe('1,3,5,7,9,11,13,15')
    expect(even?.weeks).toBe('2,4,6,8,10,12,14,16')
  })

  /* 回归：座机号原来认不出来，那一行会被当成教师名，号码反而丢了 */
  it('座机号与折行、转义字符都能还原', () => {
    const name = '数据结构与算法（双语）· 实验课，含逗号;分号\\反斜杠·超长课名测试'
    const hard: Snapshot = {
      ...snap,
      courses: [mk('c9', name, '#4FA3A1', '张三;李四', '010-12345678')],
      rules: [rule('r9', 'c9', 2, 7, 8, [3, 4, 5], '教三, 302;A\\B')],
      overrides: [],
    }
    const out = parseIcs(exportText(hard), sem)
    expect(out.courses).toHaveLength(1)
    expect(out.courses[0]).toMatchObject({ name, location: '教三, 302;A\\B', teacher: '张三;李四', teacherPhone: '01012345678', weeks: '3,4,5' })
  })
})
