# AGENTS.md

## UI 规范

原型 `src/App.tsx` 是唯一 UI 事实来源。生产壳 `src/app/RealApp.tsx` 必须与原型逐屏一致：布局、间距、字号、颜色、层级、状态呈现、交互与动画。原型里有的直接搬，不自创近似实现。

### 文案

- 客观、简短、商业软件级别。
- 禁止：教程式/第二人称句子、实现术语（入库、事务、三方合并等）、解释显而易见的下一步、免责安抚句、"可以怎么用"的说明。
- 页面标题用名词短语；副标题只在携带信息（学期、周次、门数）时出现。

### 交互

- 编辑、新增、导入、规则、冲突、变更一律全屏内页，禁止模态框套模态框。
- 主操作用底部大号实心主题色按钮（`PrimaryButton`）。
- 导入完成后回到课表，不停留在规则页。
- 本地解析不做进度条；同一屏不得出现多条进度指示。
- 返回必须回到上一页；系统返回键优先出栈，栈空回「今天」，再按退出。
- 长按课程：卡片抬起高亮，菜单出现在下方且不遮住它。
- 日历面板只能上下滚动，从底部滑入滑出，不做左右翻月/翻周。
- 「今天」不画圆圈圆点，只用主题色文字区分；日期条用圆角矩形高亮选中项。
- 内置规则不可编辑，不显示版本号、上次使用等实现信息。

### 动画

统一参数（`src/app/ui.tsx`）：

- 页面推入/退出：`tween`，`cubic-bezier(.25,1,.5,1)`，400ms，水平。
- 底栏指示器：`spring`，`bounce 0.2`，`duration 0.6`，共享 `layoutId`。
- 抽屉：`tween`，`cubic-bezier(.32,.72,0,1)`，300ms，仅 Y 轴。
- 遮罩：200ms 淡入淡出。
- Tab 切换只做淡入淡出。
- 禁止 stagger、弹力带式滚动、馅饼式弹出。

### 数据

生产界面只显示真实 Store 数据。禁止把原型假数据塞进生产。

### 提醒

提醒全部由系统日历发出，应用自己不弹通知。「我的」页的「提醒」分组就是全部设置：两个总开关 `prefs.classRemind`（上课提醒）/ `prefs.taskRemind`（作业提醒，含考试），默认都是关的。关着时只显示开关本身，打开就原地展开对应的提前量选项（`src/app/reminder.tsx` 的 `RemindGroup`，展开动效复用 `SHEET`）。没有独立的「提醒」设置页。

- 关着的类别不进 `planCalendar`（`src/domain/calendar-plan.ts`）。关掉一个开关后，下一次同步会把日历里这一类已有事件删掉；打开则按当前设置重写。
- 日历权限只在开关打开的路径上申请：用户打开开关时，或启动时至少有一个开关开着且还没授权。两个都关着时启动完全不碰 `TtCalendar`，也就不会弹授权页。
- 提前量选项点开是独立内页（`notifPick`）。同步状态那一行只在至少开着一个开关时出现。

### 安全

默认不收集账号密码，不自动登录。教务导入走内置浏览器（`TtEdu`）：用户自己在学校页面登录；只在用户点「导入」时读当前页或调同源接口（教务页后自动读一次课程数量用于胶囊文案，不落库）；先预览再应用；只注入随应用打包的脚本，不下载执行远程脚本。浏览器 Cookie/存储按学校放在独立 WebView Profile（`edu-<host>`），与应用隔离，默认打开和离开时清空；用户开了「保持登录，自动更新课表」才保留该学校的会话（仅 Cookie/存储）。自动更新（`src/app/edu-sync.ts`）默认在不可见 WebView 里打开导入时的课表页、跑导入同一套脚本；不在登录页就标「需要重新登录」，不重试，连续三次失效自动关闭。不支持多 Profile 的老 WebView 不提供保持登录。其余导入只处理用户主动粘贴或选择的内容。

例外：正方学校可以在「我的 → 自动更新」显式填一次学号与密码（`src/app/edu-auto.tsx` + `TtZf`），后台用它自己重新登录，不再依赖浏览器会话——会话过期也能自己回来。凭据只写在应用自己的数据目录里，不加密、不上传，只在用户主动填写并开启自动更新后使用；「退出登录」连同该学校的 WebView Profile 一起删掉。不填凭据时行为与上一段完全一致。

