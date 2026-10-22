package app.gagatimetable.alternative;

import android.util.Base64;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.math.BigInteger;
import java.net.CookieHandler;
import java.net.HttpURLConnection;
import java.net.SocketTimeoutException;
import java.net.URI;
import java.net.URL;
import java.net.URLEncoder;
import java.net.UnknownHostException;
import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.PublicKey;
import java.security.spec.RSAPublicKeySpec;
import java.util.Calendar;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import javax.crypto.Cipher;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLException;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

/**
 * 用账号密码直连正方教务系统拉课表（实验性功能）。
 * <p>
 * 与内置浏览器那条路的分工：内置浏览器复用用户自己登录的 WebView 会话，这里自己完成登录。
 * 输出只是课表接口的原始 JSON 文本，解析交给页面里已有的 {@code parseZfKbList()}——
 * 两边不重复实现解析，也不会互相污染。
 * <p>
 * 关键实现点，逐条对应踩过的坑：
 * <ul>
 *   <li><b>手动跟重定向。</b>登录成功后的链条是 POST → 302 login_slogin → 302 index_initMenu。
 *       {@code HttpURLConnection} 自动跟随时，中间那几跳下发的 {@code Set-Cookie} 拿不到，
 *       跟下去带的是旧 JSESSIONID，服务端把登录页吐回来。所以这里关闭自动跟随，每一跳自己发、自己存 cookie。</li>
 *   <li><b>不碰全局 CookieHandler。</b> {@code CapacitorCookies} 会把默认 CookieHandler 换成 WebView 的
 *       cookie 库，那是内置浏览器那条路的会话。本插件全程只用自己的 cookie 表，进入前把默认 CookieHandler
 *       摘掉、退出时还原，避免两边的会话互相读写。</li>
 *   <li><b>Content-Type 不带 charset。</b>必须是精确的 {@code application/x-www-form-urlencoded}，
 *       多一个 charset 参数服务端会判成另一种请求。</li>
 *   <li><b>菜单码要探测。</b>{@code kbcx/xskbcx_cxXskbcxIndex.html} 必须在 query 里带 {@code gnmkdm}，
 *       缺了它或者值不对会直接 HTTP 500。不同学校取值不同，所以按候选表逐个试。</li>
 *   <li><b>提示信息只读页面元素里的文本。</b>正方登录页的 HTML 注释和 script 里都写着「验证码」字样，
 *       拿整页字符串 contains 判断，任何登录失败都会被误报成要验证码。</li>
 * </ul>
 */
@CapacitorPlugin(name = "TtZf")
public class TtZf extends Plugin {

    /* ---------- 正方接口路径（实测值） ---------- */

    private static final String LOGIN_PAGE_PATH = "xtgl/login_slogin.html";
    private static final String PUBLIC_KEY_PATH = "xtgl/login_getPublicKey.html";
    private static final String MENU_PATH = "xtgl/index_initMenu.html";
    private static final String SCHEDULE_PAGE_PATH = "kbcx/xskbcx_cxXskbcxIndex.html";
    private static final String SCHEDULE_API_PATH = "kbcx/xskbcx_cxXsgrkb.html";

    /**
     * 课表菜单码候选。第一个是实测可用的取值；第二个是更主流的取值（另一批学校用）。
     * 逐个试页面的状态码，谁 200 用谁。
     */
    private static final String[] MENU_IDS = { "N253508", "N2151" };

    /** 部署前缀候选：网址里出现哪一段就当部署根，没出现就用整个 origin。 */
    private static final String[] KNOWN_PREFIXES = { "jwglxt", "jwxt", "jxgl", "jwzx", "jwc" };

    /**
     * 登录表单里必须原样回传的分发字段（学校代码、用户类型、是否加密密码等）。
     * 少回一个服务端会判成非法请求。值从登录页上取，取不到的不带。
     */
    private static final String[] PASSTHROUGH_FIELDS = {
        "dlmmsfknt", "mmsfjm", "mmsrddcshkzfs", "dlsbsdsj", "yzcskz",
        "sfxswechatlogin", "scene_id", "ydType", "xxdm", "rzzxxs", "rzys",
        "sfzywqh", "userPolicyOn", "dxsyrz", "ydappsfbldlzt",
    };

    private static final String[] CAPTCHA_FIELDS = { "yzm", "verifycode", "verify_code", "checkcode", "captcha", "authcode" };

