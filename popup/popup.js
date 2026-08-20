/* Bili+ 信息流净化器 —— 弹窗逻辑 */
'use strict'

const CHECKBOX_FIELDS = ['enabled', 'removeCarousel', 'removeAds', 'removeContentTypes', 'removeSponsor', 'removeBlacklist']

let settings = Object.assign({}, DEFAULT_SETTINGS)
let stats = { ads: 0, carousel: 0, sponsor: 0, contentType: 0, blacklist: 0 }
let saveTimer = null
let captureTimer = null
let captureStartedAt = 0

init()

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.captureSession) renderCaptureState(changes.captureSession.newValue)
})

function init() {
  chrome.storage.local.get(['settings', 'stats', 'captureSession'], (res) => {
    if (res && res.settings) settings = Object.assign({}, DEFAULT_SETTINGS, res.settings)
    if (res && res.stats) stats = Object.assign(stats, res.stats)
    render()
    renderCaptureState(res && res.captureSession)
    bind()
  })
}

function render() {
  CHECKBOX_FIELDS.forEach((key) => {
    document.getElementById(key).checked = settings[key] !== false
  })
  renderStatus()
  document.getElementById('sponsorKeywords').value = listToText(settings.sponsorKeywords)
  document.getElementById('blacklistUids').value = listToText(settings.blacklistUids)
  renderStats()
}

function renderStatus() {
  const enabled = settings.enabled !== false
  const status = document.getElementById('purifierStatus')
  status.dataset.state = enabled ? 'on' : 'off'
  status.textContent = enabled ? '净化已开启' : '净化已暂停'
}

function renderStats() {
  const total = Object.values(stats).reduce((sum, value) => sum + (Number(value) || 0), 0)
  document.getElementById('statsTotal').textContent = total
  document.getElementById('stAds').textContent = Number(stats.ads) || 0
  document.getElementById('stCarousel').textContent = Number(stats.carousel) || 0
  document.getElementById('stSponsor').textContent = Number(stats.sponsor) || 0
  document.getElementById('stContentType').textContent = Number(stats.contentType) || 0
  document.getElementById('stBlacklist').textContent = Number(stats.blacklist) || 0
}

function collect() {
  CHECKBOX_FIELDS.forEach((key) => {
    settings[key] = document.getElementById(key).checked
  })
  settings.sponsorKeywords = parseList(document.getElementById('sponsorKeywords').value)
  settings.blacklistUids = parseList(document.getElementById('blacklistUids').value)
}

function parseList(text) {
  return text.split(/[\n,，、;；]+/).map((item) => item.trim()).filter(Boolean)
}

function listToText(value) {
  return Array.isArray(value) ? value.join('\n') : ''
}

function scheduleSave() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(saveSettings, 300)
}

function saveSettings(callback) {
  clearTimeout(saveTimer)
  collect()
  renderStatus()
  chrome.storage.local.set({ settings }, callback)
}

function bind() {
  CHECKBOX_FIELDS.forEach((key) => {
    document.getElementById(key).addEventListener('change', scheduleSave)
  })
  document.getElementById('sponsorKeywords').addEventListener('input', scheduleSave)
  document.getElementById('blacklistUids').addEventListener('input', scheduleSave)
  document.getElementById('purgeNow').addEventListener('click', () => {
    saveSettings(() => chrome.storage.local.set({ purgeNow: Date.now() }))
  })
  document.getElementById('resetStats').addEventListener('click', () => {
    chrome.storage.local.remove('stats')
    stats = { ads: 0, carousel: 0, sponsor: 0, contentType: 0, blacklist: 0 }
    renderStats()
  })
  document.getElementById('startCapture').addEventListener('click', startCapture)
  document.getElementById('stopCapture').addEventListener('click', stopCapture)
  document.getElementById('openSponsorSettings').addEventListener('click', () => {
    saveSettings(() => chrome.runtime.openOptionsPage())
  })
}

function renderCaptureState(session) {
  const active = Boolean(session && session.active)
  const state = document.getElementById('captureState')
  const start = document.getElementById('startCapture')
  const stop = document.getElementById('stopCapture')
  state.dataset.state = active ? 'active' : 'idle'
  state.textContent = active ? '抓取中' : '未开始'
  start.disabled = active
  stop.disabled = !active

  if (active) {
    captureStartedAt = Date.parse(session.startedAt) || Date.now()
    updateCaptureDuration()
    clearInterval(captureTimer)
    captureTimer = setInterval(updateCaptureDuration, 1000)
  } else {
    captureStartedAt = 0
    clearInterval(captureTimer)
    captureTimer = null
    document.getElementById('captureDuration').textContent = ''
  }
}

function updateCaptureDuration() {
  if (!captureStartedAt) return
  const seconds = Math.max(0, Math.floor((Date.now() - captureStartedAt) / 1000))
  const minutes = String(Math.floor(seconds / 60)).padStart(2, '0')
  const remainder = String(seconds % 60).padStart(2, '0')
  document.getElementById('captureDuration').textContent = '已持续 ' + minutes + ':' + remainder
}

function isBilibiliPage(url) {
  return /^https?:\/\/www\.bilibili\.com(?:\/|$)/.test(url || '')
}

function sendCaptureMessage(action) {
  return new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (chrome.runtime.lastError) return reject(chrome.runtime.lastError)
      const tab = tabs && tabs[0]
      if (!tab || !isBilibiliPage(tab.url)) return reject(new Error('请先切到 B 站页面'))
      chrome.tabs.sendMessage(tab.id, { type: 'biliPurifierCapture', action }, (response) => {
        if (chrome.runtime.lastError) reject(chrome.runtime.lastError)
        else resolve(response)
      })
    })
  })
}

async function startCapture() {
  const button = document.getElementById('startCapture')
  button.disabled = true
  hint('正在连接当前页面…')
  try {
    const response = await sendCaptureMessage('start')
    if (!response || !response.ok) throw new Error('页面未响应，请刷新当前 B 站页面后重试')
    renderCaptureState({ active: true, startedAt: response.startedAt })
    hint('已开始抓取；问题复现后点击“结束并导出”')
  } catch (error) {
    button.disabled = false
    hint(error.message || String(error), true)
  }
}

async function stopCapture() {
  const button = document.getElementById('stopCapture')
  button.disabled = true
  hint('正在整理抓取报告…')
  try {
    const response = await sendCaptureMessage('stop')
    if (!response || !response.report) throw new Error('当前没有可结束的抓取会话')
    downloadJson(response.report, 'bili-purifier-capture.json')
    renderCaptureState(null)
    hint('抓取已结束，报告已下载')
  } catch (error) {
    button.disabled = false
    hint(error.message || String(error), true)
  }
}

function downloadJson(data, filename) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 8000)
}

function hint(text, isError) {
  const element = document.getElementById('captureHint')
  element.hidden = false
  element.textContent = text
  element.dataset.error = isError ? 'true' : 'false'
}
