#!/usr/bin/env python3
"""生成桌面小组件的 RemoteViews 布局。行/格子是重复结构，用脚本产出，避免手抄错 id。

改了版式就改这里再跑一遍，别直接手改 res/layout/widget_*.xml——手改过的文件生成器并不知道，
下次跑会把改动冲掉。
"""
import os

OUT = os.path.join(os.path.dirname(__file__), '..', 'android', 'app', 'src', 'main', 'res', 'layout')
HEAD = '<?xml version="1.0" encoding="utf-8"?>\n'
NS = 'xmlns:android="http://schemas.android.com/apk/res/android"'
# 布局里的字色只是浅色默认值，渲染时 WidgetRender 会按 App 主题整体重设
COLORS = {
    '#16171A': '@color/widgetInk',
    '#8A8E97': '@color/widgetInk3',
    '#A2A6AF': '@color/widgetInk4',
    '#4F5BD5': '@color/widgetAccent',
}


def row(i, prefix='row', name_sp='13sp', name_lines=1, loc_sp='10sp', loc_lines=1,
        time_sp='10.5sp', bar='20dp', pad='5dp', pad_x=('6dp', '8dp'), margin='6dp', time_margin='6dp'):
    """一行课：色条 + 课名/地点 + 右侧开始时刻。高度由父级 weight 拉伸，不写死高度。"""
    rid = f'{prefix}{i}'
    parts = [
        f'    <FrameLayout android:id="@+id/{rid}" android:layout_width="match_parent" android:layout_height="0dp" android:layout_weight="1" android:layout_marginTop="{margin}">',
        f'        <ImageView android:id="@+id/{rid}_ring" android:layout_width="match_parent" android:layout_height="match_parent" android:scaleType="fitXY" android:src="@drawable/widget_focus" android:contentDescription="@null" />',
        f'        <ImageView android:id="@+id/{rid}_bg" android:layout_width="match_parent" android:layout_height="match_parent" android:layout_margin="1.5dp" android:scaleType="fitXY" android:src="@drawable/widget_row_bg" android:contentDescription="@null" />',
        f'        <LinearLayout android:layout_width="match_parent" android:layout_height="match_parent" android:orientation="horizontal" android:gravity="center_vertical" android:paddingTop="{pad}" android:paddingBottom="{pad}" android:paddingLeft="{pad_x[0]}" android:paddingRight="{pad_x[1]}">',
        f'            <ImageView android:id="@+id/{rid}_bar" android:layout_width="3dp" android:layout_height="{bar}" android:scaleType="fitXY" android:src="@drawable/widget_bar" android:contentDescription="@null" />',
        '            <LinearLayout android:layout_width="0dp" android:layout_weight="1" android:layout_height="wrap_content" android:orientation="vertical" android:layout_marginLeft="6dp">',
        f'                <TextView android:id="@+id/{rid}_name" android:layout_width="match_parent" android:layout_height="wrap_content" android:maxLines="{name_lines}" android:ellipsize="end" android:textSize="{name_sp}" android:textStyle="bold" android:textColor="#16171A" />',
    ]
    if loc_lines:
        parts.append(
            f'                <TextView android:id="@+id/{rid}_loc" android:layout_width="match_parent" android:layout_height="wrap_content" android:maxLines="{loc_lines}" android:ellipsize="end" android:textSize="{loc_sp}" android:textColor="#8A8E97" android:layout_marginTop="1dp" />')
    parts.append('            </LinearLayout>')
    if time_sp:
        parts.append(
            f'            <TextView android:id="@+id/{rid}_time" android:layout_width="wrap_content" android:layout_height="wrap_content" android:textSize="{time_sp}" android:textStyle="bold" android:textColor="#8A8E97" android:layout_marginLeft="{time_margin}" />')
    parts += ['        </LinearLayout>', '    </FrameLayout>']
    return '\n'.join(parts)