    private static final int CONNECT_TIMEOUT_MS = 15000;
    private static final int READ_TIMEOUT_MS = 15000;
    private static final int MAX_REDIRECTS = 10;

    private static final String UA =
        "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36";

    /* ---------- 入口 ---------- */

    @PluginMethod
    public void fetch(PluginCall call) {
        final String rawUrl = call.getString("url", "");
        final String user = call.getString("user", "");
        final String password = call.getString("password", "");
        final boolean insecure = Boolean.TRUE.equals(call.getBoolean("insecure", false));

        // 网络与 RSA 都不该占主线程；PluginCall 的 resolve/reject 允许从任意线程调。
        new Thread(() -> {
            try {
                JSObject res = new Session(rawUrl, user, password, insecure).run();
                call.resolve(res);
            } catch (ZfError e) {
                JSObject data = new JSObject();
                data.put("stage", e.stage);
                data.put("code", e.code);
                if (e.serverMessage != null) data.put("serverMessage", e.serverMessage);
                call.reject(e.getMessage(), e.code, data);
            } catch (Throwable t) {
                call.reject(t.getClass().getSimpleName() + ": " + t.getMessage(), "unexpected");
            }
        }, "tt-zf-fetch").start();
    }

    /* ---------- 失败 ---------- */

    /** [code] 是给程序分支用的稳定标识，[stage] 是中文阶段名，[serverMessage] 是教务系统自己写的话。 */
    private static class ZfError extends Exception {
        final String code;
        final String stage;
        final String serverMessage;

        ZfError(String code, String stage, String message) {
            this(code, stage, message, null);
        }

        ZfError(String code, String stage, String message, String serverMessage) {
            super(message);
            this.code = code;
            this.stage = stage;
            this.serverMessage = serverMessage;
        }
    }

    /* ---------- 一次完整拉取 ---------- */

    private static class Session {
        private final String rawUrl;
        private final String user;
        private final String password;
        private final boolean insecure;

        /** 会话 cookie。正方靠 JSESSIONID 维持登录态，全部 Set-Cookie 都存下来。 */
        private final Map<String, String> cookies = new LinkedHashMap<>();
        private int requests = 0;
        private final JSArray stages = new JSArray();
        private long stageStart;
        private String stageName;

        private String base;

        Session(String rawUrl, String user, String password, boolean insecure) {
            this.rawUrl = rawUrl;
            this.user = user;
            this.password = password;
            this.insecure = insecure;
        }

        JSObject run() throws ZfError {
            long t0 = System.currentTimeMillis();
            base = normalizeBaseUrl(rawUrl);
            if (user.isEmpty()) throw new ZfError("empty_user", "登录", "请填写学号（用户名）。");
            if (password.isEmpty()) throw new ZfError("empty_password", "登录", "请填写密码。");

            Cookies saved = detachCookieHandler();
            try {
                login();
                Term term = resolveTerm();
                String json = loadSchedule(term);
                if (json == null || json.trim().isEmpty()) {
                    throw new ZfError("empty_body", "课表接口", "课表接口返回了空内容。");
                }
                JSObject out = new JSObject();
                out.put("json", json);
                out.put("xnm", term.xnm);
                out.put("xqm", term.xqm);
                out.put("termGuessed", term.guessed);
                out.put("menuId", term.menuId);
                out.put("requests", requests);
                out.put("elapsedMs", System.currentTimeMillis() - t0);
                out.put("stages", stages);
                return out;
            } finally {
                if (saved != null) saved.restore();
            }
        }

        /* ---- 计时 ---- */

        private void begin(String name) {
            stageName = name;
            stageStart = System.currentTimeMillis();
        }

        private void end() {
            JSObject s = new JSObject();
            s.put("name", stageName);
            s.put("ms", System.currentTimeMillis() - stageStart);
            stages.put(s);
        }

        /* ---- 网址归一：浏览器里复制的深层页地址也能直接用 ---- */