---

## 开发指南

### 命名

| 项 | 值 |
| --- | --- |
| 项目标识 | `GagaTimetable-Alternative` |
| 产品名（图标、引导页、页面标题） | 嘎嘎课程表 |
| 包名 / namespace | `app.gagatimetable.alternative` |
| npm 包名 | `gagatimetable-alternative` |
| 版本线 | `0.x`，与上游 1.4.x 无关；debug 加 `-beta` 后缀 |
| CI 产物 | `GagaTimetable-Alternative-<版本>.apk` |

改包名要同步五处：`android/app/build.gradle` 的 `namespace` 与 `applicationId`、`capacitor.config.ts` 的 `appId`、`strings.xml` 的 `package_name` 与 `custom_url_scheme`、`android/app/src/main/java` 下的目录层级与每个 `.java` 的 `package` / `import` 声明。Manifest 用相对类名（`.MainActivity`、`.widget.*`），不必改。

应用内「检查新版本」「反馈这个页面」指向 `src/domain/edu/release.ts` 的 `REPO`，目前是 `Tom13908/GagaTimetable-Alternative`。

### 目录速查

| 改什么                        | 去哪                                                                                                       |
| -------------------------- | -------------------------------------------------------------------------------------------------------- |
| 路由栈、Tab、导入流程、AI 转换页        | `src/app/RealApp.tsx`                                                                                    |
| 课程详情/编辑/冲突/变更/手动添加/搜索      | `src/app/pages.tsx`                                                                                      |
| 首次引导                       | `src/app/Onboarding.tsx`                                                                                 |
| 公共组件、动效常量                  | `src/app/ui.tsx`                                                                                         |
| 原生桥（对话框、Toast、返回键、小组件）     | `src/app/widgets.ts`、`android/.../WidgetBridge.java`、`MainActivity.java`                                 |
| 周次/节次/冲突算法                 | `src/domain/engine.ts`、`weeks.ts`、`dates.ts`                                                             |
| 导入解析、诊断、normalize          | `src/domain/importer.ts`、`importers/*`、`rules.ts`                                                        |
| 教务导入（选学校/内置浏览器/未识别页）       | `src/app/edu.tsx`、`src/app/edu-browser.ts`、`src/domain/edu/*`、`android/.../TtEdu.java`                   |
| 教务自动更新（设置页、账号密码、更新方式、立即拉取） | `src/app/edu-auto.tsx`、`src/app/edu-sync.ts`；复用会话走 `TtEdu.java` 的 profile / bg* 接口，正方自己重登走 `TtZf.java`   |
| AI Prompt 文本               | `src/domain/ai-prompt.ts`                                                                                |
| Store、持久化、导入合并             | `src/domain/store.ts`、`persistence/`                                                                     |
| 提醒（系统日历同步、两个总开关）           | `src/app/reminder.tsx`、`src/app/calendar.ts`、`src/domain/calendar-plan.ts`、`android/.../TtCalendar.java` |
| 桌面小组件                      | `android/.../widget/`、`src/domain/widget-data.ts`、`tools/`                                               |
| 冷启动首屏壳                     | `index.html` 的 `#boot` + `src/main.tsx`                                                                  |

### 性能约定（实测过，别改回去）

