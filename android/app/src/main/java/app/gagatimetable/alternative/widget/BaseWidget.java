package app.gagatimetable.alternative.widget;

import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.res.Configuration;
import android.os.Bundle;

public abstract class BaseWidget extends AppWidgetProvider {

    protected abstract String style();

    @Override
    public void onUpdate(Context ctx, AppWidgetManager mgr, int[] ids) {
        WidgetStore.Data data = WidgetStore.read(ctx);
        long now = System.currentTimeMillis();
        for (int id : ids) draw(ctx, mgr, id, data, now);
        WidgetRefresh.schedule(ctx);
    }

    /** 拉伸或改尺寸后立刻按新的高度重排；不重写这个方法的话要等下一次定时刷新才变 */
    @Override
    public void onAppWidgetOptionsChanged(Context ctx, AppWidgetManager mgr, int id, Bundle newOptions) {
        draw(ctx, mgr, id, WidgetStore.read(ctx), System.currentTimeMillis());
    }

    private void draw(Context ctx, AppWidgetManager mgr, int id, WidgetStore.Data data, long now) {
        mgr.updateAppWidget(id, WidgetRender.build(ctx, style(), data, now, heightDp(ctx, mgr, id)));
    }

    /** 桌面给的高度（dp）：竖屏读 MIN_HEIGHT、横屏读 MAX_HEIGHT，两者是同一个格子的两个方向 */
    static int heightDp(Context ctx, AppWidgetManager mgr, int id) {
        Bundle o = mgr.getAppWidgetOptions(id);
        if (o == null) return 0;
        boolean landscape = ctx.getResources().getConfiguration().orientation == Configuration.ORIENTATION_LANDSCAPE;
        int h = o.getInt(landscape
                ? AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT
                : AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 0);
        if (h <= 0) {
            h = o.getInt(landscape
                    ? AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT
                    : AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT, 0);
        }
        return h;
    }

    @Override
    public void onEnabled(Context ctx) {
        WidgetRefresh.schedule(ctx);
    }

    public static final Class<?>[] PROVIDERS = {
            TodayWidget.class, NextWidget.class, TwoDaysWidget.class, WeekWidget.class,
    };

    /** 课表、待办或时间变了就整体重画 */
    public static void updateAll(Context ctx) {
        AppWidgetManager mgr = AppWidgetManager.getInstance(ctx);
        for (Class<?> p : PROVIDERS) {
            int[] ids = mgr.getAppWidgetIds(new ComponentName(ctx, p));
            if (ids.length == 0) continue;
            Intent i = new Intent(ctx, p);
            i.setAction(AppWidgetManager.ACTION_APPWIDGET_UPDATE);
            i.putExtra(AppWidgetManager.EXTRA_APPWIDGET_IDS, ids);
            ctx.sendBroadcast(i);
        }
    }
}