        private static String normalizeBaseUrl(String input) throws ZfError {
            String s = input == null ? "" : input.trim();
            if (s.isEmpty()) throw new ZfError("empty_url", "网址", "请填写教务系统网址。");
            if (!s.startsWith("http://") && !s.startsWith("https://")) s = "https://" + s;

            URI uri;
            try {
                uri = new URI(s);
            } catch (Exception e) {
                throw new ZfError("bad_url", "网址", "网址格式不对：" + input);
            }
            String host = uri.getHost();
            if (host == null || host.isEmpty()) throw new ZfError("no_host", "网址", "网址里看不出服务器地址：" + input);

            String origin = uri.getScheme() + "://" + host;
            String path = uri.getPath();
            if (path != null) {
                for (String seg : path.split("/")) {
                    if (seg.isEmpty()) continue;
                    for (String known : KNOWN_PREFIXES) {
                        if (known.equalsIgnoreCase(seg)) return origin + "/" + seg;
                    }
                }
            }
            return origin;
        }

        /* ---- HTTP ---- */

        private static class Resp {
            final int status;
            final String body;
            final String url;
            final Map<String, List<String>> headers;

            Resp(int status, String body, String url, Map<String, List<String>> headers) {
                this.status = status;
                this.body = body;
                this.url = url;
                this.headers = headers;
            }

            boolean ok() {
                return status >= 200 && status <= 299;
            }

            /** 首个同名的响应头（重定向要用 Location）。 */
            String header(String name) {
                if (headers == null) return null;
                for (Map.Entry<String, List<String>> e : headers.entrySet()) {
                    if (e.getKey() != null && e.getKey().equalsIgnoreCase(name)) {
                        List<String> v = e.getValue();
                        if (v != null && !v.isEmpty()) return v.get(0);
                    }
                }
                return null;
            }
        }

        private String cookieHeader() {
            if (cookies.isEmpty()) return null;
            StringBuilder sb = new StringBuilder();
            for (Map.Entry<String, String> e : cookies.entrySet()) {
                if (sb.length() > 0) sb.append("; ");
                sb.append(e.getKey()).append('=').append(e.getValue());
            }
            return sb.toString();
        }

        /**
         * 存 Set-Cookie。
         * <p>
         * 删除指令（值为空、Max-Age=0、Expires 是 1970）也要处理，否则会一直带上失效 cookie。
         */
        private void storeCookies(Map<String, List<String>> headers) {
            if (headers == null) return;
            for (Map.Entry<String, List<String>> e : headers.entrySet()) {
                if (e.getKey() == null || !e.getKey().equalsIgnoreCase("set-cookie")) continue;
                if (e.getValue() == null) continue;
                for (String raw : e.getValue()) {
                    if (raw == null) continue;
                    String pair = raw.contains(";") ? raw.substring(0, raw.indexOf(';')) : raw;
                    int eq = pair.indexOf('=');
                    if (eq <= 0) continue;
                    String name = pair.substring(0, eq).trim();
                    String value = pair.substring(eq + 1).trim();
                    boolean expired = value.isEmpty()
                        || raw.toLowerCase().contains("max-age=0")
                        || raw.toLowerCase().contains("expires=thu, 01 jan 1970");
                    if (expired) cookies.remove(name);
                    else cookies.put(name, value);
                }
            }
        }

        private Resp once(String method, String url, String body, String referer) throws ZfError {
            requests++;
            HttpURLConnection conn = null;
            try {
                conn = (HttpURLConnection) new URL(url).openConnection();
                if (insecure && conn instanceof HttpsURLConnection) trustAll((HttpsURLConnection) conn);
                conn.setRequestMethod(method);
                conn.setInstanceFollowRedirects(false);
                conn.setConnectTimeout(CONNECT_TIMEOUT_MS);
                conn.setReadTimeout(READ_TIMEOUT_MS);
                conn.setRequestProperty("User-Agent", UA);
                conn.setRequestProperty("Accept", "text/html,application/xhtml+xml,application/json,*/*");
                conn.setRequestProperty("Accept-Language", "zh-CN,zh;q=0.9");
                String ck = cookieHeader();
                if (ck != null) conn.setRequestProperty("Cookie", ck);
                if (referer != null) conn.setRequestProperty("Referer", referer);
                if (body != null) {
                    conn.setDoOutput(true);
                    conn.setRequestProperty("Content-Type", "application/x-www-form-urlencoded");
                    byte[] data = body.getBytes(StandardCharsets.UTF_8);
                    conn.setFixedLengthStreamingMode(data.length);
                    OutputStream os = conn.getOutputStream();
                    os.write(data);
                    os.close();
                }

                int status = conn.getResponseCode();
                Map<String, List<String>> headers = conn.getHeaderFields();
                storeCookies(headers);
                InputStream in = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
                return new Resp(status, readAll(in), url, headers);
            } catch (UnknownHostException e) {
                throw new ZfError("dns_failed", stageName, "域名解析失败：" + e.getMessage() + "（检查网址拼写，或换个网络）");
            } catch (SocketTimeoutException e) {
                throw new ZfError("timeout", stageName, "请求超时：" + e.getMessage() + "（教务系统没在 15 秒内回应）");
            } catch (SSLException e) {
                throw new ZfError("tls_failed", stageName,
                    "TLS 握手失败：" + e.getMessage() + "。若学校用的是自签名证书，可打开「忽略证书错误」再试。");
            } catch (java.net.ConnectException e) {
                throw new ZfError("connect_failed", stageName, "连不上教务系统：" + e.getMessage() + "（可能被校园网挡在外面）");
            } catch (java.io.IOException e) {
                throw new ZfError("network_error", stageName, "网络错误：" + e.getMessage());
            } finally {
                if (conn != null) conn.disconnect();
            }
        }

