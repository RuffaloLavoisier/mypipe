// ==UserScript==
// @name         Remove Adblock Thing
// @namespace    http://tampermonkey.net/
// @version      6.1
// @description  Removes YouTube ads and adblock detection popups using multi-layer blocking
// @author       JoelMatic
// @contributor  RuffaloLavoisier
// @match        https://www.youtube.com/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=youtube.com
// @updateURL    https://github.com/RuffaloLavoisier/mypipe/raw/main/Youtube-Ad-blocker-Reminder-Remover.user.js
// @downloadURL  https://github.com/RuffaloLavoisier/mypipe/raw/main/Youtube-Ad-blocker-Reminder-Remover.user.js
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
    'use strict';

    //
    //  Config
    //

    const config = {
        requestInterception: true,  // Layer 1: Inject "no ad" flag into player requests
        responsePruning: true,      // Layer 2: Strip ad data from API responses
        adSkipFallback: true,       // Layer 3: CSS hide + skip ads that slip through
        antiDetection: true,        // Layer 4: Bypass adblock detection popups
        cosmeticFiltering: true,    // Layer 5: Hide page-level ad elements
        downloader: true,           // Layer 6: Video download panel
        updateCheck: true,
        debug: true,
    };

    //
    //  Logging
    //

    const LOG_PREFIX = '🔧 Remove Adblock Thing:';
    const LOG_FN = { error: 'error', warn: 'warn', info: 'info', log: 'log' };

    function log(msg, level = 'info', ...args) {
        if (!config.debug) return;
        console[LOG_FN[level] || 'info'](`${LOG_PREFIX} ${msg}`, ...args);
    }

    //
    //  Shared constants
    //

    const PLAYER_ENDPOINTS = ['/youtubei/v1/player', '/youtubei/v1/next'];
    const AD_FIELDS = ['adPlacements', 'playerAds', 'adSlots', 'adBreakParams', 'adBreakHeartbeatParams'];

    function isPlayerUrl(url) {
        return PLAYER_ENDPOINTS.some(ep => url.includes(ep));
    }

    function stripAdData(json) {
        let modified = false;
        for (const field of AD_FIELDS) {
            if (json[field]) {
                delete json[field];
                modified = true;
            }
        }
        try {
            if (json?.auxiliaryUi?.messageRenderers?.enforcementMessageViewModel) {
                delete json.auxiliaryUi.messageRenderers.enforcementMessageViewModel;
                modified = true;
            }
        } catch {}
        return modified;
    }

    function injectNoAdFlag(obj) {
        if (obj?.playbackContext?.contentPlaybackContext) {
            obj.playbackContext.contentPlaybackContext.isInlinePlaybackNoAd = true;
            return true;
        }
        return false;
    }

    // Shared state for downloader — populated by Layer 2 fetch proxy
    let cachedPlayerResponse = null;

    log('Script started (v6.2)');

    // =========================================================================
    //  Layer 1: Player Request Interception
    // =========================================================================

    if (config.requestInterception) {
        // Strategy A: JSON.stringify proxy
        try {
            const origStringify = JSON.stringify;
            JSON.stringify = function (value, replacer, space) {
                if (value && typeof value === 'object' && injectNoAdFlag(value)) {
                    log('Layer 1A: Injected via JSON.stringify');
                }
                return origStringify.call(this, value, replacer, space);
            };
            JSON.stringify.toString = origStringify.toString.bind(origStringify);
            log('Layer 1A: JSON.stringify proxy installed');
        } catch (e) {
            log('Layer 1A: Failed', 'warn', e);
        }

        // Strategy B: XHR hook
        try {
            const origOpen = XMLHttpRequest.prototype.open;
            const origSend = XMLHttpRequest.prototype.send;

            XMLHttpRequest.prototype.open = function (method, url, ...rest) {
                this._ratUrl = typeof url === 'string' ? url : '';
                return origOpen.call(this, method, url, ...rest);
            };

            XMLHttpRequest.prototype.send = function (body) {
                if (this._ratUrl && typeof body === 'string' && isPlayerUrl(this._ratUrl)) {
                    try {
                        const json = JSON.parse(body);
                        if (injectNoAdFlag(json)) {
                            body = JSON.stringify(json);
                            log('Layer 1B: Injected via XHR');
                        }
                    } catch {}
                }
                return origSend.call(this, body);
            };
            log('Layer 1B: XHR hook installed');
        } catch (e) {
            log('Layer 1B: Failed', 'warn', e);
        }
    }

    // =========================================================================
    //  Layer 2: Response Pruning
    // =========================================================================

    if (config.responsePruning) {
        // 2a: Fetch interception
        try {
            const origFetch = window.fetch;
            window.fetch = function (...args) {
                const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';

                // Only intercept player API calls — pass everything else through untouched
                if (!isPlayerUrl(url)) {
                    return origFetch.apply(this, args);
                }

                return origFetch.apply(this, args).then(response => {
                    return response.clone().text().then(text => {
                        try {
                            const json = JSON.parse(text);
                            if (stripAdData(json)) {
                                log('Layer 2a: Stripped ad data from fetch response');
                            }
                            // Cache for downloader
                            if (json.streamingData) {
                                cachedPlayerResponse = json;
                            }
                            return new Response(JSON.stringify(json), {
                                status: response.status,
                                statusText: response.statusText,
                                headers: response.headers,
                            });
                        } catch {
                            return response;
                        }
                    });
                }).catch(() => origFetch.apply(this, args));
            };
            window.fetch.toString = origFetch.toString.bind(origFetch);
            log('Layer 2a: Fetch proxy installed');
        } catch (e) {
            log('Layer 2a: Failed', 'warn', e);
        }

        // 2b: ytInitialPlayerResponse interception
        try {
            const desc = Object.getOwnPropertyDescriptor(window, 'ytInitialPlayerResponse');
            if (!desc || desc.configurable) {
                // Property doesn't exist yet or is configurable — install setter trap
                let _ytInitial = desc?.value;
                Object.defineProperty(window, 'ytInitialPlayerResponse', {
                    get() { return _ytInitial; },
                    set(value) {
                        if (value && typeof value === 'object') stripAdData(value);
                        _ytInitial = value;
                    },
                    configurable: true,
                });
                log('Layer 2b: ytInitialPlayerResponse interceptor installed');
            } else {
                // Already defined as non-configurable — strip directly if value exists
                if (desc.value && typeof desc.value === 'object') {
                    stripAdData(desc.value);
                    log('Layer 2b: Stripped existing ytInitialPlayerResponse directly');
                }
            }
        } catch (e) {
            // Last resort: poll and strip
            const poll = setInterval(() => {
                if (window.ytInitialPlayerResponse) {
                    stripAdData(window.ytInitialPlayerResponse);
                    clearInterval(poll);
                    log('Layer 2b: Stripped ytInitialPlayerResponse via polling');
                }
            }, 100);
            setTimeout(() => clearInterval(poll), 10000);
        }
    }

    // =========================================================================
    //  Layer 3 + 5: CSS Injection (combined — runs at document-start)
    //  Hides ad video instantly via CSS and removes page-level ad elements.
    // =========================================================================

    (function injectAllCSS() {
        const s = document.createElement('style');
        s.id = 'rat-styles';
        s.textContent = `
            /* Layer 3: Hide video during ads (instant, 0ms) */
            .html5-video-player.ad-showing video {
                visibility: hidden !important;
            }
            .html5-video-player.ad-showing .ytp-ad-player-overlay,
            .html5-video-player.ad-showing .ytp-ad-module,
            .html5-video-player.ad-showing .ytp-ad-text,
            .html5-video-player.ad-showing .ytp-ad-image-overlay,
            .html5-video-player.ad-showing .ytp-ad-overlay-container,
            .html5-video-player.ad-showing .ytp-ad-message-container,
            .html5-video-player.ad-showing .ytp-ad-progress-list,
            .html5-video-player.ad-showing .video-ads {
                display: none !important;
            }

            /* Layer 3: Loading overlay */
            #rat-ad-overlay {
                position: absolute; top: 0; left: 0; width: 100%; height: 100%;
                z-index: 9999; background: #0f0f0f;
                display: flex; align-items: center; justify-content: center;
                pointer-events: none;
            }
            #rat-ad-overlay .rat-spinner {
                width: 48px; height: 48px;
                border: 3px solid rgba(255,255,255,0.15);
                border-top-color: #fff;
                border-radius: 50%;
                animation: rat-spin 0.8s linear infinite;
            }
            @keyframes rat-spin { to { transform: rotate(360deg); } }

            /* Layer 6: Download panel */
            #rat-download-panel {
                margin: 12px 0;
                background: #1a1a1a;
                border-radius: 12px;
                overflow: hidden;
                font-family: 'YouTube Sans', 'Roboto', sans-serif;
            }
            .rat-dl-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 12px 16px;
                color: #fff;
                font-size: 16px;
                font-weight: 500;
                cursor: default;
            }
            .rat-dl-toggle {
                background: none;
                border: none;
                color: #aaa;
                font-size: 18px;
                cursor: pointer;
                padding: 4px 8px;
            }
            .rat-dl-toggle:hover { color: #fff; }
            .rat-dl-body {
                padding: 0 16px 12px;
            }
            .rat-dl-section {
                margin-bottom: 10px;
            }
            .rat-dl-section-title {
                color: #aaa;
                font-size: 11px;
                font-weight: 500;
                text-transform: uppercase;
                letter-spacing: 0.5px;
                margin-bottom: 6px;
            }
            .rat-dl-btn {
                display: flex;
                align-items: center;
                justify-content: space-between;
                width: 100%;
                padding: 8px 12px;
                margin-bottom: 4px;
                background: #272727;
                border: none;
                border-radius: 8px;
                color: #fff;
                font-size: 13px;
                cursor: pointer;
                transition: background 0.15s;
            }
            .rat-dl-btn:hover {
                background: #3a3a3a;
            }
            .rat-dl-size {
                color: #aaa;
                font-size: 12px;
                margin-left: 8px;
                flex-shrink: 0;
            }
            .rat-dl-hint {
                color: #777;
                font-size: 11px;
                padding: 6px 0 0;
                border-top: 1px solid #333;
                margin-top: 8px;
            }

            /* Layer 5: Page-level ad elements */
            .ytp-ad-module,
            .ytp-ad-player-overlay,
            .ytp-ad-player-overlay-instream-info,
            .ytp-ad-text,
            .ytp-ad-image-overlay,
            .ytp-ad-progress-list,
            .ytp-featured-product,
            .video-ads,
            .ytp-ad-overlay-container,
            .ytp-ad-message-container,
            ytd-ad-slot-renderer,
            ytd-action-companion-ad-renderer,
            ytd-display-ad-renderer,
            ytd-video-masthead-ad-advertiser-info-renderer,
            ytd-video-masthead-ad-primary-video-renderer,
            ytd-in-feed-ad-layout-renderer,
            ytd-promoted-sparkles-web-renderer,
            ytd-promoted-video-renderer,
            ytd-search-pyv-renderer,
            yt-about-this-ad-renderer,
            yt-mealbar-promo-renderer,
            ytd-statement-banner-renderer,
            ytd-banner-promo-renderer-background,
            ad-slot-renderer,
            masthead-ad,
            ytm-promoted-sparkles-web-renderer,
            #masthead-ad,
            #player-ads,
            tp-yt-iron-overlay-backdrop,
            ytd-enforcement-message-view-model {
                display: none !important;
            }
        `;
        (document.head || document.documentElement).appendChild(s);

        // Re-inject if SPA navigation removes it
        function ensureCSS() {
            if (!document.getElementById('rat-styles')) {
                (document.head || document.documentElement).appendChild(s);
            }
        }

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => {
                new MutationObserver(ensureCSS).observe(document.head, { childList: true });
            });
        } else if (document.head) {
            new MutationObserver(ensureCSS).observe(document.head, { childList: true });
        }
    })();

    // =========================================================================
    //  Layer 3: Ad Skip Logic
    // =========================================================================

    function setupAdSkip() {
        if (!config.adSkipFallback) return;

        const SKIP_SELECTORS = [
            '.ytp-ad-skip-button',
            '.ytp-ad-skip-button-modern',
            '.ytp-skip-ad-button',
            'button[id^="skip-button"]',
            '.videoAdUiSkipButton',
            '.ytp-ad-overlay-close-button',
        ];

        let adActive = false;
        let userVolume = 1;
        let cachedPlayer = null;
        let pollTimer = null;

        function getPlayer() {
            if (cachedPlayer && cachedPlayer.isConnected) return cachedPlayer;
            cachedPlayer = document.querySelector('.html5-video-player');
            return cachedPlayer;
        }

        function showOverlay() {
            const player = getPlayer();
            if (!player || document.getElementById('rat-ad-overlay')) return;
            const overlay = document.createElement('div');
            overlay.id = 'rat-ad-overlay';
            const spinner = document.createElement('div');
            spinner.className = 'rat-spinner';
            overlay.appendChild(spinner);
            player.appendChild(overlay);
        }

        function hideOverlay() {
            const el = document.getElementById('rat-ad-overlay');
            if (el) el.remove();
        }

        function forceSkipAd() {
            // 1. Click skip buttons (try all, don't return early)
            for (const sel of SKIP_SELECTORS) {
                const btn = document.querySelector(sel);
                if (btn) btn.click();
            }

            // 2. YouTube internal player API
            const mp = document.getElementById('movie_player');
            if (mp) {
                try { mp.skipAd?.(); } catch {}
                try { mp.cancelPlayback?.(); } catch {}
                try {
                    if (mp.getVideoData?.()?.isAd) mp.nextVideo?.();
                } catch {}
            }

            // 3. Force video to end
            const video = document.querySelector('video');
            if (video?.duration && isFinite(video.duration) && video.currentTime < video.duration) {
                video.currentTime = video.duration;
            }
        }

        function trySkipAd() {
            const player = getPlayer();
            if (!player) return;

            const isAd = player.classList.contains('ad-showing');

            if (isAd && !adActive) {
                adActive = true;
                const video = document.querySelector('video');
                if (video) {
                    userVolume = video.volume;
                    video.muted = true;
                }
                showOverlay();
                log('Layer 3: Ad detected');
            }

            if (!isAd && adActive) {
                adActive = false;
                const video = document.querySelector('video');
                if (video) {
                    video.muted = false;
                    video.volume = userVolume;
                    video.playbackRate = 1;
                }
                setTimeout(() => {
                    const p = getPlayer();
                    if (!p || !p.classList.contains('ad-showing')) {
                        hideOverlay();
                        document.querySelector('video')?.play()?.catch(() => {});
                    }
                }, 300);
                log('Layer 3: Ad ended');
                return;
            }

            if (!isAd) return;

            document.querySelector('video')?.muted === false &&
                (document.querySelector('video').muted = true);

            forceSkipAd();
        }

        // Observe player class changes
        const observer = new MutationObserver(trySkipAd);

        function attachToPlayer() {
            const player = getPlayer();
            if (!player) return false;
            observer.observe(player, { attributes: true, attributeFilter: ['class'] });
            log('Layer 3: Attached to player');
            trySkipAd();
            return true;
        }

        // Wait for player, then attach
        if (!attachToPlayer()) {
            const wait = setInterval(() => {
                if (attachToPlayer()) clearInterval(wait);
            }, 200);
        }

        // Backup polling — only active during ads to save CPU
        function startPolling() {
            if (pollTimer) return;
            pollTimer = setInterval(trySkipAd, 100);
        }
        function stopPolling() {
            if (pollTimer) {
                clearInterval(pollTimer);
                pollTimer = null;
            }
        }

        // Always run a slow poll to detect ads (even if MutationObserver misses)
        setInterval(() => {
            const player = getPlayer();
            if (!player) return;
            if (player.classList.contains('ad-showing')) {
                startPolling();
                trySkipAd();
            } else if (pollTimer && !adActive) {
                stopPolling();
            }
        }, 500);

        log('Layer 3: Ad skip initialized');
    }

    // =========================================================================
    //  Layer 4: Anti-Detection Bypass
    // =========================================================================

    if (config.antiDetection) {
        try {
            Object.defineProperty(Object.prototype, 'adBlocksFound', {
                get() { return 0; },
                set() {},
                configurable: true,
            });
            Object.defineProperty(Object.prototype, 'hasAllowedInstreamAd', {
                get() { return true; },
                set() {},
                configurable: true,
            });
            log('Layer 4: Anti-detection flags installed');
        } catch (e) {
            log('Layer 4: Failed', 'warn', e);
        }

        function removePopups() {
            const selectors = [
                'tp-yt-iron-overlay-backdrop',
                'ytd-enforcement-message-view-model',
                '#enforcement-message',
            ];
            for (const sel of selectors) {
                const el = document.querySelector(sel);
                if (el) {
                    el.remove();
                    log('Layer 4: Removed popup');
                }
            }
            document.body?.style?.setProperty('overflow-y', 'auto', 'important');
            document.getElementById('dismiss-button')?.click();
        }

        function setupPopupRemoval() {
            // Only observe the popup container, not the entire body
            const container = document.querySelector('ytd-popup-container') || document.body;
            new MutationObserver(removePopups).observe(container, { childList: true, subtree: true });
            log('Layer 4: Popup observer active');
        }

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', setupPopupRemoval);
        } else {
            setupPopupRemoval();
        }
    }

    // =========================================================================
    //  Layer 6: Video Downloader
    // =========================================================================

    function setupDownloader() {
        if (!config.downloader) return;

        const PANEL_ID = 'rat-download-panel';

        function getVideoId() {
            return new URLSearchParams(window.location.search).get('v');
        }
 
        function getApiKey() {
            try { return window.ytcfg?.get?.('INNERTUBE_API_KEY') || window.ytcfg?.data_?.INNERTUBE_API_KEY; } catch {}
            try {
                const match = document.documentElement.innerHTML.match(/"INNERTUBE_API_KEY":"([^"]+)"/);
                return match?.[1];
            } catch {}
            return null;
        }
 
        function getVisitorData() {
            try { return window.ytcfg?.get?.('VISITOR_DATA') || window.ytcfg?.data_?.VISITOR_DATA; } catch {}
            return null;
        }
 
        function formatBytes(bytes) {
            if (!bytes) return '';
            const n = parseInt(bytes, 10);
            if (n > 1073741824) return (n / 1073741824).toFixed(1) + ' GB';
            if (n > 1048576) return (n / 1048576).toFixed(0) + ' MB';
            return (n / 1024).toFixed(0) + ' KB';
        }
 
        function randomStr(len) {
            return Array.from({ length: len }, () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[Math.random() * 62 | 0]).join('');
        }
 
        // Fetch streams via ANDROID Innertube API (returns direct URLs)
        async function fetchAndroidStreams(videoId) {
            const apiKey = getApiKey();
            if (!apiKey) { log('Layer 6: No API key found', 'warn'); return null; }
 
            // Get visitorData (from page or fetch new)
            let visitorData = getVisitorData();
            if (!visitorData) {
                try {
                    const vResp = await fetch(`https://youtubei.googleapis.com/youtubei/v1/visitor_id?prettyPrint=false&key=${apiKey}`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            context: { client: { clientName: 'ANDROID', clientVersion: '21.03.36', platform: 'MOBILE', osName: 'Android', osVersion: '16', androidSdkVersion: 36, hl: 'en', gl: 'US' } }
                        }),
                    });
                    const vJson = await vResp.json();
                    visitorData = vJson?.responseContext?.visitorData;
                    log('Layer 6: Fetched visitorData');
                } catch (e) {
                    log('Layer 6: visitor_id fetch failed', 'warn', e);
                }
            }
 
            // Call player endpoint
            try {
                const resp = await fetch(
                    `https://youtubei.googleapis.com/youtubei/v1/player?prettyPrint=false&key=${apiKey}&t=${randomStr(12)}&id=${videoId}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        context: {
                            client: {
                                clientName: 'ANDROID',
                                clientVersion: '21.03.36',
                                clientScreen: 'WATCH',
                                platform: 'MOBILE',
                                osName: 'Android',
                                osVersion: '16',
                                androidSdkVersion: 36,
                                hl: 'en',
                                gl: 'US',
                                utcOffsetMinutes: 0,
                                ...(visitorData && { visitorData }),
                            },
                        },
                        videoId,
                        cpn: randomStr(16),
                        contentCheckOk: true,
                        racyCheckOk: true,
                    }),
                });
                const json = await resp.json();
                if (json?.playabilityStatus?.status === 'OK' && json?.streamingData) {
                    log('Layer 6: ANDROID API success — streams available');
                    return json;
                }
                log('Layer 6: ANDROID API status: ' + json?.playabilityStatus?.status, 'warn');
            } catch (e) {
                log('Layer 6: ANDROID player fetch failed', 'warn', e);
            }
            return null;
        }
 
        function parseStreams(data) {
            if (!data?.streamingData) return { combined: [], videoOnly: [], audioOnly: [] };
            const combined = [], videoOnly = [], audioOnly = [];
 
            for (const f of data.streamingData.formats || []) {
                if (!f.url) continue;
                combined.push({
                    url: f.url, quality: f.qualityLabel || '?',
                    mimeType: f.mimeType || '', size: formatBytes(f.contentLength),
                    height: f.height, type: 'combined',
                });
            }
            for (const f of data.streamingData.adaptiveFormats || []) {
                if (!f.url) continue;
                const mime = f.mimeType || '';
                if (mime.startsWith('video/')) {
                    videoOnly.push({
                        url: f.url, quality: f.qualityLabel || `${f.height}p`,
                        mimeType: mime, size: formatBytes(f.contentLength),
                        height: f.height, fps: f.fps, type: 'video',
                    });
                } else if (mime.startsWith('audio/')) {
                    audioOnly.push({
                        url: f.url, quality: f.audioQuality?.replace('AUDIO_QUALITY_', '') || '?',
                        mimeType: mime, size: formatBytes(f.contentLength),
                        bitrate: f.bitrate, type: 'audio',
                    });
                }
            }
            videoOnly.sort((a, b) => (b.height || 0) - (a.height || 0));
            audioOnly.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
            combined.sort((a, b) => (b.height || 0) - (a.height || 0));
            return { combined, videoOnly, audioOnly };
        }
 
        function createButton(label, sublabel, onClick) {
            const btn = document.createElement('button');
            btn.className = 'rat-dl-btn';
            const l = document.createElement('span');
            l.textContent = label;
            btn.appendChild(l);
            if (sublabel) {
                const s = document.createElement('span');
                s.className = 'rat-dl-size';
                s.textContent = sublabel;
                btn.appendChild(s);
            }
            btn.addEventListener('click', onClick);
            return btn;
        }
 
        function createSection(titleText) {
            const sec = document.createElement('div');
            sec.className = 'rat-dl-section';
            const t = document.createElement('div');
            t.className = 'rat-dl-section-title';
            t.textContent = titleText;
            sec.appendChild(t);
            return sec;
        }
 
        async function renderPanel() {
            document.getElementById(PANEL_ID)?.remove();
            if (!window.location.pathname.startsWith('/watch')) return;
 
            const videoId = getVideoId();
            if (!videoId) return;
 
            // Show loading state
            const target = document.querySelector('#above-the-fold') ||
                           document.querySelector('#below') ||
                           document.querySelector('ytd-watch-metadata');
            if (!target) return;
 
            const panel = document.createElement('div');
            panel.id = PANEL_ID;
 
            const header = document.createElement('div');
            header.className = 'rat-dl-header';
            const headerTitle = document.createElement('span');
            headerTitle.textContent = 'Download';
            header.appendChild(headerTitle);
 
            const toggle = document.createElement('button');
            toggle.className = 'rat-dl-toggle';
            toggle.textContent = '▾';
            toggle.addEventListener('click', () => {
                const b = panel.querySelector('.rat-dl-body');
                const hidden = b.style.display === 'none';
                b.style.display = hidden ? '' : 'none';
                toggle.textContent = hidden ? '▾' : '▸';
            });
            header.appendChild(toggle);
            panel.appendChild(header);
 
            const body = document.createElement('div');
            body.className = 'rat-dl-body';
 
            const loadingHint = document.createElement('div');
            loadingHint.className = 'rat-dl-hint';
            loadingHint.textContent = 'Fetching streams...';
            body.appendChild(loadingHint);
            panel.appendChild(body);
            target.parentNode.insertBefore(panel, target.nextSibling);
 
            // Fetch ANDROID streams
            const data = await fetchAndroidStreams(videoId);
            loadingHint.remove();
 
            if (data) {
                const { combined, videoOnly, audioOnly } = parseStreams(data);
 
                if (combined.length > 0) {
                    const sec = createSection('Video + Audio');
                    for (const s of combined) {
                        sec.appendChild(createButton(
                            `${s.quality} (MP4)`, s.size,
                            () => { log(`Layer 6: Download ${s.quality}`); window.open(s.url, '_blank'); }
                        ));
                    }
                    body.appendChild(sec);
                }
            } 
            log('Layer 6: Download panel rendered');
        }
 
        let lastVideoId = null;
 
        function tryRender(retries = 20) {
            if (!window.location.pathname.startsWith('/watch')) {
                // Not a watch page — remove panel if present
                document.getElementById(PANEL_ID)?.remove();
                lastVideoId = null;
                return;
            }
 
            const currentId = new URLSearchParams(window.location.search).get('v');
 
            // Same video, panel already exists — skip
            if (currentId === lastVideoId && document.getElementById(PANEL_ID)) return;
 
            // Different video or no panel — remove old and re-render
            document.getElementById(PANEL_ID)?.remove();
            lastVideoId = currentId;
 
            const target = document.querySelector('#above-the-fold, #below, ytd-watch-metadata');
            if (target) renderPanel();
            else if (retries > 0) setTimeout(() => tryRender(retries - 1), 500);
        }
 
        tryRender();
        document.addEventListener('yt-navigate-finish', () => {
            lastVideoId = null; // Force re-render on navigation
            setTimeout(tryRender, 1000);
        });
        log('Layer 6: Downloader initialized');
    }

    // =========================================================================
    //  SPA Navigation Support
    // =========================================================================

    function onReady(fn) {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', fn);
        } else {
            fn();
        }
    }

    onReady(() => {
        setupAdSkip();
        setupDownloader();

        document.addEventListener('yt-navigate-finish', () => {
            log('SPA navigation detected');
        });
    });

    // =========================================================================
    //  Update Checker
    // =========================================================================

    if (config.updateCheck) {
        const SCRIPT_URL =
            'https://raw.githubusercontent.com/RuffaloLavoisier/mypipe/main/Youtube-Ad-blocker-Reminder-Remover.user.js';

        onReady(() => {
            setTimeout(() => {
                if (window.top !== window.self) return;

                // Use original fetch to avoid going through our proxy
                const doFetch = window._origFetch || window.fetch;
                doFetch(SCRIPT_URL)
                    .then(r => r.text())
                    .then(data => {
                        const match = data.match(/@version\s+(\d+\.\d+)/);
                        if (!match) return;
                        const remote = parseFloat(match[1]);
                        const local = parseFloat(
                            typeof GM_info !== 'undefined' ? GM_info.script.version : '6.1'
                        );
                        if (remote > local) {
                            log(`Update available: ${local} → ${remote}`, 'warn');
                            if (confirm(`Remove Adblock Thing: v${remote} available. Update?`)) {
                                window.location.replace(SCRIPT_URL);
                            }
                        }
                    })
                    .catch(() => {});
            }, 10000);
        });
    }

    log('All layers initialized');
})();
