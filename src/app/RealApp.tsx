import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, animate, motion, useMotionValue, useTransform } from 'motion/react'
import { flushSync } from 'react-dom'
import { App as CapApp } from '@capacitor/app'
import type { Course, Occurrence, Semester, SessionRule, Task, OverrideKind, WidgetStyle } from '../domain/types'
import { addDays, diffDays, fmtDuration, fmtMinutes, inVacation, weekOf, weekdayOf, dateOf } from '../domain/dates'
import { holidaysBetween } from '../domain/holidays'
import { maskHasWeek, maskToWeeks } from '../domain/weeks'
import { firstClassDate, occurrencesOn, occurrencesInWeek, type Snapshot } from '../domain/engine'
import { diffImport, normalize } from '../domain/importer'
import type { NormalizedCourse, RuleOutput } from '../domain/importer'
import { runRule, type RuleManifest, type RuleInputKind, DEFAULT_CSV_MAPPING } from '../domain/rules'
import { fetchUrl } from '../domain/importers/url'
import { AI_IMPORT_PROMPT } from '../domain/ai-prompt'
import { ScanPage } from './scan'
import { uid, type SemesterArchive, type Store, type State } from '../domain/store'
import { store, useStore } from './store'
import { defaultSemester, extendGrid, guessSemesterName, isDefaultGrid, mondayOf, nowMinutes, semesterEnded, termEnd, todayStr } from './semester'
import Onboarding, { currentWeek } from './Onboarding'
import {
  ChangePage, ConflictPage, CourseDetailPage, CourseEditPage, EditSessionPage,
  ManualAddPage,
} from './pages'
import { CameraPage, ClassEndCard, ComposeOverlay, PickerPage, ReviewPage, TaskDetailPage, TodoView, cameraLeave, dueText, KIND_LABEL as TASK_KIND_LABEL } from './todo'
import { camera, loadPhotoSrc, nativeCamera, photoSrc, rememberPhoto, type CapturedPhoto } from './camera'
import { justEndedClass } from '../domain/next-class'
import { stickerOfOcc } from '../domain/stickers'
import { CARD_INSET, buildAxis, rowHeights } from '../domain/time-axis'
import { WeekAxis, WeekCard, WeekLines } from './week-axis'
import { SchedulePage } from './schedule'
import { EDU_RULE, EduBrowserPage, EduFailPage, EduSchoolPage, PreviewGrid, eduBack, type EduFailInfo } from './edu'
import { EduAutoPage } from './edu-auto'
import { edu } from './edu-browser'
import { enableEduSync, outcomeText, resumeSync, setEduSyncEnabled, syncOnLaunch, useEduSync, type EduSyncSource } from './edu-sync'
import type { School } from '../domain/edu/schools'
import { detectSystem } from '../domain/edu/systems'
import { Sticker, setStickersOn, useStickersOn } from './Sticker'
import { CalendarIntroPage, PrefPickPage, RemindGroup, WidgetPage, remindEnabled, type PrefKey } from './reminder'
import { calendarPermission, calendarSupported, clearCalendar, scheduleCalendarSync, syncCalendar } from './calendar'
import { copyText, haptic, nativeConfirm, nativeToast, pasteText, syncWidgets } from './widgets'
import { onIncomingIcs, saveIcs, shareIcs } from './files'
import { THEME_LABEL, resolve, setDynamic, setTheme, useDynamic, useTheme, type ThemePref } from './theme'
import {
  ActionSheet, BackPill, BottomVeil, Chips, EmptyBlock, closeTopSheet, Field, FADE, ICON, Loader, Nav, Page, PopHead, PopItem, Popover, PrimaryButton, Row, SHEET, SLIDE, SPRING, Sheet, SheetClose, SheetHead, StickyHead, TopVeil, useVeilOpacity,
  TextAction, TextInput, TopBar, WD, WD_SHORT, md, tint, type Ghost, type Rect,
  DateInput, Switch,
} from './ui'

/* ---------------- 壳 ---------------- */

function Shell({ children, tab, onTab, navHidden }: { children: React.ReactNode; tab: number; onTab: (i: number) => void; navHidden?: boolean }) {
  return (
    <div data-shell className="shell-w relative flex h-dvh flex-col overflow-hidden bg-(--c-bg) font-sans text-(--c-ink)">
      {children}
      <Nav active={tab} onTab={onTab} hidden={navHidden} />
    </div>
  )
}

function SearchButton({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick} className="flex h-9 w-9 items-center justify-center rounded-full bg-(--c-surface) transition-transform duration-150 active:scale-[.92]">
      <svg viewBox="0 0 24 24" fill="none" style={{ stroke: 'var(--c-ink2)' }} strokeWidth="2" strokeLinecap="round" className="h-[16px] w-[16px]"><circle cx="11" cy="11" r="6.5" /><path d="m20 20-3.2-3.2" /></svg>
    </button>
  )
}

/* 轻点进详情，长按弹快捷菜单（坐标换算到外层壳） */
let pressTimer: number | null = null
let pressFired = false
let pressAt = { x: 0, y: 0 }

function clearPress() {
  if (pressTimer != null) {
    window.clearTimeout(pressTimer)
    pressTimer = null
  }
}

function pressProps(onTap: () => void, onLong: (r: Rect, el: HTMLElement) => void) {
  return {
    onPointerDown: (e: React.PointerEvent) => {
      pressFired = false
      pressAt = { x: e.clientX, y: e.clientY }
      const target = e.currentTarget as HTMLElement
      const el = target.querySelector<HTMLElement>('[data-lift]') ?? target.closest<HTMLElement>('[data-lift]') ?? target
      const shell = el.closest('[data-shell]')?.getBoundingClientRect()
      const box = el.getBoundingClientRect()
      const rect: Rect = {
        x: box.left - (shell?.left ?? 0),
        y: box.top - (shell?.top ?? 0),
        w: box.width,
        h: box.height,
      }
      clearPress()
      pressTimer = window.setTimeout(() => {
        pressFired = true
        pressTimer = null
        haptic('medium')
        onLong(rect, el)
      }, 420)
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (pressTimer != null && Math.hypot(e.clientX - pressAt.x, e.clientY - pressAt.y) > 10) clearPress()
    },
    onPointerUp: () => {
      const pending = pressTimer != null
      clearPress()
      if (pending && !pressFired) onTap()
    },
    onPointerCancel: clearPress,
    onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
  }
}

/* ---------------- 日期条 + 月历 ---------------- */

/* 日期条：整学期连续横向滚动（原生惯性），选中项居中；只在关掉日历重新出现时播出场动画。
   整条最多铺 133 天 —— 只渲染可视窗口附近的一段，并只对这一段算 occurrencesOn。
   左右两个占位撑住总宽，滚动时窗口按 4 天为步进平移，scrollLeft 不受影响。 */
const DAY_W = 46
const DAY_GAP = 5
const DAY_PAD = 8
const DAY_STEP = DAY_W + DAY_GAP
const DAY_CHUNK = 4

/**
 * @param sel 高亮的那一天（「今天」页跟着滚动位置走，「课表」页就是选中的 anchor）
 * @param anchor 只用来决定日期条铺到哪一段、以及日历跳转后滚到谁
 */
function DateStrip({ snap, sel, anchor, onPick, onCalendar }: { snap: Snapshot; sel: string; anchor: string; onPick: (d: string) => void; onCalendar: () => void }) {
  const today = todayStr()
  const sem = snap.semester
  const days = useMemo(() => {
    const lo = [mondayOf(sem.startDate), mondayOf(addDays(today, -28)), mondayOf(anchor)].sort()[0]
    const hi = [addDays(sem.startDate, sem.totalWeeks * 7 + 6), addDays(today, 34), addDays(anchor, 6)].sort().pop()!
    const out: string[] = []
    for (let d = lo; d <= hi; d = addDays(d, 1)) out.push(d)
    return out
  }, [sem, today, anchor])
  const idx = Math.max(0, days.indexOf(sel))
  const n = days.length
  const [win, setWin] = useState(() => ({ lo: Math.max(0, idx - 4), hi: Math.min(n, idx + 5) }))
  const lo = Math.max(0, Math.min(win.lo, n))
  const hi = Math.max(lo, Math.min(win.hi, n))
  const box = useRef<HTMLDivElement>(null)
  const first = useRef(true)
  /* 滚动事件按帧合并：惯性滑动时一帧能来好几个 scroll，逐个 setState 等于把它们全排进主线程 */
  const scrollRaf = useRef(0)
  /* 松手后等滚动停下来再按「停在中间的那一天」选日：滑动即换日，
     和点一下的效果一样。程序化的居中滚动停在 anchor 上，算出来还是 anchor，不会自己乱跳。 */
  const settleT = useRef(0)
  /* 每天的课次只在第一次进窗口时算一遍。snap 一换就整张丢掉。 */
  const counts = useRef<{ snap: Snapshot; map: Map<string, number> }>({ snap, map: new Map() })
  if (counts.current.snap !== snap) counts.current = { snap, map: new Map() }
  const countOf = (d: string) => {
    const m = counts.current.map
    const hit = m.get(d)
    if (hit != null) return hit
    const v = occurrencesOn(snap, d).length
    m.set(d, v)
    return v
  }

  useEffect(() => () => {
    if (scrollRaf.current) cancelAnimationFrame(scrollRaf.current)
    if (settleT.current) window.clearTimeout(settleT.current)
  }, [])

  useEffect(() => {
    const sc = box.current
    if (!sc) return
    const cx = DAY_PAD + idx * DAY_STEP + DAY_W / 2
    /* 只有选中项跑出可视区才把它滚回中间：「今天」页高亮跟着纵向滚动走，
       每跨一天就把条子拽一下会像抽风；日历跳到很远的日子时才真的需要滚过去。 */
    const vis = cx >= sc.scrollLeft + 24 && cx <= sc.scrollLeft + sc.clientWidth - 24
    if (first.current || !vis) sc.scrollTo({ left: cx - sc.clientWidth / 2, behavior: first.current ? 'auto' : 'smooth' })
    first.current = false
    /* 目标日可能被日历跳到很远的日子，先把窗口挪过去，免得中间空一帧 */
    setWin((w) => (idx >= w.lo && idx < w.hi ? w : { lo: Math.max(0, idx - 6), hi: Math.min(n, idx + 7) }))
  }, [idx, n])

  const onScroll = () => {
    if (scrollRaf.current) return
    scrollRaf.current = requestAnimationFrame(() => {
      scrollRaf.current = 0
      const sc = box.current
      if (!sc) return
      const start = Math.floor((sc.scrollLeft - DAY_PAD) / (DAY_STEP * DAY_CHUNK)) * DAY_CHUNK
      const count = Math.ceil(sc.clientWidth / DAY_STEP) + 2
      const a = Math.max(0, start - DAY_CHUNK * 2)
      const b = Math.min(n, start + count + DAY_CHUNK * 2)
      setWin((w) => (w.lo === a && w.hi === b ? w : { lo: a, hi: b }))
      /* 停在中间的那一天就是选中的那一天：滑动日期条＝换日期（原来只能点，滑过去什么都不发生） */
      if (settleT.current) window.clearTimeout(settleT.current)
      settleT.current = window.setTimeout(() => {
        settleT.current = 0
        const cx = sc.scrollLeft + sc.clientWidth / 2
        const k = Math.round((cx - DAY_PAD - DAY_W / 2) / DAY_STEP)
        const d = days[k]
        if (d && d !== sel) onPick(d)
      }, 170)
    })
  }

  return (
    /* 和课表页一样横在上面，不再做底部浮岛：浮岛会盖住内容，两个页面手感也不一致 */
    <div className="flex items-stretch rounded-[16px] bg-(--c-surface) py-1.5 pr-1">
      <div
        ref={box}
        onScroll={onScroll}
        className="flex flex-1 items-stretch overflow-x-auto px-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        style={{ scrollSnapType: 'x proximity', WebkitOverflowScrolling: 'touch', touchAction: 'pan-x', maskImage: 'linear-gradient(90deg, transparent, #000 10px, #000 calc(100% - 10px), transparent)' }}
      >
        {lo > 0 && <div className="flex-none" style={{ width: lo * DAY_STEP }} />}
        {days.slice(lo, hi).map((d) => {
          const on = d === sel
          const past = d < today && !on
          const nc = countOf(d)
          const monthStart = d.slice(8) === '01'
          return (
            <button key={d} data-d={d} onClick={() => onPick(d)} className="relative flex w-[46px] flex-none flex-col items-center py-[5px]" style={{ scrollSnapAlign: 'center', marginRight: DAY_GAP }}>
              {on && (
                <motion.i
                  layoutId="date-strip-indicator"
                  transition={SPRING}
                  className="absolute inset-x-[-2px] inset-y-0 rounded-[13px] bg-(--c-accent-soft)"
                />
              )}
              <span
                className={`relative z-10 text-[17px] leading-[1.2] font-bold tabular-nums ${on ? 'text-(--c-accent)' : past ? 'text-(--c-ink5)' : 'text-(--c-ink)'}`}
              >{Number(d.slice(8))}</span>
              <span className={`relative z-10 mt-0.5 text-[10.5px] font-semibold ${on ? 'text-(--c-accent)' : past ? 'text-(--c-ink5)' : 'text-(--c-ink4)'}`}>
                {d === today ? '今天' : monthStart ? `${Number(d.slice(5, 7))}月` : WD[weekdayOf(d)]}
              </span>
              {nc > 0 && <span className={`absolute top-[3px] right-[2px] z-10 text-[9px] font-bold tabular-nums ${on ? 'text-(--c-accent2)' : past ? 'text-(--c-line)' : 'text-(--c-ink5)'}`}>{nc}</span>}
            </button>
          )
        })}
        {hi < n && <div className="flex-none" style={{ width: (n - hi) * DAY_STEP }} />}
      </div>
      <button onClick={onCalendar} className="flex w-9 flex-none items-center justify-center">
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" style={{ stroke: 'var(--c-ink2)' }} strokeWidth="1.9"><rect x="3" y="4" width="18" height="17" rx="4" /><path d="M3 9h18M8 2v4M16 2v4" /></svg>
      </button>
    </div>
  )
}