        /** 手动跟重定向：每一跳都自己发、自己存 cookie。 */
        private Resp request(String method, String path, String body, String referer) throws ZfError {
            String url = resolve(path);
            String curMethod = method;
            String curBody = body;
            String curReferer = referer;

            for (int hop = 0; hop <= MAX_REDIRECTS; hop++) {
                Resp resp = once(curMethod, url, curBody, curReferer);
                if (resp.status < 300 || resp.status > 399) return resp;

                String location = resp.header("location");
                if (location == null || location.isEmpty()) return resp;

                url = resolveRelative(url, location);
                // 302 / 303 之后按 GET 走——正方的实际链条就是 POST → 302 → GET → 302
                if (resp.status == 302 || resp.status == 303) {
                    curMethod = "GET";
                    curBody = null;
                }
                curReferer = resp.url;
            }
            throw new ZfError("too_many_redirects", stageName, "重定向次数过多，可能是教务系统在打转。");
        }

        private String resolve(String path) {
            if (path.startsWith("http://") || path.startsWith("https://")) return path;
            return path.startsWith("/") ? base + path : base + "/" + path;
        }

        private static String resolveRelative(String from, String location) {
            try {
                return URI.create(from).resolve(location).toString();
            } catch (Exception e) {
                return location;
            }
        }

        private Resp get(String path, String referer) throws ZfError {
            return request("GET", path, null, referer);
        }

        private Resp postForm(String path, Map<String, String> form, String referer) throws ZfError {
            StringBuilder sb = new StringBuilder();
            for (Map.Entry<String, String> e : form.entrySet()) {
                if (sb.length() > 0) sb.append('&');
                sb.append(encode(e.getKey())).append('=').append(encode(e.getValue()));
            }
            return request("POST", path, sb.toString(), referer);
        }

        private static String encode(String s) {
            try {
                return URLEncoder.encode(s, "UTF-8");
            } catch (Exception e) {
                return s;
            }
        }

        private static String readAll(InputStream in) throws java.io.IOException {
            if (in == null) return "";
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            byte[] chunk = new byte[16 * 1024];
            int n;
            while ((n = in.read(chunk)) > 0) buf.write(chunk, 0, n);
            in.close();
            return new String(buf.toByteArray(), StandardCharsets.UTF_8);
        }

        /* ---- 登录 ---- */

