// ==UserScript==
// @name         Remove Adblock Thing
// @namespace    http://tampermonkey.net/
// @version      6.1
// @description  Removes YouTube ads and adblock detection popups using multi-layer blocking
// @author       JoelMatic
// @match        https://www.youtube.com/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=youtube.com
// @updateURL    https://github.com/TheRealJoelmatic/RemoveAdblockThing/raw/main/Youtube-Ad-blocker-Reminder-Remover.user.js
// @downloadURL  https://github.com/TheRealJoelmatic/RemoveAdblockThing/raw/main/Youtube-Ad-blocker-Reminder-Remover.user.js
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

    log('Script started (v6.1)');

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

        // Use YouTube's own navigation event instead of MutationObserver on body
        document.addEventListener('yt-navigate-finish', () => {
            log('SPA navigation detected');
        });
    });

    // =========================================================================
    //  Update Checker
    // =========================================================================

    if (config.updateCheck) {
        const SCRIPT_URL =
            'https://raw.githubusercontent.com/TheRealJoelmatic/RemoveAdblockThing/main/Youtube-Ad-blocker-Reminder-Remover.user.js';

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
