import { useEffect, useMemo, useState } from 'react'
import type { School } from '../domain/edu/schools'
import { schoolByUrl } from '../domain/edu/schools'
import { SYSTEM_LABEL, detectSystem, hostOf } from '../domain/edu/systems'
import { eduProfile, zfLoginAvailable } from './edu-browser'
import {
  DEFAULT_INTERVAL_HOURS,
  MAX_INTERVAL_HOURS,
  elapsedText,
  logoutEduSync,
  outcomeText,
  saveEduSetup,
  statusText,
  syncNow,
  useEduSync,
  type EduSyncMode,
} from './edu-sync'
import { Field, Loader, Page, PrimaryButton, Row, Switch, TextInput, TopBar } from './ui'
import { haptic, nativeConfirm, nativeToast } from './widgets'

/*
 * 「我的 → 自动更新」：教务系统的绑定与自动更新设置都在这一页。
 *
 * 绑定信息（学校 / 网址 / 账号密码）就是自动更新要用的东西，所以首次绑定也在这里做：
 * 正方学校填上学号密码即可，不必先绕一趟内置浏览器。其它系统没有直连登录的能力，
 * 只能在「从教务系统导入」时把浏览器会话留下来，这一页只负责开关与查看。
 *
 * 密码只存在本机应用数据里，退出登录会连同浏览器会话一起删掉。
 */
