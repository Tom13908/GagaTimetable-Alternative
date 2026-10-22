import React, { useMemo, useRef, useState } from 'react'
import type { Semester } from '../domain/types'
import { fmtMinutes } from '../domain/dates'
import {
  DURATION_STEP, MAX_DURATION, MIN_DURATION, MIN_SEGMENTS,
  applyPlan, breakBefore, draftFromGrid, endOf, gridFromDraft, invalidPeriods,
  naturalSegmentCount, planBreaks, planFromGrid, planSetCount, planSetDuration, planSetStart,
  resetEnd, segmentCapacity, setEnd, setStart, spanText, type DayPlan, type ScheduleDraft,
} from '../domain/schedule'
import { store } from './store'
import { Chips, Page, PrimaryButton, Sheet, SheetClose, SheetHead, Stepper, Switch, TimeSheet, TimeWheels, TopBar } from './ui'

/* 作息时间：上面按「一天分几段」铺骨架，下面逐节细调 */

const breakName = (start: number) => (start < 15 * 60 ? '午休' : start < 20 * 60 ? '晚饭' : '休息')

/** 「一天分几段」的可选项，下标 0 对应 MIN_SEGMENTS */
const SEGMENT_ITEMS = ['2 段', '3 段']

type Pick = { i: number; which: 'start' | 'end' }

/** 节次行：序号 26 | 开始胶囊 | 箭头 | 下课胶囊 | 时长，两个胶囊平分余宽 */
const COL_IDX = 'w-[26px] flex-none'
const COL_DUR = 'ml-3 w-[46px] flex-none text-right'

function ArrowIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" style={{ stroke: 'var(--c-ink4)' }} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="mx-2 flex-none">
      <path d="M4 12h16M14 6l6 6-6 6" />
    </svg>
  )
}

export function SchedulePage({ sem, onBack }: { sem: Semester; onBack: () => void }) {
  const [d, setD] = useState<ScheduleDraft>(() => draftFromGrid(sem.timeGrid))
  const [segCount, setSegCount] = useState(() => naturalSegmentCount(sem.timeGrid))
  const [pick, setPick] = useState<Pick | null>(null)
  const [pickSeg, setPickSeg] = useState<number | null>(null)
  const bad = useMemo(() => new Set(invalidPeriods(d)), [d])
  const n = d.starts.length
  /* 段结构从当前课表反推，所以下面怎么改，上面立刻跟着变；上面一改，就按它重新铺一遍 */
  const plan = useMemo(() => planFromGrid(gridFromDraft(d), segCount), [d, segCount])
  const breaks = planBreaks(plan)
  const dirty = useMemo(() => JSON.stringify(gridFromDraft(d)) !== JSON.stringify(sem.timeGrid), [d, sem.timeGrid])
  const usePlan = (next: DayPlan) => setD(applyPlan(d, next))

  return (
    <Page>
      <div className="flex-1 overflow-y-auto px-5 pb-[130px] [scrollbar-width:none]">
        <TopBar title="作息时间" sub={`${n} 节`} onBack={onBack} />

        <div className="mt-6 rounded-[18px] bg-(--c-surface) px-4">
          <div className="flex items-center py-3">
            <span className="flex-1 text-[14px] font-semibold text-(--c-ink)">一天分几段</span>
            <Chips items={SEGMENT_ITEMS} active={segCount - MIN_SEGMENTS} onPick={(i) => setSegCount(MIN_SEGMENTS + i)} />
          </div>
          <div className="pb-3 text-[12px] leading-[1.6] font-medium text-(--c-ink4)">
            {plan.segments.map((s) => s.name).join(' · ')}
            {breaks.length > 0 && `，段与段之间就是${breaks.map((b) => b.name).join('和')}`}
          </div>
          <div className="flex items-center border-t border-(--c-line2) py-3">
            <span className="flex-1 text-[14px] font-semibold text-(--c-ink)">每节时长</span>
            <Stepper value={plan.duration} unit="分" min={MIN_DURATION} max={MAX_DURATION} step={DURATION_STEP} onChange={(v) => usePlan(planSetDuration(plan, v))} />
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
              <Stepper value={s.count} unit="节" min={0} max={segmentCapacity(plan, i)} onChange={(v) => usePlan(planSetCount(plan, i, v))} />
            </div>
          ))}
        </div>

        <div className="mt-5 flex items-baseline px-0.5">
          <span className="flex-1 text-[12px] font-bold tracking-[-.01em] text-(--c-ink5)">节次</span>
        </div>
        <div className="mt-2 rounded-[18px] bg-(--c-surface) px-4">
          <div className="flex items-center pt-3 pb-1 text-[11px] font-semibold text-(--c-ink5)">
            <span className={COL_IDX} />
            <span className="flex-1 text-center">开始</span>
            <span className="mx-2 w-[16px] flex-none" />
            <span className="flex-1 text-center">下课</span>
            <span className={COL_DUR}>时长</span>
          </div>
          {d.starts.map((s, i) => {
            const e = endOf(d, i)
            const custom = d.ends[i] != null
            const gap = breakBefore(d, i)
            const big = gap >= 60
            const wrong = bad.has(i)
            return (
              <React.Fragment key={i}>
                {i > 0 && (
                  <div className={`flex items-center ${big ? 'h-[30px]' : 'h-[18px]'}`}>
                    <span className={COL_IDX} />
                    <span className={`flex-1 border-t border-dashed ${big ? 'border-(--c-line)' : 'border-(--c-line2)'}`} />
                    <span className={`px-2 text-[11px] font-semibold tabular-nums ${gap < 0 ? 'text-(--c-danger)' : big ? 'text-(--c-ink4)' : 'text-(--c-ink5)'}`}>
                      {gap < 0 ? `重叠 ${spanText(-gap)}` : `${big ? `${breakName(s)} ` : ''}${spanText(gap)}`}
                    </span>
                    <span className={`flex-1 border-t border-dashed ${big ? 'border-(--c-line)' : 'border-(--c-line2)'}`} />
                  </div>
                )}
                <div className="flex items-center py-1.5">
                  <span className={`${COL_IDX} text-[12.5px] font-bold tabular-nums text-(--c-ink4)`}>{i + 1}</span>
                  <button
                    onClick={() => setPick({ i, which: 'start' })}
                    className={`flex-1 rounded-[10px] bg-(--c-surface2) py-1.5 text-center text-[15px] font-bold tabular-nums transition-transform duration-150 active:scale-[.96] ${wrong ? 'text-(--c-danger)' : 'text-(--c-ink)'}`}
                  >
                    {fmtMinutes(s)}
                  </button>
                  <ArrowIcon />
                  <button
                    onClick={() => setPick({ i, which: 'end' })}
                    className={`flex-1 rounded-[10px] py-1.5 text-center text-[15px] tabular-nums transition-transform duration-150 active:scale-[.96] ${custom ? 'font-bold text-(--c-ink)' : 'font-medium text-(--c-ink4)'}`}
                    style={custom ? { boxShadow: 'inset 0 0 0 1.5px var(--c-accent)' } : undefined}
                  >
                    {fmtMinutes(e)}
                  </button>
                  <span className={`${COL_DUR} text-[12px] font-semibold tabular-nums ${custom ? 'text-(--c-accent)' : 'text-(--c-ink5)'}`}>{e - s} 分</span>
                </div>
              </React.Fragment>
            )
          })}
          <div className="h-2" />
        </div>
      </div>

      <div className="flex-none px-5 pt-2 pb-[max(22px,env(safe-area-inset-bottom))]">
        <PrimaryButton
          disabled={!dirty || bad.size > 0}
          onClick={() => {
            store.setSemester({ ...sem, timeGrid: gridFromDraft(d) })
            onBack()
          }}
        >保存</PrimaryButton>
      </div>

      {pick && (
        <ScheduleTimeSheet
          draft={d}
          pick={pick}
          onApply={(next) => setD(next)}
          onClose={() => setPick(null)}
        />
      )}

      {pickSeg != null && (
        <TimeSheet
          value={fmtMinutes(plan.segments[pickSeg].start)}
          title={`${plan.segments[pickSeg].name}第 1 节开始`}
          step={5}
          onPick={(v) => {
            const [h, m] = v.split(':').map(Number)
            usePlan(planSetStart(plan, pickSeg, h * 60 + m))
          }}
          onClose={() => setPickSeg(null)}
        />
      )}
    </Page>
  )
}

