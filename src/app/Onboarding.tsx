import { useMemo, useState, type MutableRefObject } from 'react'
import { AnimatePresence } from 'motion/react'
import { diffDays, fmtMinutes } from '../domain/dates'
import {
  DURATION_STEP, MAX_DURATION, MIN_DURATION, MIN_SEGMENTS,
  buildGrid, defaultPlan, planBreaks, planSetCount, planSetDuration,
  planSetSegments, planSetStart, planTotal, segmentCapacity, segmentCountOf, spanText, type DayPlan,
} from '../domain/schedule'
import type { TimeSlot } from '../domain/types'
import { store } from './store'
import { defaultSemester, mondayOf, todayStr } from './semester'
import { Chips, DateInput, Field, Page, PrimaryButton, Row, Stepper, TextAction, TimeSheet, TopBar, md } from './ui'

const WEEKS = 20
/** 「一天分几段」的可选项，下标 0 对应 MIN_SEGMENTS */
const SEGMENT_ITEMS = ['2 段', '3 段']

/* 「课表文件」就是 builtin-ics。以前这里叫「日历」，用户根本认不出它是导入备份文件，
   于是只能先跳过向导、进到课表页再从「导入」里找同一个入口。 */
const SOURCES: { id: string; title: string; desc?: string; badge?: string }[] = [
  { id: 'edu', title: '教务系统', desc: '登录后自动拉取', badge: '推荐' },
  { id: 'builtin-ics', title: '课表文件', desc: '从 .ics 备份文件恢复' },
  { id: 'builtin-xlsx', title: 'Excel', desc: '教务导出的 .xlsx' },
  { id: 'builtin-csv', title: 'CSV' },
  { id: 'builtin-json', title: 'JSON' },
  { id: 'ai', title: '让 AI 转换', desc: '截图或文字交给 AI' },
]

/** 开学日期，落到所在周的周一 */
export function StartDateField({ value, onChange }: { value: string; onChange: (d: string) => void }) {
  return (
    <div className="divide-y divide-(--c-surface2) overflow-hidden rounded-[16px] bg-(--c-surface)">
      <Field k="开学" sub={value ? `第 1 周 ${md(mondayOf(value))} 周一` : undefined}>
        <DateInput value={value} onChange={onChange} />
      </Field>
    </div>
  )
}

export function currentWeek(startDate: string): number {
  return Math.floor(diffDays(todayStr(), startDate) / 7) + 1
}

function Step({ title, sub, onBack, footer, children }: { title: string; sub?: string; onBack?: () => void; footer: React.ReactNode; children: React.ReactNode }) {
  return (
    <Page onBack={onBack} root={!onBack}>
      <div className="flex-1 overflow-y-auto px-5 [scrollbar-width:none]">
        <TopBar title={title} sub={sub} onBack={onBack} />
        <div className="mt-6">{children}</div>
      </div>
      <div className="flex-none px-5 pb-[max(22px,env(safe-area-inset-bottom))]">{footer}</div>
    </Page>
  )
}

