/* Bili+ 信息流净化器 —— 内容脚本 */
'use strict'

;(function () {
  // 首页 pathname 可能是 / 或 /index.html，query 参数（如 ?back=...）不影响判断。
  // 其余 B 站页面也会加载本脚本，但只保留抓取会话能力，不执行信息流净化。
  // B 站是 SPA，视频页切回首页时 pathname 会变化，因此需要动态切换模式。
  let captureOnly = !isHomePath(location.pathname)

  function isHomePath(pathname) {
    return /^\/(?:index\.html?)?$/.test(pathname)
  }

  const CAROUSEL_SELECTOR = '.recommended-swipe, [class^="recommended-swipe"]'
  // 首页存在两套卡片结构：常规视频流用 feed-card / bili-video-card，
  // 直播与番剧「楼层卡」用 floor-card，二者互不通用
  const CARD_SELECTOR = '.feed-card, .bili-feed-card, .floor-card'
  // 楼层卡的外层包裹：内部卡片全部隐藏后它会留下空白，需要一起收起
  const FLOOR_WRAP_SELECTOR = '.floor-single-card'
  const EXCLUDED_LINK_SELECTOR = 'a[href*="live.bilibili.com/"], a[href*="/bangumi/"]'
  // 直播 / 番剧封面图的 CDN 路径特征：卡片没有可用链接时靠它兜底
  const EXCLUDED_IMG_SELECTOR = [
    'img[src*="/bfs/live/"]',
    'img[src*="/bfs/live-key-frame/"]',
    'img[src*="user_cover"]',
    'img[src*="/bfs/bangumi/"]'
  ].join(', ')
  // 站点自身控件：右侧悬浮的自动播放 / 刷新 / 更多 / 回到顶部，绝不动
  const PROTECTED_SELECTOR = [
    '.palette-button-wrap',
    '.palette-button-outer',
    '.palette-button-inner',
    '.flexible-roll-btn',
    '.flexible-roll-btn-inner',
    '.feed-roll-btn',
    '[class*="feed-roll"]',
    '.primary-btn',
    '.roll-btn',
    '[class*="palette-button"]',
    '[class*="roll-btn"]',
    '[class*="back-to-top"]',
    '[class*="toTop"]'
  ].join(', ')
  const AD_URL_MARKERS = [
    'cid-click.',
    'cm.bilibili.com',
    'impression.biligame.com',
    'linked_creative_id='
  ]

  let settings = Object.assign({}, DEFAULT_SETTINGS)
  let pendingStats = { ads: 0, carousel: 0, sponsor: 0, contentType: 0, blacklist: 0 }
  let saveTimer = null
  let purgeTimer = null
  let observer = null
  let capture = createCaptureState()
  const MAX_CAPTURE_EVENTS = 240

  let styleEl = null
  if (!captureOnly) {
    styleEl = document.createElement('style')
    styleEl.id = 'bili-purifier-style'
    ;(document.head || document.documentElement).appendChild(styleEl)
    syncStyle()
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.type !== 'biliPurifierCapture') return false

    if (message.action === 'start') {
      beginCapture()
      sendResponse({ ok: true, startedAt: capture.startedAt })
      return false
    }

    if (message.action === 'stop') {
      sendResponse({ ok: true, report: endCapture() })
      return false
    }

    return false
  })
  chrome.storage.local.get(['settings', 'captureSession'], (res) => {
    if (res && res.settings) settings = Object.assign({}, DEFAULT_SETTINGS, res.settings)
    if (res && res.captureSession && res.captureSession.active) {
      beginCapture(res.captureSession.startedAt, true)
    }
    if (!captureOnly) syncStyle()
    whenReady(() => {
      if (captureOnly) {
        startObserver()
      } else {
        purge()
        startObserver()
      }
    })
  })

  function handleNavigation() {
    const nowHome = isHomePath(location.pathname)
    if (nowHome === !captureOnly) return

    captureOnly = !nowHome
    if (nowHome) {
      if (!styleEl) {
        styleEl = document.createElement('style')
        styleEl.id = 'bili-purifier-style'
        ;(document.head || document.documentElement).appendChild(styleEl)
      }
      syncStyle()
      purge()
    }
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return
    if (changes.settings) {
      settings = Object.assign({}, DEFAULT_SETTINGS, changes.settings.newValue)
      if (!captureOnly) {
        syncStyle()
        purge()
      }
    }
    if (changes.purgeNow && !captureOnly) purge()
  })

  window.addEventListener('popstate', handleNavigation)
  window.addEventListener('hashchange', handleNavigation)

  function whenReady(fn) {
    if (document.body) fn()
    else document.addEventListener('DOMContentLoaded', fn, { once: true })
  }

  function syncStyle() {
    const rules = []
    if (settings.enabled !== false) {
      // B 站会给右侧「刷新内容」控件加 hidden 类；它仍在 DOM 中却不可见。
      // 仅恢复这个控件的可见性，避免把其他站点控件一并强制显示。
      rules.push(
        '.flexible-roll-btn, .feed-roll-btn { pointer-events: auto !important; position: relative; z-index: 2; }',
        '.flexible-roll-btn.hidden, .flexible-roll-btn.hidden .flexible-roll-btn-inner { visibility: visible !important; pointer-events: auto !important; }'
      )
    }
    if (settings.enabled !== false && settings.removeCarousel) {
      // B 站给轮播用过 recommended-swipe / recommended-swipe-body-normal 等变体，统一按前缀匹配
      rules.push('.recommended-swipe, [class^="recommended-swipe"] { display: none !important; }')
    }
    if (settings.enabled !== false && settings.removeContentTypes) {
      const inner = EXCLUDED_LINK_SELECTOR + ', ' + EXCLUDED_IMG_SELECTOR
      const hosts = ['.feed-card', '.bili-feed-card', '.bili-video-card', '.floor-card']
      // 与 isSafeToRemove() 保持一致：内部含站点控件的容器不隐藏，
      // 否则会连带藏掉信息流网格里的蓝色「换一换」按钮
      rules.push(
        hosts
          .map((host) => host + ':has(' + inner + '):not(:has(' + PROTECTED_SELECTOR + '))')
          .join(', ') + ' { display: none !important; }'
      )
    }
    styleEl.textContent = rules.join('\n')
  }

  function startObserver() {
    if (observer) return
    observer = new MutationObserver((mutations) => {
      recordCaptureEvent(mutations)
      handleNavigation()
      if (captureOnly) return
      clearTimeout(purgeTimer)
      purgeTimer = setTimeout(purge, 120)
    })
    observer.observe(document.body, { childList: true, subtree: true })
  }

  function purge() {
    if (settings.enabled === false) return

    if (settings.removeCarousel) {
      document.querySelectorAll(CAROUSEL_SELECTOR).forEach((el) => {
        if (el.__biliPurged) return
        // 前缀匹配会同时命中轮播的父子容器，只处理最外层：
        // 既避免一个轮播被计数多次，也省掉多余的内联样式
        if (el.parentElement && el.parentElement.closest(CAROUSEL_SELECTOR)) return
        hideCard(el)
        bump('carousel')
      })
    }

    document.querySelectorAll(CARD_SELECTOR).forEach((card) => {
      if (!card.isConnected || card.__biliPurged) return
      if (!isSafeToRemove(card)) return
      const reason = classify(card)
      if (!reason) return
      hideCard(card)
      bump(reason)
    })

    if (settings.removeContentTypes) {
      document.querySelectorAll(EXCLUDED_LINK_SELECTOR + ', ' + EXCLUDED_IMG_SELECTOR).forEach((node) => {
        const card = findCardContainer(node)
        if (!card || card.__biliPurged) return
        hideCard(card)
        bump('contentType')
      })
    }

    collapseEmptyFloorWraps()
  }

  function createCaptureState() {
    return { active: false, startedAt: null, events: [], snapshots: [], droppedEvents: 0 }
  }

  function beginCapture(startedAt, restoring) {
    capture = {
      active: true,
      startedAt: startedAt || new Date().toISOString(),
      events: [],
      snapshots: [captureSnapshot()],
      droppedEvents: 0
    }
    if (!restoring) {
      chrome.storage.local.set({ captureSession: { active: true, startedAt: capture.startedAt } })
    }
  }

  function endCapture() {
    if (!capture.active) return null
    const endedAt = new Date().toISOString()
    capture.snapshots.push(captureSnapshot())
    const report = {
      type: 'bili-purifier-capture',
      version: 1,
      startedAt: capture.startedAt,
      endedAt: endedAt,
      durationMs: Math.max(0, Date.parse(endedAt) - Date.parse(capture.startedAt)),
      url: location.href,
      snapshots: capture.snapshots,
      events: capture.events,
      eventCount: capture.events.length,
      droppedEvents: capture.droppedEvents
    }
    capture = createCaptureState()
    chrome.storage.local.set({ captureSession: { active: false, endedAt: endedAt } })
    return report
  }

  function recordCaptureEvent(mutations) {
    if (!capture.active || !mutations.length) return
    const event = {
      time: new Date().toISOString(),
      mutationCount: mutations.length,
      addedNodes: mutations.reduce((sum, mutation) => sum + mutation.addedNodes.length, 0),
      removedNodes: mutations.reduce((sum, mutation) => sum + mutation.removedNodes.length, 0),
      targets: Array.from(new Set(mutations.map((mutation) => describeNode(mutation.target))))
        .filter(Boolean)
        .slice(0, 12)
    }
    if (capture.events.length >= MAX_CAPTURE_EVENTS) {
      capture.droppedEvents += 1
      return
    }
    capture.events.push(event)
  }

  function captureSnapshot() {
    return {
      time: new Date().toISOString(),
      url: location.href,
      readyState: document.readyState,
      viewport: window.innerWidth + 'x' + window.innerHeight,
      counts: {
        feedCards: document.querySelectorAll(CARD_SELECTOR).length,
        excludedNodes: document.querySelectorAll(EXCLUDED_LINK_SELECTOR + ', ' + EXCLUDED_IMG_SELECTOR).length,
        purifiedNodes: document.querySelectorAll('[data-bili-purified="1"]').length,
        protectedControls: document.querySelectorAll(PROTECTED_SELECTOR).length
      }
    }
  }

  function describeNode(node) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return null
    return {
      tag: node.tagName.toLowerCase(),
      id: node.id || null,
      className: typeof node.className === 'string' ? node.className.slice(0, 160) : null
    }
  }

  // 楼层卡被逐个隐藏后，外层包裹仍占位并留下大片空白，
  // 只有当它内部所有卡片都已隐藏时才收起，避免误伤混排楼层
  function collapseEmptyFloorWraps() {
    document.querySelectorAll(FLOOR_WRAP_SELECTOR).forEach((wrap) => {
      if (!isSafeToRemove(wrap)) return
      const cards = wrap.querySelectorAll('.floor-card')
      if (!cards.length) return
      // CSS 规则命中的卡片没有 __biliPurged 标记，需要看实际计算样式
      const allHidden = Array.from(cards).every(
        (c) => c.__biliPurged || getComputedStyle(c).display === 'none'
      )
      if (allHidden) {
        wrap.style.setProperty('display', 'none', 'important')
        wrap.setAttribute('data-bili-purified', '1')
      } else if (wrap.getAttribute('data-bili-purified') === '1') {
        // 楼层内又插入了新卡片，恢复显示
        wrap.style.removeProperty('display')
        wrap.removeAttribute('data-bili-purified')
      }
    })
  }

  // 隐藏而非删除：不破坏 B 站自身的列表结构与滚动/刷新逻辑
  function hideCard(card) {
    card.__biliPurged = true
    card.setAttribute('data-bili-purified', '1')
    card.style.setProperty('display', 'none', 'important')
  }

  function findCardContainer(element) {
    const card =
      element.closest('.floor-card') ||
      element.closest('.feed-card, .bili-feed-card, [class*="feed-card"]') ||
      element.closest('.bili-video-card, [class*="video-card"]')
    return isSafeToRemove(card) ? card : null
  }

  // 命中站点控件（或包含控件）的节点一律放行
  function isSafeToRemove(el) {
    if (!el || el === document.body || el === document.documentElement) return false
    if (el.closest(PROTECTED_SELECTOR)) return false
    if (el.querySelector(PROTECTED_SELECTOR)) return false
    return true
  }

  function classify(card) {
    // 楼层卡（直播/番剧）内部没有 .bili-video-card，不能用它作为准入条件
    const isFloorCard = card.classList.contains('floor-card')
    if (!isFloorCard && !card.querySelector('.bili-video-card')) return null
    if (settings.removeAds && isAdCard(card)) return 'ads'
    if (settings.removeContentTypes && isExcludedContentType(card)) return 'contentType'
    if (settings.removeBlacklist && isBlacklisted(card)) return 'blacklist'
    if (settings.removeSponsor && isSponsor(card)) return 'sponsor'
    return null
  }

  function isExcludedContentType(card) {
    if (hasExcludedContentUrl(card)) return true

    const keywords = toList(settings.contentTypeKeywords)
    if (!keywords.length) return false
    const badgeNodes = card.querySelectorAll(
      '[class*="badge"], [class*="tag"], [class*="type"], [class*="corner"], [class*="label"], .bili-video-card__image--wrap'
    )
    return Array.from(badgeNodes).some((node) => {
      const text = node.textContent.trim()
      return keywords.some((keyword) => keyword && text.includes(keyword))
    })
  }

  function hasExcludedContentUrl(card) {
    if (card.querySelector(EXCLUDED_IMG_SELECTOR)) return true
    return Array.from(card.querySelectorAll('a[href]')).some((anchor) => {
      try {
        const url = new URL(anchor.href)
        return url.hostname === 'live.bilibili.com' || url.pathname.startsWith('/bangumi/')
      } catch (e) {
        return false
      }
    })
  }

  function isAdCard(card) {
    const statTexts = Array.from(card.querySelectorAll('.bili-video-card__stats--text'))
      .map((el) => el.textContent.trim())
    if (statTexts.includes('广告')) return true

    const hrefs = Array.from(card.querySelectorAll('a[href]')).map((a) => a.href)
    return hrefs.some((href) => isLikelyAdHref(href))
  }

  function isLikelyAdHref(href) {
    if (!href) return false
    if (AD_URL_MARKERS.some((marker) => href.includes(marker))) return true
    if (href.includes('creative_id=') && href.includes('track_id=')) return true
    try {
      const url = new URL(href)
      if (url.protocol === 'http:' || url.protocol === 'https:') {
        if (!/(^|\.)bilibili\.com$/.test(url.hostname)) return true
      }
    } catch (e) {
      /* 忽略无法解析的地址 */
    }
    return false
  }

  function isSponsor(card) {
    const keywords = toList(settings.sponsorKeywords)
    if (!keywords.length) return false
    const titleEl = card.querySelector('.bili-video-card__info--tit')
    const authorEl = card.querySelector('.bili-video-card__info--author')
    const badgeEl = card.querySelector('.bili-video-card__info--rcmd-text')
    const parts = [titleEl, authorEl, badgeEl]
      .filter(Boolean)
      .map((el) => el.textContent)
      .join(' ')
    return keywords.some((keyword) => keyword && parts.includes(keyword))
  }

  function isBlacklisted(card) {
    const uids = toList(settings.blacklistUids)
    if (!uids.length) return false
    const owner = card.querySelector('.bili-video-card__info--owner[href*="space.bilibili.com"]')
    const href = owner ? owner.getAttribute('href') : ''
    const match = href ? href.match(/space\.bilibili\.com\/(\d+)/) : null
    return !!(match && uids.includes(match[1]))
  }

  // storage 里的值可能被旧版本写坏或写成非数组，统一兜底
  function toList(value) {
    return Array.isArray(value) ? value : []
  }

  function bump(key) {
    pendingStats[key] += 1
    clearTimeout(saveTimer)
    saveTimer = setTimeout(saveStats, 500)
  }

  function saveStats() {
    const additions = pendingStats
    pendingStats = { ads: 0, carousel: 0, sponsor: 0, contentType: 0, blacklist: 0 }
    if (!Object.values(additions).some(Boolean)) return

    chrome.storage.local.get(['stats'], (res) => {
      const base = (res && res.stats) || {}
      const merged = Object.assign({}, base)
      Object.keys(additions).forEach((key) => {
        if (!additions[key]) return
        merged[key] = (Number(base[key]) || 0) + additions[key]
      })
      chrome.storage.local.set({ stats: merged })
    })
  }
})()
