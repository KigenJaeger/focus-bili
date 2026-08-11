/* Bili+ 信息流净化器 —— 共享默认配置（内容脚本与弹窗共用） */
'use strict'

var DEFAULT_SETTINGS = {
  enabled: true,
  removeCarousel: true,
  removeAds: true,
  removeSponsor: true,
  removeContentTypes: true,
  removeBlacklist: true,
  contentTypeKeywords: ['直播', '番剧', '电影', '电视剧', '综艺', '纪录片', '国创', '漫画', '课堂', '课程', '赛事'],
  sponsorKeywords: [
    '恰饭',
    '暗广',
    '软广',
    '广告合作',
    '商务合作',
    '品牌方',
    '金主',
    '赞助',
    '推广',
    '种草',
    '开箱',
    '横评',
    '评测',
    '测评',
    '实测',
    '安利',
    '避雷',
    '打广告'
  ],
  blacklistUids: []
}
