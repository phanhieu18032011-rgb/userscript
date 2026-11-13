// ==UserScript==
// @name         SiteTop Bypass
// @namespace    https://bypassvien.local/
// @version      1.1.0
// @description  SiteTop.net auto bypass with 3D floating UI (cross-site worker tab)
// @author       Tris
// @match        *://sitetop.net/*
// @match        *://*.sitetop.net/*
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_openInTab
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addValueChangeListener
// @grant        GM_removeValueChangeListener
// @grant        GM_addStyle
// @grant        unsafeWindow
// @connect      *
// @run-at       document-start
// ==/UserScript==

(function () {
    "use strict";

    var pageWin = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
    var STORAGE_UI_KEY = "st_ui_prefs_v1";
    var STORAGE_CACHE_KEY = "st_campaign_domain_cache_v1";
    var STORAGE_JOB_KEY = "st_worker_job_v1";
    var STORAGE_STATUS_KEY = "st_worker_status_v1";
    var JOB_TTL_MS = 180000;

    function isSiteTopHost(host) {
        return /(^|\.)sitetop\.net$/i.test(host || window.location.hostname || "");
    }

    function loadJsonStorage(key, fallbackObj) {
        try {
            var raw = typeof GM_getValue === "function"
                ? GM_getValue(key, "")
                : (localStorage.getItem(key) || "");
            if (!raw) return Object.assign({}, fallbackObj);
            var parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
            return Object.assign({}, fallbackObj, parsed || {});
        } catch (e) {
            return Object.assign({}, fallbackObj);
        }
    }

    function saveJsonStorage(key, val) {
        try {
            var serialized = JSON.stringify(val);
            if (typeof GM_setValue === "function") {
                GM_setValue(key, serialized);
            } else {
                localStorage.setItem(key, serialized);
            }
        } catch (e) {}
    }

    function normalizeFullUrl(inputStr) {
        if (!inputStr) return "";
        var s = String(inputStr).trim().replace(/\s+/g, "");
        if (!/^https?:\/\//i.test(s)) {
            s = "https://" + s;
        }
        try {
            var u = new URL(s);
            if (!u.hostname || !u.hostname.includes(".")) return "";
            return u.origin + u.pathname + u.search;
        } catch (e) {
            return "";
        }
    }

    function bareHost(h) {
        return String(h || "").replace(/^www\./i, "").toLowerCase();
    }

    function sleep(ms) {
        return new Promise(function (resolve) { setTimeout(resolve, ms); });
    }

    /* =========================================================================
     * 1. WORKER TAB MODE (chạy trên trang đích để gửi request cross-site thật)
     * ========================================================================= */

    function getMatchedWorkerJob() {
        var job = loadJsonStorage(STORAGE_JOB_KEY, null);
        if (!job || !job.sessionId || !job.createdAt) return null;
        if ((Date.now() - Number(job.createdAt)) > JOB_TTL_MS) return null;

        var hashMatch = (window.location.hash || "").match(/bv_st=([a-f0-9]+)/i);
        if (hashMatch && hashMatch[1] === job.sessionId) {
            return job;
        }
        if (job.targetHost && bareHost(window.location.hostname) === bareHost(job.targetHost)) {
            return job;
        }
        return null;
    }

    function runWorkerTab(job) {
        var apiAjaxUrl = (job.apiOrigin || "https://sitetop.net") + "/wp-admin/admin-ajax.php";

        // Chặn widget top.js gốc tự bắn verify_access (referrer rỗng) làm ghi đè phiên
        try {
            var origXhrOpen = pageWin.XMLHttpRequest && pageWin.XMLHttpRequest.prototype.open;
            var origXhrSend = pageWin.XMLHttpRequest && pageWin.XMLHttpRequest.prototype.send;
            if (origXhrOpen && origXhrSend && !origXhrSend.__stWorkerBlocked) {
                pageWin.XMLHttpRequest.prototype.open = function (method, url) {
                    this.__stTargetUrl = String(url || "");
                    return origXhrOpen.apply(this, arguments);
                };
                pageWin.XMLHttpRequest.prototype.send = function (body) {
                    var bodyStr = typeof body === "string" ? body : "";
                    if (
                        this.__stTargetUrl.indexOf("sitetop.net") !== -1 &&
                        bodyStr.indexOf("action=sitetop_") !== -1
                    ) {
                        return;
                    }
                    return origXhrSend.apply(this, arguments);
                };
                pageWin.XMLHttpRequest.prototype.send.__stWorkerBlocked = true;
            }
        } catch (e) {}

        function publishStatus(patch) {
            saveJsonStorage(STORAGE_STATUS_KEY, Object.assign({
                sessionId: job.sessionId,
                ts: Date.now()
            }, patch));
        }

        async function siteFetchAjax(action, paramsObj) {
            var body = new URLSearchParams();
            body.set("action", action);
            if (paramsObj) {
                Object.keys(paramsObj).forEach(function (k) {
                    if (paramsObj[k] !== undefined && paramsObj[k] !== null) {
                        body.set(k, String(paramsObj[k]));
                    }
                });
            }

            var res = await fetch(apiAjaxUrl, {
                method: "POST",
                credentials: "include",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: body.toString()
            });

            var txt = await res.text();
            try {
                return JSON.parse(txt);
            } catch (e) {
                throw new Error("Phản hồi không phải JSON từ " + action + " (HTTP " + res.status + ")");
            }
        }

        function findInternalLinksInDom() {
            var curHost = bareHost(window.location.hostname);
            var curPath = window.location.pathname;
            var anchors = document.querySelectorAll("a[href]");
            var links = [];
            for (var i = 0; i < anchors.length; i++) {
                var href = anchors[i].href;
                if (!href || href.indexOf("#") !== -1 || /^(javascript|tel|mailto):/i.test(href)) continue;
                try {
                    var u = new URL(href, window.location.origin);
                    if (bareHost(u.hostname) !== curHost) continue;
                    if (u.pathname === curPath || u.pathname === "/") continue;
                    if (/\.(css|js|png|jpg|jpeg|gif|svg|webp|ico|xml|json|pdf|zip)$/i.test(u.pathname)) continue;
                    if (u.pathname.includes("/wp-content/") || u.pathname.includes("/wp-includes/")) continue;
                    links.push(u.href);
                    if (links.length >= 5) break;
                } catch (e) {}
            }
            return links;
        }

        async function executeWorkerFlow() {
            var cleanPageUrl = window.location.origin + window.location.pathname + window.location.search;
            publishStatus({
                status: "progress",
                main: "Đang kết nối SiteTop từ tab đích...",
                sub: window.location.hostname,
                pct: 10
            });

            async function callVerifyAccess(urlOverride) {
                return await siteFetchAjax("sitetop_widget_verify_access", {
                    referer: "https://www.google.com/",
                    current_url: urlOverride || cleanPageUrl,
                    unlock_session: job.sessionId,
                    unlock_time: String(Date.now()),
                    unlock_active: "1",
                    campaign_type: job.campaignType || "keyword_search",
                    nav_type: "navigate",
                    kf: "1",
                    vis: "visible"
                });
            }

            var currentVerifyUrl = cleanPageUrl;
            var verifyRes = await callVerifyAccess(currentVerifyUrl);
            var vdata = verifyRes && verifyRes.data ? verifyRes.data : {};

            // Nếu vừa mở shortlink đã bắn verify quá nhanh (< ~5s) hoặc chưa qua Google check -> đợi nhịp rồi gọi lại
            if (vdata && (vdata.qua_nhanh || vdata.google_verified === false)) {
                publishStatus({
                    status: "progress",
                    main: "Đang đợi nhịp xác thực tự nhiên...",
                    sub: "Tránh cờ vào trang quá nhanh (5s)",
                    pct: 14,
                    waitSec: 5
                });
                await sleep(5000);
                verifyRes = await callVerifyAccess(currentVerifyUrl);
                vdata = verifyRes && verifyRes.data ? verifyRes.data : {};
            }

            // Nếu server chỉ định bài viết cụ thể cùng domain
            if (vdata && (!vdata.url_path_matched || !vdata.url_valid) && vdata.target_url) {
                try {
                    var targetParsed = new URL(vdata.target_url);
                    if (bareHost(targetParsed.hostname) === bareHost(window.location.hostname)) {
                        currentVerifyUrl = vdata.target_url;
                        verifyRes = await callVerifyAccess(currentVerifyUrl);
                        vdata = verifyRes && verifyRes.data ? verifyRes.data : {};
                    }
                } catch (e) {}
            }

            if (!verifyRes || !verifyRes.success || !vdata.session_valid || !vdata.url_valid) {
                var reason = vdata.reason || vdata.message || "";
                if (vdata.want_url) {
                    publishStatus({
                        status: "wrong_url",
                        wantUrl: vdata.want_url,
                        message: "Trang đích đúng là: " + vdata.want_url
                    });
                    return;
                }
                throw new Error(reason ? ("Từ chối phiên: " + reason) : "Không khớp được phiên trên " + window.location.hostname);
            }

            var wSid = vdata.session_id || job.sessionId;
            var trafficType = vdata.traffic_type || "1step";
            var step2ImageUrl = vdata.step2_image && vdata.step2_image.target_url ? vdata.step2_image.target_url : "";
            var remainingSec = parseInt(vdata.remaining, 10);
            var hasServerRemaining = !isNaN(remainingSec) && remainingSec >= 0;
            var waitSec = hasServerRemaining ? remainingSec : (parseInt(vdata.onsite_time, 10) || 70);

            var pingTimer = setInterval(function () {
                siteFetchAjax("sitetop_widget_ping", {
                    session_id: wSid,
                    nonce: job.nonce || ""
                }).catch(function () {});
            }, 9000);

            try {
                await siteFetchAjax("sitetop_track_direct_click", {
                    session_id: wSid,
                    url_matched: "1",
                    nonce: job.nonce || ""
                }).catch(function () {});

                // Đánh dấu đã bấm nút; chỉ reset timer server nếu chưa có remaining đang chạy sẵn
                await siteFetchAjax("sitetop_widget_start_timer", {
                    session_id: wSid,
                    mark: "1",
                    nonce: job.nonce || ""
                }).catch(function () {});

                if (!hasServerRemaining) {
                    await siteFetchAjax("sitetop_widget_start_timer", {
                        session_id: wSid,
                        nonce: job.nonce || ""
                    }).catch(function () {});
                }

                if (!vdata.code_ready && waitSec > 0) {
                    var step1EndPct = trafficType === "2step" ? 75 : 94;
                    var endAt = Date.now() + (waitSec + 1) * 1000;
                    while (Date.now() < endAt) {
                        var left = Math.max(0, Math.ceil((endAt - Date.now()) / 1000));
                        var ratio = (waitSec + 1 - left) / Math.max(1, waitSec + 1);
                        var pct = 18 + Math.round(ratio * (step1EndPct - 18));
                        publishStatus({
                            status: "progress",
                            main: "Bước 1" + (trafficType === "2step" ? "/2" : "") + ": Đang đợi đếm giờ (" + left + "s)",
                            sub: "Đang giữ nhịp ping từ " + window.location.hostname,
                            pct: pct,
                            waitSec: left
                        });
                        await sleep(Math.min(1000, Math.max(200, endAt - Date.now())));
                    }
                }

                await siteFetchAjax("sitetop_report_behavior", {
                    session_id: wSid,
                    mouse_movements: String(16 + Math.floor(Math.random() * 20)),
                    scroll_depth: "95",
                    time_on_page: String(Math.max(10, waitSec)),
                    tab_switches: "0",
                    clicks: "3",
                    tua_gio: "0",
                    nonce: job.nonce || ""
                }).catch(function () {});

                if (trafficType === "2step") {
                    var links = findInternalLinksInDom();
                    var secondUrl = "";
                    if (step2ImageUrl) {
                        try {
                            var s2u = new URL(step2ImageUrl, window.location.origin);
                            if (bareHost(s2u.hostname) === bareHost(window.location.hostname)) secondUrl = s2u.href;
                        } catch (e) {}
                    }
                    if (!secondUrl && links.length > 0) secondUrl = links[0];
                    if (!secondUrl) secondUrl = window.location.origin + "/";

                    publishStatus({
                        status: "progress",
                        main: "Bước 2/2: Đang xử lý trang nội bộ...",
                        sub: secondUrl,
                        pct: 78,
                        waitSec: 16
                    });

                    await siteFetchAjax("sitetop_widget_buoc2_vao", {
                        session_id: wSid,
                        nguon: "co",
                        nonce: job.nonce || ""
                    }).catch(function () {});

                    await siteFetchAjax("sitetop_widget_start_timer", {
                        session_id: wSid,
                        step2: "1",
                        nonce: job.nonce || ""
                    }).catch(function () {});

                    var endAt2 = Date.now() + 16000;
                    while (Date.now() < endAt2) {
                        var left2 = Math.max(0, Math.ceil((endAt2 - Date.now()) / 1000));
                        var pct2 = 78 + Math.round(((16 - left2) / 16) * 17);
                        publishStatus({
                            status: "progress",
                            main: "Bước 2/2: Đang hoàn tất (" + left2 + "s)",
                            sub: secondUrl,
                            pct: pct2,
                            waitSec: left2
                        });
                        await sleep(Math.min(1000, Math.max(200, endAt2 - Date.now())));
                    }
                }

                for (var attempt = 0; attempt < 6; attempt++) {
                    var codeRes = await siteFetchAjax("sitetop_get_code", {
                        session_id: wSid,
                        kf: "1",
                        vis: "visible",
                        nonce: job.nonce || ""
                    });

                    if (codeRes && codeRes.success && codeRes.data) {
                        var extractedCode = typeof codeRes.data === "string"
                            ? codeRes.data
                            : (codeRes.data.code || "");
                        if (extractedCode) {
                            saveJsonStorage(STORAGE_JOB_KEY, {});
                            publishStatus({
                                status: "code",
                                code: String(extractedCode).trim(),
                                targetUrl: currentVerifyUrl
                            });
                            try { window.close(); } catch (e) {}
                            return;
                        }
                    }

                    if (codeRes && codeRes.data && codeRes.data.data && codeRes.data.data.chan_tuagio) {
                        throw new Error((codeRes.data && codeRes.data.message) || "Server từ chối cấp mã");
                    }

                    var extraWait = (codeRes && codeRes.data && codeRes.data.data && parseInt(codeRes.data.data.remaining, 10)) || 3;
                    extraWait = Math.max(2, Math.min(20, extraWait));
                    var extraEnd = Date.now() + extraWait * 1000;
                    while (Date.now() < extraEnd) {
                        var eLeft = Math.max(0, Math.ceil((extraEnd - Date.now()) / 1000));
                        publishStatus({
                            status: "progress",
                            main: "Chờ đồng bộ server (" + eLeft + "s)...",
                            sub: "Lần thử " + (attempt + 1) + "/6",
                            pct: 96,
                            waitSec: eLeft
                        });
                        await sleep(Math.min(1000, Math.max(200, extraEnd - Date.now())));
                    }
                }

                throw new Error("Hết giờ nhưng server chưa trả mã, thử bấm Lấy Mã lại.");
            } finally {
                clearInterval(pingTimer);
            }
        }

        var startWorker = function () {
            executeWorkerFlow().catch(function (err) {
                saveJsonStorage(STORAGE_JOB_KEY, {});
                publishStatus({
                    status: "error",
                    message: (err && err.message) ? err.message : String(err)
                });
            });
        };

        if (document.readyState === "loading") {
            document.addEventListener("DOMContentLoaded", startWorker);
        } else {
            startWorker();
        }
    }

    if (!isSiteTopHost()) {
        var matchedJob = getMatchedWorkerJob();
        if (matchedJob) {
            runWorkerTab(matchedJob);
        }
        return;
    }

    /* =========================================================================
     * 2. SITETOP MAIN PAGE MODE (chạy trên sitetop.net)
     * ========================================================================= */

    function loadUiPrefs() {
        var parsed = loadJsonStorage(STORAGE_UI_KEY, {});
        return {
            autoRedirect: parsed.autoRedirect !== false,
            minimized: !!parsed.minimized
        };
    }

    function saveUiPrefs(prefs) {
        saveJsonStorage(STORAGE_UI_KEY, prefs);
    }

    function loadDomainCache() {
        return loadJsonStorage(STORAGE_CACHE_KEY, {});
    }

    function saveDomainCache(campaignId, targetUrl) {
        if (!campaignId || !targetUrl) return;
        var cache = loadDomainCache();
        cache[String(campaignId)] = {
            targetUrl: targetUrl,
            updatedAt: Date.now()
        };
        saveJsonStorage(STORAGE_CACHE_KEY, cache);
    }

    function gmRequest(options) {
        return new Promise(function (resolve, reject) {
            if (typeof GM_xmlhttpRequest !== "function") {
                reject(new Error("Thiếu quyền GM_xmlhttpRequest"));
                return;
            }
            GM_xmlhttpRequest({
                method: options.method || "GET",
                url: options.url,
                headers: options.headers || {},
                data: options.data || null,
                responseType: options.responseType || undefined,
                timeout: options.timeout || 25000,
                anonymous: !!options.anonymous,
                onload: function (res) {
                    resolve({
                        status: res.status,
                        text: res.responseText || "",
                        response: res.response,
                        headers: res.responseHeaders || "",
                        finalUrl: res.finalUrl || options.url
                    });
                },
                onerror: function () {
                    reject(new Error("Lỗi kết nối: " + options.url));
                },
                ontimeout: function () {
                    reject(new Error("Timeout: " + options.url));
                }
            });
        });
    }

    function setNativeInputValue(inputEl, val) {
        if (!inputEl) return;
        try {
            var proto = Object.getPrototypeOf(inputEl);
            var desc = proto ? Object.getOwnPropertyDescriptor(proto, "value") : null;
            if (desc && typeof desc.set === "function") {
                desc.set.call(inputEl, val);
            } else {
                inputEl.value = val;
            }
            inputEl.dispatchEvent(new Event("input", { bubbles: true }));
            inputEl.dispatchEvent(new Event("change", { bubbles: true }));
        } catch (e) {
            inputEl.value = val;
        }
    }

    function extractDomainFromText(text) {
        if (!text) return "";
        var fullMatch = text.match(/https?:\/\/([a-zA-Z0-9-]{2,}(?:\.[a-zA-Z0-9-]{2,})+)(?:\/[^\s"'<>]*)?/i);
        if (fullMatch && !fullMatch[0].includes("*")) {
            var h = fullMatch[1].toLowerCase();
            if (!h.includes("google.") && !h.includes("sitetop.") && !h.includes("youtube.")) {
                return fullMatch[0].replace(/[),.;]+$/, "");
            }
        }
        var domainRe = /\b([a-zA-Z0-9-]{2,}\.(?:com\.vn|net\.vn|org\.vn|edu\.vn|gov\.vn|io|com|net|vn|org|me|top|vip|club|info|xyz|site|online|pro|app|dev|tv|co|cc|us|uk|ca|de|jp|kr|asia|biz|mobi|pw|live|fun|store|tech|shop|space|website|press|host|ink|wiki|design|blog|art|one|link|click|help|news|lol|lat|cfd|sbs|cyou|icu|gay|bet|win|gg|ai))\b/gi;
        var m;
        while ((m = domainRe.exec(text)) !== null) {
            var candidate = m[1].toLowerCase();
            if (!candidate.includes("google.") && !candidate.includes("sitetop.") && !candidate.includes("youtube.")) {
                return "https://" + candidate + "/";
            }
        }
        return "";
    }

    function blobToDataUrl(blob) {
        return new Promise(function (resolve, reject) {
            var reader = new FileReader();
            reader.onloadend = function () { resolve(reader.result || ""); };
            reader.onerror = function () { reject(new Error("Đọc ảnh thất bại")); };
            reader.readAsDataURL(blob);
        });
    }

    async function extractDomainViaOCR(imageUrl) {
        if (!imageUrl) return "";
        try {
            var imagePayload = imageUrl;
            if (!imageUrl.startsWith("data:image/")) {
                try {
                    var imgRes = await gmRequest({
                        method: "GET",
                        url: imageUrl,
                        responseType: "blob",
                        timeout: 12000
                    });
                    if (imgRes.status === 200 && imgRes.response) {
                        var dataUrl = await blobToDataUrl(imgRes.response);
                        if (dataUrl && dataUrl.startsWith("data:image/")) {
                            imagePayload = dataUrl;
                        }
                    }
                } catch (e) {}
            }

            var boundary = "----STFormBoundary" + Math.random().toString(36).slice(2);
            var parts = [
                "--" + boundary,
                'Content-Disposition: form-data; name="apikey"',
                "",
                "helloworld",
                "--" + boundary,
                'Content-Disposition: form-data; name="language"',
                "",
                "eng",
                "--" + boundary,
                'Content-Disposition: form-data; name="OCREngine"',
                "",
                "2"
            ];

            if (imagePayload.startsWith("data:image/")) {
                parts.push(
                    "--" + boundary,
                    'Content-Disposition: form-data; name="base64Image"',
                    "",
                    imagePayload
                );
            } else {
                parts.push(
                    "--" + boundary,
                    'Content-Disposition: form-data; name="url"',
                    "",
                    imagePayload
                );
            }
            parts.push("--" + boundary + "--", "");

            var res = await gmRequest({
                method: "POST",
                url: "https://api.ocr.space/parse/image",
                headers: { "Content-Type": "multipart/form-data; boundary=" + boundary },
                data: parts.join("\r\n"),
                timeout: 15000
            });

            var data = JSON.parse(res.text);
            if (!data || !data.ParsedResults || !data.ParsedResults.length) return "";
            var text = data.ParsedResults.map(function (r) { return r.ParsedText || ""; }).join("\n");
            return extractDomainFromText(text);
        } catch (e) {
            return "";
        }
    }

    function createFloating3DUI(providerName) {
        var prefs = loadUiPrefs();

        var css = [
            "@keyframes bvCubeSpin { 0% { transform: rotateX(-22deg) rotateY(0deg); } 100% { transform: rotateX(-22deg) rotateY(360deg); } }",
            "@keyframes bvBarSheen { 0% { background-position: 0 0; } 100% { background-position: 28px 0; } }",
            "#bv-stage-3d { position: fixed; bottom: 22px; right: 22px; width: 355px; z-index: 2147483646; perspective: 950px; font-family: 'Segoe UI', system-ui, -apple-system, sans-serif; font-size: 13px; line-height: 1.45; text-align: left; }",
            "#bv-stage-3d * { box-sizing: border-box; }",
            "#bv-stage-3d.bv-minimized { width: auto; }",
            ".bv-card-3d { position: relative; transform-style: preserve-3d; transition: transform 0.16s cubic-bezier(0.2, 0.8, 0.2, 1), box-shadow 0.2s ease; color: #f1f5f9; background: linear-gradient(155deg, rgba(15, 23, 42, 0.97) 0%, rgba(10, 15, 30, 0.98) 100%); border: 1px solid rgba(56, 189, 248, 0.42); border-radius: 14px; box-shadow: 0 22px 45px -10px rgba(0, 0, 0, 0.78), 0 5px 0 rgba(2, 132, 199, 0.55), inset 0 1px 1px rgba(255, 255, 255, 0.2); backdrop-filter: blur(12px); overflow: hidden; }",
            "#bv-stage-3d.bv-minimized .bv-card-3d { border-radius: 999px; box-shadow: 0 12px 26px rgba(0, 0, 0, 0.65), 0 4px 0 rgba(2, 132, 199, 0.55), inset 0 1px 1px rgba(255, 255, 255, 0.2); }",
            "#bv-stage-3d.bv-minimized .bv-body { display: none; }",
            ".bv-header { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; background: linear-gradient(90deg, rgba(14, 165, 233, 0.22), rgba(59, 130, 246, 0.12)); border-bottom: 1px solid rgba(148, 163, 184, 0.18); cursor: move; user-select: none; transform: translateZ(8px); }",
            "#bv-stage-3d.bv-minimized .bv-header { border-bottom: none; padding: 8px 14px; gap: 12px; }",
            ".bv-title-wrap { display: flex; align-items: center; gap: 10px; }",
            ".bv-cube-scene { width: 14px; height: 14px; perspective: 60px; display: inline-block; }",
            ".bv-cube { width: 100%; height: 100%; position: relative; transform-style: preserve-3d; animation: bvCubeSpin 7s infinite linear; }",
            ".bv-cube-face { position: absolute; width: 14px; height: 14px; border: 1.5px solid #38bdf8; background: rgba(14, 165, 233, 0.22); box-shadow: 0 0 6px rgba(56, 189, 248, 0.45); }",
            ".bv-cube-f { transform: rotateY(0deg) translateZ(7px); }",
            ".bv-cube-b { transform: rotateY(180deg) translateZ(7px); }",
            ".bv-cube-r { transform: rotateY(90deg) translateZ(7px); }",
            ".bv-cube-l { transform: rotateY(-90deg) translateZ(7px); }",
            ".bv-cube-t { transform: rotateX(90deg) translateZ(7px); }",
            ".bv-cube-d { transform: rotateX(-90deg) translateZ(7px); }",
            ".bv-title { font-weight: 700; font-size: 13.5px; color: #38bdf8; display: flex; align-items: center; gap: 7px; text-shadow: 0 2px 6px rgba(14, 165, 233, 0.35); }",
            ".bv-badge { font-size: 10.5px; padding: 1px 8px; border-radius: 999px; background: rgba(14, 165, 233, 0.2); color: #7dd3fc; border: 1px solid rgba(56, 189, 248, 0.4); font-weight: 600; box-shadow: inset 0 1px 0 rgba(255,255,255,0.2); }",
            ".bv-icon-btn { background: linear-gradient(180deg, rgba(51, 65, 85, 0.9), rgba(30, 41, 59, 0.95)); border: 1px solid rgba(148, 163, 184, 0.3); color: #e2e8f0; width: 24px; height: 24px; border-radius: 6px; cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 14px; font-weight: 700; line-height: 1; padding: 0; box-shadow: 0 2px 0 rgba(15, 23, 42, 0.9); transition: transform 0.1s, box-shadow 0.1s; }",
            ".bv-icon-btn:hover { border-color: #38bdf8; color: #fff; }",
            ".bv-icon-btn:active { transform: translateY(2px); box-shadow: none; }",
            ".bv-body { padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; transform-style: preserve-3d; }",
            ".bv-status-box { background: linear-gradient(180deg, rgba(30, 41, 59, 0.9) 0%, rgba(15, 23, 42, 0.95) 100%); border: 1px solid rgba(56, 189, 248, 0.25); border-radius: 10px; padding: 9px 11px; box-shadow: 0 6px 14px rgba(0, 0, 0, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.08); transform: translateZ(12px); }",
            ".bv-status-text { font-weight: 600; color: #f8fafc; margin-bottom: 4px; word-break: break-word; }",
            ".bv-status-sub { font-size: 11.5px; color: #94a3b8; word-break: break-word; }",
            ".bv-progress-wrap { width: 100%; height: 7px; background: rgba(2, 6, 23, 0.95); border-radius: 999px; overflow: hidden; margin-top: 8px; box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.8); border: 1px solid rgba(148, 163, 184, 0.15); }",
            ".bv-progress-bar { height: 100%; width: 0%; background-color: #0ea5e9; background-image: linear-gradient(45deg, rgba(255,255,255,0.22) 25%, transparent 25%, transparent 50%, rgba(255,255,255,0.22) 50%, rgba(255,255,255,0.22) 75%, transparent 75%, transparent); background-size: 28px 28px; animation: bvBarSheen 1s linear infinite; transition: width 0.3s linear; box-shadow: 0 0 10px rgba(14, 165, 233, 0.65); }",
            ".bv-meta-box { display: none; font-size: 11.5px; color: #cbd5e1; background: rgba(15, 23, 42, 0.75); border: 1px solid rgba(148, 163, 184, 0.22); border-radius: 8px; padding: 7px 10px; transform: translateZ(8px); }",
            ".bv-preview-box { display: none; flex-direction: column; gap: 5px; background: rgba(15, 23, 42, 0.75); border: 1px dashed rgba(148, 163, 184, 0.3); border-radius: 8px; padding: 7px; transform: translateZ(6px); }",
            ".bv-preview-label { font-size: 11px; color: #94a3b8; display: flex; justify-content: space-between; }",
            ".bv-preview-img { width: 100%; max-height: 84px; object-fit: contain; border-radius: 5px; background: #fff; cursor: zoom-in; }",
            ".bv-preview-img.bv-zoomed { max-height: 230px; }",
            ".bv-input-group { display: flex; flex-direction: column; gap: 5px; transform: translateZ(10px); }",
            ".bv-label { font-size: 11.5px; color: #cbd5e1; }",
            ".bv-row { display: flex; gap: 7px; }",
            ".bv-input { flex: 1; background: rgba(2, 6, 23, 0.85); border: 1px solid rgba(148, 163, 184, 0.32); border-radius: 7px; padding: 7px 9px; color: #f8fafc; font-size: 12.5px; outline: none; box-shadow: inset 0 2px 4px rgba(0, 0, 0, 0.5); }",
            ".bv-input:focus { border-color: #38bdf8; box-shadow: inset 0 2px 4px rgba(0, 0, 0, 0.5), 0 0 0 2px rgba(56, 189, 248, 0.2); }",
            ".bv-btn { background: linear-gradient(180deg, #0ea5e9 0%, #0284c7 100%); color: #fff; border: 1px solid rgba(125, 211, 252, 0.35); border-radius: 7px; padding: 6px 12px; font-weight: 600; font-size: 12px; cursor: pointer; white-space: nowrap; box-shadow: 0 3px 0 #0369a1, 0 5px 10px rgba(0, 0, 0, 0.35); transition: transform 0.1s, box-shadow 0.1s; }",
            ".bv-btn:hover { filter: brightness(1.06); }",
            ".bv-btn:active { transform: translateY(2px); box-shadow: 0 1px 0 #0369a1; }",
            ".bv-btn:disabled { opacity: 0.55; cursor: not-allowed; transform: none; }",
            ".bv-btn-success { background: linear-gradient(180deg, #10b981 0%, #059669 100%); border-color: rgba(110, 231, 183, 0.35); box-shadow: 0 3px 0 #065f46, 0 5px 10px rgba(0, 0, 0, 0.35); }",
            ".bv-btn-success:active { box-shadow: 0 1px 0 #065f46; }",
            ".bv-code-box { display: none; align-items: center; justify-content: space-between; background: linear-gradient(180deg, rgba(16, 185, 129, 0.18), rgba(6, 95, 70, 0.25)); border: 1px solid rgba(16, 185, 129, 0.45); border-radius: 9px; padding: 8px 11px; box-shadow: 0 6px 14px rgba(0, 0, 0, 0.3), inset 0 1px 0 rgba(255, 255, 255, 0.12); transform: translateZ(14px); }",
            ".bv-code-val { font-family: Consolas, monospace; font-size: 15px; font-weight: 700; color: #34d399; letter-spacing: 1px; text-shadow: 0 0 8px rgba(52, 211, 153, 0.4); }",
            ".bv-final-box { display: none; flex-direction: column; gap: 6px; background: linear-gradient(180deg, rgba(14, 165, 233, 0.18), rgba(30, 58, 138, 0.25)); border: 1px solid rgba(56, 189, 248, 0.45); border-radius: 9px; padding: 9px 11px; box-shadow: 0 6px 14px rgba(0, 0, 0, 0.3); transform: translateZ(14px); }",
            ".bv-final-link { color: #38bdf8; font-weight: 600; word-break: break-all; text-decoration: underline; font-size: 12px; }",
            ".bv-footer { display: flex; align-items: center; justify-content: space-between; font-size: 11.5px; color: #94a3b8; padding-top: 5px; border-top: 1px solid rgba(148, 163, 184, 0.14); transform: translateZ(6px); }",
            ".bv-checkbox-label { display: flex; align-items: center; gap: 5px; cursor: pointer; user-select: none; }",
            ".bv-timer-pill { background: rgba(2, 6, 23, 0.85); border: 1px solid rgba(56, 189, 248, 0.3); color: #38bdf8; font-family: Consolas, monospace; font-weight: 700; padding: 1px 7px; border-radius: 6px; }"
        ].join("\n");

        if (typeof GM_addStyle === "function") {
            GM_addStyle(css);
        } else {
            var styleEl = document.createElement("style");
            styleEl.textContent = css;
            document.head.appendChild(styleEl);
        }

        var stage = document.createElement("div");
        stage.id = "bv-stage-3d";
        if (prefs.minimized) stage.className = "bv-minimized";

        stage.innerHTML = [
            '<div class="bv-card-3d" id="bv-card-3d">',
            '  <div class="bv-header" id="bv-drag-handle">',
            '    <div class="bv-title-wrap">',
            '      <div class="bv-cube-scene"><div class="bv-cube">',
            '        <div class="bv-cube-face bv-cube-f"></div><div class="bv-cube-face bv-cube-b"></div>',
            '        <div class="bv-cube-face bv-cube-r"></div><div class="bv-cube-face bv-cube-l"></div>',
            '        <div class="bv-cube-face bv-cube-t"></div><div class="bv-cube-face bv-cube-d"></div>',
            '      </div></div>',
            '      <div class="bv-title">BypassVIEN <span class="bv-badge">' + providerName + '</span></div>',
            '    </div>',
            '    <div>',
            '      <button type="button" class="bv-icon-btn" id="bv-btn-min">' + (prefs.minimized ? "+" : "-") + '</button>',
            '    </div>',
            '  </div>',
            '  <div class="bv-body">',
            '    <div class="bv-status-box">',
            '      <div class="bv-status-text" id="bv-status-main">Đang khởi tạo...</div>',
            '      <div class="bv-status-sub" id="bv-status-sub">Đang đọc dữ liệu nhiệm vụ...</div>',
            '      <div class="bv-progress-wrap"><div class="bv-progress-bar" id="bv-progress-bar"></div></div>',
            '    </div>',
            '    <div class="bv-meta-box" id="bv-meta-box"></div>',
            '    <div class="bv-preview-box" id="bv-preview-box">',
            '      <div class="bv-preview-label"><span>Ảnh nhiệm vụ:</span><span>(Bấm để phóng to)</span></div>',
            '      <img class="bv-preview-img" id="bv-preview-img-site" alt="Preview" style="display:none;" />',
            '    </div>',
            '    <div class="bv-input-group">',
            '      <label class="bv-label" for="bv-url-input">URL / Domain trang nhiệm vụ:</label>',
            '      <div class="bv-row">',
            '        <input type="text" class="bv-input" id="bv-url-input" placeholder="Tự động quét hoặc nhập domain..." autocomplete="off" />',
            '        <button type="button" class="bv-btn" id="bv-btn-start">Lấy Mã</button>',
            '      </div>',
            '    </div>',
            '    <div class="bv-code-box" id="bv-code-box">',
            '      <div><div style="font-size:11px;color:#a7f3d0;">Mã đã lấy:</div><div class="bv-code-val" id="bv-code-val">------</div></div>',
            '      <button type="button" class="bv-btn bv-btn-success" id="bv-btn-copy-code">Copy Mã</button>',
            '    </div>',
            '    <div class="bv-final-box" id="bv-final-box">',
            '      <div style="font-size:11.5px;color:#bae6fd;font-weight:600;">Kết quả đích:</div>',
            '      <a class="bv-final-link" id="bv-final-link" href="#" target="_blank" rel="noopener noreferrer"></a>',
            '      <div class="bv-row" style="margin-top:3px;">',
            '        <a class="bv-btn bv-btn-success" id="bv-btn-open-final" href="#" target="_self" style="text-align:center;text-decoration:none;flex:1;">Mở Link</a>',
            '        <button type="button" class="bv-btn" id="bv-btn-copy-final">Copy</button>',
            '      </div>',
            '    </div>',
            '    <div class="bv-footer">',
            '      <label class="bv-checkbox-label"><input type="checkbox" id="bv-chk-autoredirect" ' + (prefs.autoRedirect ? "checked" : "") + ' /> Tự chuyển tiếp</label>',
            '      <span class="bv-timer-pill" id="bv-timer-badge">00s</span>',
            '    </div>',
            '  </div>',
            '</div>'
        ].join("\n");

        document.body.appendChild(stage);

        var card = stage.querySelector("#bv-card-3d");
        var btnMin = stage.querySelector("#bv-btn-min");
        var isDragging = false;

        stage.addEventListener("mousemove", function (e) {
            if (isDragging || prefs.minimized) return;
            var rect = stage.getBoundingClientRect();
            var cx = rect.left + rect.width / 2;
            var cy = rect.top + rect.height / 2;
            var dx = (e.clientX - cx) / (rect.width / 2);
            var dy = (e.clientY - cy) / (rect.height / 2);
            var rotX = (-dy * 6).toFixed(2);
            var rotY = (dx * 6).toFixed(2);
            card.style.transform = "rotateX(" + rotX + "deg) rotateY(" + rotY + "deg)";
        });

        stage.addEventListener("mouseleave", function () {
            card.style.transform = "rotateX(0deg) rotateY(0deg)";
        });

        btnMin.addEventListener("click", function () {
            prefs.minimized = !prefs.minimized;
            stage.classList.toggle("bv-minimized", prefs.minimized);
            btnMin.textContent = prefs.minimized ? "+" : "-";
            card.style.transform = "rotateX(0deg) rotateY(0deg)";
            saveUiPrefs(prefs);
        });

        var chkAuto = stage.querySelector("#bv-chk-autoredirect");
        chkAuto.addEventListener("change", function () {
            prefs.autoRedirect = !!chkAuto.checked;
            saveUiPrefs(prefs);
        });

        var imgSite = stage.querySelector("#bv-preview-img-site");
        imgSite.addEventListener("click", function () {
            imgSite.classList.toggle("bv-zoomed");
        });

        var dragHandle = stage.querySelector("#bv-drag-handle");
        var startX = 0, startY = 0, startRight = 22, startBottom = 22;
        dragHandle.addEventListener("mousedown", function (e) {
            if (e.target === btnMin) return;
            isDragging = true;
            card.style.transform = "rotateX(0deg) rotateY(0deg)";
            startX = e.clientX;
            startY = e.clientY;
            var rect = stage.getBoundingClientRect();
            startRight = window.innerWidth - rect.right;
            startBottom = window.innerHeight - rect.bottom;
            e.preventDefault();
        });
        window.addEventListener("mousemove", function (e) {
            if (!isDragging) return;
            var dx = e.clientX - startX;
            var dy = e.clientY - startY;
            stage.style.right = Math.max(6, startRight - dx) + "px";
            stage.style.bottom = Math.max(6, startBottom - dy) + "px";
        });
        window.addEventListener("mouseup", function () {
            isDragging = false;
        });

        var statusMainEl = stage.querySelector("#bv-status-main");
        var statusSubEl = stage.querySelector("#bv-status-sub");
        var progressBarEl = stage.querySelector("#bv-progress-bar");
        var timerBadgeEl = stage.querySelector("#bv-timer-badge");
        var metaBoxEl = stage.querySelector("#bv-meta-box");
        var urlInputEl = stage.querySelector("#bv-url-input");
        var btnStartEl = stage.querySelector("#bv-btn-start");
        var previewBoxEl = stage.querySelector("#bv-preview-box");
        var codeBoxEl = stage.querySelector("#bv-code-box");
        var codeValEl = stage.querySelector("#bv-code-val");
        var btnCopyCode = stage.querySelector("#bv-btn-copy-code");
        var finalBoxEl = stage.querySelector("#bv-final-box");
        var finalLinkEl = stage.querySelector("#bv-final-link");
        var btnOpenFinal = stage.querySelector("#bv-btn-open-final");
        var btnCopyFinal = stage.querySelector("#bv-btn-copy-final");

        btnCopyCode.addEventListener("click", function () {
            navigator.clipboard.writeText(codeValEl.textContent.trim());
            btnCopyCode.textContent = "Đã Copy";
            setTimeout(function () { btnCopyCode.textContent = "Copy Mã"; }, 1500);
        });

        btnCopyFinal.addEventListener("click", function () {
            navigator.clipboard.writeText(finalLinkEl.textContent.trim());
            btnCopyFinal.textContent = "Đã Copy";
            setTimeout(function () { btnCopyFinal.textContent = "Copy"; }, 1500);
        });

        return {
            setStatus: function (mainText, subText, progressPercent) {
                if (mainText !== undefined && mainText !== null) statusMainEl.textContent = mainText;
                if (subText !== undefined && subText !== null) statusSubEl.textContent = subText;
                if (typeof progressPercent === "number") {
                    progressBarEl.style.width = Math.max(0, Math.min(100, progressPercent)) + "%";
                }
            },
            setMeta: function (keyword, campaignId) {
                var parts = [];
                if (keyword) parts.push("Từ khoá: <b>" + keyword.replace(/</g, "&lt;") + "</b>");
                if (campaignId) parts.push("Camp #" + campaignId);
                if (parts.length) {
                    metaBoxEl.innerHTML = parts.join(" &nbsp;|&nbsp; ");
                    metaBoxEl.style.display = "block";
                }
            },
            setTimer: function (sec) {
                timerBadgeEl.textContent = (sec > 0 ? sec : 0) + "s";
            },
            setPreviewImage: function (siteImgSrc) {
                if (siteImgSrc) {
                    imgSite.src = siteImgSrc;
                    imgSite.style.display = "block";
                    previewBoxEl.style.display = "flex";
                } else {
                    imgSite.style.display = "none";
                    previewBoxEl.style.display = "none";
                }
            },
            getUrlInput: function () {
                return urlInputEl.value.trim();
            },
            setUrlInput: function (val) {
                urlInputEl.value = val || "";
            },
            focusUrlInput: function () {
                urlInputEl.focus();
                urlInputEl.style.borderColor = "#f59e0b";
            },
            setLoading: function (isLoading) {
                btnStartEl.disabled = !!isLoading;
                btnStartEl.textContent = isLoading ? "Đang chạy..." : "Lấy Mã";
            },
            onStartClick: function (handler) {
                btnStartEl.addEventListener("click", function () {
                    handler(urlInputEl.value.trim());
                });
                urlInputEl.addEventListener("keydown", function (e) {
                    if (e.key === "Enter") {
                        e.preventDefault();
                        if (!btnStartEl.disabled) handler(urlInputEl.value.trim());
                    }
                });
            },
            showCode: function (code) {
                codeValEl.textContent = code;
                codeBoxEl.style.display = "flex";
            },
            showFinalResult: function (finalUrl, delayMs) {
                finalLinkEl.textContent = finalUrl;
                finalLinkEl.href = finalUrl;
                btnOpenFinal.href = finalUrl;
                finalBoxEl.style.display = "flex";
                if (prefs.autoRedirect) {
                    setTimeout(function () {
                        try {
                            if (typeof pageWin.markVisitCompleted === "function") {
                                pageWin.markVisitCompleted();
                            }
                        } catch (e) {}
                        window.location.href = finalUrl;
                    }, typeof delayMs === "number" ? delayMs : 600);
                }
            }
        };
    }

    function readPageTaskInfo() {
        var html = document.documentElement.innerHTML;
        var sessionId = typeof pageWin.sessionId === "string" ? pageWin.sessionId.trim() : "";
        if (!sessionId) {
            var sidMatch = html.match(/var\s+sessionId\s*=\s*['"]([a-f0-9]+)['"]/i);
            if (sidMatch) sessionId = sidMatch[1];
        }

        var ajaxUrl = typeof pageWin.ajaxUrl === "string" && pageWin.ajaxUrl
            ? pageWin.ajaxUrl
            : (window.location.origin + "/wp-admin/admin-ajax.php");

        var campId = pageWin.currentCampaignId ? String(pageWin.currentCampaignId) : "";
        if (!campId) {
            var campMatch = html.match(/var\s+currentCampaignId\s*=\s*(\d+)/);
            if (campMatch) campId = campMatch[1];
        }

        var kwEl = document.querySelector(".g-mock-typed");
        var keyword = kwEl ? (kwEl.textContent || "").trim() : "";

        var desktopImg = document.getElementById("screenshot-desktop");
        var mobileImg = document.getElementById("screenshot-mobile");
        var nocodeImg = document.getElementById("screenshot-desktop-nocode") || document.getElementById("screenshot-mobile-nocode");
        var screenshotUrl = "";
        if (desktopImg && desktopImg.src) screenshotUrl = desktopImg.src;
        else if (mobileImg && mobileImg.src) screenshotUrl = mobileImg.src;
        else if (nocodeImg && nocodeImg.src) screenshotUrl = nocodeImg.src;

        var campaignType = "keyword_search";
        try {
            campaignType = localStorage.getItem("tn_campaign_type") || "keyword_search";
        } catch (e) {}

        return {
            sessionId: sessionId,
            ajaxUrl: ajaxUrl,
            campaignId: campId,
            keyword: keyword,
            screenshotUrl: screenshotUrl,
            campaignType: campaignType
        };
    }

    async function fetchTopJsNonce() {
        try {
            var res = await gmRequest({
                method: "GET",
                url: "https://sitetop.net/top.js",
                timeout: 12000
            });
            var wjs = res.text || "";
            var nonceMatch = wjs.match(/['"]&nonce=['"]\s*\+\s*encodeURIComponent\(\s*['"]([^'"]+)['"]\s*\)/)
                || wjs.match(/nonce\s*[:=]\s*['"]([a-f0-9]+)['"]/i);
            var apiMatch = wjs.match(/var\s+_canonical\s*=\s*['"](https?:\/\/[^'"]+)['"]/);
            return {
                apiOrigin: apiMatch ? apiMatch[1] : "https://sitetop.net",
                nonce: nonceMatch ? nonceMatch[1] : ""
            };
        } catch (e) {
            return { apiOrigin: "https://sitetop.net", nonce: "" };
        }
    }

    function sendSameOriginAjax(ajaxUrl, action, paramsObj) {
        var fd = new FormData();
        fd.append("action", action);
        if (paramsObj) {
            Object.keys(paramsObj).forEach(function (k) {
                if (paramsObj[k] !== undefined && paramsObj[k] !== null) {
                    fd.append(k, String(paramsObj[k]));
                }
            });
        }
        return fetch(ajaxUrl, {
            method: "POST",
            credentials: "same-origin",
            body: fd
        }).catch(function () {});
    }

    function initSiteTop() {
        var codeInputEl = document.getElementById("code-input");
        var btnUnlockEl = document.getElementById("btn-unlock");
        if (!codeInputEl || !btnUnlockEl) return;

        var taskInfo = readPageTaskInfo();
        if (!taskInfo.sessionId) return;

        var ui = createFloating3DUI("SiteTop");
        ui.setMeta(taskInfo.keyword, taskInfo.campaignId);
        if (taskInfo.screenshotUrl) {
            ui.setPreviewImage(taskInfo.screenshotUrl);
        }

        var isRunning = false;
        var finalUrlResolved = false;
        var activeWorkerTab = null;
        var statusListenerId = null;
        var statusPollTimer = null;
        var wrongUrlRetries = 0;

        // Hook fetch trên trang để bắt ngay link đích khi submit mã thành công
        var origFetch = pageWin.fetch;
        if (typeof origFetch === "function" && !origFetch.__stHooked) {
            var wrappedFetch = function () {
                return origFetch.apply(this, arguments).then(function (response) {
                    try {
                        var clone = response.clone();
                        clone.text().then(function (txt) {
                            if (!txt || txt.charAt(0) !== "{") return;
                            var json = JSON.parse(txt);
                            if (json && json.success && json.data) {
                                var dest = json.data.target_url || json.data.redirect_url;
                                if (dest && /^https?:\/\//i.test(dest) && !finalUrlResolved) {
                                    finalUrlResolved = true;
                                    ui.setStatus("Vượt link SiteTop thành công!", dest, 100);
                                    ui.showFinalResult(dest, 350);
                                }
                            }
                        }).catch(function () {});
                    } catch (e) {}
                    return response;
                });
            };
            wrappedFetch.__stHooked = true;
            pageWin.fetch = wrappedFetch;
        }

        function closeWorkerTab() {
            if (activeWorkerTab) {
                try {
                    if (typeof activeWorkerTab.close === "function") activeWorkerTab.close();
                } catch (e) {}
                activeWorkerTab = null;
            }
            if (statusListenerId !== null && typeof GM_removeValueChangeListener === "function") {
                try { GM_removeValueChangeListener(statusListenerId); } catch (e) {}
                statusListenerId = null;
            }
            if (statusPollTimer) {
                clearInterval(statusPollTimer);
                statusPollTimer = null;
            }
        }

        window.addEventListener("beforeunload", function () {
            closeWorkerTab();
        });

        function applyCodeAndSubmit(codeStr) {
            ui.showCode(codeStr);
            ui.setTimer(0);
            codeInputEl.disabled = false;
            btnUnlockEl.disabled = false;
            setNativeInputValue(codeInputEl, codeStr);

            try {
                localStorage.setItem("code_input_" + taskInfo.sessionId, JSON.stringify({
                    code: codeStr,
                    ts: Date.now()
                }));
            } catch (e) {}

            var captchaNeeded = !!pageWin.unlockCaptchaOn && !pageWin.unlockCaptchaTok;
            if (captchaNeeded) {
                ui.setStatus("Đã lấy & điền mã: " + codeStr, "Tick vào ô xác minh Turnstile đang mở để tự gửi!", 99);
                try {
                    if (typeof pageWin.openUnlockCaptcha === "function") {
                        pageWin.openUnlockCaptcha();
                        return;
                    }
                } catch (e) {}
                ui.setStatus("Đã điền mã: " + codeStr, "Bấm nút Nhập mã xác nhận và giải Turnstile trên trang.", 99);
                return;
            }

            ui.setStatus("Đã lấy mã: " + codeStr, "Đang tự động xác nhận lấy link đích...", 99);
            try {
                if (typeof pageWin.doUnlockSubmit === "function") {
                    pageWin.doUnlockSubmit(codeStr);
                }
            } catch (e) {}
        }

        async function runBypass(manualInput) {
            if (isRunning) return;
            var cleanUrl = normalizeFullUrl(manualInput || ui.getUrlInput());
            if (!cleanUrl) {
                ui.setStatus("Chưa có domain trang đích", "Nhập tên miền từ ảnh/từ khoá vào ô rồi bấm Lấy Mã", null);
                ui.focusUrlInput();
                return;
            }
            if (typeof GM_openInTab !== "function") {
                ui.setStatus("Thiếu quyền GM_openInTab", "Cập nhật Tampermonkey để script mở tab nền.", null);
                return;
            }

            closeWorkerTab();
            isRunning = true;
            ui.setLoading(true);
            ui.setUrlInput(cleanUrl);
            ui.setStatus("Đang mở tab nền xử lý SiteTop...", cleanUrl, 6);

            try {
                await sendSameOriginAjax(taskInfo.ajaxUrl, "sitetop_task_handoff", {
                    session_id: taskInfo.sessionId
                });
                var topCfg = await fetchTopJsNonce();
                var parsedTarget = new URL(cleanUrl);

                // Reset status trước khi mở tab nền
                saveJsonStorage(STORAGE_STATUS_KEY, {
                    sessionId: taskInfo.sessionId,
                    status: "init",
                    ts: Date.now()
                });

                saveJsonStorage(STORAGE_JOB_KEY, {
                    sessionId: taskInfo.sessionId,
                    apiOrigin: topCfg.apiOrigin,
                    nonce: topCfg.nonce,
                    targetUrl: cleanUrl,
                    targetHost: parsedTarget.hostname,
                    campaignType: taskInfo.campaignType,
                    createdAt: Date.now()
                });

                var lastHandledTs = 0;
                var handleWorkerStatus = function (st) {
                    if (!st || st.sessionId !== taskInfo.sessionId) return;
                    if (st.ts && st.ts <= lastHandledTs) return;
                    if (st.ts) lastHandledTs = st.ts;

                    if (st.status === "progress") {
                        ui.setStatus(st.main, st.sub, st.pct);
                        if (typeof st.waitSec === "number") ui.setTimer(st.waitSec);
                    } else if (st.status === "code" && st.code) {
                        closeWorkerTab();
                        isRunning = false;
                        ui.setLoading(false);
                        if (taskInfo.campaignId) {
                            saveDomainCache(taskInfo.campaignId, st.targetUrl || cleanUrl);
                        }
                        applyCodeAndSubmit(st.code);
                    } else if (st.status === "wrong_url" && st.wantUrl && wrongUrlRetries < 1) {
                        wrongUrlRetries++;
                        closeWorkerTab();
                        isRunning = false;
                        ui.setLoading(false);
                        ui.setUrlInput(st.wantUrl);
                        ui.setStatus("Phát hiện đúng trang đích", st.wantUrl, 10);
                        setTimeout(function () { runBypass(st.wantUrl); }, 250);
                    } else if (st.status === "error" || st.status === "wrong_url") {
                        closeWorkerTab();
                        isRunning = false;
                        ui.setLoading(false);
                        ui.setStatus("Lỗi SiteTop", st.message || "Không lấy được mã", null);
                        ui.focusUrlInput();
                    }
                };

                if (typeof GM_addValueChangeListener === "function") {
                    statusListenerId = GM_addValueChangeListener(STORAGE_STATUS_KEY, function (_name, _oldVal, newVal) {
                        try {
                            var parsed = typeof newVal === "string" ? JSON.parse(newVal) : newVal;
                            handleWorkerStatus(parsed);
                        } catch (e) {}
                    });
                }

                // Fallback poll phòng trường hợp GM_addValueChangeListener trễ
                statusPollTimer = setInterval(function () {
                    var st = loadJsonStorage(STORAGE_STATUS_KEY, null);
                    handleWorkerStatus(st);
                }, 600);

                var workerUrl = cleanUrl.split("#")[0] + "#bv_st=" + taskInfo.sessionId;
                activeWorkerTab = GM_openInTab(workerUrl, {
                    active: false,
                    insert: true,
                    setParent: true
                });
            } catch (err) {
                closeWorkerTab();
                isRunning = false;
                ui.setLoading(false);
                ui.setStatus("Lỗi SiteTop", (err && err.message) ? err.message : String(err), null);
                ui.focusUrlInput();
            }
        }

        ui.onStartClick(function (val) {
            wrongUrlRetries = 0;
            runBypass(val);
        });

        // Tự dò URL theo thứ tự: Từ khoá -> Cache campaign -> OCR ảnh SERP
        (async function autoDetectAndStart() {
            var fromKeyword = extractDomainFromText(taskInfo.keyword);
            if (fromKeyword) {
                ui.setUrlInput(fromKeyword);
                ui.setStatus("Nhận diện từ khoá: " + fromKeyword, "Đang khởi chạy tab nền vượt link...", 5);
                runBypass(fromKeyword);
                return;
            }

            var cache = loadDomainCache();
            if (taskInfo.campaignId && cache[taskInfo.campaignId] && cache[taskInfo.campaignId].targetUrl) {
                var cachedUrl = cache[taskInfo.campaignId].targetUrl;
                ui.setUrlInput(cachedUrl);
                ui.setStatus("Nhận diện từ bộ nhớ đệm", cachedUrl, 5);
                runBypass(cachedUrl);
                return;
            }

            if (taskInfo.screenshotUrl) {
                ui.setStatus("Đang quét tên miền từ ảnh...", "Phân tích ảnh kết quả Google qua OCR...", 3);
                var ocrUrl = await extractDomainViaOCR(taskInfo.screenshotUrl);
                if (ocrUrl) {
                    ui.setUrlInput(ocrUrl);
                    ui.setStatus("OCR thành công: " + ocrUrl, "Đang khởi chạy tab nền vượt link...", 5);
                    runBypass(ocrUrl);
                    return;
                }
            }

            ui.setStatus("Cần nhập domain nhiệm vụ", "Không tự quét được từ ảnh, anh gõ domain vào ô bên dưới nha", null);
            ui.focusUrlInput();
        })();
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", initSiteTop);
    } else {
        initSiteTop();
    }
})();
