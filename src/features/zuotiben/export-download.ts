/**
 * 导出 PDF 的「取回并下载」这一步 —— 两份册子（数学做题本 / 英语每日一句）共用。
 *
 * 服务端（lib/zuotiben-export.mjs）是真出文件：字节以 `Content-Disposition` 带回，
 * 文件名是中文（`filename*=UTF-8''…`），所以优先用响应头里的名字，别自己拼。
 * 生成要十几秒，调用方必须先给 loading —— 不然用户会以为没反应又点一遍。
 */
export async function downloadPdf(url: string, fallbackName: string) {
  const res = await fetch(url)
  if (!res.ok) {
    // 失败时服务端回的是 JSON（不是 200 也就不会是 PDF）
    const j = await res.json().catch(() => null)
    throw new Error(j?.error || `导出失败（HTTP ${res.status}）`)
  }
  const blob = await res.blob()
  const cd = res.headers.get('Content-Disposition') ?? ''
  const hit = /filename\*=UTF-8''([^;]+)/.exec(cd)
  const name = hit ? decodeURIComponent(hit[1]) : fallbackName
  const a = document.createElement('a')
  const objUrl = URL.createObjectURL(blob)
  a.href = objUrl
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  // 立刻 revoke 会让某些浏览器拿到空文件，等一会儿
  setTimeout(() => URL.revokeObjectURL(objUrl), 10000)
}