/** 一个月的网格：只在月份 / 课程数 / 选中 / 模式变化时重渲染，滚动不碰它 */
const MonthGrid = memo(function MonthGrid({ month, sem, counts, anchor, today, mode, onPick }: {
  month: string
  sem: Semester
  counts: Map<string, number>
  anchor: string
  today: string
  mode: 'day' | 'week'
  onPick: (d: string) => void
}) {
  const rows = useMemo(() => {
    const lead = weekdayOf(`${month}-01`) - 1
    const total = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate()
    const cells: (string | null)[] = [
      ...Array.from({ length: lead }, () => null),
      ...Array.from({ length: total }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`),
    ]
    while (cells.length % 7 !== 0) cells.push(null)
    const out: (string | null)[][] = []
    for (let i = 0; i < cells.length; i += 7) out.push(cells.slice(i, i + 7))
    return out
  }, [month])
  const rowWeek = (row: (string | null)[]) => {
    const d = row.find(Boolean)
    return d ? weekOf(sem, d) : 0
  }
  const anchorWeek = weekOf(sem, anchor)
  return (
    <div className="space-y-[3px]">
      {rows.map((row, ri) => {
        const wk = rowWeek(row)
        const rowOn = mode === 'week' && wk === anchorWeek
        return (
          <div key={ri} className={`flex gap-[5px] rounded-[12px] ${rowOn ? 'bg-(--c-accent-soft)' : ''}`}>
            <div className="flex w-7 flex-none items-center justify-center">
              <span className={`text-[10.5px] font-bold tabular-nums ${rowOn ? 'text-(--c-accent)' : 'text-(--c-ink5)'}`}>{wk >= 1 && wk <= sem.totalWeeks ? wk : ''}</span>
            </div>
            {row.map((d, ci) => {
              if (!d) return <div key={ci} className="flex-1" />
              const n = counts.get(d) ?? 0
              const isToday = d === today
              const sel = d === anchor
              return (
                <button key={d} onClick={() => onPick(d)} className="relative flex flex-1 flex-col items-center py-[9px]">
                  {sel && <i className="absolute inset-x-[-4px] inset-y-0 rounded-[13px] bg-(--c-accent-soft)" />}
                  <span
                    className={`relative z-10 flex h-[22px] w-[22px] items-center justify-center text-[15px] leading-none font-bold tabular-nums ${
                      isToday || sel ? 'text-(--c-accent)' : n ? 'text-(--c-ink)' : 'text-(--c-ink5)'
                    }`}
                  >
                    {Number(d.slice(8))}
                  </span>
                  <span className={`relative z-10 mt-1 h-[3px] w-[3px] rounded-full ${n ? (isToday || sel ? 'bg-(--c-accent)' : 'bg-(--c-ink5)') : 'bg-transparent'}`} />
                  {n > 0 && <span className={`absolute top-[3px] right-[2px] z-10 text-[9px] font-bold tabular-nums ${isToday || sel ? 'text-(--c-accent2)' : 'text-(--c-ink5)'}`}>{n}</span>}
                </button>
              )
            })}
          </div>
        )
      })}
    </div>
  )
})

/** 月标题：吸顶后下沿出现羽化；只有这一小块跟着滚动位置重渲染 */
function MonthHead({ month, sem, stuck }: { month: string; sem: Semester; stuck: boolean }) {
  const first = weekOf(sem, `${month}-01`)
  const lastDay = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate()
  const last = weekOf(sem, `${month}-${String(lastDay).padStart(2, '0')}`)
  return (
    <div className={`sticky top-0 z-[20] flex items-baseline gap-2.5 bg-(--c-surface) px-1 py-2 after:pointer-events-none after:absolute after:inset-x-0 after:top-full after:h-4 after:bg-[linear-gradient(180deg,var(--c-surface),transparent)] after:transition-opacity after:duration-200 after:content-[''] ${stuck ? 'after:opacity-100' : 'after:opacity-0'}`}>
      <span className="text-[19px] font-extrabold tracking-[-.02em]">{Number(month.slice(5, 7))}月</span>
      <span className="text-[12px] font-semibold text-(--c-ink4)">
        {sem.name}
        {last >= 1 ? ` 第 ${Math.max(1, first)}–${Math.min(sem.totalWeeks, Math.max(1, last))} 周` : ''}
      </span>
    </div>
  )
}

function CalendarSheet({ snap, mode, anchor, onPick, onClose }: { snap: Snapshot; mode: 'day' | 'week'; anchor: string; onPick: (d: string) => void; onClose: () => void }) {
  const today = todayStr()
  const sem = snap.semester
  const scrollRef = useRef<HTMLDivElement>(null)
  const marks = useRef<Record<string, HTMLDivElement>>({})
  const dismiss = useRef<(() => void) | null>(null)
  /** 选日期后先播完抽屉退出动画，再由 onExitComplete 卸载 */
  const pick = useCallback((d: string) => { onPick(d); dismiss.current?.() }, [onPick])

  /** 学期覆盖到的月份，连续排列，直接上下滚动 */
  const months = useMemo(() => {
    const out: string[] = []
    const key = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    const end = new Date(`${addDays(sem.startDate, sem.totalWeeks * 7 - 1)}T00:00:00`)
    const cur = new Date(`${sem.startDate}T00:00:00`)
    cur.setDate(1)
    while (cur <= end) {
      out.push(key(cur))
      cur.setMonth(cur.getMonth() + 1)
    }
    for (const m of [anchor.slice(0, 7), today.slice(0, 7)]) if (!out.includes(m)) out.push(m)
    return out.sort()
  }, [sem, anchor, today])

  /** 每天的课程数：整个范围算一次，格子里只查表 */
  const counts = useMemo(() => {
    const m = new Map<string, number>()
    const lo = `${months[0]}-01`
    const hiM = months[months.length - 1]
    const hi = `${hiM}-${String(new Date(Number(hiM.slice(0, 4)), Number(hiM.slice(5, 7)), 0).getDate()).padStart(2, '0')}`
    for (let d = lo; d <= hi; d = addDays(d, 1)) {
      const n = occurrencesOn(snap, d).length
      if (n) m.set(d, n)
    }
    return m
  }, [snap, months])

  const scrollTo = (month: string) => {
    const node = marks.current[month]
    const box = scrollRef.current?.parentElement
    if (node && box) box.scrollTop = node.offsetTop - box.offsetTop
  }

  /** 哪个月标题正吸在顶上 */
  const [stuckMonth, setStuckMonth] = useState<string | null>(null)
  useEffect(() => {
    scrollTo(anchor.slice(0, 7))
    const box = scrollRef.current?.parentElement
    if (!box) return
    const onScroll = () => {
      const top = box.scrollTop
      let cur: string | null = null
      for (const m of months) {
        const node = marks.current[m]
        if (node && top > node.offsetTop - box.offsetTop + 1) cur = m
      }
      setStuckMonth(cur)
    }
    onScroll()
    box.addEventListener('scroll', onScroll, { passive: true })
    return () => box.removeEventListener('scroll', onScroll)
  }, [])

  return (
    <Sheet
      onClose={onClose}
      dismissRef={dismiss}
      className="px-4"
      header={
        <div className="flex gap-[5px] px-4 pt-1 pb-2">
          <div className="w-7 flex-none" />
          {[1, 2, 3, 4, 5, 6, 7].map((w) => (
            <div key={w} className="flex-1 text-center text-[10.5px] font-semibold text-(--c-ink4)">{WD_SHORT[w]}</div>
          ))}
        </div>
      }
      footer={
        <div className="flex justify-end px-5 pt-3">
          <TextAction onClick={() => { scrollTo(today.slice(0, 7)); pick(today) }}>{mode === 'day' ? '今天' : '本周'}</TextAction>
        </div>
      }
    >
      <div ref={scrollRef} className="max-h-full">
        {months.map((month) => (
          <div
            key={month}
            ref={(el) => {
              if (el) marks.current[month] = el
            }}
            className="pb-4"
          >
            <MonthHead month={month} sem={sem} stuck={stuckMonth === month} />
            <MonthGrid month={month} sem={sem} counts={counts} anchor={anchor} today={today} mode={mode} onPick={pick} />
          </div>
        ))}
      </div>
    </Sheet>
  )
}

/* ---------------- 今天（跨日连续时间线） ---------------- */

/** 当前日期：定时、回前台、页面可见时重算，跨零点后自动变化 */
function useToday(): string {
  const [today, setToday] = useState(todayStr)
  useEffect(() => {
    const check = () => setToday((t) => { const n = todayStr(); return n === t ? t : n })
    const timer = setInterval(check, 30_000)
    document.addEventListener('visibilitychange', check)
    const onResume = CapApp.addListener('resume', check)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', check)
      void onResume.then((h) => h.remove())
    }
  }, [])
  return today
}

/** 当前时刻（分）：每 30s 一次，回前台立即对时 */
function useNowMinutes(): number {
  const [now, setNow] = useState(nowMinutes)
  useEffect(() => {
    const check = () => setNow(nowMinutes())
    const timer = setInterval(check, 30_000)
    document.addEventListener('visibilitychange', check)
    const onResume = CapApp.addListener('resume', check)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', check)
      void onResume.then((h) => h.remove())
    }
  }, [])
  return now
}

function TodayView({
  snap, anchor, setAnchor, onPick, onMenu, onSearch, onImport, onManual, onSemester, onNewSemester, onCapture, liftKey,
}: {
  snap: Snapshot
  anchor: string
  setAnchor: (d: string) => void
  onPick: (o: Occurrence) => void
  onMenu: (o: Occurrence, r: Rect, el: HTMLElement) => void
  onSearch: () => void
  onImport: () => void
  onManual: () => void
  onSemester: () => void
  onNewSemester: () => void
  onCapture: (kind: 'camera' | 'text', courseId?: string) => void
  liftKey?: string
}) {
  const today = useToday()
  const now = useNowMinutes()
  const [cal, setCal] = useState(false)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  /* 底部日期条跟随滚动位置：滚到「明天」那段时选中项切到明天 */
  const [view, setView] = useState(anchor)
  useEffect(() => setView(anchor), [anchor])
  /* 某一天的段落在滚动容器里的顶部偏移（标题区下方对齐） */
  const dayTop = (sc: HTMLElement, el: HTMLElement) => {
    const headH = (sc.firstElementChild as HTMLElement | null)?.offsetHeight ?? 0
    return el.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop - headH
  }
  const gliding = useRef(0)
  const onScroll = () => {
    const sc = scrollRef.current
    if (!sc) return
    if (gliding.current) {
      window.clearTimeout(gliding.current)
      gliding.current = window.setTimeout(() => { gliding.current = 0 }, 120)
      return
    }
    let cur = anchor
    if (sc.scrollTop > 4) {
      const line = sc.scrollTop + Math.min(sc.clientHeight * 0.3, 120)
      for (const el of Array.from(sc.querySelectorAll<HTMLElement>('[data-day]'))) {
        if (dayTop(sc, el) <= line) cur = el.dataset.day!
        else break
      }
    }
    setView(cur)
  }
  /* 点日期条：目标日已在时间线里就滚过去，不重建列表；不在才换锁定日 */
  const pickDay = (d: string) => {
    const sc = scrollRef.current
    const el = sc?.querySelector<HTMLElement>(`[data-day="${d}"]`)
    if (sc && el) {
      setView(d)
      gliding.current = window.setTimeout(() => { gliding.current = 0 }, 120)
      sc.scrollTo({ top: Math.max(0, dayTop(sc, el) - 8), behavior: 'smooth' })
    } else if (d === anchor) sc?.scrollTo({ top: 0, behavior: 'smooth' })
    else setAnchor(d)
  }

  const days = useMemo(() => {
    const out: { date: string; rel: string; occ: Occurrence[] }[] = []
    for (let i = 0; i < 14; i++) {
      const d = addDays(anchor, i)
      const occ = occurrencesOn(snap, d)
      const rel = d === today ? '今天' : d === addDays(today, 1) ? '明天' : d === addDays(today, 2) ? '后天' : WD[weekdayOf(d)]
      if (i === 0 || occ.length > 0) out.push({ date: d, rel, occ })
      if (out.reduce((n, x) => n + x.occ.length, 0) >= 14 && i >= 2) break
    }
    return out
  }, [snap, anchor, today])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 })
  }, [anchor])

  const week = weekOf(snap.semester, view)
  const vac = inVacation(snap.semester, view)
  /* 标题、日期条、副标题都跟着「正在看的那一天」走：日期条高亮的是 view，
     标题要是还写 anchor，两者就会打架（标题 10月20日、下面高亮 22 号）。
     列表起点仍是 anchor，滚动到头也不会把列表重建。 */
  const shownOcc = useMemo(() => occurrencesOn(snap, view), [snap, view])
  const remain = view === today
    ? shownOcc.filter((o) => o.end > now && o.status !== 'cancelled').length
    : shownOcc.length
  const head = days[0]?.occ ?? []
  const inTerm = week >= 1 && week <= snap.semester.totalWeeks
  const nothingAtAll = snap.courses.length === 0 && snap.entries.length === 0
  /* 刚下课那一刻：时间线里那节课下面直接给出记录入口 */
  const ended = useMemo(() => justEndedClass(snap, today, now), [snap, today, now])
  const [endHidden, setEndHidden] = useState<string[]>([])
  const endKey = ended ? `${ended.date}-${ended.courseId}-${ended.start}` : ''
  const showEnd = ended && !endHidden.includes(endKey)
  const weekend = weekdayOf(view) >= 6
  const termEndDay = termEnd(snap.semester)
  /* 学期第一节课还在选中日之后：整个学期还没开课；两周内都没课且已过学期末：学期已结束 */
  const free = !nothingAtAll && head.length === 0
  const firstClass = useMemo(() => (free ? firstClassDate(snap, snap.semester.startDate) : null), [snap, free])
  const notStarted = free && firstClass != null && firstClass > anchor
  const idle = free && days.length === 1
  const afterTerm = idle && anchor > termEndDay && firstClassDate(snap, anchor) == null

  return (
    <>
      <div
        ref={(el) => { scrollRef.current = el }}
        onScroll={onScroll}
        className="flex-1 overflow-y-auto pb-[130px] [scrollbar-width:none]"
      >
        <StickyHead bleed={0} className="px-5">
          <div className="flex items-start justify-between">
            <h1 className="text-[26px] font-extrabold tracking-[-.02em]">
              {md(view)} <span className="font-bold text-(--c-ink5)">{WD[weekdayOf(view)]}</span>
            </h1>
            <SearchButton onClick={onSearch} />
          </div>
          <div className="mt-2 flex items-center gap-2.5 text-[12.5px] font-semibold text-(--c-ink3)">
            {inTerm ? <span>第 {week} 周</span> : <span>学期外</span>}
            {inTerm && (
              <>
                <span className="h-3 w-px bg-(--c-line)" />
                <span>{week % 2 === 1 ? '单周' : '双周'}</span>
              </>
            )}
            <span className="h-3 w-px bg-(--c-line)" />
            {shownOcc.length > 0 ? (
              <span>{shownOcc.length} 节课{view === today && <span className="text-(--c-ink5)">，剩 {remain} 节</span>}</span>
            ) : (
              <span className="text-(--c-ink5)">{nothingAtAll ? '暂无课表' : notStarted ? '暂未开课' : afterTerm ? '学期已结束' : view === today ? '今天没有课' : '没有课'}</span>
            )}
          </div>
          {/* 日期条钉在标题下面：往下翻课表也一直在，不用滚回去才换天。
              高亮的是「正在看的那一天」（view），标题也用它——以前标题写 anchor、
              条子高亮 view，滚动时两个日期会打架；反过来只认 anchor 又会让点了日期条不动。 */}
          {!cal && <div className="mt-2.5"><DateStrip snap={snap} sel={view} anchor={anchor} onPick={pickDay} onCalendar={() => setCal(true)} /></div>}
        </StickyHead>
        {vac && <div className="mx-5 mt-1 rounded-[16px] bg-(--c-surface) px-4 py-3 text-[13px] font-semibold text-[#9A7B3F]">{vac}</div>}

        {nothingAtAll ? (
          <div className="mt-16">
            <EmptyBlock
              kind="none"
              title="让课表就位"
              desc="一键导入，或是手动创建。随后的日程追踪与准时提醒，皆会为你准备就绪。"
              actions={[['导入课表', onImport], ['手动添加', onManual]]}
            />
          </div>
        ) : notStarted && idle ? (
          <div className="mt-14">
            <EmptyBlock
              kind="term"
              title="暂未开课"
              desc={`课程将于第 ${weekOf(snap.semester, firstClass)} 周（${md(firstClass)}）正式开启`}
              actions={[[`前往 ${md(firstClass)}`, () => setAnchor(firstClass)]]}
            />
          </div>
        ) : afterTerm ? (
          <div className="mt-14">
            <EmptyBlock
              kind="term"
              title="学期已结束"
              actions={[['开始新学期', onNewSemester], ['学期设置', onSemester]]}
            />
          </div>
        ) : head.length === 0 && days.length === 1 ? (
          <div className="mt-14">
            <EmptyBlock
              kind="free"
              title="今天没有课，好耶"
              desc={weekend ? '周末到了，不如去做点感兴趣的事，出去走走。' : '不如去做点感兴趣的事，出去走走。'}
              actions={[['手动添加', onManual]]}
            />
          </div>
        ) : (
          <div className="mt-6 px-5">
            {days.map((day) => {
              /* 今天里第一节还没开始的课：给出「下一节」提示，和原型一致 */
              const nextKey = day.date === today
                ? day.occ.find((x) => x.start > now && x.status !== 'cancelled')?.key
                : undefined
              const inClass = day.date === today && day.occ.some((x) => x.start <= now && now < x.end && x.status !== 'cancelled')
              return (
              <div key={day.date} data-day={day.date}>
                {/* 有没有课都摆同一个表头：以前没课的那天只写一行「无课程」，
                    「今天」这两个大字就没了，和下面的「明天」「后天」完全不像同一套版式 */}
                <div className="flex items-baseline justify-between pb-[22px]">
                  <div className="flex items-baseline gap-2.5">
                    <span className="text-[17px] leading-none font-extrabold tracking-[-.02em]">{day.rel}</span>
                    <span className="text-[12.5px] font-semibold text-(--c-ink4)">{md(day.date)}{day.rel !== WD[weekdayOf(day.date)] ? ` ${WD[weekdayOf(day.date)]}` : ''}</span>
                  </div>
                  <span className="text-[12px] font-semibold tabular-nums text-(--c-ink5)">
                    {day.occ.length > 0
                      ? `${day.occ.length} 节课，${fmtMinutes(day.occ[0].start)} 开始`
                      : notStarted ? '暂未开课' : '无课程'}
                  </span>
                </div>
                {day.occ.map((o, oi) => {
                  const isLast = oi === day.occ.length - 1
                  const isToday = day.date === today
                  const past = (isToday && o.end <= now) || day.date < today
                  const nowOn = isToday && o.start <= now && now < o.end
                  const pct = ((now - o.start) / Math.max(1, o.end - o.start)) * 100
                  const sticker = stickerOfOcc(o, snap.courses)
                  return (
                    <Fragment key={o.key}>
                    <button
                      {...pressProps(() => onPick(o), (r, el) => onMenu(o, r, el))}
                      className={`flex w-full py-1.5 text-left transition-transform duration-150 ${liftKey === o.key ? '' : 'active:scale-[.985]'}`}
                    >
                      <div className={`w-11 flex-none pt-3.5 ${past ? 'opacity-50' : ''}`}>
                        <div className="text-[11px] font-bold text-(--c-ink2)">{o.startPeriod === o.endPeriod ? `${o.startPeriod}节` : `${o.startPeriod}–${o.endPeriod}节`}</div>
                        <div className="mt-1 text-[11px] font-medium tabular-nums text-(--c-ink4)">{fmtMinutes(o.start)}</div>
                        <div className="text-[11px] font-medium tabular-nums text-(--c-ink5)">{fmtMinutes(o.end)}</div>
                      </div>
                      {/* 时间轴在一天里贯穿，最后一节下方留出与日期标题下方等高的空白 */}
                      <div className={`-my-1.5 ml-3 w-[2px] flex-none self-stretch ${isLast ? 'pb-7' : ''}`}>
                        <div className="relative h-full bg-(--c-line)">
                          {past && <i className="absolute inset-0 bg-(--c-accent)" />}
                          {nowOn && (
                            <>
                              <i className="absolute inset-x-0 top-0 bg-(--c-accent)" style={{ height: `${pct}%` }} />
                              <i className="absolute left-1/2 h-[9px] w-[9px] -translate-x-1/2 -translate-y-1/2 rounded-full border-[2.5px] border-(--c-accent) bg-(--c-surface)" style={{ top: `${pct}%` }} />
                            </>
                          )}
                        </div>
                      </div>
                      <div className={`min-w-0 flex-1 pl-4 ${isLast ? 'pb-7' : ''} ${past || o.status === 'cancelled' ? 'opacity-50' : ''}`}>
                      {/* 每节课一张卡；贴纸固定钉在卡片右上角，所有课都在同一个位置。
                          课名让出右侧那一竖条（pr-8），长课名折行也不会钻到贴纸底下。 */}
                      <div data-lift className="relative rounded-[16px] bg-(--c-surface) px-4 py-3.5">
                        {sticker && <Sticker id={sticker} size={22} tilt={-4} className="pointer-events-none absolute top-3 right-4" />}
                        <div className="min-w-0">
                          <div className={`pr-8 text-[16px] leading-[1.25] font-bold tracking-[-.01em] ${o.status === 'cancelled' ? 'line-through' : ''}`}>{o.name}</div>
                          <div className="mt-1 flex items-center gap-2 text-[12.5px] font-medium text-(--c-ink3)">
                            <span className="min-w-0 truncate">{[o.location, o.teacher].filter(Boolean).join('，') || '—'}</span>
                            {o.conflict && <span className="flex-none rounded-[7px] bg-(--c-amber-soft) px-2 py-[3px] text-[10.5px] font-bold text-(--c-amber)">冲突</span>}
                            {o.status === 'moved' && <span className="flex-none rounded-[7px] bg-(--c-accent-soft) px-2 py-[3px] text-[10.5px] font-bold text-(--c-accent)">已调课</span>}
                            {o.status === 'cancelled' && <span className="flex-none rounded-[7px] bg-(--c-surface2) px-2 py-[3px] text-[10.5px] font-bold text-(--c-ink3)">停课</span>}
                            {o.status === 'leave' && <span className="flex-none rounded-[7px] bg-(--c-rose-soft) px-2 py-[3px] text-[10.5px] font-bold text-(--c-rose)">请假</span>}
                            {o.muted && o.status === 'normal' && !past && <span className="flex-none rounded-[7px] bg-(--c-surface2) px-2 py-[3px] text-[10.5px] font-bold text-(--c-ink3)">静音</span>}
                          </div>
                        </div>
                        {nowOn && <div className="mt-1.5 text-[12px] font-bold tabular-nums text-(--c-accent)">上课中，现在 {fmtMinutes(now)}，还剩 {fmtDuration(o.end - now)}</div>}
                        {!nowOn && o.key === nextKey && (!inClass && o.start - now <= 60
                          ? <div className="mt-1.5 text-[12px] font-bold tabular-nums text-(--c-accent)">还有 {fmtDuration(o.start - now)}，{fmtMinutes(o.start)} 开始</div>
                          : <div className="mt-1.5 text-[12px] font-semibold tabular-nums text-(--c-ink3)">下一节，{fmtMinutes(o.start)} 开始</div>
                        )}
                      </div>
                      </div>
                    </button>
                    {showEnd && ended && day.date === ended.date && o.courseId === ended.courseId && o.start === ended.start && (
                      <ClassEndCard
                        moment={ended}
                        onCamera={() => onCapture('camera', ended.courseId)}
                        onText={() => onCapture('text', ended.courseId)}
                        onDismiss={() => setEndHidden((s) => [...s, endKey])}
                      />
                    )}
                    </Fragment>
                  )
                })}
              </div>
              )
            })}
          </div>
        )}
      </div>

      <BottomVeil height={130} />
      <BackPill show={!cal && view !== today} label="回到今天" bottom="calc(80px + max(24px, env(safe-area-inset-bottom)))" onClick={() => (anchor === today ? pickDay(today) : setAnchor(today))} />
      {cal && <CalendarSheet snap={snap} mode="day" anchor={anchor} onPick={setAnchor} onClose={() => setCal(false)} />}
    </>
  )
}

/* ---------------- 周视图 ---------------- */

/**
 * 一周的日期条：和「今天」的日期条一个待遇——钉在标题下面，往下翻课表也一直在。
 * 早先它跟在网格里一起滚，翻到第 6 节就看不到今天几号了，也没法点着换天。
 */
function WeekDays({ snap, week, anchor, today, setAnchor }: {
  snap: Snapshot
  week: number
  anchor: string
  today: string
  setAnchor: (d: string) => void
}) {
  const byDay = useMemo(() => occurrencesInWeek(snap, week), [snap, week])
  const monday = dateOf(snap.semester, week, 1)
  const days = [1, 2, 3, 4, 5, 6, 7].map((wd) => dateOf(snap.semester, week, wd))
  return (
    <div className="flex items-stretch gap-[5px]">
      <div className="-mr-[5px] flex w-8 flex-none items-center justify-center text-[10.5px] font-semibold text-(--c-ink4)">
        {Number(monday.slice(5, 7))}月
      </div>
      {days.map((d) => {
        const on = d === anchor
        const isToday = d === today
        const n = (byDay.get(weekdayOf(d)) ?? []).length
        return (
          <button key={d} onClick={() => setAnchor(d)} className="relative flex flex-1 flex-col items-center py-[5px]">
            {on && <motion.i layoutId="week-strip-indicator" transition={SPRING} className="absolute inset-x-[-4px] inset-y-0 rounded-[13px] bg-(--c-accent-soft)" />}
            <span className={`relative z-10 flex h-[24px] w-[24px] items-center justify-center text-[17px] leading-none font-bold tabular-nums ${isToday || on ? 'text-(--c-accent)' : 'text-(--c-ink)'}`}>{Number(d.slice(8))}</span>
            <span className={`relative z-10 mt-0.5 text-[10.5px] font-semibold ${on || isToday ? 'text-(--c-accent)' : 'text-(--c-ink4)'}`}>{isToday ? '今天' : WD[weekdayOf(d)]}</span>
            {n > 0 && <span className={`absolute top-[3px] right-[2px] z-10 text-[9px] font-bold tabular-nums ${on ? 'text-(--c-accent2)' : 'text-(--c-ink5)'}`}>{n}</span>}
          </button>
        )
      })}
    </div>
  )
}

/** 节次网格（纵轴见 domain/time-axis）；左右滑时相邻周也各渲染一份，日期条在 WeekView 的吸顶区里 */
function WeekGrid({ snap, week, today, now, onPick, onMenu, liftKey, gridRef, onGeometry, fillH }: {
  snap: Snapshot
  week: number
  today: string
  now: number
  onPick: (o: Occurrence) => void
  onMenu: (o: Occurrence, r: Rect, el: HTMLElement) => void
  liftKey?: string
  gridRef?: React.MutableRefObject<HTMLDivElement | null>
  onGeometry?: (todayIdx: number, nowTop: number) => void
  /** 可视区高度：平板上一屏比课表高得多，按这个把行拉高补满（0 表示不补） */
  fillH?: number
}) {
  const sem = snap.semester
  const byDay = useMemo(() => occurrencesInWeek(snap, week), [snap, week])
  const days = [1, 2, 3, 4, 5, 6, 7].map((wd) => dateOf(sem, week, wd))
  const todayIdx = days.indexOf(today)

  /* 列宽决定卡片里文字折几行；首次按视口估，挂载后用真实宽度（宽屏上限 720，同 .shell-w） */
  const [colW, setColW] = useState(() => (Math.min(window.innerWidth, 720) - 98) / 7)

  /* 轴的范围跟着真实课程走：节次之外的早课、晚自习按真实时长延伸，不会溢出；行高按这一行卡片实际需要的高度来 */
  const axis = useMemo(() => {
    const all = [...byDay.values()].flat()
    const span = all.length > 0 ? { start: Math.min(...all.map((o) => o.start)), end: Math.max(...all.map((o) => o.end)) } : undefined
    const heights = rowHeights(sem.timeGrid, all.map((o) => ({ start: o.start, end: o.end, name: o.name, loc: o.location })), colW)
    const base = buildAxis(sem.timeGrid, span, heights)
    const periods = base.segs.filter((s) => s.kind === 'period').length
    const extra = (fillH ?? 0) - base.height - 8
    if (periods === 0 || extra < 40) return base
    return buildAxis(sem.timeGrid, span, heights, Math.floor(extra / periods))
  }, [sem.timeGrid, byDay, colW, fillH])
  const first = axis.segs[0]
  const last = axis.segs[axis.segs.length - 1]
  const gridH = axis.height + 8
  const nowTop = now >= first.t0 && now <= last.t1 ? axis.y(now) : 0
  useEffect(() => {
    onGeometry?.(todayIdx, nowTop)
  }, [todayIdx, nowTop, onGeometry])

  const gridEl = useRef<HTMLDivElement | null>(null)
  const setGridEl = useCallback((el: HTMLDivElement | null) => {
    gridEl.current = el
    if (gridRef) gridRef.current = el
  }, [gridRef])
  useEffect(() => {
    const el = gridEl.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(([e]) => {
      const w = (e.contentRect.width - 6 * 5) / 7
      if (w > 0) setColW(w)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  return (
    <>
      <div className="relative mt-2 pt-1.5">
        <div className="flex">
          <WeekAxis axis={axis} nowTop={todayIdx >= 0 && nowTop > 0 ? nowTop : undefined} nowLabel={fmtMinutes(now)} />
          <div ref={setGridEl} className="relative flex flex-1 gap-[5px]" style={{ height: gridH }}>
            <WeekLines axis={axis} />
            {days.map((d, i) => {
              const occ = byDay.get(weekdayOf(d)) ?? []
              const pastCol = d < today
              return (
                <div key={d} className={`relative flex-1 ${pastCol ? 'opacity-45' : ''}`}>
                  {occ.map((o) => {
                    /* 冲突：同一时段的课按开始时间叠放，前一张在上，后一张右移露边，右上角标门数 */
                    const cluster = occ.filter((x) => x.start < o.end && o.start < x.end).sort((a, b) => a.start - b.start || a.key.localeCompare(b.key))
                    const lane = cluster.indexOf(o)
                    const stacked = cluster.length > 1
                    const done = d < today || (d === today && o.end <= now)
                    const nowOn = d === today && o.start <= now && now < o.end
                    const lift = liftKey === o.key
                    const top = axis.y(o.start) + CARD_INSET
                    const cellH = axis.y(o.end) - top - CARD_INSET
                    const covered = lane > 0 ? Math.max(0, ...cluster.slice(0, lane).map((x) => axis.y(x.end) - CARD_INSET - top)) : 0
                    const ring = nowOn
                      ? `inset 0 0 0 1.5px ${o.color}`
                      : stacked || o.conflict
                        ? `inset 0 0 0 1.5px ${lane > 0 ? 'rgba(217,169,75,.55)' : '#D9A94B'}`
                        : undefined
                    const sticker = !stacked && cellH >= 44 ? stickerOfOcc(o, snap.courses) : null
                    return (
                      <div
                        key={o.key}
                        data-lift
                        className="absolute"
                        style={{
                          top,
                          height: cellH,
                          left: lane * 5,
                          right: -lane * 5,
                          zIndex: stacked ? 6 - lane : undefined,
                          opacity: done && !pastCol ? 0.55 : 1,
                        }}
                      >
                      <button
                        {...pressProps(() => onPick(o), (r, el) => onMenu(o, r, el))}
                        className={`block h-full w-full transition-transform duration-150 ${lift ? '' : 'active:scale-[.97]'}`}
                      >
                        <WeekCard
                          name={o.name}
                          loc={o.location}
                          color={o.color}
                          h={cellH}
                          w={colW}
                          now={nowOn}
                          done={done}
                          progress={nowOn ? axis.y(now) - top : undefined}
                          sticker={sticker}
                          status={o.status}
                          muted={o.muted && !done}
                          ring={ring}
                          textTop={Math.min(covered, cellH)}
                          tone={stacked && !nowOn ? 14 : undefined}
                        />
                      </button>
                      {stacked && lane === 0 && (
                        <span className="pointer-events-none absolute top-[-5px] right-[-6px] z-10 flex h-[14px] w-[14px] items-center justify-center rounded-full bg-[#D9A94B] text-[8.5px] leading-none font-bold text-white ring-[2px] ring-(--c-bg)">
                          {cluster.length}
                        </span>
                      )}
                      </div>
                    )
                  })}
                  {i === todayIdx && nowTop > 0 && (
                    <div className="pointer-events-none absolute right-[-2px] left-[-2px] z-20" style={{ top: nowTop }}>
                      <i className="block h-[1.5px] w-full rounded-full bg-(--c-accent)" />
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </>
  )
}

/* 横滑翻周：方向锁定后手指跟随，松手按位移/速度吸附到相邻周 */
const SWIPE_LOCK = 8
const SWIPE_RATIO = 0.3
const SWIPE_VELOCITY = 0.5
const SWIPE_EASE = [0.25, 1, 0.5, 1] as const

function WeekView({ snap, anchor, setAnchor, onPick, onMenu, onSearch, liftKey }: { snap: Snapshot; anchor: string; setAnchor: (d: string) => void; onPick: (o: Occurrence) => void; onMenu: (o: Occurrence, r: Rect, el: HTMLElement) => void; onSearch: () => void; liftKey?: string }) {
  const sem = snap.semester
  const today = useToday()
  const [cal, setCal] = useState(false)
  const week = Math.min(Math.max(weekOf(sem, anchor), 1), sem.totalWeeks)
  const thisWeek = Math.min(Math.max(weekOf(sem, today), 1), sem.totalWeeks)
  const now = useNowMinutes()
  const monday = dateOf(sem, week, 1)

  /* 首次进入且本周含今天：滚到当前时刻附近 */
  const scroller = useRef<HTMLDivElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const scrolled = useRef(false)
  const onGeometry = useCallback((todayIdx: number, nowTop: number) => {
    const sc = scroller.current
    const grid = gridRef.current
    if (scrolled.current || !sc || !grid || todayIdx < 0 || nowTop <= 0) return
    scrolled.current = true
    const gridTop = grid.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop
    const target = gridTop + nowTop - sc.clientHeight * 0.4
    if (target > 0) sc.scrollTop = target
  }, [])

  /* 换周时整块网格按方向平移；横滑翻过来的那次已经滑到位，不再播。
     入场动画改为对同一个节点做命令式动画 —— 原来靠 motion.div 的 key={week} 重挂载来播，
     切周会把三份周网格整棵卸载重建（实测 commit 帧 106ms），现在只更新 DOM。 */
  const seen = useRef(week)
  const swiped = useRef(false)
  const enterRef = useRef<HTMLDivElement>(null)
  const firstEnter = useRef(true)
  useEffect(() => {
    const el = enterRef.current
    if (seen.current !== week) {
      const d = week > seen.current ? 1 : -1
      seen.current = week
      if (!swiped.current && el) animate(el, { opacity: [0, 1], x: [d * 28, 0] }, { type: 'tween', ease: SWIPE_EASE, duration: 0.22 })
    } else if (firstEnter.current && el) {
      animate(el, { opacity: [0, 1] }, { type: 'tween', ease: SWIPE_EASE, duration: 0.22 })
    }
    firstEnter.current = false
    swiped.current = false
  }, [week])

  const x = useMotionValue(0)
  /* 日期条自己一条轨道（三份：上周/本周/下周）。它比网格窄 20px（列宽要对齐网格），
     所以和网格共用同一个拖动位移、但不共用终点：松手后各自滑出自己的那一屏宽度，时长一致。 */
  const xs = useMotionValue(0)
  const box = useRef<HTMLDivElement>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const stripBoxRef = useRef<HTMLDivElement>(null)
  const drag = useRef<{ x0: number; y0: number; w: number; state: 'pending' | 'drag' | 'off'; last: number; t: number; v: number } | null>(null)

  const settle = (delta: -1 | 0 | 1, from: number, w: number, stripW = 0) => {
    const to = -delta * w
    const dist = Math.abs(to - from)
    const opt = { type: 'tween' as const, ease: SWIPE_EASE, duration: Math.min(0.4, Math.max(0.2, dist / w * 0.4)) }
    /* 两条一起走、同一时长：日期条滑走一排的同时网格也滑走一屏 */
    if (stripW > 0) animate(xs, -delta * stripW, opt)
    animate(x, to, opt).then(() => {
      if (!delta) return
      swiped.current = true
      x.jump(0)
      xs.jump(0)
      flushSync(() => setAnchor(addDays(monday, delta * 7)))
    })
  }

  const onDown = (e: React.PointerEvent) => {
    if (drag.current?.state === 'drag') return
    const pane = box.current
    if (!pane) return
    drag.current = { x0: e.clientX, y0: e.clientY, w: pane.clientWidth - 12, state: 'pending', last: 0, t: e.timeStamp, v: 0 }
  }
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d || d.state === 'off') return
    const dx = e.clientX - d.x0
    const dy = e.clientY - d.y0
    if (d.state === 'pending') {
      if (Math.abs(dy) > SWIPE_LOCK && Math.abs(dy) >= Math.abs(dx)) {
        d.state = 'off'
        return
      }
      if (Math.abs(dx) <= SWIPE_LOCK) return
      d.state = 'drag'
      clearPress()
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    }
    const dt = e.timeStamp - d.t
    if (dt > 0) d.v = (dx - d.last) / dt
    d.last = dx
    d.t = e.timeStamp
    const blocked = (dx > 0 && week <= 1) || (dx < 0 && week >= sem.totalWeeks)
    x.set(blocked ? dx * 0.25 : dx)
  }
  const onUp = (e: React.PointerEvent) => {
    const d = drag.current
    drag.current = null
    if (!d || d.state !== 'drag') {
      return
    }
    ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
    const dx = d.last
    let delta: -1 | 0 | 1 = 0
    if (dx < -d.w * SWIPE_RATIO || (dx < 0 && d.v < -SWIPE_VELOCITY)) delta = 1
    else if (dx > d.w * SWIPE_RATIO || (dx > 0 && d.v > SWIPE_VELOCITY)) delta = -1
    if ((delta === 1 && week >= sem.totalWeeks) || (delta === -1 && week <= 1)) delta = 0
    settle(delta, x.get(), d.w)
  }

  /* 日期条也能横滑换周：它钉在标题下面，是最顺手的落点。
     拖的时候它和网格一起跟手（同一位移量），松手各自滑出自己的那一屏，
     于是「上周的日期滑走、这周的日期滑进来」和下面的课表是同一个动作。 */
  const strip = useRef<{ x0: number; y0: number; state: 'pending' | 'drag' | 'off'; last: number; t: number; v: number } | null>(null)
  /* 滑动松手后浏览器还会补一个 click，别让它顺手把日期切到手指抬起的那一格 */
  const stripSwiped = useRef(false)

  const onStripDown = (e: React.PointerEvent) => {
    strip.current = { x0: e.clientX, y0: e.clientY, state: 'pending', last: 0, t: e.timeStamp, v: 0 }
    stripSwiped.current = false
  }

  const onStripMove = (e: React.PointerEvent) => {
    const d = strip.current
    if (!d || d.state === 'off') return
    const dx = e.clientX - d.x0
    const dy = e.clientY - d.y0
    if (d.state === 'pending') {
      if (Math.abs(dy) > SWIPE_LOCK && Math.abs(dy) >= Math.abs(dx)) {
        d.state = 'off'
        return
      }
      if (Math.abs(dx) <= SWIPE_LOCK) return
      d.state = 'drag'
      stripSwiped.current = true
    }
    const dt = e.timeStamp - d.t
    if (dt > 0) d.v = (dx - d.last) / dt
    d.last = dx
    d.t = e.timeStamp
    const blocked = (dx > 0 && week <= 1) || (dx < 0 && week >= sem.totalWeeks)
    const v = blocked ? dx * 0.25 : dx
    x.set(v)
    xs.set(v)
  }

  const onStripUp = () => {
    const d = strip.current
    strip.current = null
    if (!d || d.state !== 'drag') return
    const w = (box.current?.clientWidth ?? 300) - 12
    /* 裁切层左右各有 4px 内边（给选中态外扩），百分比宽度参照的是内边之内那块 */
    const swBox = stripBoxRef.current?.clientWidth ?? 0
    const sw = swBox > 8 ? swBox - 8 : 0
    const dx = d.last
    let delta: -1 | 0 | 1 = 0
    if (dx < -w * SWIPE_RATIO || (dx < 0 && d.v < -SWIPE_VELOCITY)) delta = 1
    else if (dx > w * SWIPE_RATIO || (dx > 0 && d.v > SWIPE_VELOCITY)) delta = -1
    if ((delta === 1 && week >= sem.totalWeeks) || (delta === -1 && week <= 1)) delta = 0
    window.setTimeout(() => {
      stripSwiped.current = false
    }, 150)
    /* delta 为 0 时也要走一遍：两条轨道都要回弹到原位 */
    settle(delta, dx, w, sw)
  }

  const panes = [week - 1, week, week + 1]

  /* 进课表时先只画当周，前后两周隔一帧再补。
     三周一起建在 660 这类机器上要 500ms 左右，切页时首帧全花在建 DOM 上，
     用户看到的就是「点了没反应」。先给当周，邻周随后补上，首帧就只是当周的开销。 */
  const [sides, setSides] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => setSides(true), 90)
    return () => clearTimeout(t)
  }, [])

  /* 大屏上可视区比课表本身高得多，下面会空一大片：量出网格顶到屏底的距离，交给 WeekGrid 把行拉高补满。
     手机（内容宽度 430）保持原样，行高完全不变。 */
  const [fillH, setFillH] = useState(0)
  useEffect(() => {
    const sc = scroller.current
    if (!sc) return
    const measure = () => {
      const g = gridRef.current
      const shell = document.querySelector('[data-shell]')?.getBoundingClientRect().width ?? 0
      if (!g || shell < 600) {
        setFillH(0)
        return
      }
      const top = g.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop
      /* 底部 120 是给浮在内容上的底部导航让出的高度，不然最后一节会被压在 dock 下面 */
      setFillH(Math.max(0, Math.round(sc.clientHeight - top - 120)))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(sc)
    return () => ro.disconnect()
  }, [])

  return (
    <>
      <div ref={scroller} className="flex-1 overflow-y-auto pb-[130px] [scrollbar-width:none]">
        <StickyHead className="px-5">
          <div className="flex items-center justify-between">
          <button onClick={() => setCal(true)} className="flex items-center gap-1.5 text-[17px] font-extrabold tracking-[-.01em]">
            第 {week} 周
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" style={{ stroke: 'var(--c-ink4)' }} strokeWidth="2.6" strokeLinecap="round"><path d="m6 9 6 6 6-6" /></svg>
          </button>
          <div className="flex items-center gap-2.5">
            <span className="text-[12.5px] font-semibold text-(--c-ink3)">{week % 2 === 1 ? '单周' : '双周'}</span>
            <span className="h-3 w-px bg-(--c-line)" />
            <span className="text-[12.5px] font-semibold text-(--c-ink3)">{sem.name}</span>
            <SearchButton onClick={onSearch} />
          </div>
          </div>
          {/* 日期条挂在标题下面：横向的 18px 偏移和网格对齐（20 - 12 + 10），七列宽度才和下面一模一样。
              左右滑它=换周（三份并排，滑走一排进来一排），点某一格=看那天。 */}
          {!cal && (
            <div
              onPointerDown={onStripDown}
              onPointerMove={onStripMove}
              onPointerUp={onStripUp}
              onPointerCancel={onStripUp}
              className="mt-1.5 -mx-3 px-2.5 [touch-action:pan-y]"
            >
              <div ref={stripBoxRef} className="-mx-1 overflow-hidden px-1">
                <motion.div className="flex w-[300%] -ml-[100%] items-start" style={{ x: xs }}>
                  {[week - 1, week, week + 1].map((w) => (
                    <div key={w} className="w-1/3 flex-none">
                      {w >= 1 && w <= sem.totalWeeks && (
                        <WeekDays snap={snap} week={w} anchor={anchor} today={today} setAnchor={(d) => { if (!stripSwiped.current) setAnchor(d) }} />
                      )}
                    </div>
                  ))}
                </motion.div>
              </div>
            </div>
          )}
        </StickyHead>

        <div className="mt-1 px-2">
          <div
            ref={box}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onUp}
            className="overflow-hidden rounded-[22px] bg-(--c-surface) px-1.5 pt-2.5 pb-4 [touch-action:pan-y]"
          >
            {/* 相邻周在这层裁掉：每周自带 4px 内边，选中标记外扩的 4px 不被切。
                key 用周号（不是槽位序号）：翻周时新旧 panes 有两周重叠，React 会把这两份
                连同里面的卡片 DOM 一起挪过来复用，只新建真正新出现的那一周。
                原来外层 motion.div 还有一个 key={week}，会把三份整棵卸载重建 —— 那才是 commit 帧的大头。
                will-change 常驻（[style] 里那句）：按下才挂的话，整幅光栅正好落在手指刚动的那一帧——
                低端平板上就是「按下去 300ms 没反应」。真机实测常驻把滑动帧 p95 从 50ms 拉到 36ms。 */}
            <div ref={enterRef} className="-mx-1 overflow-hidden px-1">
              <motion.div ref={trackRef} className="flex w-[300%] -ml-[100%] items-start" style={{ x, willChange: 'transform' }}>
                {panes.map((w) => (
                  <div key={w} className="w-1/3 flex-none px-1">
                    {w >= 1 && w <= sem.totalWeeks && (w === week || sides) && (
                      <WeekGrid
                        snap={snap}
                        week={w}
                        today={today}
                        now={now}
                        onPick={onPick}
                        onMenu={onMenu}
                        liftKey={liftKey}
                        fillH={fillH}
                        gridRef={w === week ? gridRef : undefined}
                        onGeometry={w === week ? onGeometry : undefined}
                      />
                    )}
                  </div>
                ))}
              </motion.div>
            </div>
          </div>
        </div>
      </div>
      <BackPill show={!cal && week !== thisWeek} label="回到本周" bottom="calc(80px + max(24px, env(safe-area-inset-bottom)))" onClick={() => setAnchor(today)} />
      {cal && <CalendarSheet snap={snap} mode="week" anchor={anchor} onPick={setAnchor} onClose={() => setCal(false)} />}
    </>
  )
}

/* ---------------- 搜索 ---------------- */

/* 命中部分按原型高亮 */
function Hit({ text, q }: { text: string; q: string }) {
  const s = q.trim()
  const i = s ? text.toLowerCase().indexOf(s.toLowerCase()) : -1
  if (i < 0) return <>{text}</>
  return (
    <>
      {text.slice(0, i)}
      <span className="bg-(--c-accent-soft) text-(--c-accent)">{text.slice(i, i + s.length)}</span>
      {text.slice(i + s.length)}
    </>
  )
}

function SearchPalette({ state, onClose, onPickCourse, onPickTask }: { state: State; onClose: () => void; onPickCourse: (c: Course) => void; onPickTask: (t: Task) => void }) {
  const [q, setQ] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => inputRef.current?.focus(), [])
  const today = todayStr()

  const tasks = useMemo(() => {
    const s = q.trim().toLowerCase()
    if (!s) return []
    const hit = (v?: string) => !!v && v.toLowerCase().includes(s)
    return state.tasks
      .filter((t) => hit(t.title) || hit(t.note) || hit(t.location) || hit(state.courses.find((c) => c.id === t.courseId)?.name))
      .sort((a, b) => Number(a.done) - Number(b.done) || (a.due ?? '9').localeCompare(b.due ?? '9'))
      .slice(0, 8)
  }, [q, state])

  const groups = useMemo(() => {
    const s = q.trim().toLowerCase()
    if (!s) return []
    const locOf = new Map<string, string[]>()
    for (const r of state.rules) {
      const arr = locOf.get(r.courseId) ?? []
      if (r.location) arr.push(r.location)
      locOf.set(r.courseId, arr)
    }
    const live = state.courses.filter((c) => !c.removedByImport)
    const byName = live.filter((c) => c.name.toLowerCase().includes(s))
    const byTeacher = live.filter((c) => !byName.includes(c) && c.teacher?.toLowerCase().includes(s))
    const byRoom = live.filter((c) => !byName.includes(c) && !byTeacher.includes(c) && (locOf.get(c.id) ?? []).some((l) => l.toLowerCase().includes(s)))
    const mk = (label: string, list: Course[]): [string, Course[]] => [label, list.slice(0, 8)]
    return ([mk('课程', byName), mk('老师', byTeacher), mk('教室', byRoom)] as [string, Course[]][]).filter(([, l]) => l.length > 0)
  }, [q, state])

  return (
    <div className="flex-1 overflow-y-auto [scrollbar-width:none]">
      <div className="px-4 pt-[max(52px,calc(env(safe-area-inset-top)+22px))] pb-10">
        <div className="flex items-center rounded-full bg-(--c-surface) px-4 py-2.5">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" style={{ stroke: 'var(--c-ink4)' }} strokeWidth="2.2" strokeLinecap="round" className="mr-2.5 flex-none"><circle cx="11" cy="11" r="7" /><path d="m16.5 16.5 4 4" /></svg>
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="课程、老师、教室、待办"
            className="min-w-0 flex-1 bg-transparent text-[14px] font-medium text-(--c-ink) outline-none placeholder:text-(--c-ink5)"
          />
          <button onClick={onClose} className="ml-auto flex-none pl-2 text-[12.5px] font-medium text-(--c-ink3)">取消</button>
        </div>

        <div className="mt-3 space-y-3.5">
          {groups.map(([g, list]) => (
            <div key={g}>
              <div className="px-1.5 text-[11.5px] font-medium text-(--c-ink4)">{g}</div>
              <div className="mt-1.5 overflow-hidden rounded-[14px] bg-(--c-surface) p-1">
                {list.map((c) => {
                  const locs = [...new Set(state.rules.filter((r) => r.courseId === c.id).map((r) => r.location).filter(Boolean))]
                  const slots = state.rules.filter((r) => r.courseId === c.id)
                  return (
                    <button key={c.id} onClick={() => onPickCourse(c)} className="flex w-full items-center rounded-[10px] px-2.5 py-2.5 text-left transition-colors active:bg-(--c-surface2)">
                      <i className="mr-3 h-[26px] w-[3px] flex-none rounded-full" style={{ background: c.color }} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13.5px] font-semibold"><Hit text={c.name} q={q} /></div>
                        <div className="mt-[2px] truncate text-[11.5px] font-medium text-(--c-ink4)">
                          {slots.length > 0 ? `${WD[slots[0].weekday]} ${slots[0].startPeriod}–${slots[0].endPeriod} 节` : '—'}{locs[0] ? `，${locs[0]}` : ''}
                        </div>
                      </div>
                      {c.teacher && <span className="ml-2 flex-none text-[11.5px] font-medium text-(--c-ink5)">{c.teacher}</span>}
                    </button>
                  )
                })}
              </div>
            </div>
          ))}
          {tasks.length > 0 && (
            <div>
              <div className="px-1.5 text-[11.5px] font-medium text-(--c-ink4)">待办</div>
              <div className="mt-1.5 overflow-hidden rounded-[14px] bg-(--c-surface) p-1">
                {tasks.map((t) => {
                  const course = state.courses.find((c) => c.id === t.courseId)
                  return (
                    <button key={t.id} onClick={() => onPickTask(t)} className={`flex w-full items-center rounded-[10px] px-2.5 py-2.5 text-left transition-colors active:bg-(--c-surface2) ${t.done ? 'opacity-45' : ''}`}>
                      <i className="mr-3 h-[26px] w-[3px] flex-none rounded-full" style={{ background: course?.color ?? 'var(--c-ink5)' }} />
                      <div className="min-w-0 flex-1">
                        <div className={`truncate text-[13.5px] font-semibold ${t.done ? 'line-through' : ''}`}><Hit text={t.title || '板书'} q={q} /></div>
                        <div className="mt-[2px] truncate text-[11.5px] font-medium text-(--c-ink4)">
                          {course?.name ?? TASK_KIND_LABEL[t.kind]}，{dueText(t.due, t.dueMinutes, today)}
                        </div>
                      </div>
                      {t.kind === 'exam' && <span className="ml-2 flex-none rounded-[5px] bg-(--c-rose-soft) px-1.5 py-[2px] text-[10px] font-extrabold text-(--c-rose)">考试</span>}
                    </button>
                  )
                })}
              </div>
            </div>
          )}
          {q.trim() && groups.length === 0 && tasks.length === 0 && (
            <div className="rounded-[14px] bg-(--c-surface) px-4 py-5 text-center text-[13px] font-medium text-(--c-ink4)">没有匹配的结果</div>
          )}
        </div>
      </div>
    </div>
  )
}

/* ---------------- 导入 ---------------- */

const KIND_LABEL: Record<RuleInputKind, string> = { csv: 'CSV', json: 'JSON', html: 'HTML', xlsx: 'Excel', ics: '.ics 文件', script: '脚本' }
const KIND_HINT: Record<RuleInputKind, string> = {
  csv: '课程,教师,地点,星期,节次,周次',
  json: '{"courses":[{"name":"高等数学","day":1,"startNode":1,"step":2,"weeks":"1-16"}]}',
  html: '粘贴教务课表页面的 HTML',
  xlsx: '选择教务导出的 .xlsx 文件',
  ics: 'BEGIN:VCALENDAR …',
  script: '粘贴要解析的文本',
}

type ImportStage = 'input' | 'preview'

/* 规则列表（内页）：选中一条直接进导入流程 */
function ImportPage({ onBack, onManual, onEditRule, onRun, onAi, onEdu, onScan }: { onBack: () => void; onManual: () => void; onEditRule: (r: RuleManifest | 'new') => void; onRun: (ruleId: string) => void; onAi: () => void; onEdu: () => void; onScan: () => void }) {
  const state = useStore()
  const rules = [...state.savedRules].sort((a, b) => a.createdAt - b.createdAt)

  return (
    <Page>
      <div className="flex-1 overflow-y-auto px-5 pb-10 [scrollbar-width:none]">
        <TopBar title="导入课表" onBack={onBack} />

        <div className="mt-6 divide-y divide-(--c-surface2) overflow-hidden rounded-[16px] bg-(--c-surface)">
          <Row title="从教务系统导入" badge="推荐" onClick={onEdu} />
          <Row title="导入课表文件" onClick={() => onRun('builtin-ics')} />
          <Row title="扫码导入" onClick={onScan} />
        </div>

        <div className="mt-6 text-[12.5px] font-semibold text-(--c-ink3)">规则</div>
        <div className="mt-2.5 overflow-hidden rounded-[16px] bg-(--c-surface)">
          {rules.map((r, i) => (
            <div key={r.id} className={i > 0 ? 'border-t border-(--c-surface2)' : ''}>
              <Row title={r.name} onClick={() => onRun(r.id)} />
            </div>
          ))}
        </div>

        <div className="mt-6 text-[12.5px] font-semibold text-(--c-ink3)">更多</div>
        <div className="mt-2.5 overflow-hidden rounded-[16px] bg-(--c-surface)">
          <Row title="让 AI 转换课表" onClick={onAi} />
          <div className="border-t border-(--c-surface2)" />
          <Row title="自定义规则" onClick={() => onEditRule('new')} />
          <div className="border-t border-(--c-surface2)" />
          <Row title="手动添加课程" onClick={onManual} />
        </div>
      </div>
    </Page>
  )
}

/* Prompt 高亮：引号内字符串、列表符号、标题分别着色 */
function promptTokens(line: string): [string, 'k' | 'p' | 's'][] {
  const out: [string, 'k' | 'p' | 's'][] = []
  const lead = /^(\s*(?:[-#]+\s|\d+\.\s))/.exec(line)
  if (lead) {
    out.push([lead[1], 'p'])
    line = line.slice(lead[1].length)
  }
  const re = /"[^"]*"/g
  let last = 0
  for (const m of line.matchAll(re)) {
    if (m.index > last) out.push([line.slice(last, m.index), 's'])
    out.push([m[0], 'k'])
    last = m.index + m[0].length
  }
  if (last < line.length) out.push([line.slice(last), 's'])
  return out
}

/* AI 转换课表：复制 Prompt → AI 输出 JSON → 粘贴 → 走 JSON 规则解析 */
function AiImportPage({ onBack, onNext, attach }: { onBack: () => void; onNext: (text: string) => void; attach?: string }) {
  const [text, setText] = useState('')
  const [copied, setCopied] = useState(false)
  const ta = useRef<HTMLTextAreaElement>(null)
  const copy = async () => {
    if (await copyText(attach ? `${AI_IMPORT_PROMPT.trimEnd()}\n\n—— 课表页面文字 ——\n${attach}` : AI_IMPORT_PROMPT)) {
      setCopied(true)
      haptic('success')
      nativeToast('已复制')
      window.setTimeout(() => setCopied(false), 1500)
    } else {
      haptic('error')
      nativeToast('复制失败')
    }
  }
  const paste = async () => {
    const t = await pasteText()
    if (t.trim()) {
      setText(t)
      return
    }
    nativeToast('剪贴板为空')
    ta.current?.focus()
  }
  const lines = AI_IMPORT_PROMPT.trimEnd().split('\n')
  return (
    <Page>
      <div className="flex-1 overflow-y-auto px-5 pb-6 [scrollbar-width:none]">
        <TopBar title="让 AI 转换课表" sub={attach ? '复制这段 Prompt（已附上课表页面文字）交给任意 AI，输出后粘贴即可' : '复制这段 Prompt 连同课表交给任意 AI，输出后粘贴即可'} onBack={onBack} />

        <div className="relative mt-6 rounded-[16px] bg-(--c-surface) px-4 py-4">
          <button onClick={copy} className="absolute top-1.5 right-1.5 flex h-10 w-10 items-center justify-center rounded-full transition-opacity active:opacity-60">
            {copied ? (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" style={{ stroke: 'var(--c-accent)' }} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="m5 12 5 5L20 7" /></svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" style={{ stroke: 'var(--c-ink2)' }} strokeWidth="1.9"><rect x="9" y="9" width="11" height="11" rx="2.5" /><path d="M15 5.5A2.5 2.5 0 0 0 12.5 3h-6A3.5 3.5 0 0 0 3 6.5v6A2.5 2.5 0 0 0 5.5 15" /></svg>
            )}
          </button>
          <div className="relative h-[168px] overflow-hidden">
            {lines.map((line, i) => (
              <div key={i} className="pr-10 font-mono text-[11.5px] leading-[1.95]">
                {line === '' ? '\u00a0' : promptTokens(line).map(([t, c], j) => (
                  <span
                    key={j}
                    className="whitespace-pre-wrap"
                    style={{ color: c === 'k' ? 'var(--c-accent)' : c === 'p' ? 'var(--c-ink5)' : 'var(--c-ink2)', fontWeight: c === 'k' ? 700 : 500 }}
                  >
                    {t}
                  </span>
                ))}
              </div>
            ))}
            <div
              aria-hidden
              className="pointer-events-none absolute inset-x-0 bottom-0 h-20"
              style={{ background: 'linear-gradient(to bottom, transparent, var(--c-surface))' }}
            />
          </div>
        </div>

        <div className="mt-4 rounded-[16px] bg-(--c-surface) px-4 py-3.5">
          <div className="flex items-center justify-between">
            <span className="text-[11.5px] font-semibold text-(--c-ink4)">AI 输出的课表</span>
            <TextAction onClick={paste}>粘贴</TextAction>
          </div>
          <textarea
            ref={ta}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="在这里粘贴 AI 输出的 JSON"
            className="mt-2 h-40 w-full resize-none bg-transparent font-mono text-[12.5px] leading-[1.5] outline-none placeholder:text-(--c-ink5)"
          />
        </div>
      </div>

      <div className="flex-none px-5 pt-2 pb-[max(22px,env(safe-area-inset-bottom))]">
        <PrimaryButton disabled={!text.trim()} onClick={() => onNext(text)}>解析并预览</PrimaryButton>
      </div>
    </Page>
  )
}

/* 解析出来的课程卡片：与原型的课程行同一套视觉 */
function ParsedRow({ nc, sem }: { nc: NormalizedCourse; sem: Semester }) {
  const r = nc.rules[0]
  const weeks = r ? maskToWeeks(r.weeksMask) : []
  const span = weeks.length === 0
    ? ''
    : weeks.length === weeks[weeks.length - 1] - weeks[0] + 1
      ? `第 ${weeks[0]}–${weeks[weeks.length - 1]} 周`
      : weeks.every((w) => w % 2 === weeks[0] % 2)
        ? `第 ${weeks[0]}–${weeks[weeks.length - 1]} 周${weeks[0] % 2 === 1 ? '单' : '双'}`
        : `${weeks.length} 周`
  const slot = r ? `${WD[r.weekday]} ${r.startPeriod}–${r.endPeriod} 节` : '—'
  const time = r ? `${fmtMinutes(sem.timeGrid[r.startPeriod - 1]?.start ?? 0)}–${fmtMinutes(sem.timeGrid[r.endPeriod - 1]?.end ?? 0)}` : ''
  return (
    <div className="flex items-center px-4 py-3">
      <i className="mr-3 h-[26px] w-[3px] flex-none rounded-full" style={{ background: nc.course.color }} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[14px] font-bold">{nc.course.name}</div>
        <div className="mt-0.5 truncate text-[12px] font-medium text-(--c-ink4)">
          {[slot, time, span, r?.location, nc.course.teacher].filter(Boolean).join('，')}
        </div>
      </div>
      {nc.rules.length > 1 && <span className="ml-2 flex-none text-[11.5px] font-semibold text-(--c-ink5)">{nc.rules.length} 段</span>}
    </div>
  )
}

/* 导入流程（内页）：输入 → 解析结果 → 回到课表 */
function ImportRunPage({ rule, initialText, initialOut, autoRun, overBrowser, syncSource, onBack, onDone }: { rule: RuleManifest; initialText?: string; initialOut?: RuleOutput; autoRun?: boolean; /** 盖在内置浏览器上：透明模式下仍保持可见且不透明，退回时从学校页面上滑走 */ overBrowser?: boolean; /** 教务导入：可选保持登录自动更新 */ syncSource?: EduSyncSource; onBack: () => void; onDone: () => void }) {
  const [stage, setStage] = useState<ImportStage>(initialOut ? 'preview' : 'input')
  const eduSync = useEduSync()
  const [keepLogin, setKeepLogin] = useState(!!eduSync?.enabled)
  /* 正方 + 有账号密码：会话过期时能自己重新登录，不用等人工。存本机，退出登录会删 */
  const [cred, setCred] = useState(() => ({ user: eduSync?.user ?? '', password: eduSync?.password ?? '' }))
  /* 这个入口的学校是不是正方——只有正方能用账号密码在后台自己重登 */
  const zfLoginable = !!syncSource && detectSystem(syncSource.school.url, syncSource.school.system) === 'zhengfang_new'
  /* 保持登录需要系统 WebView 支持多 Profile，不支持就不显示 */
  const [canKeep, setCanKeep] = useState(false)
  useEffect(() => {
    if (!syncSource) return
    let alive = true
    void edu.profiles().then((ok) => alive && setCanKeep(ok))
    return () => {
      alive = false
    }
  }, [syncSource])
  const [text, setText] = useState(initialText ?? '')
  const [fileBytes, setFileBytes] = useState<Uint8Array | null>(null)
  const [fileName, setFileName] = useState('')
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState<'' | 'fetch' | 'parse'>('')
  const [error, setError] = useState('')
  const [out, setOut] = useState<RuleOutput | null>(initialOut ?? null)
  const [useFileGrid, setUseFileGrid] = useState(false)
  const [sem] = useState<Semester>(() => store.state.semester ?? defaultSemester(mondayOf(todayStr())))

  /* 文件里的节次表：和当前不同才算“带了作息” */
  const fileGrid = useMemo(() => {
    const g = out?.timeGrid
    if (!g || g.length === 0) return null
    return JSON.stringify(g) === JSON.stringify(sem.timeGrid) ? null : g
  }, [out, sem.timeGrid])

  /* 当前学期已结束且有内容：这次导入封存旧学期，开一个新学期，不和旧课合并 */
  const rollover = !!store.state.semester && semesterEnded(sem) && (store.state.courses.length > 0 || store.state.entries.length > 0)

  /* 导入后的学期：作息取文件或当前，课程超出节次表时往后补齐 */
  const target = useMemo<Semester>(() => {
    if (!out) return sem
    const meta = out.semester ?? {}
    const grid = useFileGrid && fileGrid ? fileGrid : sem.timeGrid
    const need = Math.min(20, Math.max(0, ...out.courses.map((c) => c.endPeriod)))
    if (!rollover) return { ...sem, ...meta, timeGrid: extendGrid(grid, need) }
    const startDate = meta.startDate ?? mondayOf(todayStr())
    return {
      ...sem,
      id: uid(),
      name: meta.name ?? guessSemesterName(startDate),
      startDate,
      totalWeeks: meta.totalWeeks ?? sem.totalWeeks,
      vacations: [],
      examWeeks: [],
      timeGrid: extendGrid(grid, need),
    }
  }, [out, sem, fileGrid, useFileGrid, rollover])
  const pending = useMemo(() => (out ? normalize(out, target) : null), [out, target])
  const preview = useMemo(() => (pending ? (rollover ? diffImport([], pending.courses, new Set()) : store.previewImport(pending.courses)) : null), [pending, rollover])

  const parse = async () => {
    setBusy('parse')
    setError('')
    try {
      const res: RuleOutput = await runRule(rule, { text, bytes: fileBytes ?? undefined }, sem)
      const g = res.timeGrid
      const differs = !!g && g.length > 0 && JSON.stringify(g) !== JSON.stringify(sem.timeGrid)
      // 当前作息还是出厂默认、或文件是课程表自己导出的：默认采用文件里的；用户改过的作息不自动覆盖
      setUseFileGrid(differs && (!!res.semester || isDefaultGrid(sem.timeGrid)))
      setOut(res)
      setStage('preview')
    } catch (e) {
      setError(e instanceof Error ? e.message : '解析失败')
    } finally {
      setBusy('')
    }
  }

  const confirm = () => {
    if (!pending) return
    const t0 = performance.now()
    const failed = pending.diagnostics.filter((d) => d.level === 'error').length
    const hadCourses = store.state.courses.length > 0
    if (rollover) store.startSemester(target)
    else store.setSemester(target)
    store.applyImport(pending.courses, {
      id: uid(), semesterId: target.id,
      ruleId: rule.id, ruleName: rule.name, ruleVersion: rule.version,
      at: Date.now(), durationMs: Math.max(1, Math.round(performance.now() - t0)),
      failed, diagnostics: pending.diagnostics,
    })
    if (syncSource && canKeep) {
      if (keepLogin) {
        enableEduSync({
          ...syncSource,
          /* 只带填了的过去；留空表示沿用之前存的，不覆盖成空 */
          user: zfLoginable ? cred.user.trim() || undefined : undefined,
          password: zfLoginable ? cred.password || undefined : undefined,
        })
      } else if (eduSync) setEduSyncEnabled(false)
    }
    onDone()
  }

  const grab = async () => {
    setBusy('fetch')
    setError('')
    try {
      const res = await fetchUrl(url.trim())
      setText(res.text)
    } catch (e) {
      setError(e instanceof Error ? e.message : '抓取失败，可以改用复制粘贴')
    } finally {
      setBusy('')
    }
  }

  const errors = pending?.diagnostics.filter((d) => d.level === 'error') ?? []

  /* 文件是用课程表直接打开的（或在页内选了文件）：不经过粘贴页，直接给预览 */
  const auto = useRef(autoRun && !!initialText)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!auto.current) return
    auto.current = false
    void parse()
  }, [tick])

  return (
    <Page keep={overBrowser ? 'opaque' : undefined}>
      <div className="flex-1 overflow-y-auto px-5 pb-6 [scrollbar-width:none]">
        <TopBar
          title={stage === 'input' ? rule.name : `${pending?.courses.length ?? 0} 门课`}
          sub={stage === 'input' ? KIND_LABEL[rule.input] : undefined}
          onBack={stage === 'preview' && !initialOut ? () => setStage('input') : onBack}
        />

        <AnimatePresence mode="wait" initial={false}>
          <motion.div key={stage} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={FADE}>
            {stage === 'input' && (
              <div className="mt-6">
                {rule.input === 'xlsx' ? (
                  <label className="flex w-full cursor-pointer items-center justify-center rounded-[16px] bg-(--c-surface) py-10 text-[13.5px] font-semibold text-(--c-ink2)">
                    {fileName || '选择 .xlsx 文件'}
                    <input
                      type="file"
                      accept=".xlsx"
                      className="hidden"
                      onChange={async (e) => {
                        const f = e.target.files?.[0]
                        if (!f) return
                        setFileBytes(new Uint8Array(await f.arrayBuffer()))
                        setFileName(f.name)
                      }}
                    />
                  </label>
                ) : (
                  <>
                    {rule.input === 'ics' && (
                      <label className="mb-2.5 flex w-full cursor-pointer items-center justify-center rounded-[16px] bg-(--c-surface) py-10 text-[13.5px] font-semibold text-(--c-ink2)">
                        {fileName || '选择 .ics 文件'}
                        <input
                          type="file"
                          accept=".ics,text/calendar"
                          className="hidden"
                          onChange={async (e) => {
                            const f = e.target.files?.[0]
                            if (!f) return
                            setFileName(f.name)
                            setText(await f.text())
                            auto.current = true
                            setTick((n) => n + 1)
                          }}
                        />
                      </label>
                    )}
                    <div className="flex items-center gap-3 rounded-[16px] bg-(--c-surface) px-4 py-2.5">
                      <TextInput value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https:// 链接" className="min-w-0 flex-1 text-[13px]" />
                      <TextAction disabled={!url.trim() || busy !== ''} busy={busy === 'fetch'} onClick={grab}>抓取</TextAction>
                    </div>
                    <textarea
                      value={text}
                      onChange={(e) => setText(e.target.value)}
                      placeholder={KIND_HINT[rule.input]}
                      className="mt-2.5 h-64 w-full rounded-[16px] bg-(--c-surface) p-3.5 font-mono text-[12px] leading-relaxed outline-none placeholder:text-(--c-ink5) focus:ring-1 focus:ring-(--c-accent-line)"
                    />
                  </>
                )}
                {error && <div className="mt-2.5 px-1 text-[12.5px] font-medium text-(--c-danger)">{error}</div>}
              </div>
            )}

            {stage === 'preview' && pending && preview && (
              <div className="mt-6">
                <div className="flex items-baseline gap-4 px-1 text-[12.5px] font-semibold tabular-nums">
                  {preview.added.length > 0 && <span className="text-(--c-accent)">新增 {preview.added.length}</span>}
                  {preview.changed.length > 0 && <span className="text-(--c-ink)">调整 {preview.changed.length}</span>}
                  {preview.unchanged > 0 && <span className="text-(--c-ink3)">不变 {preview.unchanged}</span>}
                  {preview.protectedKept.length > 0 && <span className="text-(--c-ink3)">保留改动 {preview.protectedKept.length}</span>}
                  {preview.removed.length > 0 && <span className="text-(--c-danger)">消失 {preview.removed.length}</span>}
                </div>
                {(out?.semester || rollover) && (
                  <div className="mt-1.5 px-1 text-[12.5px] font-semibold tabular-nums text-(--c-ink4)">{`${target.name}，${md(target.startDate)} 开学，共 ${target.totalWeeks} 周`}</div>
                )}
                {rollover && (
                  <div className="mt-2.5 rounded-[16px] bg-(--c-surface) px-4 py-3 text-[12.5px] font-medium text-(--c-ink3)">
                    <span className="font-bold text-(--c-ink)">开始新学期</span>　{sem.name}已结束，将移入往期学期
                  </div>
                )}

                {initialOut && pending.courses.length > 0 && (
                  <div className="mt-2.5">
                    <PreviewGrid courses={pending.courses} periods={target.timeGrid.length} />
                  </div>
                )}

                {fileGrid && (
                  <div className="mt-2.5 flex items-center rounded-[16px] bg-(--c-surface) px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <div className="text-[14px] font-bold">采用文件里的作息时间</div>
                      <div className="mt-0.5 truncate text-[12px] font-medium tabular-nums text-(--c-ink4)">
                        {`${fileGrid.length} 节 ${fmtMinutes(fileGrid[0].start)}–${fmtMinutes(fileGrid[fileGrid.length - 1].end)}，当前 ${sem.timeGrid.length} 节`}
                      </div>
                    </div>
                    <Switch on={useFileGrid} onChange={setUseFileGrid} />
                  </div>
                )}

                {syncSource && canKeep && (
                  <div className="mt-2.5 flex items-center rounded-[16px] bg-(--c-surface) px-4 py-3">
                    <div className="min-w-0 flex-1 text-[14px] font-bold">保持登录，自动更新课表</div>
                    <Switch on={keepLogin} onChange={setKeepLogin} />
                  </div>
                )}

                {syncSource && canKeep && keepLogin && zfLoginable && (
                  <div className="mt-2.5 overflow-hidden rounded-[16px] bg-(--c-surface)">
                    <div className="flex items-center gap-3 px-4 pt-3 pb-2.5">
                      <span className="w-[38px] flex-none text-[12.5px] font-medium text-(--c-ink4)">学号</span>
                      <TextInput
                        value={cred.user}
                        onChange={(e) => setCred({ ...cred, user: e.target.value })}
                        placeholder="学号 / 用户名"
                        autoCapitalize="off"
                        autoCorrect="off"
                        spellCheck={false}
                        className="min-w-0 flex-1 text-[13px]"
                      />
                    </div>
                    <div className="flex items-center gap-3 px-4 pb-3">
                      <span className="w-[38px] flex-none text-[12.5px] font-medium text-(--c-ink4)">密码</span>
                      <TextInput
                        type="password"
                        value={cred.password}
                        onChange={(e) => setCred({ ...cred, password: e.target.value })}
                        placeholder="教务系统密码"
                        autoCapitalize="off"
                        autoCorrect="off"
                        spellCheck={false}
                        className="min-w-0 flex-1 text-[13px]"
                      />
                    </div>
                    <div className="px-4 pb-3 text-[11.5px] leading-[1.5] font-medium text-(--c-ink4)">
                      填了就不用等会话过期再来手动登录。只存在这台手机上，退出登录会删掉。
                    </div>
                  </div>
                )}

                <div className="mt-2.5 divide-y divide-(--c-surface2) overflow-hidden rounded-[16px] bg-(--c-surface)">
                  {pending.courses.map((nc) => (
                    <ParsedRow key={nc.course.identityKey} nc={nc} sem={target} />
                  ))}
                  {pending.courses.length === 0 && (
                    <div className="px-4 py-8 text-center text-[13px] font-medium text-(--c-ink4)">没有解析出课程</div>
                  )}
                </div>

                {preview.removed.length > 0 && (
                  <div className="mt-4 rounded-[16px] bg-(--c-surface) px-4 py-3.5 text-[12.5px] font-medium text-(--c-ink3)">
                    <span className="font-bold text-(--c-danger)">进回收站</span>　{preview.removed.map((c) => c.name).join('、')}
                  </div>
                )}

                {errors.length > 0 && (
                  <>
                    <div className="mt-5 text-[12.5px] font-semibold text-(--c-ink3)">{errors.length} 条无法解析</div>
                    <div className="mt-2 space-y-2">
                      {errors.map((d, i) => (
                        <div key={i} className="rounded-[12px] bg-(--c-surface) px-3.5 py-2.5">
                          <div className="text-[12.5px] font-bold text-(--c-danger)">{d.message}</div>
                          {d.at?.snippet && <div className="mt-1 truncate font-mono text-[11px] text-(--c-ink4)">{d.at.snippet}</div>}
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}
          </motion.div>
        </AnimatePresence>
      </div>

      <div className="flex-none px-5 pt-2 pb-[max(22px,env(safe-area-inset-bottom))]">
        {stage === 'input' ? (
          <PrimaryButton disabled={busy === 'fetch' || (rule.input === 'xlsx' ? !fileBytes : !text.trim())} busy={busy === 'parse'} onClick={parse}>解析</PrimaryButton>
        ) : (
          <PrimaryButton disabled={(pending?.courses.length ?? 0) === 0} onClick={confirm}>导入</PrimaryButton>
        )}
      </div>
    </Page>
  )
}

/* ---------------- 规则编辑 ---------------- */

const SCRIPT_TEMPLATE = `// 输入整段文本，返回课程数组
function parse(input) {
  return { courses: input.split('\\n').filter(Boolean).map(line => {
    const [name, teacher, location, weekday, sp, ep, weeks] = line.split(',')
    return { name, teacher, location, weekday: Number(weekday), startPeriod: Number(sp), endPeriod: Number(ep), weeks }
  }), diagnostics: [] }
}`

function bumpVersion(v: string): string {
  const [a, b] = v.split('.').map((n) => parseInt(n, 10) || 0)
  return `${a}.${b + 1}`
}

function RuleEditorPage({ rule, onBack }: { rule: RuleManifest | null; onBack: () => void }) {
  const KINDS: RuleInputKind[] = ['csv', 'json', 'html', 'xlsx', 'ics', 'script']
  const [name, setName] = useState(rule?.name ?? '')
  const [input, setInput] = useState<RuleInputKind>(rule?.input ?? 'csv')
  const [script, setScript] = useState(rule?.script ?? SCRIPT_TEMPLATE)
  const builtin = !!rule?.id.startsWith('builtin-')

  const save = () => {
    const next: RuleManifest = {
      id: rule?.id ?? uid(),
      name: name.trim() || KIND_LABEL[input],
      version: rule ? bumpVersion(rule.version) : '1.0',
      input,
      csv: input === 'csv' || input === 'xlsx' ? (rule?.csv ?? DEFAULT_CSV_MAPPING) : undefined,
      html: input === 'html' ? (rule?.html ?? { mode: 'grid' }) : undefined,
      script: input === 'script' ? script : undefined,
      samples: rule?.samples,
      createdAt: rule?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
    }
    store.saveRule(next)
    onBack()
  }

  return (
    <Page>
      <div className="flex-1 overflow-y-auto px-5 pb-10 [scrollbar-width:none]">
        <TopBar title={rule ? '编辑规则' : '添加规则'} onBack={onBack} />

        <div className="mt-6 divide-y divide-(--c-surface2) overflow-hidden rounded-[16px] bg-(--c-surface)">
          <Field k="规则名"><TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder={KIND_LABEL[input]} /></Field>
        </div>

        <div className="mt-5 text-[12.5px] font-semibold text-(--c-ink3)">输入类型</div>
        <div className="mt-2.5">
          <Chips items={KINDS.map((k) => KIND_LABEL[k])} active={KINDS.indexOf(input)} onPick={(i) => setInput(KINDS[i])} />
        </div>

        {input === 'script' && (
          <>
            <textarea
              value={script}
              onChange={(e) => setScript(e.target.value)}
              spellCheck={false}
              className="mt-4 h-56 w-full rounded-[16px] bg-(--c-surface) p-3.5 font-mono text-[11.5px] leading-relaxed outline-none focus:ring-1 focus:ring-(--c-accent-line)"
            />
          </>
        )}

        {rule && !builtin && (
          <div className="mt-5 overflow-hidden rounded-[16px] bg-(--c-surface)">
            <Row title="删除规则" danger onClick={() => { store.removeRule(rule.id); onBack() }} right={<span />} />
          </div>
        )}
      </div>
      <div className="flex-none px-5 pt-2 pb-[max(22px,env(safe-area-inset-bottom))]">
        <PrimaryButton onClick={save}>保存</PrimaryButton>
      </div>
    </Page>
  )
}

/* ---------------- 我的 ---------------- */

type MePage = 'semester' | 'schedule' | 'history' | 'trash' | 'courses' | 'import' | 'share' | 'eduAuto' | 'changes' | 'widget' | 'theme' | 'profile' | 'stats' | 'erase'

/* 「我的」页的分组：普通分组是一列可点的行，提醒分组原地展开，不跳页 */
type MeGroup = { kind: 'rows'; title: string; rows: [string, string, MePage][] } | { kind: 'remind' }

const WIDGET_LABEL: Record<WidgetStyle, string> = {
  today: '今日课程',
  next: '下一节',
  twoDays: '今天与明天',
  week: '本周课表',
}

function MeView({ onPage, onPref, onCalendar }: { onPage: (p: MePage) => void; onPref: (k: PrefKey) => void; onCalendar: () => void }) {
  const state = useStore()
  const theme = useTheme()
  const sem = state.semester
  const trashCount = state.courses.filter((c) => c.removedByImport).length
  const live = state.courses.filter((c) => !c.removedByImport)
  const week = sem ? weekOf(sem, todayStr()) : 0
  /* 顶部三格：门课 / 每周节数 / 未完成待办。调整次数只在「记录」里看，这里换成能一眼判断忙不忙的指标 */
  const weekly = weekPeriods(state)
  const openTasks = openTasksOf(state)
  const edu = useEduSync()
  /* 自动更新那行的右侧摘要：没绑过、关着、按启动还是按小时 */
  const eduLabel = !edu
    ? '未设置'
    : !edu.enabled
      ? '已关闭'
      : edu.mode === 'launch'
        ? '每次启动'
        : `每 ${edu.intervalHours} 小时`

  const groups: MeGroup[] = [
    { kind: 'rows', title: '课表', rows: [
      ['学期', sem ? (semesterEnded(sem) ? `${sem.name}，已结束` : `${sem.name}，第 ${Math.max(0, Math.min(sem.totalWeeks, week))} / ${sem.totalWeeks} 周`) : '未设置', 'semester'],
      ['作息时间', '', 'schedule'],
      ['课程', `${live.length} 门`, 'courses'],
      ['导入课表', '', 'import'],
      ['分享课表', '', 'share'],
      ['自动更新', eduLabel, 'eduAuto'],
    ] },
    { kind: 'remind' },
    { kind: 'rows', title: '外观', rows: [
      ['主题', THEME_LABEL[theme], 'theme'],
    ] },
    { kind: 'rows', title: '记录', rows: [
      ['变更记录', `${state.changes.length + state.overrides.length} 条`, 'changes'],
      ['导入历史', `${state.batches.length} 次`, 'history'],
      ['回收站', trashCount > 0 ? `${trashCount} 门` : '空', 'trash'],
    ] },
    { kind: 'rows', title: '数据', rows: [
      ['清除数据', '', 'erase'],
    ] },
  ]
  const avatar = usePhotoSrc(state.prefs.avatar)
  const wall = usePhotoSrc(state.prefs.wall)

  const meHero = useRef<HTMLDivElement>(null)
  const meHead = useRef<HTMLDivElement>(null)
  /* 头图在标题下面时不起白色羽化（原型里标题是直接写在图上的白字），等头图滑过标题区下沿之后才接上常规羽化 */
  const meVeil = useVeilOpacity(meHero, () => (meHero.current?.offsetHeight ?? 258) - (meHead.current?.offsetHeight ?? 0))
  /* 标题字色：头图顶部的暗色带（92px）滑走后就换成深色 */
  const meInkRaw = useVeilOpacity(meHero, () => 60)
  const meInk = useTransform(meInkRaw, (v) => Math.max(0, Math.min(1, v)))
  const meWhite = useTransform(meInk, (v) => 1 - v)
  return (
    <>
      <div ref={meHead} className="pointer-events-none absolute inset-x-0 top-0 z-[30] isolate px-5 pt-[max(52px,calc(env(safe-area-inset-top)+22px))] pb-3">
        <TopVeil progress={meVeil} />
        <span className="relative inline-block text-[15px] font-bold tracking-[-.01em]">
          <motion.span style={{ opacity: meWhite }} className="text-white drop-shadow-[0_1px_6px_rgba(0,0,0,.35)]">我的</motion.span>
          <motion.span style={{ opacity: meInk }} className="absolute inset-0 text-(--c-ink)">我的</motion.span>
        </span>
      </div>
      <div className="relative flex-1 overflow-y-auto pb-[130px] [scrollbar-width:none]">
        {/* 横屏或矮屏（平板横放、手机横放）时头图按屏高收一档，否则一屏里全是背景图 */}
        <div ref={meHero} className="relative h-[258px] overflow-hidden bg-(--c-bg) [@media(max-height:640px)]:h-[186px]">
          <button onClick={() => onPage('profile')} className="absolute inset-0 transition-opacity active:opacity-85">
            {wall ? <img src={wall} alt="" className="h-full w-full object-cover object-[50%_32%]" /> : <WallPlaceholder />}
          </button>
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-[150px] bg-gradient-to-t from-(--c-bg) via-(--c-bg)/70 to-transparent" />
          {wall && <div className="pointer-events-none absolute inset-x-0 top-0 h-[92px] bg-gradient-to-b from-black/25 to-transparent" />}
          <button onClick={() => onPage('profile')} className="absolute inset-x-5 bottom-3 flex items-end text-left transition-opacity active:opacity-70">
            {avatar ? (
              <img src={avatar} alt="" className="h-[62px] w-[62px] flex-none rounded-full border-[1.5px] border-(--c-bg) bg-(--c-accent) object-cover" />
            ) : (
              <AvatarPlaceholder size={62} />
            )}
            <div className="mb-1 ml-3.5 flex-1">
              <div className="text-[19px] font-extrabold tracking-[-.02em] text-(--c-ink)">{state.prefs.name || sem?.name || '我的课表'}</div>
              <div className="mt-[3px] flex items-center gap-2.5 text-[12px] font-semibold text-(--c-ink3)">
                <span>{sem ? `第 ${Math.max(0, Math.min(sem.totalWeeks, week))} / ${sem.totalWeeks} 周` : '未设置学期'}</span>
                {sem && <span className="tabular-nums text-(--c-ink5)">{md(sem.startDate)} 起</span>}
              </div>
            </div>
          </button>
        </div>

        <div className="px-5">
          <button onClick={() => onPage('stats')} className="flex w-full rounded-[18px] bg-(--c-surface) px-4 py-3.5 transition-opacity active:opacity-60">
            {[[String(live.length), '门课'], [String(weekly), '本周节数'], [String(openTasks), '项待办']].map(([n, l], i) => (
              <div key={l} className={`flex-1 ${i ? 'border-l border-(--c-surface2)' : ''}`}>
                <div className="text-center text-[17px] font-extrabold tabular-nums text-(--c-ink)">{n}</div>
                <div className="mt-0.5 text-center text-[11px] font-semibold text-(--c-ink4)">{l}</div>
              </div>
            ))}
          </button>

          {groups.map((g) => (g.kind === 'remind' ? (
            <RemindGroup key="remind" onPick={onPref} onPermission={onCalendar} />
          ) : (
            <div key={g.title} className="mt-5">
              <div className="px-0.5 text-[12px] font-bold tracking-[-.01em] text-(--c-ink5)">{g.title}</div>
              <div className="mt-2 rounded-[18px] bg-(--c-surface) px-4">
                {g.rows.map(([k, v, page], i) => (
                  <button
                    key={k}
                    onClick={() => onPage(page)}
                    className={`flex w-full items-center py-3.5 text-left transition-opacity active:opacity-60 ${i ? 'border-t border-(--c-surface2)' : ''}`}
                  >
                    <span className="flex-1 text-[14px] font-semibold text-(--c-ink)">{k}</span>
                    <span className="text-[12.5px] font-medium text-(--c-ink4)">{v}</span>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" style={{ stroke: 'var(--c-ink5)' }} strokeWidth="2.2" className="ml-2"><path d="m9 5 7 7-7 7" /></svg>
                  </button>
                ))}
              </div>
            </div>
          )))}
        </div>
      </div>
    </>
  )
}

/* 头像 / 背景：自选照片先用直接路径再换成可显示的；没选就返回空串，由调用处显示占位 */
function usePhotoSrc(path: string): string {
  const [src, setSrc] = useState(() => (path ? photoSrc(path) : ''))
  useEffect(() => {
    if (!path) {
      setSrc('')
      return
    }
    let alive = true
    setSrc(photoSrc(path))
    void loadPhotoSrc(path).then((s) => alive && setSrc(s))
    return () => {
      alive = false
    }
  }, [path])
  return src
}

/* 没设头像时的占位：主题色圆底 + 人形 */
function AvatarPlaceholder({ size }: { size: number }) {
  return (
    <span
      className="grid flex-none place-items-center rounded-full text-white"
      style={{ width: size, height: size, background: 'var(--c-accent)', boxShadow: '0 0 0 1.5px var(--c-bg)' }}
    >
      <svg width={size * 0.52} height={size * 0.52} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
        {ICON.user}
      </svg>
    </span>
  )
}

/* 没设背景图时的占位：主题色到页面底的渐变 */
function WallPlaceholder() {
  return <div className="absolute inset-0" style={{ background: 'linear-gradient(160deg, var(--c-accent-soft), var(--c-bg) 72%)' }} />
}

const periodsOf = (r: SessionRule) => r.endPeriod - r.startPeriod + 1
const fmtNum = (n: number) => String(Math.round(n * 10) / 10)

/** 本周有几节课：按本周真正生效的规则数一遍，和课表上看到的那一屏对得上。
 *  不用「整学期平均」——它会把只上前八周的课摊薄，和课表上的数字对不上，反而更像错数。
 *  统计页和「我的」顶部共用这一份。 */
function weekPeriods(state: State): number {
  const sem = state.semester
  if (!sem || sem.totalWeeks <= 0) return 0
  const w = Math.max(1, Math.min(sem.totalWeeks, weekOf(sem, todayStr())))
  const ids = new Set(state.courses.filter((c) => !c.removedByImport).map((c) => c.id))
  let n = 0
  for (const r of state.rules) if (ids.has(r.courseId) && maskHasWeek(r.weeksMask, w)) n += periodsOf(r)
  return n
}

/** 还没做完的待办（作业 + 考试），做完就不再计入 */
const openTasksOf = (state: State) => state.tasks.filter((t) => !t.done).length

type PhotoTarget = 'avatar' | 'wall'

function CameraBadge({ className }: { className: string }) {
  return (
    <span className={`grid place-items-center rounded-full ${className}`}>
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">{ICON.camera}</svg>
    </span>
  )
}

/* 个人资料：顶部就是「我」页头图的缩影，点背景换背景、点头像换头像；已自定义时弹出「从相册选择 / 恢复默认」 */
function ProfilePage({ onBack, onPick }: { onBack: () => void; onPick: (t: PhotoTarget) => void }) {
  const state = useStore()
  const avatar = usePhotoSrc(state.prefs.avatar)
  const wall = usePhotoSrc(state.prefs.wall)
  const [menu, setMenu] = useState<PhotoTarget | null>(null)
  const tap = (t: PhotoTarget) => (state.prefs[t] ? setMenu(t) : onPick(t))
  const reset = (t: PhotoTarget) => {
    void camera.remove([state.prefs[t]])
    store.setPrefs(t === 'avatar' ? { avatar: '' } : { wall: '' })
  }
  return (
    <SubPage title="个人资料" onBack={onBack}>
      <div className="relative h-[172px] overflow-hidden rounded-[18px] bg-(--c-bg)">
        <button onClick={() => tap('wall')} className="absolute inset-0 transition-opacity active:opacity-80">
          {wall ? <img src={wall} alt="" className="h-full w-full object-cover object-[50%_32%]" /> : <WallPlaceholder />}
          <CameraBadge className="absolute top-3 right-3 h-[28px] w-[28px] bg-black/35 text-white backdrop-blur-md" />
        </button>
        <button onClick={() => tap('avatar')} className="absolute bottom-4 left-4 h-[64px] w-[64px] transition-transform duration-150 active:scale-[.95]">
          {avatar ? (
            <img src={avatar} alt="" className="h-full w-full rounded-full border-2 border-white/90 object-cover" />
          ) : (
            <AvatarPlaceholder size={64} />
          )}
          <CameraBadge className="absolute -right-0.5 -bottom-0.5 h-[24px] w-[24px] bg-(--c-ink) text-(--c-bg) ring-2 ring-white" />
        </button>
      </div>
      {menu && (
        <ActionSheet
          title={menu === 'avatar' ? '头像' : '背景'}
          groups={[[
            { title: '从相册选择', icon: ICON.image, onClick: () => onPick(menu) },
            { title: '恢复默认', icon: ICON.undo, onClick: () => { reset(menu); haptic('light') } },
          ]]}
          onClose={() => setMenu(null)}
        />
      )}
      <div className="mt-5 overflow-hidden rounded-[16px] bg-(--c-surface)">
        <Field k="名称">
          <TextInput
            value={state.prefs.name}
            maxLength={20}
            placeholder={state.semester?.name ?? '我的课表'}
            onChange={(e) => store.setPrefs({ name: e.target.value })}
            onBlur={(e) => store.setPrefs({ name: e.target.value.trim() })}
          />
        </Field>
      </div>
    </SubPage>
  )
}

/* 统计：学期走到哪、每门课上到哪，请过假的课单独标出来；可直接给导师或老师看 */
function StatsPage({ onBack, onCourse, onChanges, onTodo }: { onBack: () => void; onCourse: (c: Course) => void; onChanges: () => void; onTodo: () => void }) {
  const state = useStore()
  const sem = state.semester
  const live = state.courses.filter((c) => !c.removedByImport)
  const today = todayStr()
  const ruleCourse = new Map(state.rules.map((r) => [r.id, r.courseId]))

  const rows = live.map((c) => {
    const rs = state.rules.filter((r) => r.courseId === c.id)
    const weeks = new Set<number>()
    let total = 0
    let done = 0
    for (const r of rs) {
      for (const w of maskToWeeks(r.weeksMask)) {
        weeks.add(w)
        total += periodsOf(r)
        if (sem && dateOf(sem, w, r.weekday) < today) done += periodsOf(r)
      }
    }
    const leave = state.overrides.filter((o) => o.kind === 'leave' && ruleCourse.get(o.ruleId) === c.id).length
    return { c, total, done, weekly: weeks.size ? Math.round(total / weeks.size) : 0, leave }
  })
  const weekly = weekPeriods(state)
  const week = sem ? Math.min(Math.max(weekOf(sem, today), 0), sem.totalWeeks) : 0

  const byCategory = new Map<string, typeof rows>()
  for (const r of rows) {
    const k = r.c.category?.trim() || ''
    byCategory.set(k, [...(byCategory.get(k) ?? []), r])
  }
  const cats = [...byCategory.keys()].sort((a, b) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b, 'zh-CN')))
  const donePeriods = rows.reduce((a, r) => a + r.done, 0)
  const facts = [
    live.length > 0 ? `${live.length} 门课` : '',
    weekly > 0 ? `本周 ${weekly} 节` : '',
    donePeriods > 0 ? `已上 ${donePeriods} 节` : '',
  ].filter(Boolean)

  const liveIds = new Set(live.map((c) => c.id))
  const ovs = state.overrides.filter((o) => liveIds.has(ruleCourse.get(o.ruleId) ?? ''))
  const nOv = (k: OverrideKind) => ovs.filter((o) => o.kind === k).length
  const homework = state.tasks.filter((t) => t.kind === 'homework')
  const exams = state.tasks.filter((t) => t.kind === 'exam')
  const firstDays = new Set(state.rules.filter((r) => liveIds.has(r.courseId) && r.startPeriod === 1).map((r) => r.weekday)).size
  type More = [string, string, (() => void) | null]
  const more = (
    [
      ['第一节有课', firstDays > 0 ? `每周 ${firstDays} 天` : '', null],
      ['作业', homework.length > 0 ? `${homework.filter((t) => t.done).length} / ${homework.length} 已完成` : '', onTodo],
      ['考试', exams.length > 0 ? `${exams.length} 场` : '', onTodo],
      ['请假', nOv('leave') > 0 ? `${nOv('leave')} 次` : '', onChanges],
      ['停课', nOv('cancelled') > 0 ? `${nOv('cancelled')} 次` : '', onChanges],
      ['调课', nOv('moved') > 0 ? `${nOv('moved')} 次` : '', onChanges],
    ] as More[]
  ).filter((m) => m[1])

  return (
    <SubPage title="统计" onBack={onBack}>
      {sem && (
        <div className="rounded-[18px] bg-(--c-surface) px-4 pt-4 pb-4">
          <div className="flex items-baseline justify-between">
            <span className="text-[22px] font-extrabold tracking-[-.02em] text-(--c-ink)">第 {week} 周</span>
            <span className="text-[12.5px] font-medium tabular-nums text-(--c-ink4)">共 {sem.totalWeeks} 周</span>
          </div>
          <div className="mt-3 h-[5px] overflow-hidden rounded-full bg-(--c-surface2)">
            <div className="h-full rounded-full bg-(--c-ink)" style={{ width: `${sem.totalWeeks > 0 ? Math.min(100, (week / sem.totalWeeks) * 100) : 0}%` }} />
          </div>
          {facts.length > 0 && (
            <div className="mt-3.5 flex gap-3 text-[12.5px] font-medium tabular-nums text-(--c-ink3)">
              {facts.map((f) => <span key={f}>{f}</span>)}
            </div>
          )}
        </div>
      )}

      {cats.map((cat) => (
        <div key={cat || '_'} className="mt-5">
          <div className="px-0.5 text-[12px] font-bold tracking-[-.01em] text-(--c-ink5)">{cat || (cats.length > 1 ? '其他' : '课程')}</div>
          <div className="mt-2 rounded-[18px] bg-(--c-surface) px-4">
            {(byCategory.get(cat) ?? []).map(({ c, total, done, weekly: w, leave }, i) => {
              const meta = [c.teacher ?? '', w > 0 ? `每周 ${w} 节` : ''].filter(Boolean)
              return (
                <button key={c.id} onClick={() => onCourse(c)} className={`block w-full py-3.5 text-left transition-opacity active:opacity-60 ${i ? 'border-t border-(--c-surface2)' : ''}`}>
                  <div className="flex items-baseline">
                    <span className="min-w-0 flex-1 truncate text-[14px] font-semibold text-(--c-ink)">{c.name}</span>
                    {total > 0 && <span className="ml-3 flex-none text-[12.5px] font-semibold tabular-nums text-(--c-ink3)">{done} / {total} 节</span>}
                  </div>
                  {total > 0 && (
                    <div className="mt-2 h-[4px] overflow-hidden rounded-full bg-(--c-surface2)">
                      <div className="h-full rounded-full" style={{ width: `${Math.min(100, (done / total) * 100)}%`, background: c.color }} />
                    </div>
                  )}
                  {(meta.length > 0 || leave > 0) && (
                    <div className="mt-1.5 flex items-baseline text-[12px] font-medium tabular-nums text-(--c-ink4)">
                      <span className="flex min-w-0 flex-1 gap-2.5 truncate">{meta.map((m) => <span key={m}>{m}</span>)}</span>
                      {leave > 0 && <span className="ml-3 flex-none text-(--c-danger)">请假 {leave} 次</span>}
                    </div>
                  )}
                </button>
              )
            })}
          </div>
        </div>
      ))}

      {more.length > 0 && (
        <div className="mt-5">
          <div className="px-0.5 text-[12px] font-bold tracking-[-.01em] text-(--c-ink5)">本学期</div>
          <div className="mt-2 rounded-[18px] bg-(--c-surface) px-4">
            {more.map(([k, v, go], i) => (
              <button key={k} onClick={go ?? undefined} disabled={!go} className={`flex w-full items-center py-3.5 text-left transition-opacity active:opacity-60 disabled:active:opacity-100 ${i ? 'border-t border-(--c-surface2)' : ''}`}>
                <span className="flex-1 text-[14px] font-semibold text-(--c-ink)">{k}</span>
                <span className="text-[12.5px] font-medium tabular-nums text-(--c-ink4)">{v}</span>
                {go && <svg width="13" height="13" viewBox="0 0 24 24" fill="none" style={{ stroke: 'var(--c-ink5)' }} strokeWidth="2.2" className="ml-2"><path d="m9 5 7 7-7 7" /></svg>}
              </button>
            ))}
          </div>
        </div>
      )}
    </SubPage>
  )
}

/* 清除数据：本机课表、作业和系统日历里应用建的日历一并删掉，回到初始状态 */
function ErasePage({ onBack, onDone }: { onBack: () => void; onDone: () => void }) {
  const [busy, setBusy] = useState(false)
  const run = async () => {
    if (busy) return
    setBusy(true)
    const s = store.state
    const paths = [...s.tasks.flatMap((t) => t.photos?.map((p) => p.path) ?? []), s.prefs.avatar, s.prefs.wall].filter(Boolean)
    await clearCalendar()
    await camera.remove(paths)
    store.reset()
    await syncWidgets()
    onDone()
  }
  return (
    <Page>
      <div className="flex-1 overflow-y-auto px-5 [scrollbar-width:none]">
        <TopBar title="清除数据" sub="卸载应用不会移除系统日历中的内容。" onBack={onBack} />
        <div className="mt-6 rounded-[18px] bg-(--c-surface) px-4">
          {['课表、课程和调整', '作业和照片', '系统日历中由本应用创建的日历'].map((t, i) => (
            <div key={t} className={`py-3.5 text-[14px] font-semibold text-(--c-ink) ${i ? 'border-t border-(--c-surface2)' : ''}`}>{t}</div>
          ))}
        </div>
      </div>
      <div className="flex-none px-5 pt-3 pb-[max(28px,env(safe-area-inset-bottom))]">
        <PrimaryButton tone="danger" busy={busy} onClick={() => void run()}>清除全部数据</PrimaryButton>
      </div>
    </Page>
  )
}

const THEME_ORDER: ThemePref[] = ['system', 'light', 'dark', 'black']

/* 主题选择：选项列表同提醒设置页，上方三块小预览直接用各主题的色板渲染 */
function ThemePage({ onBack }: { onBack: () => void }) {
  const theme = useTheme()
  const [dyn, dynOk] = useDynamic()
  const stickers = useStickersOn()
  return (
    <Page>
      <div className="flex-1 overflow-y-auto px-5 pb-[130px] [scrollbar-width:none]">
        <TopBar title="主题" onBack={onBack} />
        <div className="mt-6 flex gap-3">
          {(['light', 'dark', 'black'] as const).map((r) => {
            const on = theme === r || (theme === 'system' && resolve() === r)
            return (
              <button
                key={r}
                onClick={() => setTheme(r)}
                data-theme={r}
                className={`flex-1 overflow-hidden rounded-[16px] bg-(--c-bg) p-2.5 ring-[1.5px] transition-transform duration-150 active:scale-[.97] ${on ? 'ring-(--c-accent)' : 'ring-(--c-line)'}`}
              >
                <div className="rounded-[10px] bg-(--c-surface) p-2">
                  <div className="h-[6px] w-2/3 rounded-full bg-(--c-ink)" />
                  <div className="mt-1.5 h-[5px] w-1/2 rounded-full bg-(--c-ink4)" />
                </div>
                <div className="mt-2 flex gap-1.5">
                  <div className="h-[14px] flex-1 rounded-[5px] bg-(--c-accent)" />
                  <div className="h-[14px] flex-1 rounded-[5px] bg-(--c-surface)" />
                </div>
              </button>
            )
          })}
        </div>
        <div className="mt-5 rounded-[18px] bg-(--c-surface) px-4">
          {THEME_ORDER.map((t, i) => {
            const on = theme === t
            return (
              <button
                key={t}
                onClick={() => setTheme(t)}
                className={`flex w-full items-center py-3.5 text-left transition-opacity active:opacity-60 ${i ? 'border-t border-(--c-surface2)' : ''}`}
              >
                <span className={`flex-1 text-[14px] font-semibold ${on ? 'text-(--c-accent)' : 'text-(--c-ink)'}`}>{THEME_LABEL[t]}</span>
                {on && (
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" style={{ stroke: 'var(--c-accent)' }} strokeWidth="2.6"><path d="m5 13 4.5 4.5L19 7" /></svg>
                )}
              </button>
            )
          })}
        </div>
        {dynOk && (
          <>
            <div className="mt-6 px-1 text-[12px] font-bold text-(--c-ink4)">主题色</div>
            <div className="mt-2 rounded-[18px] bg-(--c-surface) px-4">
              {([[false, '默认'], [true, '跟随系统配色']] as const).map(([v, label], i) => {
                const on = dyn === v
                return (
                  <button
                    key={label}
                    onClick={() => setDynamic(v)}
                    className={`flex w-full items-center py-3.5 text-left transition-opacity active:opacity-60 ${i ? 'border-t border-(--c-surface2)' : ''}`}
                  >
                    <span className={`flex-1 text-[14px] font-semibold ${on ? 'text-(--c-accent)' : 'text-(--c-ink)'}`}>{label}</span>
                    {on && (
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" style={{ stroke: 'var(--c-accent)' }} strokeWidth="2.6"><path d="m5 13 4.5 4.5L19 7" /></svg>
                    )}
                  </button>
                )
              })}
            </div>
          </>
        )}
        <div className="mt-6 px-1 text-[12px] font-bold text-(--c-ink4)">课程贴纸</div>
        <div className="mt-2 rounded-[18px] bg-(--c-surface) px-4">
          {([[true, '显示'], [false, '隐藏']] as const).map(([v, label], i) => {
            const on = stickers === v
            return (
              <button
                key={label}
                onClick={() => setStickersOn(v)}
                className={`flex w-full items-center py-3.5 text-left transition-opacity active:opacity-60 ${i ? 'border-t border-(--c-surface2)' : ''}`}
              >
                <span className={`flex-1 text-[14px] font-semibold ${on ? 'text-(--c-accent)' : 'text-(--c-ink)'}`}>{label}</span>
                {on && (
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" style={{ stroke: 'var(--c-accent)' }} strokeWidth="2.6"><path d="m5 13 4.5 4.5L19 7" /></svg>
                )}
              </button>
            )
          })}
        </div>
      </div>
    </Page>
  )
}

function SubPage({ title, sub, onBack, children }: { title: string; sub?: string; onBack: () => void; children: React.ReactNode }) {
  return (
    <Page>
      <div className="flex-1 overflow-y-auto px-5 pb-10 [scrollbar-width:none]">
        <TopBar title={title} sub={sub} onBack={onBack} />
        <div className="mt-6">{children}</div>
      </div>
    </Page>
  )
}

const liveCount = (s: Snapshot) => s.courses.filter((c) => !c.hidden && !c.removedByImport).length

/* 选学期：和教务导入的「导入哪个学期？」同一套单选样式，第一项默认选中 */
function SemesterPickSheet({ title, action, options, onPick, onClose }: {
  title: string; action: string; options: Snapshot[]; onPick: (s: Snapshot) => void; onClose: () => void
}) {
  const [sel, setSel] = useState(0)
  const dismiss = useRef<(() => void) | null>(null)
  return (
    <Sheet
      onClose={onClose}
      dismissRef={dismiss}
      className="px-5 pb-1"
      header={<SheetHead title={title} trail={<SheetClose onClick={() => dismiss.current?.()} />} />}
      footer={<div className="px-5 pt-2"><PrimaryButton onClick={() => { onPick(options[sel]); dismiss.current?.() }}>{action}</PrimaryButton></div>}
    >
      <div className="space-y-2 pt-1">
        {options.map((s, i) => {
          const on = i === sel
          return (
            <button
              key={s.semester.id}
              onClick={() => { haptic('selection'); setSel(i) }}
              className="flex w-full items-center rounded-[12px] px-3.5 py-3 text-left"
              style={{ background: on ? 'var(--c-accent-soft)' : 'var(--c-row-muted)', boxShadow: on ? 'inset 0 0 0 1.5px var(--c-accent)' : undefined }}
            >
              <span className="mr-3 flex h-[17px] w-[17px] flex-none items-center justify-center rounded-full border-[1.8px]" style={{ borderColor: on ? 'var(--c-accent)' : 'var(--c-radio-border)', background: on ? 'var(--c-accent)' : 'transparent' }}>
                {on && <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3.6"><path d="m6 12.5 4 4 8-9" /></svg>}
              </span>
              <span className={`min-w-0 flex-1 truncate text-[13.5px] font-bold text-(--c-ink) ${on ? '' : 'opacity-55'}`}>{s.semester.name}</span>
              <span className={`ml-3 flex-none text-[12.5px] font-semibold tabular-nums text-(--c-ink4) ${on ? '' : 'opacity-55'}`}>{i === 0 ? '当前' : `${liveCount(s)} 门课`}</span>
            </button>
          )
        })}
      </div>
    </Sheet>
  )
}

/* 导出一个学期的课表：分享给别的应用，或直接存进本机「下载」 */
function ExportSheet({ snap, onClose }: { snap: Snapshot; onClose: () => void }) {
  const save = async () => {
    try {
      const r = await saveIcs(snap)
      if (r) nativeToast(`已保存到${r.path}`)
    } catch (e) {
      nativeToast(e instanceof Error && e.message ? `保存失败：${e.message}` : '保存失败')
    }
  }
  return (
    <ActionSheet
      title={`导出「${snap.semester.name}」`}
      onClose={onClose}
      groups={[[
        {
          title: '分享到其他应用',
          icon: <><path d="M12 15.5V4.2" /><path d="m7.6 8.4 4.4-4.4 4.4 4.4" /><path d="M5 14.6v3.6A1.8 1.8 0 0 0 6.8 20h10.4a1.8 1.8 0 0 0 1.8-1.8v-3.6" /></>,
          onClick: () => { void shareIcs(snap) },
        },
        {
          title: '保存到本机',
          value: '本设备的Download文件夹',
          icon: <><path d="M12 4.2v11.3" /><path d="m7.6 11.4 4.4 4.4 4.4-4.4" /><path d="M5 19.8h14" /></>,
          onClick: () => { void save() },
        },
      ]]}
    />
  )
}

/* 往期学期：只读内页，课程列表、底部分享；删除走和规则页一样的红色行 */
function ArchivePage({ a, onBack }: { a: SemesterArchive; onBack: () => void }) {
  const courses = a.courses.filter((c) => !c.hidden && !c.removedByImport)
  const [exporting, setExporting] = useState(false)
  const remove = async () => {
    const ok = await nativeConfirm({ title: `删除「${a.semester.name}」`, message: `${courses.length} 门课一起删除，不可恢复`, ok: '删除' })
    if (!ok) return
    store.removeArchive(a.semester.id)
    haptic('warning')
    nativeToast('已删除')
    onBack()
  }
  return (
    <Page>
      <div className="flex-1 overflow-y-auto px-5 pb-6 [scrollbar-width:none]">
        <TopBar title={a.semester.name} sub={`${md(a.semester.startDate)} 开学，${a.semester.totalWeeks} 周，${courses.length} 门课`} onBack={onBack} />
        <div className="mt-6 divide-y divide-(--c-surface2) overflow-hidden rounded-[16px] bg-(--c-surface)">
          {courses.map((c) => <Row key={c.id} title={c.name} desc={c.teacher} right={<span />} />)}
        </div>
        <div className="mt-5 overflow-hidden rounded-[16px] bg-(--c-surface)">
          <Row title="删除学期" danger onClick={() => void remove()} right={<span />} />
        </div>
      </div>
      <div className="flex-none px-5 pt-2 pb-[max(22px,env(safe-area-inset-bottom))]">
        <PrimaryButton onClick={() => setExporting(true)}>分享课表</PrimaryButton>
      </div>
      {exporting && <ExportSheet snap={a} onClose={() => setExporting(false)} />}
    </Page>
  )
}

function SemesterSettings({ sem, onBack, onNew, onArchive }: { sem: Semester; onBack: () => void; onNew: () => void; onArchive: (id: string) => void }) {
  const state = useStore()
  const [name, setName] = useState(sem.name)
  const [date, setDate] = useState(sem.startDate)
  const [weeks, setWeeks] = useState(sem.totalWeeks)
  const [holidays, setHolidays] = useState(sem.holidays !== false)
  const start = mondayOf(date)
  const ended = semesterEnded({ startDate: start, totalWeeks: weeks })
  const archives = [...state.archives].reverse()
  const hols = holidaysBetween(start, termEnd({ startDate: start, totalWeeks: weeks }))

  return (
    <SubPage title="学期" sub={ended ? `已结束，共 ${weeks} 周` : `第 ${Math.max(1, currentWeek(start))} 周，共 ${weeks} 周`} onBack={onBack}>
      <div className="divide-y divide-(--c-surface2) overflow-hidden rounded-[16px] bg-(--c-surface)">
        <Field k="名称"><TextInput value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field k="开学" sub={`第 1 周 ${md(start)} 周一`}><DateInput value={date} onChange={setDate} /></Field>
        <Field k="总周数"><TextInput type="number" min={1} max={64} value={weeks} onChange={(e) => setWeeks(Number(e.target.value))} /></Field>
        <div className="flex items-center px-4 py-3.5">
          <div className="min-w-0 flex-1">
            <div className="text-[14px] font-bold">法定节假日不排课</div>
            <div className="mt-0.5 text-[12px] font-medium text-(--c-ink4)">{hols.length > 0 ? hols.map((h) => `${h.name} ${md(h.start)}${h.start !== h.end ? `–${md(h.end)}` : ''}`).join('，') : '学期内无法定节假日'}</div>
          </div>
          <Switch on={holidays} onChange={setHolidays} />
        </div>
      </div>

      <div className="mt-2.5 overflow-hidden rounded-[16px] bg-(--c-surface)">
        <Row title="开始新学期" desc={ended ? "当前学期移入往期" : undefined} onClick={onNew} />
      </div>

      {archives.length > 0 && (
        <>
          <div className="mt-7 mb-2 px-1 text-[12.5px] font-semibold text-(--c-ink4)">往期学期</div>
          <div className="divide-y divide-(--c-surface2) overflow-hidden rounded-[16px] bg-(--c-surface)">
            {archives.map((a) => (
              <Row key={a.semester.id} title={a.semester.name} desc={`${md(a.semester.startDate)} 开学，${liveCount(a)} 门课`} onClick={() => onArchive(a.semester.id)} />
            ))}
          </div>
        </>
      )}

      <div className="mt-8">
        <PrimaryButton
          onClick={() => {
            store.setSemester({
              ...sem,
              name: name.trim() || sem.name,
              startDate: start,
              totalWeeks: Math.min(64, Math.max(1, weeks)),
              holidays,
            })
            onBack()
          }}
        >保存</PrimaryButton>
      </div>
    </SubPage>
  )
}

/* 新学期：当前学期连课表封存进往期，作息、待办、偏好带到新学期，完成后直接进导入 */
function NewSemesterPage({ sem, onBack, onDone }: { sem: Semester; onBack: () => void; onDone: () => void }) {
  const state = useStore()
  const [date, setDate] = useState(() => mondayOf(todayStr()))
  const start = mondayOf(date)
  const [name, setName] = useState(() => guessSemesterName(start))
  const [named, setNamed] = useState(false)
  const [weeks, setWeeks] = useState(sem.totalWeeks)
  const shown = named ? name : guessSemesterName(start)
  const keep = state.courses.length > 0 || state.entries.length > 0
  const live = liveCount({ ...state, semester: sem })

  return (
    <SubPage title="新学期" sub={keep ? `${sem.name} 移入往期，${live} 门课；作息与待办将会保留` : '作息与待办将会保留'} onBack={onBack}>
      <div className="divide-y divide-(--c-surface2) overflow-hidden rounded-[16px] bg-(--c-surface)">
        <Field k="名称"><TextInput value={shown} onChange={(e) => { setNamed(true); setName(e.target.value) }} /></Field>
        <Field k="开学" sub={`第 1 周 ${md(start)} 周一`}><DateInput value={date} onChange={setDate} /></Field>
        <Field k="总周数"><TextInput type="number" min={1} max={64} value={weeks} onChange={(e) => setWeeks(Number(e.target.value))} /></Field>
      </div>

      <div className="mt-8">
        <PrimaryButton
          onClick={() => {
            store.startSemester({
              ...sem,
              id: uid(),
              name: shown.trim() || guessSemesterName(start),
              startDate: start,
              totalWeeks: Math.min(64, Math.max(1, weeks)),
              vacations: [],
              examWeeks: [],
            })
            void syncWidgets()
            onDone()
          }}
        >开始新学期</PrimaryButton>
      </div>
    </SubPage>
  )
}

function HistoryPage({ onBack }: { onBack: () => void }) {
  const state = useStore()
  const batches = [...state.batches].reverse()
  return (
    <SubPage title="导入历史" sub={`共 ${batches.length} 次`} onBack={onBack}>
      {batches.length === 0 && <EmptyBlock kind="none" title="无导入记录" />}
      <div className="space-y-2.5">
        {batches.map((b) => (
          <div key={b.id} className="rounded-[16px] bg-(--c-surface) px-4 py-3.5">
            <div className="flex items-baseline justify-between">
              <span className="text-[13.5px] font-bold">{b.ruleName} <span className="font-medium text-(--c-ink5)">v{b.ruleVersion}</span></span>
              <span className="text-[11.5px] font-medium tabular-nums text-(--c-ink4)">{new Date(b.at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
            </div>
            <div className="mt-1.5 text-[12.5px] font-medium text-(--c-ink3)">
              新增 {b.added}，更新 {b.updated}{b.removed > 0 ? `，消失 ${b.removed}` : ''}{b.failed > 0 ? `，失败 ${b.failed}` : ''}，用时 {(b.durationMs / 1000).toFixed(1)} 秒
            </div>
            {b.diagnostics.filter((d) => d.level === 'error').slice(0, 3).map((d, i) => (
              <div key={i} className="mt-1.5 text-[11.5px] font-medium text-(--c-danger)">{d.message}</div>
            ))}
          </div>
        ))}
      </div>
    </SubPage>
  )
}

function TrashPage({ onBack }: { onBack: () => void }) {
  const state = useStore()
  const removed = state.courses.filter((c) => c.removedByImport)
  return (
    <SubPage title="回收站" sub={removed.length > 0 ? `${removed.length} 门课` : undefined} onBack={onBack}>
      {removed.length === 0 && <EmptyBlock kind="free" title="无课程" />}
      <div className="space-y-2.5">
        {removed.map((c) => (
          <div key={c.id} className="flex items-center rounded-[16px] bg-(--c-surface) px-4 py-3.5">
            <div className="min-w-0 flex-1">
              <div className="text-[14px] font-bold">{c.name}</div>
              <div className="mt-0.5 text-[12px] font-medium text-(--c-ink4)">{c.teacher ?? '—'}，上次导入时消失</div>
            </div>
            <div className="ml-3 flex flex-none items-center gap-4">
              <TextAction onClick={() => store.restoreCourse(c.id)}>恢复</TextAction>
              <TextAction tone="danger" onClick={() => store.purgeCourse(c.id)}>删除</TextAction>
            </div>
          </div>
        ))}
      </div>
    </SubPage>
  )
}

function CoursesPage({ onBack, onDetail, onManual }: { onBack: () => void; onDetail: (c: Course) => void; onManual: () => void }) {
  const state = useStore()
  const courses = state.courses.filter((c) => !c.removedByImport)
  return (
    <SubPage title="课程" sub={`${courses.length} 门`} onBack={onBack}>
      {courses.length === 0 ? (
        <EmptyBlock kind="none" title="无课程" actions={[['手动添加', onManual]]} />
      ) : (
        <div className="overflow-hidden rounded-[16px] bg-(--c-surface)">
          {courses.map((c, i) => {
            const slots = state.rules.filter((r) => r.courseId === c.id)
            return (
              <button key={c.id} onClick={() => onDetail(c)} className={`flex w-full items-center px-4 py-3.5 text-left transition-colors active:bg-(--c-bg) ${i > 0 ? 'border-t border-(--c-surface2)' : ''}`}>
                <i className="mr-3 h-[26px] w-[3px] flex-none rounded-full" style={{ background: c.color }} />
                <div className="min-w-0 flex-1">
                  <div className={`truncate text-[14px] font-bold ${c.hidden ? 'text-(--c-ink5) line-through' : ''}`}>{c.name}</div>
                  <div className="mt-0.5 truncate text-[12px] font-medium text-(--c-ink4)">
                    {slots.length > 0 ? slots.map((s) => `${WD[s.weekday]} ${s.startPeriod}–${s.endPeriod}`).join('，') : '—'}
                  </div>
                </div>
                {c.teacher && <span className="ml-2 flex-none text-[11.5px] font-medium text-(--c-ink5)">{c.teacher}</span>}
              </button>
            )
          })}
        </div>
      )}
    </SubPage>
  )
}

/* ---------------- 根 ---------------- */

const ONBOARD_KEY = 'tt.onboarded.v1'

type Route =
  | { k: 'course'; course: Course }
  | { k: 'courseEdit'; course: Course }
  | { k: 'session'; occ: Occurrence }
  | { k: 'conflict'; occ: Occurrence }
  | { k: 'changes'; courseId?: string }
  | { k: 'todoDetail'; task: Task }
  | { k: 'todoCamera'; courseId?: string; taskId?: string }
  | { k: 'todoPicker'; courseId?: string; taskId?: string }
  | { k: 'todoReview'; photos: CapturedPhoto[]; courseId?: string }
  | { k: 'manual' }
  | { k: 'import' }
  | { k: 'scan' }
  | { k: 'importRun'; ruleId: string; text?: string; auto?: boolean }
  | { k: 'aiImport'; attach?: string }
  | { k: 'eduSchool' }
  /** 教务自动更新的设置页；url 是刚选完学校带回来的网址，不传就用已存的 */
  | { k: 'eduAuto'; url?: string }
  | { k: 'eduAutoSchool' }
  | { k: 'eduBrowser'; school: School }
  /** src 只有「从教务系统导入」那条路有：记下学校与当时所在的课表页，供自动更新复用 */
  | { k: 'eduPreview'; out: RuleOutput; src?: EduSyncSource }
  | { k: 'eduFail'; info: EduFailInfo }
  | { k: 'rule'; rule: RuleManifest | null }
  | { k: 'semester' }
  | { k: 'newSemester' }
  | { k: 'archive'; id: string }
  | { k: 'schedule' }
  | { k: 'history' }
  | { k: 'trash' }
  | { k: 'courses' }
  | { k: 'calendarIntro' }
  | { k: 'notifPick'; pref: PrefKey }
  | { k: 'widget' }
  | { k: 'theme' }
  | { k: 'profile' }
  | { k: 'photoPick'; target: PhotoTarget }
  | { k: 'stats' }
  | { k: 'erase' }

/* 课程详情里点某条每周安排：找到这条规则在本周（或第一周）的那次课 */
function occurrenceOfRule(snap: Snapshot, ruleId: string): Occurrence | null {
  const rule = snap.rules.find((r) => r.id === ruleId)
  if (!rule) return null
  const cur = Math.max(1, Math.min(snap.semester.totalWeeks, weekOf(snap.semester, todayStr())))
  const weeks = [cur, ...Array.from({ length: snap.semester.totalWeeks }, (_, i) => i + 1)]
  for (const w of weeks) {
    if (!maskHasWeek(rule.weeksMask, w)) continue
    const date = dateOf(snap.semester, w, rule.weekday)
    const hit = occurrencesOn(snap, date).find((o) => o.ruleId === ruleId)
    if (hit) return hit
  }
  return null
}

export default function RealApp() {
  const state = useStore()
  const [onboarded, setOnboarded] = useState(() => {
    try {
      return localStorage.getItem(ONBOARD_KEY) === '1' || store.state.courses.length > 0
    } catch {
      return store.state.courses.length > 0
    }
  })
  const [tab, setTab] = useState(0)
  const today = useToday()
  const [anchor, setAnchor] = useState(today)
  const [weekAnchor, setWeekAnchor] = useState(today)
  /* 还锁在“今天”的视图跨零点后跟着日期走；用户自己翻到别的日子则不动 */
  const lastToday = useRef(today)
  useEffect(() => {
    const prev = lastToday.current
    if (prev === today) return
    lastToday.current = today
    setAnchor((a) => (a === prev ? today : a))
    setWeekAnchor((a) => (mondayOf(a) === mondayOf(prev) ? today : a))
  }, [today])
  const [stack, setStack] = useState<Route[]>([])
  const [menu, setMenu] = useState<{ occ: Occurrence; anchor: Rect; ghost: Ghost } | null>(null)
  /* 关菜单走浮层自己的退场，退完再清状态；直接 setMenu(null) 会让它瞬间消失 */
  const menuDismiss = useRef<(() => void) | null>(null)
  const closeMenu = () => {
    if (menuDismiss.current) menuDismiss.current()
    else setMenu(null)
  }
  const [searching, setSearching] = useState(false)
  const [sharing, setSharing] = useState(false)
  /* 选完学期（或只有一个学期）后弹出「分享 / 保存到本机」 */
  const [exporting, setExporting] = useState<Snapshot | null>(null)
  /* 导出：有往期学期时先选学期，选完再问分享还是保存 */
  const share = () => {
    if (!store.state.semester) { nativeToast('先设置学期'); return }
    if (store.state.archives.length > 0) setSharing(true)
    else setExporting(store.snapshot())
  }
  const [compose, setCompose] = useState<{ courseId?: string } | null>(null)
  const [, tick] = useState(0)

  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000)
    return () => clearInterval(t)
  }, [])

  /* 手机日历与小组件跟着数据走：Store 一变就重写、重画；回到前台再对一遍 */
  useEffect(() => {
    let timer: number | null = null
    const run = () => {
      scheduleCalendarSync()
      if (timer != null) window.clearTimeout(timer)
      timer = window.setTimeout(() => void syncWidgets(), 400)
    }
    run()
    const off = store.subscribe(run)
    /* 冷启动：按设置决定要不要更新一次（「每次开启 APP 时更新」就走这里） */
    void syncOnLaunch()?.then((o) => {
      if (o.result === 'ok' || o.note) nativeToast(outcomeText(o))
    })
    const onResume = CapApp.addListener('resume', () => {
      void syncCalendar()
      void syncWidgets()
      void resumeSync()?.then((o) => {
        if (o.result === 'ok' || o.note) nativeToast(outcomeText(o))
      })
    })
    /* 日历事件里的「在应用中打开」 */
    const onUrl = CapApp.addListener('appUrlOpen', ({ url }) => {
      const m = /^timetable:\/\/open\/(course|task|day)\/([^/?#]+)/.exec(url)
      if (!m) return
      const [, kind, id] = m
      setMenu(null)
      if (kind === 'course') {
        const c = store.state.courses.find((x) => x.id === id)
        setTab(0)
        setStack(c ? [{ k: 'course', course: c }] : [])
      } else if (kind === 'task') {
        const t = store.state.tasks.find((x) => x.id === id)
        setTab(2)
        setStack(t ? [{ k: 'todoDetail', task: t }] : [])
      } else {
        setTab(0)
        setStack([])
      }
    })
    /* 别人发来的 .ics 用课程表打开：直接进导入预览 */
    const offIcs = onIncomingIcs((text) => {
      setMenu(null)
      setTab(3)
      setStack([{ k: 'importRun', ruleId: 'builtin-ics', text, auto: true }])
    })
    return () => {
      off()
      offIcs()
      if (timer != null) window.clearTimeout(timer)
      void onResume.then((h) => h.remove())
      void onUrl.then((h) => h.remove())
    }
  }, [])

  const rootRef = useRef<HTMLDivElement>(null)

  const snap = useMemo<Snapshot | null>(
    () => (state.semester ? { semester: state.semester, courses: state.courses, rules: state.rules, overrides: state.overrides, entries: state.entries } : null),
    [state],
  )
  /** 引导期间底下就把壳挂好，选完去向时内页推入不用等整个应用首次挂载 */
  const shellSnap = useMemo<Snapshot>(
    () => snap ?? { semester: defaultSemester(mondayOf(todayStr())), courses: [], rules: [], overrides: [], entries: [] },
    [snap],
  )

  const push = (r: Route) => { closeMenu(); setStack((s) => [...s, r]) }
  /*
   * 拍完/选完：给已有待办直接加照片并退回；新待办把确认页推在相机上方。
   * 相机留在栈里：确认页从右侧盖上去，底下是定格的取景框；重拍就是退回去，不会出现一页退一页进交叉。
   */
  const notShot = (r: Route) => r.k !== 'todoCamera' && r.k !== 'todoPicker' && r.k !== 'todoReview'
  const onPhotos = (photos: CapturedPhoto[], courseId?: string, taskId?: string) => {
    if (taskId) {
      store.addPhotos(taskId, photos.map((p) => ({ id: uid(), path: p.path, w: p.width, h: p.height, takenAt: Date.now() })))
      setStack((s) => s.filter(notShot))
      return
    }
    setStack((s) => [...s, { k: 'todoReview', photos, courseId }])
  }
  const openCapture = (kind: 'camera' | 'text', courseId?: string) => {
    if (kind === 'camera') push({ k: 'todoCamera', courseId })
    else setCompose({ courseId })
  }
  const pop = () => setStack((s) => s.slice(0, -1))
  /* 未识别页顶替浏览器页（会话已关）；预览页推在浏览器上方，退回时回到浏览器 */
  const replaceTop = (r: Route) => setStack((s) => [...s.slice(0, -1), r])
  const backToTimetable = () => { setStack([]); setTab(0) }
  /* 头像 / 背景：原生走相册页（单选），浏览器直接选文件；换掉的文件随手删 */
  const applyPhoto = (target: PhotoTarget, ps: CapturedPhoto[]) => {
    const p = ps[0]
    if (!p) return
    const old = store.state.prefs[target]
    const path = rememberPhoto(p).path
    store.setPrefs(target === 'avatar' ? { avatar: path } : { wall: path })
    if (old) void camera.remove([old])
  }
  const pickPhoto = async (target: PhotoTarget) => {
    if (nativeCamera()) push({ k: 'photoPick', target })
    else applyPhoto(target, await camera.pick())
  }
  /* 清除完：回到刚安装的样子，重新走引导 */
  const eraseDone = () => {
    try {
      localStorage.removeItem(ONBOARD_KEY)
    } catch {
      /* 忽略 */
    }
    setOnboardUnder(false)
    setOnboarded(false)
    setStack([])
    setTab(0)
  }
  const openCourseById = (id: string) => {
    const c = store.state.courses.find((x) => x.id === id)
    if (c) push({ k: 'course', course: c })
  }
  const openOccurrence = (o: Occurrence) => {
    if (o.courseId) openCourseById(o.courseId)
    else push({ k: 'session', occ: o })
  }

  /** 引导选了去向时：内页从右侧推入盖住引导；内页退回后有课才算完成，否则回到引导 */
  const [onboardUnder, setOnboardUnder] = useState(false)
  /* 内页退回的同一帧就把引导隐藏（visibility），不等 effect，避免退场动画期间露出引导页 */
  const onboardDone = onboardUnder && stack.length === 0 && state.courses.length > 0
  const showOnboard = !onboarded || !snap
  useEffect(() => {
    if (!onboardUnder || stack.length > 0) return
    if (store.state.courses.length === 0) {
      /* 没有课就回到引导：等内页滑出后再升回顶层，否则会盖住退场动画 */
      const t = window.setTimeout(() => setOnboardUnder(false), SLIDE.duration * 1000)
      return () => window.clearTimeout(t)
    }
    try {
      localStorage.setItem(ONBOARD_KEY, '1')
    } catch {
      /* 忽略 */
    }
    setOnboarded(true)
  }, [onboardUnder, stack.length])

  /* 有课表、开了至少一类提醒、还没拿到日历权限：启动时推一次「加进手机日历」。
     两类提醒都关着时完全不碰权限，也就不会弹授权页。 */
  const calAsked = useRef(false)
  useEffect(() => {
    if (!onboarded || onboardUnder || stack.length > 0 || !calendarSupported() || calAsked.current) return
    if (state.courses.length === 0 || !remindEnabled(state.prefs)) return
    let alive = true
    void calendarPermission().then((p) => {
      if (!alive) return
      calAsked.current = true
      if (p === 'granted') void syncCalendar()
      else setStack((s) => (s.length === 0 ? [{ k: 'calendarIntro' }] : s))
    })
    return () => { alive = false }
  }, [onboarded, onboardUnder, stack.length, state.courses.length, state.prefs.classRemind, state.prefs.taskRemind])

  /* 系统返回：先关浮层，再退内页，再回今天；引导期间退上一步 */
  const backRef = useRef<() => boolean>(() => false)
  const onboardBack = useRef<() => boolean>(() => false)
  backRef.current = () => {
    if (menu) { closeMenu(); return true }
    if (compose) { setCompose(null); return true }
    if (closeTopSheet()) return true
    if (stack.length > 0) {
      const top = stack[stack.length - 1]
      if (top.k === 'todoCamera' && cameraLeave.current) void cameraLeave.current().then(pop)
      else if (top.k === 'eduBrowser' && eduBack.current) void eduBack.current()
      else setStack((s) => s.slice(0, -1))
      return true
    }
    if (showOnboard && !onboardUnder) return onboardBack.current()
    if (searching) { setSearching(false); return true }
    if (tab !== 0) { setTab(0); return true }
    return false
  }
  /* 栏空后再按一次才退出 */
  const exitArmed = useRef(0)
  useEffect(() => {
    const h = CapApp.addListener('backButton', () => {
      if (backRef.current()) { exitArmed.current = 0; return }
      const t = Date.now()
      if (t - exitArmed.current < 2000) { void CapApp.exitApp(); return }
      exitArmed.current = t
      nativeToast('再按一次退出')
    })
    return () => void h.then((x) => x.remove())
  }, [])

  const renderApp = (snap: Snapshot) => {
  const renderRoute = (r: Route, i: number) => {
    const key = `${r.k}-${i}`
    switch (r.k) {
      case 'course':
        return (
          <CourseDetailPage
            key={key}
            course={r.course}
            snap={snap}
            onBack={pop}
            onChanges={() => push({ k: 'changes', courseId: r.course.id })}
            onEdit={() => push({ k: 'courseEdit', course: r.course })}
            composing={compose?.courseId === r.course.id}
            onCapture={(kind) => openCapture(kind, r.course.id)}
            onOpenTask={(t) => push({ k: 'todoDetail', task: t })}
          />
        )
      case 'courseEdit':
        return (
          <CourseEditPage
            key={key}
            course={r.course}
            onBack={pop}
            onEditSession={(ruleId) => {
              const occ = occurrenceOfRule(snap, ruleId)
              if (occ) push({ k: 'session', occ })
            }}
          />
        )
      case 'session':
        return <EditSessionPage key={key} occ={r.occ} snap={snap} onBack={pop} />
      case 'conflict':
        return <ConflictPage key={key} occ={r.occ} snap={snap} onBack={pop} onCourse={openCourseById} />
      case 'changes':
        return <ChangePage key={key} courseId={r.courseId} onBack={pop} />
      case 'todoDetail':
        return (
          <TaskDetailPage
            key={key}
            task={r.task}
            snap={snap}
            onBack={pop}
            onCamera={() => push({ k: 'todoCamera', courseId: r.task.courseId, taskId: r.task.id })}
          />
        )
      case 'todoCamera':
        return (
          <CameraPage
            key={key}
            snap={snap}
            courseId={r.courseId}
            active={i === stack.length - 1}
            onBack={pop}
            onPicker={() => push({ k: 'todoPicker', courseId: r.courseId, taskId: r.taskId })}
            onShot={(photos, cid) => onPhotos(photos, cid, r.taskId)}
          />
        )
      case 'todoPicker':
        return <PickerPage key={key} onBack={pop} onDone={(photos) => onPhotos(photos, r.courseId, r.taskId)} />
      case 'todoReview':
        return (
          <ReviewPage
            key={key}
            snap={snap}
            photos={r.photos}
            courseId={r.courseId}
            onBack={pop}
            onRetake={() => setStack((s) => (s.some((x) => x.k === 'todoCamera') ? s.filter((x) => x.k !== 'todoPicker' && x.k !== 'todoReview') : [...s.filter(notShot), { k: 'todoCamera', courseId: r.courseId }]))}
            onSaved={() => setStack([])}
          />
        )
      case 'manual':
        return <ManualAddPage key={key} snap={snap} onBack={pop} />
      case 'import':
        return (
          <ImportPage
            key={key}
            onBack={pop}
            onManual={() => push({ k: 'manual' })}
            onEditRule={(x) => push({ k: 'rule', rule: x === 'new' ? null : x })}
            onRun={(ruleId) => push({ k: 'importRun', ruleId })}
            onAi={() => push({ k: 'aiImport' })}
            onEdu={() => push({ k: 'eduSchool' })}
            onScan={() => push({ k: 'scan' })}
          />
        )
      case 'scan':
        return <ScanPage key={key} onBack={pop} onResult={(ruleId, text) => replaceTop({ k: 'importRun', ruleId, text })} />
      case 'aiImport':
        return <AiImportPage key={key} attach={r.attach} onBack={pop} onNext={(text) => push({ k: 'importRun', ruleId: 'builtin-json', text })} />
      case 'eduSchool':
        return <EduSchoolPage key={key} onBack={pop} onOpen={(school) => push({ k: 'eduBrowser', school })} />
      case 'eduAuto':
        return <EduAutoPage key={key} initialUrl={r.url} onBack={pop} onPickSchool={() => push({ k: 'eduAutoSchool' })} />
      case 'eduAutoSchool':
        return <EduSchoolPage key={key} onBack={pop} onOpen={(school) => replaceTop({ k: 'eduAuto', url: school.url })} />
      case 'eduBrowser':
        return (
          <EduBrowserPage
            key={key}
            school={r.school}
            active={i === stack.length - 1}
            onBack={pop}
            onImport={(out, src) => push({ k: 'eduPreview', out, src })}
            onFail={(info) => replaceTop({ k: 'eduFail', info })}
          />
        )
      case 'eduPreview':
        return <ImportRunPage key={key} rule={EDU_RULE} initialOut={r.out} overBrowser syncSource={r.src} onBack={pop} onDone={backToTimetable} />
      case 'eduFail':
        return <EduFailPage key={key} info={r.info} onBack={pop} onAi={(attach) => replaceTop({ k: 'aiImport', attach })} />
      case 'importRun': {
        const rule = state.savedRules.find((x) => x.id === r.ruleId)
        return rule ? <ImportRunPage key={key} rule={rule} initialText={r.text} autoRun={r.auto} onBack={pop} onDone={backToTimetable} /> : null
      }
      case 'rule':
        return <RuleEditorPage key={key} rule={r.rule} onBack={pop} />
      case 'semester':
        return <SemesterSettings key={key} sem={snap.semester} onBack={pop} onNew={() => push({ k: 'newSemester' })} onArchive={(id) => push({ k: 'archive', id })} />
      case 'archive': {
        const a = state.archives.find((x) => x.semester.id === r.id)
        return a ? <ArchivePage key={key} a={a} onBack={pop} /> : null
      }
      case 'newSemester':
        return <NewSemesterPage key={key} sem={snap.semester} onBack={pop} onDone={() => setStack([{ k: 'import' }])} />
      case 'schedule':
        return <SchedulePage key={key} sem={snap.semester} onBack={pop} />
      case 'history':
        return <HistoryPage key={key} onBack={pop} />
      case 'trash':
        return <TrashPage key={key} onBack={pop} />
      case 'calendarIntro':
        return <CalendarIntroPage key={key} onDone={pop} />
      case 'notifPick':
        return <PrefPickPage key={key} pref={r.pref} onBack={pop} />
      case 'widget':
        return <WidgetPage key={key} snap={snap} onBack={pop} />
      case 'theme':
        return <ThemePage key={key} onBack={pop} />
      case 'profile':
        return <ProfilePage key={key} onBack={pop} onPick={(t) => void pickPhoto(t)} />
      case 'photoPick':
        return <PickerPage key={key} single onBack={pop} onDone={(ps) => { applyPhoto(r.target, ps); pop() }} />
      case 'stats':
        return <StatsPage key={key} onBack={pop} onCourse={(c) => push({ k: 'course', course: c })} onChanges={() => push({ k: 'changes' })} onTodo={() => { setStack([]); setTab(2) }} />
      case 'erase':
        return <ErasePage key={key} onBack={pop} onDone={eraseDone} />
      case 'courses':
        return (
          <CoursesPage
            key={key}
            onBack={pop}
            onDetail={(c) => push({ k: 'course', course: c })}
            onManual={() => push({ k: 'manual' })}
          />
        )
    }
  }

  const mo = menu?.occ
  const ovr = (kind: OverrideKind) => {
    if (!mo?.ruleId) return
    store.addOverride({ id: uid(), kind, date: mo.date, ruleId: mo.ruleId, createdAt: Date.now() })
    closeMenu()
    haptic(kind === 'cancelled' ? 'warning' : 'light')
    nativeToast(kind === 'cancelled' ? '本节已停课' : kind === 'leave' ? '已请假' : '本节已静音')
  }
  const restore = () => {
    if (!mo?.ruleId) return
    store.removeOverride(mo.ruleId, mo.date)
    closeMenu()
    haptic('light')
    nativeToast('已恢复')
  }
  const undoTitle = mo
    ? mo.status === 'leave' ? '取消请假'
      : mo.status === 'cancelled' ? '恢复上课'
      : mo.status === 'moved' ? '恢复原时间'
      : null
    : null

  /* 四个 Tab「常驻 + 只切可见性」试过，在这台设备上是负收益：
     切走的面板无论用 opacity:0 / opacity:0.01 / 仅被遮挡，合成器都会把它的栅格结果丢掉
     （实测：藏 20s 再显示，仍要一次 150ms 的整页重绘；opacity 0.02→1 却是 0 帧）。
     结果就是「没省下光栅，反而多挂三棵 DOM、多三份羽化模糊层」，切页从 ~40ms 掉到 53–97ms。
     所以这里仍然一次只挂一个面板；能省的只有那层 160ms 的淡入。 */
  const viewOf = (i: number) =>
      i === 0 ? (
        <TodayView
          snap={snap}
          anchor={anchor}
          setAnchor={setAnchor}
          onPick={openOccurrence}
          onMenu={(o, a, el) => setMenu({ occ: o, anchor: a, ghost: { el, rect: a, radius: 16, scale: 1.03, bg: 'var(--c-surface)' } })}
          liftKey={menu?.occ.key}
          onSearch={() => setSearching(true)}
          onImport={() => push({ k: 'import' })}
          onManual={() => push({ k: 'manual' })}
          onSemester={() => push({ k: 'semester' })}
          onNewSemester={() => push({ k: 'newSemester' })}
          onCapture={openCapture}
        />
      ) : i === 1 ? (
        <WeekView
          snap={snap}
          anchor={weekAnchor}
          setAnchor={setWeekAnchor}
          onPick={openOccurrence}
          onMenu={(o, a, el) => setMenu({ occ: o, anchor: a, ghost: { el, rect: a, color: o.color, radius: 9, scale: 1.06, overhang: true } })}
          liftKey={menu?.occ.key}
          onSearch={() => setSearching(true)}
        />
      ) : i === 2 ? (
        <TodoView
          snap={snap}
          composing={compose != null && compose.courseId == null}
          onOpen={(t) => push({ k: 'todoDetail', task: t })}
          onCamera={() => push({ k: 'todoCamera' })}
          onText={() => setCompose({})}
        />
      ) : (
        <MeView
          onPage={(p) => { if (p === 'share') share(); else push({ k: p } as Route) }}
          onPref={(pref) => push({ k: 'notifPick', pref })}
          onCalendar={() => push({ k: 'calendarIntro' })}
        />
      )

  return (
    <Shell tab={tab} onTab={(i) => { setStack([]); setTab(i) }}>
      {/* 不用 AnimatePresence 的 popLayout：它要把正在退场的整棵子树做一次布局投影测量，
          大纲视图正好是最重的那棵（真机采样：一次切页 2888 次 getBoundingClientRect）。
          也不再给整层做淡入：新内容第一帧就要整页光栅，再叠一层 160ms 的透明度动画，
          只会让这段昂贵的光栅在动画期间重复提交。 */}
      <div key={tab} data-veil-host className="relative flex flex-1 flex-col overflow-hidden">
        {viewOf(tab)}
      </div>

      {sharing && snap && (
        <SemesterPickSheet
          title="导出哪个学期？"
          action="下一步"
          options={[snap, ...[...store.state.archives].reverse()]}
          onPick={(s) => setExporting(s)}
          onClose={() => setSharing(false)}
        />
      )}

      {exporting && <ExportSheet snap={exporting} onClose={() => setExporting(null)} />}

      {/* 搜索：盖在 Tab 上的浮层（淡入带一点上浮），位于内页之下：从搜索点进课程再返回，回到的是搜索 */}
      <AnimatePresence>
        {searching && (
          <motion.div
            key="search"
            initial={{ opacity: 0, transform: 'translateY(14px)' }}
            animate={{ opacity: 1, transform: 'translateY(0px)' }}
            exit={{ opacity: 0, transform: 'translateY(10px)' }}
            transition={SHEET}
            className="absolute inset-0 z-[35] flex flex-col bg-(--c-bg) will-change-transform"
          >
            <SearchPalette
              state={state}
              onClose={() => setSearching(false)}
              onPickCourse={(c) => push({ k: 'course', course: c })}
              onPickTask={(t) => { setSearching(false); push({ k: 'todoDetail', task: t }) }}
            />
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {compose && (
          <ComposeOverlay
            key="compose"
            snap={snap}
            courseId={compose.courseId}
            onClose={() => setCompose(null)}
            onCamera={() => { const cid = compose.courseId; setCompose(null); push({ k: 'todoCamera', courseId: cid }) }}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>{stack.map((r, i) => renderRoute(r, i))}</AnimatePresence>

      <AnimatePresence>
        {menu && mo && (
          <Popover key={menu.occ.key} anchor={menu.anchor} ghost={menu.ghost} dismissRef={menuDismiss} onClose={() => setMenu(null)}>
            <PopHead title={mo.name} sub={fmtMinutes(mo.start)} />
            {mo.ruleId && undoTitle && <PopItem icon={ICON.undo} title={undoTitle} onClick={restore} />}
            {mo.ruleId && mo.status === 'normal' && <PopItem icon={ICON.leave} title="请假一次" onClick={() => ovr('leave')} />}
            {mo.ruleId && mo.status === 'normal' && <PopItem icon={ICON.bell} title={mo.muted ? '取消静音' : '静音本节'} onClick={() => (mo.muted ? restore() : ovr('muted'))} />}
            {mo.ruleId && mo.status !== 'cancelled' && <PopItem icon={ICON.clock} title="调整时间" onClick={() => push({ k: 'session', occ: mo })} />}
            {mo.conflict && <PopItem icon={ICON.info} title="查看冲突" onClick={() => push({ k: 'conflict', occ: mo })} />}
            {mo.courseId && (
              <PopItem
                icon={ICON.edit}
                title="编辑课程"
                onClick={() => {
                  const c = store.state.courses.find((x) => x.id === mo.courseId)
                  if (c) push({ k: 'courseEdit', course: c })
                  else closeMenu()
                }}
              />
            )}
            {mo.ruleId && mo.status === 'normal' && <PopItem icon={ICON.ban} title="本节停课" danger onClick={() => ovr('cancelled')} />}
            {mo.entryId && <PopItem icon={ICON.trash} title="删除这条安排" danger onClick={() => { store.removeEntry(mo.entryId!); closeMenu(); haptic('warning'); nativeToast('已删除') }} />}
          </Popover>
        )}
      </AnimatePresence>

    </Shell>
  )
  }

  return (
    <div ref={rootRef} className="shell-w relative h-dvh overflow-hidden bg-(--c-bg)">
      {renderApp(shellSnap)}
      <AnimatePresence initial={false}>
        {showOnboard && (
          <motion.div
            key="onboarding"
            exit={onboardUnder ? { opacity: 1 } : { transform: 'translateX(-28%)', opacity: 0 }}
            transition={onboardUnder ? { duration: 0 } : SLIDE}
            className={`absolute inset-0 ${onboardUnder ? 'z-[35]' : 'z-[90]'}`}
            style={{ visibility: onboardDone ? 'hidden' : 'visible' }}
          >
            <Onboarding
              backRef={onboardBack}
              onDone={(ruleId) => {
                if (!ruleId) {
                  try {
                    localStorage.setItem(ONBOARD_KEY, '1')
                  } catch {
                    /* 忽略 */
                  }
                  setOnboarded(true)
                  return
                }
                setOnboardUnder(true)
                if (ruleId === 'manual') push({ k: 'manual' })
                else if (ruleId === 'ai') push({ k: 'aiImport' })
                else if (ruleId === 'edu') push({ k: 'eduSchool' })
                else push({ k: 'importRun', ruleId })
              }}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