        private void login() throws ZfError {
            String loginPageUrl = base + "/" + LOGIN_PAGE_PATH;

            begin("登录页");
            Resp page;
            try {
                page = get(loginPageUrl, null);
            } finally {
                end();
            }
            // 登录页本身就该是 200。非 2xx 是网关/服务器侧的问题，
            // 继续往下走只会让后面某一步报出一个假的原因（比如「读不到公钥」）。
            if (!page.ok()) throw serverSide("登录页", page);

            if (captchaRequired(page.body)) {
                throw new ZfError("captcha_required", "登录",
                    "教务系统当前要求填写验证码。这种验证必须人工完成，本功能不处理。");
            }

            begin("公钥接口");
            Resp pub;
            try {
                pub = get(base + "/" + PUBLIC_KEY_PATH, null);
            } finally {
                end();
            }
            if (!pub.ok()) throw serverSide("公钥接口", pub);

            String modulus = jsonString(pub.body, "modulus");
            String exponent = jsonString(pub.body, "exponent");
            if (modulus.isEmpty() || exponent.isEmpty()) {
                throw new ZfError("public_key_unreadable", "登录",
                    "公钥接口返回 200，但内容里没有 modulus/exponent。这是教务系统改了公钥下发格式，不是账号密码的问题。");
            }

            begin("RSA 加密");
            String encrypted;
            try {
                encrypted = encryptPassword(password, modulus, exponent);
            } finally {
                end();
            }

            Map<String, String> form = new LinkedHashMap<>();
            form.put("yhm", user);
            form.put("mm", encrypted);
            String language = inputValue(page.body, "language");
            form.put("language", language == null || language.isEmpty() ? "zh_CN" : language);
            form.put("yzm", "");
            String csrf = inputValue(page.body, "csrftoken");
            form.put("csrftoken", csrf == null ? "" : csrf);
            for (String name : PASSTHROUGH_FIELDS) {
                String v = inputValue(page.body, name);
                if (v != null) form.put(name, v);
            }

            begin("登录提交");
            Resp resp;
            try {
                resp = postForm(LOGIN_PAGE_PATH, form, loginPageUrl);
            } finally {
                end();
            }

            // 成功时正方 302 到菜单页并下发 JSESSIONID；失败时 200 + 原登录页。
            // 用「最终 URL 是不是菜单页」判定，比翻页面文本可靠。
            if (resp.url.contains("index_initMenu")) return;

            // 有的学校用 200 + JS 跳转，没有 302 也可能是成功的，探一次菜单接口确认。
            Resp probe = null;
            begin("菜单探测");
            try {
                probe = get(MENU_PATH, loginPageUrl);
            } catch (ZfError ignored) {
                // 探不通就当没探
            } finally {
                end();
            }
            if (probe != null && probe.ok() && !isLoginPage(probe.body)) return;

            String serverMsg = readMessage(resp.body);
            if (serverMsg == null) serverMsg = readMessage(probe == null ? "" : probe.body);

            if (serverMsg != null) {
                String code;
                if (serverMsg.contains("密码") || serverMsg.contains("用户")) code = "bad_credentials";
                else if (serverMsg.contains("锁定") || serverMsg.contains("冻结")) code = "account_locked";
                else if (serverMsg.contains("验证码")) code = "captcha_required";
                else code = "login_rejected";
                throw new ZfError(code, "登录",
                    "登录没成功。教务系统页面说：" + serverMsg
                        + "。注意这里填的是教务系统的密码，不是网站登录密码。",
                    serverMsg);
            }

            throw new ZfError("login_rejected", "登录",
                "登录没成功，而教务系统页面没有写明原因。常见的可能是账号或密码不对，或账号被锁定。");
        }

        /** 未登录时菜单接口会把登录页内容吐回来。 */
        private static boolean isLoginPage(String html) {
            if (html == null) return false;
            if (html.contains("login_slogin")) return true;
            return inputValue(html, "yhm") != null;
        }

        /* ---- 学期 + 课表页 ---- */

        private static class Term {
            final String xnm;
            final String xqm;
            final boolean guessed;
            final String menuId;

            Term(String xnm, String xqm, boolean guessed, String menuId) {
                this.xnm = xnm;
                this.xqm = xqm;
                this.guessed = guessed;
                this.menuId = menuId;
            }
        }

        /**
         * 课表接口要 xnm + xqm 两个参数（如 2026 / 3）。
         * 取法：拉课表页，读它自己标了 selected 的下拉项——那就是学校认定的当前学期。
         * 读不到再按当前月份猜一个，猜的结果在返回里标出来，界面上要如实说明。
         * <p>
         * 课表页必须在 query 里带 gnmkdm，缺了或值不对会直接 HTTP 500。不同学校取值不同，逐个试。
         */
        private Term resolveTerm() throws ZfError {
            Resp page = null;
            String menuId = null;
            Resp last = null;

            begin("课表页");
            try {
                for (String candidate : MENU_IDS) {
                    Resp p;
                    try {
                        p = get(SCHEDULE_PAGE_PATH + "?gnmkdm=" + candidate, null);
                    } catch (ZfError e) {
                        throw e;
                    }
                    last = p;
                    if (p.ok()) {
                        page = p;
                        menuId = candidate;
                        break;
                    }
                }
            } finally {
                end();
            }

            if (page == null) {
                throw serverSide("课表页", last);
            }

            String year = selectedOption(page.body, "xnm");
            String term = selectedOption(page.body, "xqm");
            if (year != null && !year.isEmpty() && term != null && !term.isEmpty()) {
                return new Term(year, term, false, menuId);
            }
            Term guess = guessTerm();
            return new Term(guess.xnm, guess.xqm, true, menuId);
        }