export function EduAutoPage({ initialUrl, onBack, onPickSchool }: { initialUrl?: string; onBack: () => void; onPickSchool: () => void }) {
  const s = useEduSync()
  const [url, setUrl] = useState(initialUrl ?? s?.school.url ?? '')
  const [user, setUser] = useState(s?.user ?? '')
  const [password, setPassword] = useState(s?.password ?? '')
  const [showPw, setShowPw] = useState(false)
  const [enabled, setEnabled] = useState(s ? s.enabled : true)
  const [mode, setMode] = useState<EduSyncMode>(s?.mode ?? 'interval')
  const [hours, setHours] = useState(String(s?.intervalHours ?? DEFAULT_INTERVAL_HOURS))
  const [busy, setBusy] = useState(false)
  /* 本次手动拉取的耗时，拉完显示在按钮那一行 */
  const [lastMs, setLastMs] = useState<number | null>(null)

  /* 选完学校回来是同一条路由（key 不变，组件不会重挂），靠这个把网址换过去 */
  useEffect(() => {
    if (initialUrl) setUrl(initialUrl)
  }, [initialUrl])

  const native = zfLoginAvailable()
  const school = useMemo<School | null>(() => {
    const u = url.trim()
    if (!u) return null
    return schoolByUrl(u) ?? { name: hostOf(u), system: null, url: u }
  }, [url])
  /* 只有正方能在没有浏览器会话的情况下自己重新登录 */
  const sys = school ? detectSystem(school.url, school.system) : null
  const zf = sys === 'zhengfang_new'
  /* 认不出是哪个系统，又填了账号密码：直连用不上，得把地址补全 */
  const unknown = !!school && sys === null && (user.trim() !== '' || password !== '')
  const ready = native && !!school

  const hoursNum = useMemo(() => {
    const v = Number(hours)
    if (!Number.isFinite(v) || v <= 0) return s?.intervalHours ?? DEFAULT_INTERVAL_HOURS
    return Math.min(MAX_INTERVAL_HOURS, v)
  }, [hours, s])

  /* 写回设置。网址为空时不动，免得把已绑定的抹掉 */
  const save = (): boolean => {
    if (!ready || !school) return false
    const same = !!s && eduProfile(s.school.url) === eduProfile(school.url)
    saveEduSetup({
      school,
      /* 同一所学校时保留导入时记下的课表页，会话失效的判断依赖它 */
      pageUrl: same && s ? s.pageUrl : school.url,
      term: same && s ? s.term : undefined,
      user: user.trim(),
      password,
      enabled,
      mode,
      intervalHours: hoursNum,
    })
    return true
  }

  const onSave = () => {
    if (!save()) return
    haptic('success')
    nativeToast('已保存')
  }

  const pull = async () => {
    if (busy || !save()) return
    setBusy(true)
    try {
      const o = await syncNow()
      setLastMs(o.elapsedMs)
      haptic(o.result === 'ok' || o.result === 'nochange' ? 'success' : 'error')
      nativeToast(`${outcomeText(o)}，用时 ${elapsedText(o.elapsedMs)}`)
    } finally {
      setBusy(false)
    }
  }

  const logout = async () => {
    if (!s) return
    const ok = await nativeConfirm({ title: '退出登录', message: `清除${s.school.name}的登录会话与账号密码，关闭自动更新`, ok: '退出' })
    if (!ok) return
    await logoutEduSync()
    haptic('warning')
    nativeToast('已退出登录')
    onBack()
  }

  const status = s ? statusText(s) : null
  const shown = lastMs ?? (s?.lastMs || null)

  return (
    <Page>
      <div className="flex-1 overflow-y-auto px-5 pb-6 [scrollbar-width:none]">
        <TopBar title="自动更新" sub={s ? s.school.name : '记下教务系统，课表自己更新'} onBack={onBack} />

        <div className="mt-6 divide-y divide-(--c-surface2) overflow-hidden rounded-[16px] bg-(--c-surface)">
          <Field k="学校" sub={school ? school.url : undefined}>
            <div className="flex items-center gap-2">
              <button onClick={onPickSchool} className="min-w-0 flex-1 truncate text-left text-[14px] font-semibold text-(--c-ink)">
                {school ? school.name : '选择学校'}
              </button>
              {school?.system && <span className="flex-none text-[12px] font-medium text-(--c-ink4)">{SYSTEM_LABEL[school.system]}</span>}
            </div>
          </Field>
          <Field k="网址">
            <TextInput
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="教务系统网址"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              inputMode="url"
              className="text-[13px]"
            />
          </Field>
          <Field k="学号">
            <TextInput
              value={user}
              onChange={(e) => setUser(e.target.value)}
              placeholder="学号 / 用户名"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              className="text-[13px]"
            />
          </Field>
          <Field k="密码">
            <div className="flex items-center gap-2">
              <TextInput
                type={showPw ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="教务系统密码"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                className="min-w-0 flex-1 text-[13px]"
              />
              <button onClick={() => setShowPw((v) => !v)} className="flex-none text-[12px] font-semibold text-(--c-accent)">
                {showPw ? '隐藏' : '显示'}
              </button>
            </div>
          </Field>
        </div>

        <div className="mt-2.5 overflow-hidden rounded-[16px] bg-(--c-surface)">
          <div className="flex items-center px-4 py-3.5">
            <div className="min-w-0 flex-1">
              <div className="text-[14px] font-bold">自动更新课表</div>
              <div className={`mt-0.5 text-[12px] font-medium ${status?.danger ? 'text-(--c-danger)' : 'text-(--c-ink4)'}`}>
                {status ? status.text : '还没绑定教务系统'}
              </div>
            </div>
            <Switch on={enabled} onChange={setEnabled} />
          </div>

          <ModeRow title="每次开启 APP 时更新" desc="App 启动时更新一次" active={mode === 'launch'} disabled={!enabled} onClick={() => setMode('launch')} />
          <ModeRow
            title="每隔一段时间更新"
            desc={`上次更新超过 ${hoursNum} 小时后，下次打开时更新`}
            active={mode === 'interval'}
            disabled={!enabled}
            onClick={() => setMode('interval')}
          >
            <div className="mr-3 w-[52px] flex-none" onClick={(e) => e.stopPropagation()}>
              <TextInput
                type="number"
                min={1}
                max={MAX_INTERVAL_HOURS}
                value={hours}
                onFocus={() => enabled && setMode('interval')}
                onChange={(e) => setHours(e.target.value)}
                onBlur={() => setHours(String(hoursNum))}
                className="text-right text-[13px]"
              />
            </div>
            <span className={`mr-1 flex-none text-[12.5px] font-medium ${mode === 'interval' && enabled ? 'text-(--c-accent)' : 'text-(--c-ink4)'}`}>小时</span>
          </ModeRow>

          <div className="border-t border-(--c-surface2)" />
          <Row
            title="立即拉取课表"
            desc={ready ? '拉一次最新课表，结果直接并入当前课表' : '先填好网址与账号密码'}
            onClick={() => void pull()}
            right={
              busy ? (
                <Loader className="ml-3 flex-none text-(--c-ink4)" />
              ) : shown ? (
                <span className="ml-3 flex-none text-[12.5px] font-medium tabular-nums text-(--c-ink4)">用时 {elapsedText(shown)}</span>
              ) : (
                <span />
              )
            }
          />
        </div>

        {school && sys && !zf && (
          <div className="mt-2.5 rounded-[16px] bg-(--c-surface) px-4 py-3.5 text-[12.5px] leading-[1.6] font-medium text-(--c-ink4)">
            这个系统不是正方，账号密码用不上，仍靠导入时留下的浏览器会话；会话过期需要重新走一次「从教务系统导入」。
          </div>
        )}

        {unknown && (
          <div className="mt-2.5 rounded-[16px] bg-(--c-surface) px-4 py-3.5 text-[12.5px] leading-[1.6] font-medium text-(--c-ink4)">
            认不出这个教务系统，账号密码暂时用不上。正方的话，把地址填到课表页的完整地址（路径里带 /jwglxt/），密码才能用来自动重新登录。
          </div>
        )}

        <div className="mt-2.5 rounded-[16px] bg-(--c-surface) px-4 py-3.5 text-[12.5px] leading-[1.6] font-medium text-(--c-ink4)">
          账号密码只写在这台手机上（应用自己的数据目录），不加密、不上传，用来在后台更新课表。点「退出登录」会连同浏览器会话一起删掉。
        </div>

        {s && (
          <div className="mt-2.5 overflow-hidden rounded-[16px] bg-(--c-surface)">
            <Row title="退出登录" desc={`清除${s.school.name}的会话与账号密码`} danger onClick={() => void logout()} right={<span />} />
          </div>
        )}

        {!native && (
          <div className="mt-2.5 rounded-[16px] bg-(--c-surface) px-4 py-3.5 text-[12.5px] font-medium text-(--c-ink4)">自动更新仅在应用内可用</div>
        )}
      </div>

      <div className="flex-none px-5 pt-2 pb-[max(22px,env(safe-area-inset-bottom))]">
        <PrimaryButton disabled={!ready} onClick={onSave}>
          保存
        </PrimaryButton>
      </div>
    </Page>
  )
}

/* 更新方式的两行：整行可点，选中项右侧打勾 */
function ModeRow({ title, desc, active, disabled, onClick, children }: { title: string; desc?: string; active: boolean; disabled: boolean; onClick: () => void; children?: React.ReactNode }) {
  const on = active && !disabled
  return (
    <div
      onClick={disabled ? undefined : onClick}
      className={`flex items-center px-4 py-3.5 transition-colors ${disabled ? 'opacity-40' : 'active:bg-(--c-bg)'} ${on ? 'bg-(--c-accent-soft)' : ''}`}
    >
      <div className="min-w-0 flex-1">
        <div className={`text-[14px] font-bold ${on ? 'text-(--c-accent)' : 'text-(--c-ink)'}`}>{title}</div>
        {desc && <div className="mt-0.5 text-[12px] font-medium text-(--c-ink4)">{desc}</div>}
      </div>
      {children}
      {on && (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" className="flex-none" style={{ stroke: 'var(--c-accent)' }} strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="m5 12.5 4.5 4.5L19 7" />
        </svg>
      )}
    </div>
  )
}