- **首屏壳**：`index.html` 内联一段静态骨架（`#boot`），只对已走过向导的用户显示；壳画完就用内联脚本调 `WidgetBridge.ready()` 撤系统开屏，**不等 React**。`main.tsx` 首帧提交后调 `window.__ttDropBoot()` 收壳，另有 6s 兜底。壳的配色与结构必须与真实首屏一致，改首屏布局时一起改。
- **按需加载**：`xlsx`（`importers/xlsx.ts` 里 `await import('xlsx')`）与原型 `src/App.tsx`（`main.tsx` 里只有 `?proto` 才 `import`）都不在冷启动路径上。别改回顶层静态 import。
- **`main.tsx` 的 `initStore()` 与 `import('./app/RealApp')` 必须并行发起**，不然第二段请求会被 `await` 挡到 100ms 后。
- **周视图 panes 的 key 用周号，外层不要再套 `key={week}`**：翻周时新旧 panes 有两周重叠，React 靠 key 把这两份连同卡片 DOM 挪过来复用（实测 commit 帧 59→33ms）。用槽位序号做 key 会让三份卡片全部重建，等于没优化。
- **`WeekCard` 是 `memo` 的**，props 全是原始值；给它加对象/箭头函数 props 会让 memo 失效。
- **`DateStrip` 已虚拟化**：只渲染可视窗口附近的日期，左右用占位撑总宽，位置公式是 `DAY_PAD + i * DAY_STEP`；窗口按 4 天步进平移。
- **保留 `index.css` 末尾的 `@supports not (height:100dvh)` 兜底**：三处根容器（`RealApp.tsx` 两处、`Onboarding.tsx` 一处）的高度**只由 `h-dvh` 提供**。dvh 是 Chrome 108+ 的单位，老 WebView 会把 `height:100dvh` 整条声明丢掉 → 高度回落 `auto`。向导根的子级全是 `absolute inset-0`，高度一塌成 0 就整页画不出来，偏偏外层 `absolute inset-0 z-[90]` 还在铺着吃事件 → 症状是「看得见主界面、点哪个按钮都没反应」。兜底用 `100vh` 顶上，只在老引擎生效，改 `h-dvh` 用法时连这条一起改。
- **贴纸一律走位图，不要在 DOM 里展开 SVG**（`Sticker.tsx`）：学科贴纸源文件是 devicon，`linux.svg` 一个就 190KB/800 条路径。以前原图 + 刀切边各渲染一份内联 `<svg>`，一周 7 天 × 3 周下来是 **1.2 万个 DOM 节点**；真机（骁龙 660）切到课表要 2 秒。现在按 `id|边色|边宽` 拼成一张带描边的 SVG，再按显示尺寸 `canvas.drawImage` 成 PNG data URL（缓存键带 px）。刀的边缘色/宽度是主题变量，靠 `<html>` 属性上的 MutationObserver 整体失效重建。
- **不要给导航选中底片用 `layoutId`**：共享布局动画每帧都要量视口盒，真机采样一次切页 **2888 次 `getBoundingClientRect`、约 900ms**。现在是一块固定宽度的 `motion.i`，只动 `x` 百分比（`ui.tsx` 的 `Nav`）。
- **不要在 tab 容器上用 `AnimatePresence mode="popLayout"`**：popLayout 要对退场的整棵子树做布局投影测量。`RealApp.tsx` 里现在是一个 `key={tab}` 的普通 `div`，旧树直接卸载。
- **切页不要加淡入**：新页面第一帧本来就要整页光栅，再叠 160ms 的透明度动画只是在光栅期间反复提交。去掉后真机（骁龙 660）p90 85–101→69–73ms、jank 70–79%→52–60%。
- **不要尝试「四个 tab 常驻、只切可见性」**：实测过，是负收益。这台设备的合成器会把不可见面板的栅格结果丢掉——`visibility:hidden` 藏 20 秒再显示要一次 **150ms** 的整页重绘；`opacity:0.01`、`opacity:0`、仅被上层遮挡（opacity:1）都一样，切回来仍要重绘。结果是没省下光栅，反而多挂三棵 DOM、多三份羽化模糊层，切页 p50 从 ~40ms 掉到 53–97ms。真机性能一律以 `dumpsys gfxinfo`（**不接调试器**）为准，CDP 会把数字放大 5–10 倍。
- **`BOTTOM_BANDS` 只留一层**（`ui.tsx`）：底部羽化原来是 1/2/4px 三层 `backdrop-filter`，每多一层就多一次整屏背景重采样。三层→一层：切页 p50 28–36→19–28ms、jank 52–60%→32–46%，横滑 p95 46–57→34–36ms，而画面上看不出差别（前两层本来就压在几乎不透明的渐变底下）。顶部羽化在滚动到顶时 opacity 为 0，实测无额外开销，保持三层。
- **周视图轨道常驻 `will-change: transform`**（`RealApp.tsx` 里 `style={{ x, willChange: 'transform' }}`）：真机实测常驻 vs 按下才挂，横滑帧 p95 36ms vs 50ms；按下才挂等于把整幅光栅推迟到手指刚动那一帧，主观就是「按下去没反应」。
- **进课表先只建当周，邻周隔 90ms 补**（`sides` 状态）：三周一起建是首帧的大头。

### 真机性能怎么量（别再靠无头浏览器猜）

无头 Chromium 测不出合成/光栅开销，**接了 CDP 的真机也会失真 5–10 倍**（调试器本身的开销）。