        /** 读不出下拉框时按当前月份猜：9 月起上学期，2 月起下学期。 */
        private static Term guessTerm() {
            Calendar c = Calendar.getInstance();
            int y = c.get(Calendar.YEAR);
            int m = c.get(Calendar.MONTH) + 1;
            if (m >= 9) return new Term(String.valueOf(y), "3", true, null);
            if (m >= 2) return new Term(String.valueOf(y - 1), "12", true, null);
            return new Term(String.valueOf(y - 1), "3", true, null);
        }

        /**
         * 拉课表数据。接口是 POST，返回 JSON。
         * <p>
         * kzlx=ck 是「查看」（不是 dy 打印、也不 xj 选课），少这个参数服务端会当成另一个业务。
         */
        private String loadSchedule(Term term) throws ZfError {
            Map<String, String> form = new LinkedHashMap<>();
            form.put("xnm", term.xnm);
            form.put("xqm", term.xqm);
            form.put("kzlx", "ck");
            form.put("xsdm", "");
            form.put("kclbdm", "");
            form.put("kclxdm", "");

            String referer = base + "/" + SCHEDULE_PAGE_PATH + (term.menuId == null ? "" : "?gnmkdm=" + term.menuId);

            begin("课表接口");
            Resp resp;
            try {
                resp = postForm(SCHEDULE_API_PATH, form, referer);
            } finally {
                end();
            }
            if (!resp.ok()) throw serverSide("课表接口", resp);
            return resp.body;
        }

        /* ---- 错误归因 ---- */

        /**
         * 服务器返回了非 2xx。
         * <p>
         * 如果页面自己写了原因（很多 50X 维护页会写），把原话带出来——那是服务器说的，不是程序猜的；
         * 没写就只报状态码，不推断原因。
         */
        private ZfError serverSide(String stage, Resp resp) {
            String serverMsg = resp == null ? null : readMessage(resp.body);
            if (resp == null) {
                return new ZfError("http_error", stage, stage + " 没有拿到响应。", serverMsg);
            }
            String explain;
            String code;
            if (resp.status == 502 || resp.status == 503 || resp.status == 504) {
                explain = "网关没能连上教务系统的后端服务器";
                code = "server_unavailable";
            } else if (resp.status == 500) {
                explain = "教务系统服务器内部出错";
                code = "server_error";
            } else if (resp.status == 404) {
                explain = "这个地址在教务系统上不存在，可能是系统换了部署路径";
                code = "endpoint_not_found";
            } else if (resp.status == 401 || resp.status == 403) {
                explain = "教务系统拒绝了这次访问";
                code = "http_error";
            } else if (resp.status >= 500) {
                explain = "教务系统返回服务端错误";
                code = "server_error";
            } else {
                explain = "教务系统返回了非预期的状态";
                code = "http_error";
            }
            return new ZfError(code, stage,
                stage + " 请求失败：HTTP " + resp.status + "（" + explain + "）。这不是账号或密码的问题。",
                serverMsg);
        }

        /* ---- RSA ---- */

        /**
         * 密码用 PKCS#1 v1.5 加密，返回 base64。
         * <p>
         * 页面上的 login.js 走 jsbn，标准 JCE 的 Cipher 与它同为 PKCS#1 v1.5，密文可以互相解密。
         * 公钥的 modulus 实测有前导 0x00 字节，直接按字节数当模长会拿到 129 而不是 128；
         * 用 Cipher 就没有这个问题——它按密钥的真实位长算块长。
         */
        private static String encryptPassword(String password, String modulusB64, String exponentB64) throws ZfError {
            try {
                BigInteger n = new BigInteger(1, decodeB64(modulusB64));
                BigInteger e = new BigInteger(1, decodeB64(exponentB64));
                PublicKey key = KeyFactory.getInstance("RSA").generatePublic(new RSAPublicKeySpec(n, e));
                Cipher cipher = Cipher.getInstance("RSA/ECB/PKCS1Padding");
                cipher.init(Cipher.ENCRYPT_MODE, key);
                return Base64.encodeToString(cipher.doFinal(password.getBytes(StandardCharsets.UTF_8)), Base64.NO_WRAP);
            } catch (IllegalArgumentException ex) {
                throw new ZfError("public_key_unreadable", "登录",
                    "公钥不是合法的 base64，教务系统下发的格式可能变了。");
            } catch (Exception ex) {
                throw new ZfError("rsa_failed", "登录",
                    "加密密码失败：" + ex.getClass().getSimpleName() + ": " + ex.getMessage());
            }
        }

