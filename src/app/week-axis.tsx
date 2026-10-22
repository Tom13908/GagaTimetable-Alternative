import React, { memo } from 'react'
import { cardFit, fitLoc, stickerReserve, stickerSize, type TimeAxis } from '../domain/time-axis'
import { fmtMinutes } from '../domain/dates'
import { Sticker, stickerTilt } from './Sticker'
import { inkMix, tint } from './ui'

function clampStyle(lines: number): React.CSSProperties | undefined {
  return lines > 1 ? { display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: lines } : undefined
}

export type WeekCardStatus = 'normal' | 'moved' | 'cancelled' | 'leave' | 'done'

/**
 * 周视图卡片：按自身高宽决定课名、地点各排几行。
 * 冲突时后一张卡叠在前一张下面右移 5px 露出一条边（原型做法）；textTop 是它被盖住的高度，文字从露出的部分开始排。
 * 状态只用底纹表达，不压文字：停课 = 空心虚线框 + 划掉；请假 = 斜纹底；调课 = 点阵底；静音 = 浅底 + 淡字。
 * props 全是原始值，memo 之后「now 每 30s 一跳 / 切天 / liftKey 变化」不再让整页卡片重算 cardFit。
 */
export const WeekCard = memo(function WeekCard({ name, loc, color, h, w, now, done, progress, sticker, status = 'normal', muted, ring, textTop = 0, tone }: {
  name: string
  loc?: string
  color: string
  h: number
  w: number
  now?: boolean
  done?: boolean
  progress?: number
  sticker?: string | null
  status?: WeekCardStatus
  muted?: boolean
  ring?: string
  textTop?: number
  tone?: number
}) {
  /* 贴纸固定在卡片右下角，排字时先把那一块扣掉——这样它永远压不到字，跨几节的卡片也都在同一个角。
     尺寸和让出的高度都按列宽算（手机一列 37px，17px 的贴纸会占掉半个卡宽）。 */
  const sSize = sticker ? stickerSize(w) : 0
  const fit = cardFit(h - textTop - (sticker ? stickerReserve(w) : 0), w, name, loc)
  const lineCls = (n: number) => (n > 1 ? 'overflow-hidden wrap-anywhere' : 'truncate')
  const cancelled = status === 'cancelled'
  const fill = tint(color, tone ?? (now ? 22 : done ? 7 : muted ? 5 : 10))
  const background = cancelled
    ? 'transparent'
    : status === 'leave'
      ? `repeating-linear-gradient(135deg, ${fill} 0 4px, transparent 4px 8px)`
      : status === 'moved'
        ? `radial-gradient(${fill} 1.6px, transparent 1.8px) 0 0 / 6px 6px, ${tint(color, 4)}`
        : fill
  /* 贴纸位置见上：右下角，已经让出位置，不用再判空 */
  return (
    <div
      className={`relative h-full w-full rounded-[9px] text-left font-bold ${fit?.dense ? 'px-[2px] py-0.5' : 'px-[2px] py-1'} ${cancelled ? 'line-through' : ''}`}
      style={{
        background,
        color: inkMix(color, cancelled || muted ? 60 : 85),
        boxShadow: ring ?? (now ? `inset 0 0 0 1.5px ${color}` : undefined),
        outline: cancelled ? `1.5px dashed ${tint(color, 55)}` : undefined,
        outlineOffset: cancelled ? -1.5 : undefined,
        paddingTop: textTop > 0 ? textTop + (fit?.dense ? 2 : 4) : undefined,
      }}
    >
      <div className="relative">
        {fit && (
          <div className={`relative text-[10px] leading-[1.3] ${lineCls(fit.nameLines)}`} style={clampStyle(fit.nameLines)}>
            {name}
          </div>
        )}
        {fit && fit.locLines > 0 && loc && (
          <div
            className={`relative mt-0.5 text-[9px] leading-[1.25] font-semibold opacity-60 ${lineCls(fit.locLines)}`}
            style={clampStyle(fit.locLines)}
          >
            {fitLoc(loc, fit.locLines, w)}
          </div>
        )}
      </div>
      {now && progress != null && (
        <div className="pointer-events-none absolute inset-0 overflow-hidden rounded-[9px]">
          <div className="absolute inset-x-0 top-0 bg-(--c-surface)/60" style={{ height: progress }} />
        </div>
      )}
      {sticker && (
        <Sticker
          id={sticker}
          size={sSize}
          tilt={stickerTilt(name)}
          className="pointer-events-none absolute right-0 bottom-0"
        />
      )}
    </div>
  )
})

/** 左侧节次刻度：序号 + 开始时刻；当前时刻不与刻度打架时单独标出 */
export function WeekAxis({ axis, nowTop, nowLabel }: { axis: TimeAxis; nowTop?: number; nowLabel?: string }) {
  const periods = axis.segs.filter((s) => s.kind === 'period')
  return (
    <div className="relative w-8 flex-none" style={{ height: axis.height }}>
      {periods.map((s) => (
        <div key={s.index} className="absolute right-1.5 left-0 text-right" style={{ top: s.y0 + 4 }}>
          <div className="text-[10.5px] leading-none font-bold tabular-nums text-(--c-ink4)">{s.index}</div>
          <div className="mt-[3px] text-[8.5px] leading-none font-semibold tabular-nums text-(--c-ink5)">{fmtMinutes(s.t0).replace(/^0/, '')}</div>
        </div>
      ))}
      {nowTop != null && nowLabel && periods.every((s) => Math.abs(nowTop - s.y0) >= 22) && (
        <div className="absolute right-1.5 text-[9.5px] font-bold tabular-nums text-(--c-accent)" style={{ top: nowTop - 6 }}>{nowLabel}</div>
      )}
    </div>
  )
}

/**
 * 网格线：每两节之间一条横线，落在两张卡之间空隙的正中（卡片上下各内缩 1.5px，所以线离两边的卡都是 3px）。
 * 午休 / 晚饭那种长带子，线走在带子的**正中间**，并且分成名字左右两段——名字不能被线穿过。
 * 原来把线压到带子下沿、贴着下面那一行卡片，跟别的线不是一个节奏，就显得「对不齐」。
 * 第一行上面不画线（那里是网格顶边，画一条会像一根游离的横杠）。
 */
export function WeekLines({ axis }: { axis: TimeAxis }) {
  return (
    <>
      {axis.segs.map((s, i) => {
        const prev = axis.segs[i - 1]
        if (s.kind === 'period') {
          /* 有名字的长带自己画了「线—名字—线」，这里再按中点补一条贯穿全宽的，
             就会从「午休」两个字中间穿过去。只有无名带的课间才需要这条共用的线。 */
          if (prev?.kind !== 'gap' || prev.label) return null
          const y = (prev.y0 + prev.y1) / 2
          return <div key={i} className="pointer-events-none absolute inset-x-0 h-px bg-(--c-line2)" style={{ top: y }} />
        }
        if (s.kind === 'gap' && s.label) {
          return (
            <div
              key={i}
              className="pointer-events-none absolute inset-x-0 flex items-center gap-2 text-[9px] leading-none font-semibold text-(--c-ink4)"
              style={{ top: s.y0, height: s.y1 - s.y0 }}
            >
              <i className="h-px flex-1 bg-(--c-line2)" />
              <span>{s.label}</span>
              <i className="h-px flex-1 bg-(--c-line2)" />
            </div>
          )
        }
        return null
      })}
    </>
  )
}