```bash
adb shell dumpsys gfxinfo app.gagatimetable.alternative reset
adb shell input tap <x> <y>          # 设备像素 = CSS × 1.75，y 还要加状态栏 60
adb shell dumpsys gfxinfo app.gagatimetable.alternative   # 看 janky% / 50th / 90th
```

要抓某一段为什么慢，用 CDP（`adb forward tcp:9222 localabstract:webview_devtools_remote_$(adb shell pidof app.gagatimetable.alternative)`）跑 `Tracing` + `Profiler`，但**只看相对值和调用链，不要拿绝对值下结论**——量完记得 `adb forward --remove tcp:9222`，否则后续 gfxinfo 数字全被抬高。

### 屏幕适配 / 小组件 / 文件导出

- **内容宽度只有一处定义**：`src/index.css` 的 `.shell-w`（<600 → 430，600–840 → 600，840–1000 → 720，≥1000 → 900）。
  三个根容器（`RealApp` 的 Shell、`RealApp` 最外层、`Onboarding`）都用它；`index.html` 首屏骨架 `#boot .shell`
  里有同一套断点的一半值，**改一处必须改另一处**，否则冷启动会看到一次由宽缩窄的跳变。
- **别用 `color-mix()` 做课程色**。小米平板 4 的 WebView 是 104，`color-mix()` 要 111 起，
  在它上面整条 `background`/`color` 声明会被丢掉——课表卡片没有色块、课名变黑字就是这个原因。
  统一走 `ui.tsx` 的 `tint()`（= 课程色带 alpha，叠在不透明底色上等价于与 `--c-surface` 混合）和
  `inkMix()`（= 与 `--c-ink-mix` 混合，按 `<html data-theme>` 取黑或白）。
  `tint`/`inkMix` 只认 `#rgb`/`#rrggbb`；传 `var(--c-accent)` 这类会退回 `color-mix`，在老 WebView 上仍然失效。
- 需要按"内容区"而不是"屏幕"计算的浮层，用 `ui.tsx` 的 `shellBox()`（读 `[data-shell]` 的 rect）。
  别再写 `Math.min(window.innerWidth, 430)`——宽屏上会把菜单排到内容区外面。
- 周视图在大屏上比可视区矮时，`WeekGrid` 用 `fillH`（可视区高度）把行高按 `AXIS_ROW_STRETCH` 上限拉高补满；
  手机（内容宽 430）不触发，行高保持原样。
- **贴纸位置按页面分工，别自作主张改**：「今天」的列表贴纸钉在卡片**右上角**（`top-3 right-4`），课名让出 `pr-8`；
  「课表」的贴纸钉在每张卡片的**右下角**（`right-0 bottom-0`），排字时先用 `stickerReserve(w)` 把那一块扣掉，
  贴纸就永远压不到字，跨几节的卡片也都在同一个角。别再改成「挂在文字块下面」——
  卡片一高贴纸就飘到两行文字中间，看着像不属于这门课。
- 贴纸尺寸按列宽取（`time-axis.ts` 的 `stickerSize`：`w<48 → 12`、`w<66 → 15`、否则 18）。
  卡片不要加 `overflow-hidden`（「上课中」那条进度盖层自己包了一层带圆角的裁切容器），否则贴纸溢出会被裁掉。
- **手机上一列只有 37px**：`CARD_PAD_X` 必须 ≤ 2.5px，可用宽度才够 32.4px、每行排 3 个汉字；
  回到 4px 就掉到 29.4px，课名全被拆成「计算／机组／成原／理…」，同样的高度少读一行。
- **网格线和卡片必须共用同一套坐标**：`WeekLines` 是网格容器（`flex flex-1 gap-[5px]`）的子元素，
  和外层 `relative` 同一个原点，线画在 `top: y`（节次边界）就正好落在两张卡之间那 9px 的空隙里。
  以前它在外层、线写 `top: y + 6`、`left-8`，和卡片内缩 1.5px 错开，看着就是「线穿过卡片」。