/** 首次进入：开学日期 → 作息时间 → 课表来源，和应用内其他页面同一套推入 */
export default function Onboarding({ onDone, initialStep = 0, backRef }: { onDone: (ruleId: string | null) => void; initialStep?: number; backRef?: MutableRefObject<() => boolean> }) {
  const [step, setStep] = useState(initialStep)
  if (backRef) {
    backRef.current = () => {
      if (step <= 0) return false
      setStep(step - 1)
      return true
    }
  }
  const [date, setDate] = useState(() => mondayOf(todayStr()))
  const start = mondayOf(date)
  const [plan, setPlan] = useState<DayPlan>(() => defaultPlan())
  /* 正在挑第 1 节开始时刻的那一段 */
  const [pickSeg, setPickSeg] = useState<number | null>(null)
  const grid = useMemo(() => buildGrid(plan), [plan])
  const total = planTotal(plan)
  const breaks = planBreaks(plan)
  /* 预览列表：每段排完接一条午休/晚饭 */
  const rows = useMemo(() => {
    const out: ({ kind: 'period'; slot: TimeSlot } | { kind: 'break'; name: string; minutes: number })[] = []
    let k = 0
    plan.segments.forEach((_, i) => {
      for (let j = 0; j < segmentCountOf(plan, i); j++) out.push({ kind: 'period', slot: grid[k++] })
      const br = breaks[i]
      if (br) out.push({ kind: 'break', name: br.name, minutes: br.minutes })
    })
    return out
  }, [plan, grid, breaks])

  const finish = (ruleId: string | null) => {
    store.setSemester({ ...defaultSemester(start), totalWeeks: WEEKS, timeGrid: grid })
    onDone(ruleId)
  }

  return (
    <div className="shell-w relative h-dvh overflow-hidden bg-(--c-bg) font-sans text-(--c-ink)">
      <Page root className="intro-hero">
        <div className="flex flex-1 flex-col px-7 pt-[max(64px,calc(env(safe-area-inset-top)+34px))]">
          <img src="/mascot.png" alt="" className="h-[200px] w-[200px] self-center object-contain" />
          <div className="mt-auto pb-14">
            <div className="text-[17px] font-bold tracking-[.02em] text-(--c-ink3)">嘎嘎课程表</div>
            <h1 className="mt-3 text-[44px] leading-[1.15] font-extrabold tracking-[-.04em]">
              <span className="block text-(--c-ink)">你的课表，</span>
              <span className="block text-(--c-ink4)">理应如此。</span>
            </h1>
          </div>
        </div>
        <div className="flex-none px-5 pb-[max(22px,env(safe-area-inset-bottom))]">
          <PrimaryButton onClick={() => setStep(1)}>开始</PrimaryButton>
        </div>
      </Page>

      <AnimatePresence>
        {step >= 1 && (
          <Step
            key="start"
            title="开学日期"
            sub={`第 ${Math.max(1, currentWeek(start))} 周`}
            onBack={() => setStep(0)}
            footer={<PrimaryButton onClick={() => setStep(2)}>继续</PrimaryButton>}
          >
            <StartDateField value={date} onChange={setDate} />
          </Step>
        )}
        {step >= 2 && (
          <Step
            key="schedule"
            title="作息时间"
            sub={
              grid.length
                ? `${total} 节 · ${fmtMinutes(grid[0].start)} – ${fmtMinutes(grid[grid.length - 1].end)}`
                : '还没排上课'
            }
            onBack={() => setStep(1)}
            footer={<PrimaryButton onClick={() => setStep(3)}>继续</PrimaryButton>}
          >
            <div className="rounded-[18px] bg-(--c-surface) px-4">
              <div className="flex items-center py-3">
                <span className="flex-1 text-[14px] font-semibold text-(--c-ink)">一天分几段</span>
                <Chips
                  items={SEGMENT_ITEMS}
                  active={plan.segments.length - MIN_SEGMENTS}
                  onPick={(i) => setPlan(planSetSegments(plan, MIN_SEGMENTS + i))}
                />
              </div>
              <div className="pb-3 text-[12px] leading-[1.6] font-medium text-(--c-ink4)">
                {plan.segments.map((s) => s.name).join(' · ')}
                {breaks.length > 0 && `，段与段之间就是${breaks.map((b) => b.name).join('和')}`}
              </div>
              <div className="flex items-center border-t border-(--c-line2) py-3">
                <span className="flex-1 text-[14px] font-semibold text-(--c-ink)">每节时长</span>
                <Stepper value={plan.duration} unit="分" min={MIN_DURATION} max={MAX_DURATION} step={DURATION_STEP} onChange={(v) => setPlan(planSetDuration(plan, v))} />
              </div>
            </div>

            <div className="mt-3 rounded-[18px] bg-(--c-surface) px-4">
              <div className="flex items-center pt-3 pb-1 text-[11px] font-semibold text-(--c-ink5)">
                <span className="w-[42px] flex-none" />
                <span className="flex-1">每段第 1 节开始</span>
                <span>节数</span>
              </div>
              {plan.segments.map((s, i) => (
                <div key={s.name} className="flex items-center border-t border-(--c-line2) py-2.5">
                  <span className="w-[42px] flex-none text-[13px] font-bold text-(--c-ink)">{s.name}</span>
                  <button
                    onClick={() => setPickSeg(i)}
                    className="rounded-[10px] bg-(--c-surface2) px-3 py-1.5 text-[15px] font-bold tabular-nums text-(--c-ink) transition-transform duration-150 active:scale-[.96]"
                  >
                    {fmtMinutes(s.start)}
                  </button>
                  <span className="flex-1" />
                  <Stepper
                    value={s.count}
                    unit="节"
                    min={0}
                    max={segmentCapacity(plan, i)}
                    onChange={(v) => setPlan(planSetCount(plan, i, v))}
                  />
                </div>
              ))}
            </div>

            <div className="mt-5 mb-6 grid grid-cols-2 gap-x-4 rounded-[18px] bg-(--c-surface) px-4 py-2">
              {rows.map((it) =>
                it.kind === 'break' ? (
                  <div key={`b-${it.name}`} className="col-span-2 flex items-center py-[7px]">
                    <span className="h-px flex-1 border-t border-dashed border-(--c-line)" />
                    <span className="px-2 text-[11px] font-semibold tabular-nums text-(--c-ink4)">
                      {it.name} {spanText(it.minutes)}
                    </span>
                    <span className="h-px flex-1 border-t border-dashed border-(--c-line)" />
                  </div>
                ) : (
                  <div key={it.slot.index} className="flex items-center py-[7px]">
                    <span className="w-[24px] text-[12px] font-bold tabular-nums text-(--c-ink5)">{it.slot.index}</span>
                    <span className="text-[13px] font-semibold tabular-nums text-(--c-ink)">{fmtMinutes(it.slot.start)}</span>
                    <span className="mx-1.5 text-[12px] text-(--c-ink5)">–</span>
                    <span className="text-[13px] font-medium tabular-nums text-(--c-ink4)">{fmtMinutes(it.slot.end)}</span>
                  </div>
                ),
              )}
            </div>
            {pickSeg != null && (
              <TimeSheet
                value={fmtMinutes(plan.segments[pickSeg].start)}
                title={`${plan.segments[pickSeg].name}第 1 节开始`}
                step={5}
                onPick={(v) => {
                  const [h, m] = v.split(':').map(Number)
                  setPlan(planSetStart(plan, pickSeg, h * 60 + m))
                }}
                onClose={() => setPickSeg(null)}
              />
            )}
          </Step>
        )}
        {step >= 3 && (
          <Step
            key="source"
            title="课表来源"
            onBack={() => setStep(2)}
            footer={
              <div className="flex justify-center">
                <TextAction tone="mute" onClick={() => finish(null)}>稍后</TextAction>
              </div>
            }
          >
            <div className="divide-y divide-(--c-surface2) overflow-hidden rounded-[16px] bg-(--c-surface)">
              {SOURCES.map((s) => (
                <Row key={s.id} title={s.title} desc={s.desc} badge={s.badge} onClick={() => finish(s.id)} />
              ))}
            </div>
            <div className="mt-5 divide-y divide-(--c-surface2) overflow-hidden rounded-[16px] bg-(--c-surface)">
              <Row title="手动添加" onClick={() => finish('manual')} />
            </div>
          </Step>
        )}
      </AnimatePresence>
    </div>
  )
}
