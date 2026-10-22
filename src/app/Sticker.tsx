import React, { useEffect, useState, useSyncExternalStore } from 'react'
import { stickerSrc } from '../domain/stickers'

const ON_KEY = 'tt.stickers'
let stickersOn = localStorage.getItem(ON_KEY) !== '0'
const onListeners = new Set<() => void>()

/** 课程贴纸开关：默认开，关掉后所有 Sticker 不渲染 */
export function setStickersOn(on: boolean) {
  stickersOn = on
  if (on) localStorage.removeItem(ON_KEY)
  else localStorage.setItem(ON_KEY, '0')
  onListeners.forEach((l) => l())
}

export function useStickersOn(): boolean {
  return useSyncExternalStore(
    (l) => {
      onListeners.add(l)
      return () => onListeners.delete(l)
    },
    () => stickersOn,
  )
}

interface Art { vb: string; size: number; body: string }

const arts = new Map<string, Art | null>()
const loading = new Map<string, Promise<Art | null>>()
/* 拼好的图（刀切边颜色/粗细跟主题走，所以键里带边色与边宽） */
const urls = new Map<string, string>()
/* 按显示尺寸落到位图：SVG 每被重绘一次就要重新光栅化几百条路径，
   在 660 这类机器上横滑时每一帧都在重付这笔账。位图只要贴一次。 */
const bitmaps = new Map<string, string>()
const urlListeners = new Set<() => void>()
let artVersion = 0

/* 换主题要重拼：边缘色是写进 SVG 里的，不是 CSS 变量能穿透的。
   主题用的是 <html data-theme>，属性一变就整体作废重来。 */
if (typeof MutationObserver !== 'undefined') {
  new MutationObserver(() => {
    urls.clear()
    bitmaps.clear()
    artVersion++
    urlListeners.forEach((l) => l())
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style', 'class'] })
}

function useArtVersion() {
  return useSyncExternalStore(
    (l) => {
      urlListeners.add(l)
      return () => urlListeners.delete(l)
    },
    () => artVersion,
  )
}

function parse(text: string): Art | null {
  const open = /<svg[^>]*>/.exec(text)
  if (!open) return null
  const vb = /viewBox="([^"]+)"/.exec(open[0])?.[1] ?? '0 0 128 128'
  const size = Number(vb.split(/[\s,]+/)[2]) || 128
  const body = text.slice(open.index + open[0].length).replace(/<\/svg>\s*$/, '')
  return { vb, size, body }
}

function load(id: string): Promise<Art | null> {
  const cached = loading.get(id)
  if (cached) return cached
  const p = fetch(stickerSrc(id))
    .then((r) => (r.ok ? r.text() : ''))
    .then((t) => parse(t))
    .catch(() => null)
    .then((a) => {
      arts.set(id, a)
      return a
    })
  loading.set(id, p)
  return p
}

const cssVar = (name: string, fallback: string) => {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v.length > 0 ? v : fallback
}

/** 刀切边那层：把图形自带的 fill/stroke 全剥掉，统一由外层 g 给边色 */
function edgeBody(body: string): string {
  return body
    .replace(/\s(fill|stroke|opacity)="[^"]*"/g, '')
    .replace(/\sstyle="[^"]*"/g, '')
}

/**
 * 把「垫底的描边层 + 原图」拼成一张完整 SVG，交给浏览器当图片画。
 * 原来是两份几千节点的内联 SVG，一屏三周就是一万多个 DOM 节点——
 * 换周、切页、横滑时这些节点都要重排重画，低端平板直接卡到按不动。
 * viewBox 四边各让出半个描边宽度，刀切边就不会被图片边界切掉，
 * 外轮廓的落地位置也因此和原来「overflow:visible 溢出」时一致。
 */
function buildUrl(art: Art, edge: string, edgeW: number): string {
  const w = art.size * edgeW
  const parts = art.vb.split(/[\s,]+/).map(Number)
  const [x, y, vw, vh] = parts.length === 4 && parts.every((n) => Number.isFinite(n))
    ? parts
    : [0, 0, art.size, art.size]
  const pad = w / 2
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x - pad} ${y - pad} ${vw + w} ${vh + w}">`
    + `<g fill="${edge}" stroke="${edge}" stroke-width="${w}" stroke-linejoin="round" stroke-linecap="round">${edgeBody(art.body)}</g>`
    + `<g>${art.body}</g>`
    + '</svg>'
  return URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
}

/** 把矢量图按显示尺寸画成位图，避免每次重绘都重新光栅化整份路径 */
function rasterize(url: string, px: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      try {
        const c = document.createElement('canvas')
        c.width = px
        c.height = px
        const ctx = c.getContext('2d')
        if (!ctx) throw new Error('no 2d context')
        ctx.drawImage(img, 0, 0, px, px)
        resolve(c.toDataURL('image/png'))
      } catch (e) {
        reject(e)
      }
    }
    img.onerror = () => reject(new Error('sticker load failed'))
    img.src = url
  })
}

/** 学科贴纸：原版图形垫一层刀切边，浅色白边、深色同调暗边 */
export function Sticker({ id, size, tilt = 0, hidden, className = '', style }: {
  id: string
  size: number
  tilt?: number
  hidden?: boolean
  className?: string
  style?: React.CSSProperties
}) {
  const on = useStickersOn()
  const ver = useArtVersion()
  const [art, setArt] = useState<Art | null>(() => arts.get(id) ?? null)
  const [bmp, setBmp] = useState<string | null>(null)
  useEffect(() => {
    const hit = arts.get(id)
    if (hit !== undefined) {
      setArt(hit)
      return
    }
    let live = true
    load(id).then((a) => live && setArt(a))
    return () => {
      live = false
    }
  }, [id])

  const edge = typeof document === 'undefined' ? '#FFFFFF' : cssVar('--c-sticker-edge', '#FFFFFF')
  const edgeW = typeof document === 'undefined' ? 0.07 : Number(cssVar('--c-sticker-edge-w', '0.07')) || 0.07
  const key = `${id}|${edge}|${edgeW}`
  let url = art ? urls.get(key) : ''
  if (art && !url) {
    url = buildUrl(art, edge, edgeW)
    urls.set(key, url)
  }
  url = url ?? ''
  const dpr = typeof devicePixelRatio === 'number' ? Math.min(devicePixelRatio, 3) : 1
  const px = Math.max(8, Math.min(256, Math.round(size * dpr)))
  const bkey = `${key}|${px}`

  useEffect(() => {
    if (!url) return
    const hit = bitmaps.get(bkey)
    if (hit) {
      setBmp(hit)
      return
    }
    let live = true
    rasterize(url, px).then((d) => {
      bitmaps.set(bkey, d)
      if (live) setBmp(d)
    }).catch(() => undefined)
    return () => {
      live = false
    }
  }, [bkey, url, px])

  if (!on || !art) return null

  return (
    <img
      data-sticker
      src={bitmaps.get(bkey) ?? url}
      alt=""
      draggable={false}
      width={size}
      height={size}
      aria-hidden
      className={`sticker transition-opacity duration-150 ${className}`}
      style={{ width: size, height: size, transform: tilt ? `rotate(${tilt}deg)` : undefined, ...style, opacity: hidden ? 0 : style?.opacity ?? 1 }}
      data-v={ver}
      data-bmp={bmp ? 1 : 0}
    />
  )
}

/** 同一课名的贴纸每次都歪同一个角度 */
export function stickerTilt(seed: string): number {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0
  const tilts = [-8, 6, -5, 7, -9, 5, -6, 8]
  return tilts[Math.abs(h) % tilts.length]
}
