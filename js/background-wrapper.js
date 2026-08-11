// Load the bundled SponsorBlock worker, then ignore only Chrome's transient
// tab-drag rejection. Other rejected promises remain visible for diagnosis.
self.addEventListener('unhandledrejection', (event) => {
  const message = String(event.reason?.message || event.reason || '')
  if (/Tabs cannot be edited right now/i.test(message)) event.preventDefault()
})

importScripts('background.js')