/** 改某节开始 / 下课：时:分滚轮；改开始时可选「后续节次同步平移」；改过的下课可恢复标准时长 */
function ScheduleTimeSheet({ draft, pick, onApply, onClose }: { draft: ScheduleDraft; pick: Pick; onApply: (d: ScheduleDraft) => void; onClose: () => void }) {
  const dismiss = useRef<(() => void) | null>(null)
  const { i, which } = pick
  const [m, setM] = useState(which === 'start' ? draft.starts[i] : endOf(draft, i))
  const [shift, setShift] = useState(true)
  const isStart = which === 'start'
  const preview = isStart ? setStart(draft, i, m, shift) : setEnd(draft, i, m)
  const last = draft.starts.length - 1
  const custom = draft.ends[i] != null
  const sub = isStart
    ? `${fmtMinutes(preview.starts[i])} – ${fmtMinutes(endOf(preview, i))}`
    : `${fmtMinutes(draft.starts[i])} – ${fmtMinutes(endOf(preview, i))}`
  return (
    <Sheet
      onClose={onClose}
      dismissRef={dismiss}
      className="px-5 pb-1"
      header={<SheetHead title={`第 ${i + 1} 节 ${isStart ? '开始' : '下课'}`} sub={sub} trail={<SheetClose onClick={() => dismiss.current?.()} />} />}
      footer={
        <div className="px-5 pt-2">
          <PrimaryButton onClick={() => { onApply(preview); dismiss.current?.() }}>确定</PrimaryButton>
        </div>
      }
    >
      <TimeWheels minutes={m} onChange={setM} step={5} className="py-3" />
      {isStart && i < last && (
        <div className="mt-1 flex items-center rounded-[14px] bg-(--c-row-muted) px-3.5 py-3">
          <span className="flex-1 text-[13.5px] font-semibold text-(--c-ink)">后续节次同步平移</span>
          <Switch on={shift} onChange={setShift} />
        </div>
      )}
      {!isStart && custom && (
        <div className="mt-1 flex items-center rounded-[14px] bg-(--c-row-muted) px-3.5 py-3">
          <span className="flex-1 text-[13.5px] font-semibold text-(--c-ink)">标准时长 {draft.duration} 分</span>
          <button onClick={() => { onApply(resetEnd(draft, i)); dismiss.current?.() }} className="text-[13px] font-bold text-(--c-accent) transition-opacity active:opacity-60">
            恢复
          </button>
        </div>
      )}
    </Sheet>
  )
}