- 「今天」的日期条在 `StickyHead` 里面（跟着标题一起钉住）；课表页那条是网格列头，必须跟着网格滚，别搬。
- 横屏矮屏（`max-height: 720px` 且 `min-width: 600px`）把标题区上边距从 52 收到 34（`.head-pad`）。
- **小组件尺寸必须落在标准格位上**：`minWidth = 格数 × 70 − 30`（1 格 40、2 格 110、3 格 180、4 格 250、5 格 320）。
  卡在中间值（原来的 150/300）会被桌面按 `(w+30)/70` 向上取整，多占一格。`minResize*` 也要一起写，
  否则系统把最小值当成最小值、缩不动。改完必须**删掉重加**才会重新协商尺寸。
- 小组件行数由格子高度决定（`WidgetRender.rows()` / `rowsTwo()`），布局里每行是 `0dp + weight=1`，
  所以拉伸后行会自己长高；`onAppWidgetOptionsChanged` 必须重画，不然要等 30 分钟的定时刷新。
  「下一节」缩到 2×1 后走 `widget_next_short.xml`（`layoutOf(style, hDp)` 按高度选），大号倒计时缩到卡片右侧。
- 导出课表给两条路（`ExportSheet`）：分享走 `TtFiles.share`（FileProvider + ACTION_SEND），
  保存走 `TtFiles.save`（Android 10+ 用 MediaStore 写公共 `Download/`，不用权限；9 及以下走 `ACTION_CREATE_DOCUMENT`）。
- **单测要带时区**：`parsers.test.ts` 里「ICS：时区策略」那组用例假设设备时区是 UTC，
  本机是东八区，直接 `npx vitest run` 会挂 5 条；用 `TZ=UTC npx vitest run`。

### 环境

- Node 22，`npm ci`。
- JDK 21：`export JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64`。
- Android SDK：`android/local.properties` 写 `sdk.dir=...`，**不要提交**。
- Gradle 被限流时在 `~/.gradle/init.gradle` 加阿里云镜像。

### 验证

```bash
npm run check          # = tsc --noEmit && vitest run && vite build
npx cap sync android
cd android && ./gradlew assembleDebug
```

- `npm run build` 必须在 `cap sync` 之前。
- 不改测试来让测试通过。新增逻辑补 `src/domain/__tests__/` 用例。
- 不启动模拟器、不 `adb install`。

### 部署

```bash
npm run build && npx cap sync android
cd android && ./gradlew assembleDebug -q
cp app/build/outputs/apk/debug/app-debug.apk ../GagaTimetable-Alternative-debug.apk
```

版本号在 `android/app/build.gradle`（`versionCode` / `versionName`，默认 1 / 0.1），打包时可用 `VERSION_CODE` / `VERSION_NAME` 环境变量覆盖。

### 截图

README 里的图是 S23 实机截图，不再用浏览器模拟（模拟出来的字重、行高和真机不一致）：

1. 装 debug 包，`adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>`，用 CDP 驱动点击、滚动、长按。
2. `adb exec-out screencap -p` 取 1080×2340 原图；截之前清掉状态栏通知与媒体播放。
3. 脱敏只换人名、学校、学号、教务域名（`X老师` / `XX大学` / `jw.xx.edu.cn`），课程名保留；原图不进仓库。
4. 拼版：三屏一组，单屏缩到 520 宽、`#EDEDEB` 底、圆角 26、柔和投影，产物放 `docs/shots/`。
5. 小组件预览：`tools/gen_widget_previews.sh`。
6. 图标/开屏改动，出对比图；monochrome 层控制在 68dp 安全区内。

上游官网素材保留但不引用：`site/`（上游官网 12 MB）、`docs/screenshots/`（上游截图）、`docs/website.svg`。
原 `docs/SCREENSHOTS.md` 教的是往上游官网里补截图的流程，已删；新流程就是上面这 6 步。
原 `.github/workflows/pages.yml` 会把 `site/` 部署到 GitHub Pages，已移除——site 只留档，不部署、不外链。

### 桌面小组件（RemoteViews）

布局由 `tools/gen_widget_layouts.py` 生成，**不要手改 `res/layout/widget_*.xml`**——生成器不知道手改，下次跑会冲掉。

- 只用 RemoteViews 白名单里的控件。`<Space>`、`<View>` 都不在里面，inflate 时抛
  `Class not allowed to be inflated android.widget.Space`，表现为桌面「无法添加微件」。要占位就用空 `TextView` + `weight`。
- 桌面回报的高度比真实可用高度大：Samsung 4×2 报 `appWidgetMinHeight=202`，实测框只有 **168.7dp**（`hsResizeRatio≈0.833`）。
  行数按 `WidgetRender.HEIGHT_SAFETY`（0.85）打折算，宁可少画一行，别把最后一行切成半截。
