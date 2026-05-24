import type { Userscript } from './types';

export const DEFAULT_BUILTIN_USERSCRIPTS: Userscript[] = [
  {
    id: 'yt-adblock-builtin',
    name: 'YouTube Adblocker (Built-in)',
    match: '*://*.youtube.com/*',
    enabled: true,
    code: `(function() {
    function removeAds(data) {
        if (!data) return data;
        if (data.adPlacements) delete data.adPlacements;
        if (data.playerAds) delete data.playerAds;
        if (data.playabilityStatus?.errorScreen) delete data.playabilityStatus.errorScreen;
        return data;
    }
    let _ytInitialPlayerResponse = removeAds(window.ytInitialPlayerResponse);
    Object.defineProperty(window, 'ytInitialPlayerResponse', {
        get: () => _ytInitialPlayerResponse,
        set: (val) => { _ytInitialPlayerResponse = removeAds(val); }
    });
    const originalFetch = window.fetch;
    window.fetch = async function() {
        const response = await originalFetch.apply(this, arguments);
        const url = arguments[0]?.url || arguments[0] || '';
        if (typeof url === 'string' && url.includes('/youtubei/v1/player')) {
            const clone = response.clone();
            const text = await clone.text();
            try {
                const data = JSON.parse(text);
                return new Response(JSON.stringify(removeAds(data)), {
                    status: response.status, statusText: response.statusText, headers: response.headers
                });
            } catch(e) {}
        }
        return response;
    };
    setInterval(() => {
        const ad = document.querySelector('.ad-showing video');
        if (ad && !isNaN(ad.duration)) ad.currentTime = ad.duration;
        const skip = document.querySelector('.ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-skip-ad-button');
        if (skip) skip.click();
        const banners = document.querySelectorAll('ytd-ad-slot-renderer, ytd-promoted-sparkles-web-renderer, #masthead-ad');
        banners.forEach(b => b.remove());
    }, 100);
})();`,
  },
  {
    id: 'zhihu-clean-builtin',
    name: 'Zhihu Cleaner (Built-in)',
    match: '*://*.zhihu.com/*',
    enabled: true,
    code: `(function() {
    const style = document.createElement('style');
    style.innerHTML = '.signFlowModal, .Modal-wrapper { display: none !important; } html, body { overflow: auto !important; } .TopstoryItem--advertCard, .Pc-card, .Pc-word, .AdblockBanner { display: none !important; }';
    document.head.appendChild(style);
    setInterval(() => {
        const expandBtns = document.querySelectorAll('.ContentItem-expandButton');
        expandBtns.forEach(btn => { if(btn.innerText.includes('阅读全文') || btn.innerText.includes('展开详细')) btn.click(); });
        const closeBtn = document.querySelector('.Modal-closeButton');
        if(closeBtn) closeBtn.click();
    }, 1000);
})();`,
  },
  {
    id: 'bilibili-clean-builtin',
    name: 'Bilibili Cleaner (Built-in)',
    match: '*://*.bilibili.com/*',
    enabled: true,
    code: `(function() {
    const style = document.createElement('style');
    style.innerHTML = '.ad-report, .bili-ad, #bannerAd, .ad-floor-cover, .pop-live-shim, .bpx-player-toast-wrap { display: none !important; }';
    document.head.appendChild(style);
})();`,
  },
  {
    id: 'twitter-clean-builtin',
    name: 'X/Twitter Cleaner (Built-in)',
    match: '*://*.x.com/*, *://*.twitter.com/*',
    enabled: true,
    code: `(function() {
    const style = document.createElement('style');
    style.innerHTML = '[data-testid="placementTracking"] { display: none !important; }';
    document.head.appendChild(style);
    setInterval(() => {
        document.querySelectorAll('[data-testid="cellInnerDiv"]').forEach(div => {
            if (div.innerText.includes('Promoted') || div.innerText.includes('赞助商') || div.innerText.includes('Who to follow')) {
                div.style.display = 'none';
            }
        });
    }, 500);
})();`,
  },
  {
    id: 'baidu-clean-builtin',
    name: 'Baidu Search Cleaner (Built-in)',
    match: '*://*.baidu.com/*',
    enabled: true,
    code: `(function() {
    const style = document.createElement('style');
    style.innerHTML = '#content_right, [data-tuiguang] { display: none !important; }';
    document.head.appendChild(style);
    setInterval(() => {
        document.querySelectorAll('.c-container, .result').forEach(div => {
            const html = div.innerHTML;
            if (html.includes('广告') || html.includes('商业推广') || div.getAttribute('data-tuiguang')) {
                div.style.display = 'none';
            }
        });
    }, 500);
})();`,
  },
];
