import fs from "node:fs"
import { buildCatalog, resolveModelRef } from "../lib/catalog.js"
import { BUILTIN_PRESETS } from "../lib/presets.js"
const HOME = process.env.DSH_HOME || "C:/Users/18136/.dsh"
const refs = {}
{ const text = fs.readFileSync(`${HOME}/.credentials.yaml`, "utf8"); let inRefs=false
  for (const line of text.split(/\r?\n/)) { if (/^refs:\s*$/.test(line)) { inRefs=true; continue }
    if (/^\S/.test(line)) inRefs=false; if (!inRefs) continue
    const m = /^\s+([A-Za-z0-9_]+):\s*(.+?)\s*$/.exec(line); if (m) refs[m[1]]=m[2] } }
const catalog = await buildCatalog({})
const userContent = "以下是本次会话已发生的对话记录（可能为空）：\n（本次会话尚无更早的对话）\n\n---\n\n现在需要优化的、我最新输入的提示词是：\n帮我看看那个东西\n\n请按上述要求改写它。"
// 用原始长工作说明（上次超时的那次），重试 3 次看是否稳定
for (let i = 1; i <= 3; i++) {
  const r = resolveModelRef(catalog, BUILTIN_PRESETS[0].modelRef)
  const started = Date.now()
  try {
    const res = await fetch(`${r.baseURL.replace(/\/+$/,"")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${refs[r.apiKeyEnv]}` },
      body: JSON.stringify({ model: r.model, messages: [
        { role: "system", content: BUILTIN_PRESETS[0].instruction },
        { role: "user", content: userContent }], max_tokens: 2048, temperature: 0.3, stream: false }),
      signal: AbortSignal.timeout(90000),
    })
    const j = await res.json()
    const ch = j?.choices?.[0]
    console.log(`run${i}: http=${res.status} ${Date.now()-started}ms contentLen=${typeof ch?.message?.content === "string" ? ch.message.content.length : -1} finish=${ch?.finish_reason} completion=${j?.usage?.completion_tokens}`)
  } catch (e) { console.log(`run${i}: FAIL ${Date.now()-started}ms ${e?.name}`) }
}
