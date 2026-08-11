/* Bili+ 诊断脚本：在 B 站首页的 DevTools 控制台粘贴运行
 * 作用：抓取悬浮按钮的祖先链、计算样式、以及被本扩展规则命中的元素，
 *      导出 JSON（自动下载 + 复制到剪贴板），便于离线分析选择器失效原因。
 * 不修改页面，只读。 */
;(async function () {
  'use strict'

  const MAX_DEPTH = 8
  const PROTECTED = [
    '.palette-button-wrap', '.palette-button-outer', '.palette-button-inner',
    '.flexible-roll-btn', '.flexible-roll-btn-inner', '.feed-roll-btn', '[class*="feed-roll"]',
    '.primary-btn', '.roll-btn',
    '[class*="palette-button"]', '[class*="roll-btn"]', '[class*="back-to-top"]', '[class*="toTop"]'
  ].join(', ')
  const EXCLUDED_LINK = 'a[href*="live.bilibili.com/"], a[href*="/bangumi/"]'
  const EXCLUDED_IMG = [
    'img[src*="/bfs/live/"]', 'img[src*="/bfs/live-key-frame/"]',
    'img[src*="user_cover"]', 'img[src*="/bfs/bangumi/"]'
  ].join(', ')

  function desc(el) {
    if (!el || el.nodeType !== 1) return null
    const cs = getComputedStyle(el)
    const rect = el.getBoundingClientRect()
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      class: el.getAttribute('class') || null,
      display: cs.display,
      visibility: cs.visibility,
      opacity: cs.opacity,
      size: Math.round(rect.width) + 'x' + Math.round(rect.height),
      hiddenByUs: el.getAttribute('data-bili-purified') === '1',
      hiddenBySiteClass: el.classList.contains('hidden'),
      inlineDisplay: el.style.display || null,
      isProtected: el.matches(PROTECTED),
      hasExcludedInside: !!el.querySelector(EXCLUDED_LINK + ', ' + EXCLUDED_IMG)
    }
  }

  function chain(el) {
    const out = []
    let cur = el
    for (let i = 0; i < MAX_DEPTH && cur && cur !== document.documentElement; i++) {
      out.push(Object.assign({ depth: i }, desc(cur)))
      cur = cur.parentElement
    }
    return out
  }

  // 1. 找候选按钮：站点控件 + 任何看起来像悬浮圆钮的东西
  const buttonNodes = new Set()
  document.querySelectorAll(PROTECTED).forEach((n) => buttonNodes.add(n))
  document.querySelectorAll('svg, button').forEach((n) => {
    const r = n.getBoundingClientRect()
    if (r.width >= 24 && r.width <= 80 && r.height >= 24 && r.height <= 80) {
      const cs = getComputedStyle(n)
      const bg = cs.backgroundColor || ''
      // 蓝色系背景或位于视口右侧的小方钮
      if (/rgb\(\s*(0|1?\d?\d)\s*,\s*1[5-9]\d\s*,\s*2[0-5]\d/.test(bg) || r.left > innerWidth * 0.8) {
        buttonNodes.add(n)
      }
    }
  })

  const buttons = Array.from(buttonNodes).slice(0, 25).map((n) => ({
    self: desc(n),
    text: (n.textContent || '').trim().slice(0, 20) || null,
    ancestors: chain(n.parentElement)
  }))

  // 2. 本扩展 CSS 规则实际命中了哪些元素
  const hostSel = ['.feed-card', '.bili-feed-card', '.bili-video-card']
  const inner = EXCLUDED_LINK + ', ' + EXCLUDED_IMG
  const ruleSel = hostSel
    .map((h) => h + ':has(' + inner + '):not(:has(' + PROTECTED + '))')
    .join(', ')
  let cssMatches = []
  let cssError = null
  try {
    cssMatches = Array.from(document.querySelectorAll(ruleSel)).slice(0, 40).map(desc)
  } catch (e) {
    cssError = String(e)
  }

  // 3. 不带 :not 保护时会多命中什么（差集 = 被保护救回来的元素）
  const naiveSel = hostSel.map((h) => h + ':has(' + inner + ')').join(', ')
  let rescued = []
  try {
    const naive = new Set(document.querySelectorAll(naiveSel))
    const guarded = new Set(document.querySelectorAll(ruleSel))
    rescued = Array.from(naive).filter((n) => !guarded.has(n)).slice(0, 20).map((n) => ({
      self: desc(n),
      protectedInside: Array.from(n.querySelectorAll(PROTECTED)).slice(0, 5).map(desc),
      html: n.outerHTML.slice(0, 600)
    }))
  } catch (e) {
    cssError = cssError || String(e)
  }

  // 4. 注入的样式表内容 + 扩展设置
  const styleEl = document.getElementById('bili-purifier-style')
  const settings = await new Promise((resolve) => {
    try {
      chrome.storage.local.get(['settings'], (r) => resolve((r && r.settings) || null))
    } catch (e) { resolve('无法读取（需在扩展上下文）') }
  })

  const report = {
    meta: {
      url: location.href,
      time: new Date().toISOString(),
      viewport: innerWidth + 'x' + innerHeight,
      supportsHas: CSS.supports('selector(:has(a))'),
      styleInjected: !!styleEl
    },
    settings: settings,
    injectedCss: styleEl ? styleEl.textContent : null,
    generatedRule: ruleSel,
    cssError: cssError,
    counts: {
      feedCard: document.querySelectorAll('.feed-card').length,
      biliFeedCard: document.querySelectorAll('.bili-feed-card').length,
      biliVideoCard: document.querySelectorAll('.bili-video-card').length,
      purifiedByJs: document.querySelectorAll('[data-bili-purified="1"]').length,
      protectedFound: document.querySelectorAll(PROTECTED).length,
      cssMatched: cssMatches.length,
      rescuedByGuard: rescued.length
    },
    buttons: buttons,
    cssMatches: cssMatches,
    rescuedByGuard: rescued
  }

  const json = JSON.stringify(report, null, 2)
  console.log('%c[Bili+ 诊断]', 'color:#00a1d6;font-weight:bold', report)

  try {
    await navigator.clipboard.writeText(json)
    console.log('%c已复制到剪贴板，直接粘贴给我即可', 'color:#0f0')
  } catch (e) {
    console.warn('剪贴板不可用，请用下载的文件', e)
  }

  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url
  a.download = 'bili-purifier-diagnose.json'
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 5000)

  return report
})()