        /** base64 解码，容忍缺 padding 与换行。 */
        private static byte[] decodeB64(String s) {
            String t = s.replaceAll("\\s", "");
            int pad = t.length() % 4;
            if (pad == 2) t = t + "==";
            else if (pad == 3) t = t + "=";
            return Base64.decode(t, Base64.DEFAULT);
        }

        /* ---- 极简 HTML 取值（只为表单字段与提示文本，不引 jsoup） ---- */

        private static final Pattern INPUT_TAG = Pattern.compile("<input\\b[^>]*>", Pattern.CASE_INSENSITIVE);

        /**
         * 取标签属性的值，按 HTML5 的三种写法都认："v" / 'v' / v（无引号）。
         * 实测正方页面写的是 {@code value= 0}（等号后有空格、值无引号），这里必须容忍。
         */
        private static String attr(String tag, String name) {
            Matcher m = Pattern.compile(
                "\\b" + name + "\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s>]*))",
                Pattern.CASE_INSENSITIVE).matcher(tag);
            if (!m.find()) return null;
            for (int i = 1; i <= 3; i++) {
                if (m.group(i) != null) return unescape(m.group(i));
            }
            return null;
        }

        /** 取 input 的 value（按 name 找，找不到再按 id 找）；没有这个 input 返回 null。 */
        private static String inputValue(String html, String name) {
            Matcher m = INPUT_TAG.matcher(html);
            while (m.find()) {
                String tag = m.group();
                String n = attr(tag, "name");
                if (n == null) n = attr(tag, "id");
                if (name.equalsIgnoreCase(n)) {
                    String v = attr(tag, "value");
                    return v == null ? "" : v;
                }
            }
            return null;
        }

        /** 验证码输入框是否真的摆在页面上（正方默认隐藏，改用微信/学号验证时才显示）。 */
        private static boolean captchaRequired(String html) {
            Matcher m = INPUT_TAG.matcher(html);
            while (m.find()) {
                String tag = m.group();
                String n = attr(tag, "name");
                if (n == null) n = attr(tag, "id");
                if (n == null) continue;
                boolean hit = false;
                for (String f : CAPTCHA_FIELDS) {
                    if (f.equalsIgnoreCase(n)) {
                        hit = true;
                        break;
                    }
                }
                if (!hit) continue;
                String style = attr(tag, "style");
                if (style != null && !style.replace(" ", "").toLowerCase().contains("display:none")) return true;
            }
            return false;
        }

        /** 取 select 里标了 selected 的 option；没有就取第一个非空 option。 */
        private static String selectedOption(String html, String name) {
            Matcher m = Pattern.compile(
                "<select\\b[^>]*\\bname\\s*=\\s*[\"']?" + name + "[\"']?[^>]*>([\\s\\S]*?)</select>",
                Pattern.CASE_INSENSITIVE).matcher(html);
            if (!m.find()) return null;
            String inner = m.group(1);

            Matcher o = Pattern.compile("<option\\b[^>]*>", Pattern.CASE_INSENSITIVE).matcher(inner);
            String firstNonEmpty = null;
            while (o.find()) {
                String tag = o.group();
                String v = attr(tag, "value");
                if (v == null || v.isEmpty()) continue;
                if (Pattern.compile("\\bselected\\b", Pattern.CASE_INSENSITIVE).matcher(tag).find()) return v;
                if (firstNonEmpty == null) firstNonEmpty = v;
            }
            return firstNonEmpty;
        }

        private static final String[] MESSAGE_IDS = {
            "tips", "errmsg", "err_msg", "errormsg", "error_msg", "errorMsg", "message", "msg",
        };
        private static final String[] MESSAGE_CLASSES = { "alert-danger", "alert-error", "text-danger", "error-tip" };