def head_block(day='w_day', wd='w_wd', sub='w_sub', day_sp='22sp', wd_sp='10.5sp', sub_sp='9.5sp'):
    """一天的表头：日期 + 星期 + 右对齐的副标题。两列的表头必须一模一样的结构，不然两列第一行对不齐。"""
    return f'''    <LinearLayout android:layout_width="match_parent" android:layout_height="wrap_content" android:orientation="horizontal" android:baselineAligned="true">
        <TextView android:id="@+id/{day}" android:layout_width="wrap_content" android:layout_height="wrap_content" android:textSize="{day_sp}" android:textStyle="bold" android:textColor="#16171A" />
        <TextView android:id="@+id/{wd}" android:layout_width="wrap_content" android:layout_height="wrap_content" android:textSize="{wd_sp}" android:textStyle="bold" android:textColor="#4F5BD5" android:layout_marginLeft="4dp" />
        <TextView android:id="@+id/{sub}" android:layout_width="0dp" android:layout_weight="1" android:layout_height="wrap_content" android:gravity="right" android:maxLines="1" android:ellipsize="end" android:textSize="{sub_sp}" android:textStyle="bold" android:textColor="#A2A6AF" />
    </LinearLayout>'''


EMPTY = '<TextView android:id="@+id/w_empty" android:layout_width="match_parent" android:layout_height="wrap_content" android:visibility="gone" android:textSize="12sp" android:textStyle="bold" android:textColor="#8A8E97" android:layout_marginTop="10dp" />'
EMPTY_FILL = '<TextView android:id="@+id/w_empty" android:layout_width="match_parent" android:layout_height="0dp" android:layout_weight="1" android:gravity="center" android:visibility="gone" android:textSize="12sp" android:textStyle="bold" android:textColor="#8A8E97" />'


def wrap(body, pad='10dp', note=None):
    # 卡片底是一张可 setColorFilter 的 ImageView：颜色由原生按 App 主题在渲染时决定，不走资源限定符
    head = HEAD if note is None else HEAD + '<!-- ' + note + ' -->\n'
    return f'''{head}<FrameLayout {NS}
    android:id="@+id/widget_root"
    android:layout_width="match_parent"
    android:layout_height="match_parent">
    <ImageView android:id="@+id/widget_root_bg" android:layout_width="match_parent" android:layout_height="match_parent" android:scaleType="fitXY" android:src="@drawable/widget_bg" android:contentDescription="@null" />
    <LinearLayout android:layout_width="match_parent" android:layout_height="match_parent" android:orientation="vertical" android:padding="{pad}">
{body}
    </LinearLayout>
</FrameLayout>
'''


def write(name, text):
    for hex_, ref in COLORS.items():
        text = text.replace(f'android:textColor="{hex_}"', f'android:textColor="{ref}"')
    with open(os.path.join(OUT, name), 'w', encoding='utf-8') as f:
        f.write(text)
    print('wrote', name)


# 1) 今日列表
write('widget_today.xml', wrap(
    '\n'.join([head_block(day_sp='28sp', wd_sp='12sp', sub_sp='10.5sp'), EMPTY_FILL] + [row(i) for i in range(4)]),
    pad='12dp',
    note='今日最多四行，具体画几行由格子高度决定（WidgetRender.rows）。'))

# 2) 下一节倒计时：2×2
next_tall = f'''    <TextView android:id="@+id/w_label" android:layout_width="match_parent" android:layout_height="wrap_content" android:textSize="10.5sp" android:textStyle="bold" android:textColor="#8A8E97" />
    <LinearLayout android:layout_width="match_parent" android:layout_height="wrap_content" android:orientation="horizontal" android:baselineAligned="true" android:layout_marginTop="2dp">
        <TextView android:id="@+id/w_num" android:layout_width="wrap_content" android:layout_height="wrap_content" android:textSize="34sp" android:textStyle="bold" android:textColor="#16171A" />
        <TextView android:id="@+id/w_unit" android:layout_width="wrap_content" android:layout_height="wrap_content" android:textSize="12sp" android:textStyle="bold" android:textColor="#8A8E97" android:layout_marginLeft="4dp" />
    </LinearLayout>
    <LinearLayout android:layout_width="match_parent" android:layout_height="0dp" android:layout_weight="1" android:orientation="vertical" android:gravity="bottom">
{row(0)}
    </LinearLayout>'''
write('widget_next.xml', wrap(
    next_tall,
    pad='12dp',
    note='两格高的版式。一格的紧凑版式见 widget_next_short.xml（由 WidgetRender.layoutOf 按格子高度选）。'))

