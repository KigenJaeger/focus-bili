(() => {
  self.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason
    const message = String(reason?.message || reason || '')
    const stack = String(reason?.stack || '')
    if (/appendChild/.test(message) && /setupThumbnailListener|content\.js/.test(stack)) {
      event.preventDefault()
    }
  })

  const storage = chrome?.storage?.sync
  if (!storage || storage.__biliPlusSafetyPatched) return

  const get = storage.get.bind(storage)
  storage.__biliPlusSafetyPatched = true
  storage.get = (keys, callback) => {
    const normalize = (values) => ({
      ...values,
      showPortVideoButton: false,
      showPreviewYoutubeButton: false,
      dynamicSponsorBlock: false,
      dynamicAndCommentSponsorBlocker: false,
      dynamicSpaceSponsorBlocker: false,
      commentSponsorBlock: false,
      commentSponsorReplyBlock: false,
      fullVideoLabelsOnThumbnailsMode: 0
    })

    if (typeof callback === 'function') {
      return get(keys, (values) => callback(normalize(values)))
    }

    return get(keys).then(normalize)
  }
})()