        /**
         * 读出页面上写明的提示；读不到返回 null。
         * <p>
         * 只认页面元素里的可见文本，绝不搜整页 HTML 字符串——登录页的注释和 script 里都写着「验证码」，
         * 一旦用 contains 判断，任何登录失败都会被误报成要验证码。读不到就如实说没写明原因。
         */
        private static String readMessage(String html) {
            if (html == null) return null;
            for (String id : MESSAGE_IDS) {
                String t = elementText(html, "\\bid\\s*=\\s*[\"']?" + Pattern.quote(id) + "[\"']?");
                if (t != null && !t.isEmpty()) return t;
            }
            for (String cls : MESSAGE_CLASSES) {
                String t = elementText(html, "\\bclass\\s*=\\s*\"[^\"]*\\b" + Pattern.quote(cls) + "\\b[^\"]*\"");
                if (t != null && !t.isEmpty()) return t;
            }
            return null;
        }

        /** 找第一个带给定属性写法的元素，返回它的文本内容。 */
        private static String elementText(String html, String attrPattern) {
            Matcher m = Pattern.compile(
                "<([a-zA-Z][a-zA-Z0-9]*)\\b[^>]*" + attrPattern + "[^>]*>([\\s\\S]*?)</\\1\\s*>",
                Pattern.CASE_INSENSITIVE).matcher(html);
            if (!m.find()) return null;
            return stripTags(m.group(2));
        }

        private static String stripTags(String s) {
            String t = s.replaceAll("(?is)<(script|style)\\b[^>]*>[\\s\\S]*?</\\1\\s*>", " ");
            t = t.replaceAll("(?s)<[^>]*>", " ");
            t = unescape(t).replaceAll("[\\s\\u00a0]+", " ").trim();
            return t;
        }

        private static String unescape(String s) {
            return s.replace("&nbsp;", " ")
                .replace("&lt;", "<")
                .replace("&gt;", ">")
                .replace("&quot;", "\"")
                .replace("&#39;", "'")
                .replace("&apos;", "'")
                .replace("&amp;", "&");
        }

        /** 取 JSON 顶层的字符串字段并反转义。该接口的 base64 里斜杠是转义过的（\/），不处理会解码失败。 */
        private static String jsonString(String json, String key) {
            Matcher m = Pattern.compile("\"" + Pattern.quote(key) + "\"\\s*:\\s*\"([^\"]*)\"", Pattern.CASE_INSENSITIVE).matcher(json);
            if (!m.find()) return "";
            return m.group(1).replace("\\/", "/").replace("\\\"", "\"").replace("\\\\", "\\");
        }

        /* ---- TLS ---- */

        private static SSLContext trustAllContext;

        private static void trustAll(HttpsURLConnection conn) {
            try {
                if (trustAllContext == null) {
                    TrustManager[] tm = { new X509TrustManager() {
                        @Override
                        public void checkClientTrusted(java.security.cert.X509Certificate[] chain, String authType) {
                        }

                        @Override
                        public void checkServerTrusted(java.security.cert.X509Certificate[] chain, String authType) {
                        }

                        @Override
                        public java.security.cert.X509Certificate[] getAcceptedIssuers() {
                            return new java.security.cert.X509Certificate[0];
                        }
                    } };
                    SSLContext ctx = SSLContext.getInstance("TLS");
                    ctx.init(null, tm, new java.security.SecureRandom());
                    trustAllContext = ctx;
                }
                conn.setSSLSocketFactory(trustAllContext.getSocketFactory());
                conn.setHostnameVerifier((host, session) -> true);
            } catch (Exception ignored) {
                // 拿不到就按默认校验走，失败时由 TLS 分支如实报出来
            }
        }

        /* ---- 全局 CookieHandler 的摘除与还原 ---- */

        /**
         * 本插件只用自己的 cookie 表，不希望 {@code HttpURLConnection} 顺手去读写
         * 默认 CookieHandler——那里面是 WebView 的会话（CapacitorCookies 装进去的），
         * 两边混在一起会互相踩。取用期间摘掉，用完原样装回。
         */
        private static class Cookies {
            private final CookieHandler saved;

            Cookies(CookieHandler saved) {
                this.saved = saved;
            }

            void restore() {
                try {
                    CookieHandler.setDefault(saved);
                } catch (Exception ignored) {
                    // 还原失败不影响本次结果
                }
            }
        }

        private static Cookies detachCookieHandler() {
            try {
                CookieHandler current = CookieHandler.getDefault();
                if (current == null) return null;
                CookieHandler.setDefault(null);
                return new Cookies(current);
            } catch (Exception e) {
                return null;
            }
        }
    }
}