# 3) 下一节：2×1（高度只有一格）
next_short = f'''    <TextView android:id="@+id/w_label" android:layout_width="match_parent" android:layout_height="wrap_content" android:maxLines="1" android:ellipsize="end" android:textSize="9.5sp" android:textStyle="bold" android:textColor="#8A8E97" />
    <FrameLayout android:id="@+id/row0" android:layout_width="match_parent" android:layout_height="0dp" android:layout_weight="1" android:layout_marginTop="4dp">
        <ImageView android:id="@+id/row0_ring" android:layout_width="match_parent" android:layout_height="match_parent" android:scaleType="fitXY" android:src="@drawable/widget_focus" android:contentDescription="@null" />
        <ImageView android:id="@+id/row0_bg" android:layout_width="match_parent" android:layout_height="match_parent" android:layout_margin="1.5dp" android:scaleType="fitXY" android:src="@drawable/widget_row_bg" android:contentDescription="@null" />
        <LinearLayout android:layout_width="match_parent" android:layout_height="match_parent" android:orientation="horizontal" android:gravity="center_vertical" android:paddingTop="4dp" android:paddingBottom="4dp" android:paddingLeft="6dp" android:paddingRight="8dp">
            <ImageView android:id="@+id/row0_bar" android:layout_width="3dp" android:layout_height="18dp" android:scaleType="fitXY" android:src="@drawable/widget_bar" android:contentDescription="@null" />
            <LinearLayout android:layout_width="0dp" android:layout_weight="1" android:layout_height="wrap_content" android:orientation="vertical" android:layout_marginLeft="6dp">
                <TextView android:id="@+id/row0_name" android:layout_width="match_parent" android:layout_height="wrap_content" android:maxLines="1" android:ellipsize="end" android:textSize="11.5sp" android:textStyle="bold" android:textColor="#16171A" />
                <TextView android:id="@+id/row0_loc" android:layout_width="match_parent" android:layout_height="wrap_content" android:maxLines="1" android:ellipsize="end" android:textSize="9sp" android:textColor="#8A8E97" android:layout_marginTop="1dp" />
            </LinearLayout>
            <LinearLayout android:layout_width="wrap_content" android:layout_height="wrap_content" android:orientation="vertical" android:gravity="center_vertical|right" android:layout_marginLeft="6dp">
                <TextView android:id="@+id/w_num" android:layout_width="wrap_content" android:layout_height="wrap_content" android:textSize="16sp" android:textStyle="bold" android:textColor="#16171A" />
                <TextView android:id="@+id/w_unit" android:layout_width="wrap_content" android:layout_height="wrap_content" android:textSize="8.5sp" android:textStyle="bold" android:textColor="#8A8E97" />
            </LinearLayout>
        </LinearLayout>
    </FrameLayout>'''
write('widget_next_short.xml', wrap(
    next_short,
    note='「下一节」一格的版式：大号倒计时缩到卡片右侧。控件 id 必须和 widget_next.xml 一致，'
         'WidgetRender.row() 会无条件给 row0_bg / row0_ring / row0_bar / row0_name / row0_loc 上色。'))

# 4) 今天 / 明天：两列表头结构一致，各三行
# 4×2 的真实可用高度只有 168.7dp（桌面报 202dp，Samsung 的 hsResizeRatio 把它放大了），
# 扣掉上下内边距 20 和表头 24 之后每行只剩 39dp：刚好放两行课名（11.5sp ≈ 27.6dp）加内侧 6dp。
# 再塞一行地点就要 45dp，必定被切掉半截——所以这一版不放地点，把三点全留给「有哪些课、几点上」。
TWO_ROW = dict(name_sp='11.5sp', name_lines=2, loc_lines=0, time_sp='9.5sp',
               bar='16dp', pad='3dp', pad_x=('5dp', '6dp'), margin='4dp', time_margin='5dp')
