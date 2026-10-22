import React from 'react'
import ReactDOM from 'react-dom/client'
import { initStore } from './app/store'
import { initTheme } from './app/theme'
import { notifyWebReady } from './app/widgets'
import './index.css'

const params = new URLSearchParams(window.location.search)
const proto = params.has('proto')
const onboardStep = params.get('onboardStep')

/** 静态首屏壳（index.html 内联）已接管画面，这里只负责把它撤掉 */
function dropBootShell() {
  const drop = (window as { __ttDropBoot?: () => void }).__ttDropBoot
  if (typeof drop === 'function') { drop(); return }
  document.getElementById('boot')?.remove()
}

async function boot() {
  initTheme()
  // 第二段（RealApp）与 initStore 并行下载：原来 await initStore 之后才发起 import，
  // 中间那 100ms 空窗既不下载也不渲染
  const prefetch = onboardStep == null && !proto ? import('./app/RealApp') : null
  // 只是别让它在这期间被当成未处理拒绝；真正的错误仍在下面的 await 处抛
  prefetch?.catch(() => undefined)
  await initStore()
  const root = ReactDOM.createRoot(document.getElementById('root')!)
  if (onboardStep != null) {
    if (params.has('still')) {
      const s = document.createElement('style')
      s.textContent = '*{animation:none!important;transition:none!important}'
      document.head.appendChild(s)
    }
    const { default: Onboarding } = await import('./app/Onboarding')
    root.render(<Onboarding initialStep={Number(onboardStep)} onDone={() => {}} />)
    dropBootShell()
    return
  }
  // 原型（tools/shoot-dark.py 用 ?proto 打开）改成按需加载：正式冷启动不再解析、执行它
  if (proto) {
    const { default: Prototype } = await import('./App')
    root.render(<React.StrictMode><Prototype /></React.StrictMode>)
  } else {
    const { default: RealApp } = await prefetch!
    root.render(<React.StrictMode><RealApp /></React.StrictMode>)
  }
  requestAnimationFrame(() => requestAnimationFrame(() => {
    dropBootShell()
    notifyWebReady()
  }))
}

void boot()