- 真机尺寸不靠猜：`adb shell uiautomator dump` 里有每个 id 的 `bounds`，除 dpr 就是 dp。
  实测 4×2 = 250.7×168.7dp（每行 39.3dp）、4×4 = 250.7×353.3dp（每格 43.3×96.3dp）。
- 「今天与明天」两列的表头必须同构（同样的 22sp 日期 + 10.5sp 星期 + 右对齐副标题），否则两列第一行课对不齐；
  左列的表头写的是**实际在列的那一天**，不是「今天」。
- 一格的 `rowN_*` / `trowN_*` / `cC_R_*` 这些 id 是 `WidgetRender` 硬编码的，加行时两边一起改；
  紧凑版式和常规版式也必须提供**同一批 id**（`row()` 会无条件给 `_bg/_ring/_bar/_name` 上色，缺一个就 NPE）。

### 常见坑

- 原生对话框必须 `Theme.DeviceDefault.(Light.)Dialog.Alert`，AppCompat 会退回 AOSP 样式。
- 对话框要自己吃掉返回键，否则偶发退到桌面。
- 学期默认 10 节；导入课到 13 节时靠 `timeSlots` 或自动补足扩表，别改默认值。
- 引导页卸载要在内页退回同一帧，否则退场动画会闪。
- 长按菜单关闭走 `Popover` 的 `dismissRef`（先退场再清状态），不要直接 `setMenu(null)`。
- 内置浏览器退出：先 `edu.snapshot()` 把学校页面定格贴进洞里、同帧去掉 `tt-edu`，再出栈；原生 `close` 在页面卸载时才调。盖在浏览器上的页用 `<Page keep="opaque">`，否则透明模式下它会被隐藏、退场看不到。
- 颜色选择器是固定宽度横向滚动 + 两端渐变，不要改成撑满一行。

### 周视图与贴纸（v94–v95）

- 贴纸固定在周视图卡片**右下角**（`week-axis.tsx`），排字先用 `stickerReserve(w)` 扣掉那一块，永远压不到字；
  尺寸 `stickerSize(w)`：`w<48→14 / w<66→17 / 否则 20`。「今天」列表的贴纸钉卡片**右上角**（`top-3 right-4`），课名 `pr-8` 让位。
- 卡片度量都在 `time-axis.ts`：`AXIS_ROW=74`、`CARD_NAME_PX=10`、`CARD_LOC_PX=9`、`CARD_PAD_X=2`（37px 一列三字一行）。
  地点放不下按「最不值钱先丢」：去空格 → 去开头括号（校区）→ 才从头截留房号（`fitLoc`）。
- 网格线由 `WeekLines` 画在**网格容器**里（与卡片同一坐标原点），落在课间带的下沿、与下一行卡片顶齐平；
  别再画在外层容器手工 +6。带内蓝线是「当前时刻」指示线（只画在今天列），不是错位的网格线。
- 「今天」「课表」两页的日期条都放在 `StickyHead` 里（吸顶不随滚动消失）；「今天」空态也摆同款日期表头。
- 时刻线/卡片用色禁用 `color-mix()`（WebView 104 整条丢弃），用 `ui.tsx` 的 `tint()/inkMix()`。

### 小组件（RemoteViews）

- 布局只准用白名单控件（TextView/ImageView/FrameLayout/LinearLayout/AnalogClock等）——**`<Space>` 不在白名单**，
  inflate 直接抛 `Class not allowed to be inflated`，表现为「无法添加微件」。要占位用空 `TextView` + weight。
- `res/layout/widget_*.xml` 全部由 `tools/gen_widget_layouts.py` 生成，别手改 XML。
- **桌面报的高度是虚高的**：Samsung `appWidgetMinHeight=202` 实测真实只有 168.7dp（`hsResizeRatio≈0.833`）。
  行数一律按 `0.85` 打折算（`HEIGHT_SAFETY`），行高按真实 dp 预算。
- 文本单位一律一个词：2×1 里「3小时 25 分钟后」会被截，写成 `数字 + 小时/分钟/天`（`WidgetRender.next`）。
- 行 id（`rowN_*`/`trowN_*`/`cC_R_*`）与 `WidgetRender` 硬编码一一对应；紧凑版式必须提供同一批 id。