two = f'''    <LinearLayout android:layout_width="match_parent" android:layout_height="match_parent" android:orientation="horizontal">
        <LinearLayout android:layout_width="0dp" android:layout_weight="1" android:layout_height="match_parent" android:orientation="vertical">
{head_block()}
{EMPTY_FILL}
{chr(10).join(row(i, **TWO_ROW) for i in range(3))}
        </LinearLayout>
        <LinearLayout android:layout_width="0dp" android:layout_weight="1" android:layout_height="match_parent" android:orientation="vertical" android:layout_marginLeft="10dp">
{head_block(day='w_day2', wd='w_wd2', sub='w_sub2')}
{chr(10).join(row(i, prefix='trow', **TWO_ROW) for i in range(3))}
        </LinearLayout>
    </LinearLayout>'''
write('widget_two_days.xml', wrap(
    two,
    pad='10dp',
    note='左右各一天。两列表头必须同构（22sp 日期 + 10.5sp 星期 + 右对齐副标题），否则第一行课对不齐。'))

# 5) 周视图
cols = []
for c in range(5):
    cells = []
    for r in range(3):
        cid = f'c{c}_{r}'
        cells.append(f'''            <FrameLayout android:id="@+id/{cid}" android:layout_width="match_parent" android:layout_height="0dp" android:layout_weight="1" android:layout_marginTop="3dp">
                <ImageView android:id="@+id/{cid}_ring" android:layout_width="match_parent" android:layout_height="match_parent" android:scaleType="fitXY" android:src="@drawable/widget_focus" android:contentDescription="@null" />
                <ImageView android:id="@+id/{cid}_bg" android:layout_width="match_parent" android:layout_height="match_parent" android:layout_margin="1.5dp" android:scaleType="fitXY" android:src="@drawable/widget_cell_bg" android:contentDescription="@null" />
                <LinearLayout android:layout_width="match_parent" android:layout_height="match_parent" android:orientation="vertical" android:padding="3dp">
                    <TextView android:id="@+id/{cid}_name" android:layout_width="match_parent" android:layout_height="wrap_content" android:maxLines="3" android:ellipsize="end" android:textSize="10.5sp" android:textStyle="bold" android:textColor="#16171A" />
                    <TextView android:id="@+id/{cid}_time" android:layout_width="match_parent" android:layout_height="wrap_content" android:maxLines="1" android:textSize="9sp" android:textStyle="bold" android:textColor="#8A8E97" android:layout_marginTop="2dp" />
                    <TextView android:id="@+id/{cid}_loc" android:layout_width="match_parent" android:layout_height="wrap_content" android:maxLines="2" android:ellipsize="end" android:textSize="9sp" android:textColor="#A2A6AF" />
                </LinearLayout>
            </FrameLayout>''')
    cols.append(f'''        <LinearLayout android:layout_width="0dp" android:layout_weight="1" android:layout_height="match_parent" android:orientation="vertical" android:layout_marginLeft="{'0dp' if c == 0 else '4dp'}">
            <TextView android:id="@+id/wd{c}" android:layout_width="match_parent" android:layout_height="wrap_content" android:gravity="center" android:textSize="10.5sp" android:textStyle="bold" android:textColor="#8A8E97" />
{chr(10).join(cells)}
        </LinearLayout>''')

week_body = f'''    <LinearLayout android:layout_width="match_parent" android:layout_height="wrap_content" android:orientation="horizontal" android:baselineAligned="true">
        <TextView android:id="@+id/w_week" android:layout_width="wrap_content" android:layout_height="wrap_content" android:textSize="15sp" android:textStyle="bold" android:textColor="#16171A" />
        <TextView android:id="@+id/w_date" android:layout_width="0dp" android:layout_weight="1" android:layout_height="wrap_content" android:textSize="10.5sp" android:textStyle="bold" android:textColor="#A2A6AF" android:layout_marginLeft="7dp" />
    </LinearLayout>
{EMPTY}
    <LinearLayout android:id="@+id/w_grid" android:layout_width="match_parent" android:layout_height="0dp" android:layout_weight="1" android:orientation="horizontal" android:layout_marginTop="6dp">
{chr(10).join(cols)}
    </LinearLayout>'''
write('widget_week.xml', wrap(
    week_body,
    pad='12dp',
    note='每格约 110dp，放得下三行课名 + 时间 + 两行地点；name/loc 的行数别收回到 1，'
         '10.5sp 的中文在 50dp 宽的列里只剩四个字。'))
