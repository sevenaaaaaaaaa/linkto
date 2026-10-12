// parse-pool 桩：正文解析与本次问题无关，直接返回固定结果
module.exports.parseEmailRaw = async () => ({ text: 'stub body', html: null, attachments: [] })
module.exports.shutdownParsePool = async () => {}