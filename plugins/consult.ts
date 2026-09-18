import { type Plugin, tool } from "@opencode-ai/plugin"
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync, unlinkSync, appendFileSync } from "node:fs"
import { join } from "node:path"

/*
 * 模块逻辑分区（仅注释分层，不拆文件）
 * 1. 会话状态管理：group_config/shared_draft 读写、sessionId 校验、状态机 idle/running、expireAt 过期兜底
 * 2. 发言持久化：按 speaker 分文件 + 主持人单点写入 + 原子写 + 内存锁
 * 3. 业务审计：会诊启停、保密等级变更事件（不涉及工具读写拦截）
 * 4. 主持人业务逻辑：会诊轮次、保密等级提示、调度器
 * 5. 逃生指令：/reset-consult（复用 consult_reset）
 * 6. team_dev：架构师+开发分工、任务看板、驳回阈值防卡死（P2）
 */

const AGENTS_ORDER = ["arch", "impl", "review"]
const PHASE_TAGS: Record<string, string> = {
  independent: "position",
  dissent: "dissent",
  restate: "restate",
  redteam: "redteam",
  recap: "recap",
  team_dev: "team_dev",
}

interface TeamTask {
  taskId: string
  title: string
  module: string
  files: string[]
  assignee: string
  status: "pending" | "assigned" | "in_progress" | "submitted" | "reviewed" | "rejected"
  reject_count: number
  last_reject_reason: string
}

interface TeamDevState {
  architect: string
  devs: string[]
  tasks: TeamTask[]
  max_reject: number
}

interface Draft {
  goal: string
  agreed: string[]
  open_issues: string[]
  risks: string[]
  code_changes: string[]
  session: {
    active: boolean
    round: number
    phase: string
    redteam_target: string | null
    spoken: Record<string, boolean>
    added_this_cycle: number
    done: boolean
    done_reason: string
    summary: string
    security: SecurityChoice | null
    sessionId: string
    expireAt: number
    selectedModels?: string[]
    mode?: string
    allowDuplicateAgents?: boolean
    team_dev?: TeamDevState
  }
}

interface SecurityChoice {
  level: number
  name: string
  model_policy: string
  sandbox_bash: boolean | null
  ownerId: string
}

const empty_draft = (): Draft => ({
  goal: "",
  agreed: [],
  open_issues: [],
  risks: [],
  code_changes: [],
  session: {
    active: false,
    round: 1,
    phase: "independent",
    redteam_target: null,
    spoken: { arch: false, impl: false, review: false },
    added_this_cycle: 0,
    done: false,
    done_reason: "",
    summary: "",
    security: null,
    sessionId: "",
    expireAt: 0,
    selectedModels: undefined,
    mode: undefined,
    team_dev: undefined,
  },
})

interface RawMsg {
  id: number
  ts: string
  speaker: string
  tags: string[]
  text: string
}

interface CapItem {
  score: number
  grade: string
  recommendation: string
  sources: string
}

interface ScoreRec {
  scored_at: string
  scores: Record<string, CapItem>
}

interface ProbeResult {
  ok: boolean
  ms?: number
  error?: string
}

interface ProbeRec {
  probed_at: string
  results: Record<string, ProbeResult>
}

function groupchat_dir(directory: string) {
  return join(directory, ".opencode", "groupchat")
}

function fmtScoreRec(rec: ScoreRec): string {
  if (!rec.scored_at) return "无打分记录"
  const rows = Object.entries(rec.scores)
    .map(([k, v]) => `${k} → ${v.score}分(${v.grade}) | 推荐:${v.recommendation} | 来源:${v.sources}`)
  return `打分时间:${rec.scored_at}\n${rows.join("\n") || "-"}`
}

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T
  } catch {
    return fallback
  }
}

const SESSION_TTL_MS = 30 * 60 * 1000
const AUDIT_ROTATION_LINE_COUNT = 500
const TEAMDEV_MAX_REJECT = 3
const TEAMDEV_MAX_DEVS = 5

const writeLocks = new Set<string>()

function writeJson(path: string, data: unknown) {
  const d = join(path, "..")
  if (!existsSync(d)) mkdirSync(d, { recursive: true })
  if (writeLocks.has(path)) throw new Error(`consult: 写入冲突，文件正被占用：${path}`)
  writeLocks.add(path)
  try {
    const tmp = `${path}.tmp`
    writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8")
    if (existsSync(path)) copyFileSync(path, `${path}.bak`)
    if (existsSync(path)) unlinkSync(path)
    renameSync(tmp, path)
  } finally {
    writeLocks.delete(path)
  }
}

function appendText(path: string, text: string) {
  const d = join(path, "..")
  if (!existsSync(d)) mkdirSync(d, { recursive: true })
  if (writeLocks.has(path)) throw new Error(`consult: 写入冲突，文件正被占用：${path}`)
  writeLocks.add(path)
  try {
    appendFileSync(path, text, "utf8")
  } finally {
    writeLocks.delete(path)
  }
}

function getSessionId(directory: string): string {
  return directory.split(/[\\/]/).pop() || "unknown"
}

function getArchiveNumber(cdir: string): number {
  const archiveDir = join(cdir, "archive")
  if (!existsSync(archiveDir)) return 0
  return readdirSync(archiveDir).filter((f) => f.startsWith("audit-archive-")).length
}

let auditLineCount = 0
let rotatingAudit = false

function writeAuditEvent(directory: string, event: string, payload: Record<string, unknown>) {
  const record = { ts: new Date().toISOString(), event, ...payload }
  const line = JSON.stringify(record) + "\n"
  const logPath = join(groupchat_dir(directory), "audit.log")
  if (writeLocks.has(logPath)) return
  writeLocks.add(logPath)
  try {
    appendFileSync(logPath, line, "utf8")
    auditLineCount += 1
    if (!rotatingAudit && auditLineCount >= AUDIT_ROTATION_LINE_COUNT) {
      rotatingAudit = true
      try {
        rotateAuditLog(directory)
      } finally {
        rotatingAudit = false
      }
    }
  } finally {
    writeLocks.delete(logPath)
  }
}

function rotateAuditLog(directory: string) {
  const cdir = groupchat_dir(directory)
  const auditPath = join(cdir, "audit.log")
  const archiveDir = join(cdir, "archive")
  if (!existsSync(archiveDir)) mkdirSync(archiveDir, { recursive: true })
  if (!existsSync(auditPath)) return
  const n = getArchiveNumber(cdir) + 1
  const newPath = join(archiveDir, `audit-archive-${n}.log`)
  renameSync(auditPath, newPath)
  auditLineCount = 0
  writeAuditEvent(directory, "audit_archived", {
    sessionId: getSessionId(directory),
    oldPath: auditPath,
    newPath,
    archiveNumber: n,
    reason: "rotation",
    extension: {}, // team_dev P2 预留扩展
  })
}

function paths(directory: string) {
  const d = groupchat_dir(directory)
  return {
    draft: join(d, "shared_draft.json"),
    raw: join(d, "raw_messages.json"),
    cfg: join(d, "group_config.json"),
    score: join(d, "capability_scores.json"),
    probe: join(d, "probe_results.json"),
  }
}

function readConfig(directory: string): any {
  const fallback = { scheduler: { mode: "main", model: "ollama/qwen2.5:7b", max_rounds: 3, multi_opinion: { redteam: true, dissent_after_redteam: true } } }
  const cfg = readJson<any>(paths(directory).cfg, fallback)
  if (!cfg.scheduler) cfg.scheduler = fallback.scheduler
  if (!cfg.scheduler.multi_opinion) cfg.scheduler.multi_opinion = fallback.scheduler.multi_opinion
  return cfg
}

function readDraft(directory: string): Draft {
  return readJson<Draft>(paths(directory).draft, empty_draft())
}

function loadDraftValidated(directory: string, sessionId: string): Draft {
  const draft = readDraft(directory)
  const expired = draft.session.active && draft.session.expireAt > 0 && Date.now() > draft.session.expireAt
  const activeForeign = draft.session.active && !expired && draft.session.sessionId && draft.session.sessionId !== sessionId
  const staleIdle = !draft.session.active && draft.session.sessionId && draft.session.sessionId !== sessionId
  if (expired || staleIdle) {
    const reason = expired ? "会诊超时未结束（异常中断）" : "会话ID不匹配（残留自其他会话）"
    writeAuditEvent(directory, "state-reset", { reason })
    const fresh = empty_draft()
    writeJson(paths(directory).draft, fresh)
    return fresh
  }
  return draft
}

function checkSessionOwner(directory: string, draft: Draft, sessionId: string, op: string): string | null {
  const s = draft.session
  const ownerId = s.active ? s.sessionId : (s.security?.ownerId || "")
  if (!ownerId) return null
  if (ownerId !== sessionId) {
    writeAuditEvent(directory, "session_security_rejected", { blockedSessionId: sessionId, ownerSessionId: ownerId, operation: op })
    return `consult: 权限拒绝——${op} 为主会话独占操作，仅发起会话可执行。当前会话 ${sessionId} 非主人（${ownerId}）。子代理请用 consult_speak/consult_task 等业务接口。`
  }
  return null
}

function readRaw(directory: string): RawMsg[] {
  const v = readJson<RawMsg[]>(paths(directory).raw, [])
  return Array.isArray(v) ? v : []
}

function roleOrder(cfg: any, draft?: Draft): string[] {
  const td = draft?.session?.team_dev
  if (td && td.architect && td.devs?.length) return [td.architect, ...td.devs]
  if (draft?.session?.selectedModels?.length) return draft.session.selectedModels
  const keys = Object.keys(cfg.agents || {})
  if (!keys.length) return AGENTS_ORDER
  for (const a of AGENTS_ORDER) if (keys.includes(a)) return AGENTS_ORDER
  return keys
}

function unspoken(draft: Draft, order: string[]): string | null {
  for (const r of order) if (!draft.session.spoken[r]) return r
  return null
}

function roleName(cfg: any, role: string): string {
  return cfg.agents?.[role]?.name || role
}

function resetSpoken(draft: Draft, order: string[]) {
  draft.session.spoken = Object.fromEntries(order.map((r) => [r, false]))
}

function phasePrompt(cfg: any, draft: Draft, role: string): string {
  const a = cfg.agents?.[role]
  const name = roleName(cfg, role)
  const ob = (a?.obligations || []).join("\n")
  const s = draft.session
  let task = `阶段：${s.phase}（第 ${s.round} 轮）\n以「${name}」身份发言。职责：${a?.declaration || ""}\n表达义务：\n${ob}\n`
  if (s.phase === "independent") task += "要求：不要引用其他角色的发言，独立给出你的立场。\n"
  if (s.phase === "dissent") task += "要求：逐条点名你不同意谁的观点及原因；确实无分歧则显式写'无分歧'。\n"
  if (s.phase === "restate") task += "要求：先复述你要反驳的立场（复述错视为无效），再反驳。\n"
  if (s.phase === "redteam") task += "要求：你是本轮指定对立面，专门攻击当前方案找漏洞，不计后果。\n"
  if (s.phase === "recap") task += "要求：重新审视 open_issues，检查是否有被忽略的分歧，逐条确认。\n"
  if (s.phase === "team_dev") {
    if (role === s.team_dev?.architect) task += "要求：你是架构师，审视整体架构与模块接口，用 consult_task 下发/评审任务，仅可修改自有文件。\n"
    else task += "要求：你是开发模型，只实现自己被分配的模块文件（其余文件只读，权限复用 redteam 隔离），用 consult_task action=submit 提交。\n"
  }
  return task
}

function nextTurn(draft: Draft, cfg: any) {
  const order = roleOrder(cfg, draft)
  const s = draft.session
  if (s.phase === "redteam") {
    if (s.redteam_target && !s.spoken[s.redteam_target]) return { speaker: s.redteam_target, phase: "redteam", round: s.round }
    return advance(s, draft, cfg, order)
  }
  const un = unspoken(draft, order)
  if (un) return { speaker: un, phase: s.phase, round: s.round }
  return advance(s, draft, cfg, order)
}

function advance(s: any, draft: Draft, cfg: any, order: string[]) {
  const multi = cfg.scheduler.multi_opinion || {}
  // team_dev：架构师/开发循环发言，不做独立/分歧/红队阶段切换
  if (s.phase === "team_dev") {
    if (s.round >= (cfg.scheduler.max_rounds || 5)) return finish(draft, s, "max_rounds")
    s.round += 1
    s.added_this_cycle = 0
    resetSpoken(draft, order)
    return { speaker: unspoken(draft, order) || order[0], phase: "team_dev", round: s.round }
  }
  const step: Record<string, string> = { independent: "dissent", dissent: "restate", restate: "redteam", redteam: "recap" }
  if (s.phase === "restate") {
    if (multi.redteam === false) return finish(draft, s, "converged")
    s.phase = "redteam"
    const target = order[s.round % order.length]
    s.redteam_target = target
    resetSpoken(draft, order)
    s.spoken[target] = true
    return { speaker: target, phase: "redteam", round: s.round }
  }
  if (s.phase === "redteam") {
    const next = multi.dissent_after_redteam === false ? "independent" : "recap"
    s.phase = next
    s.redteam_target = null
    resetSpoken(draft, order)
    return { speaker: unspoken(draft, order) || order[0], phase: next, round: s.round }
  }
  if (s.phase === "recap") {
    if (s.added_this_cycle === 0 || s.round >= (cfg.scheduler.max_rounds || 3)) return finish(draft, s, s.added_this_cycle === 0 ? "converged" : "max_rounds")
    s.phase = "independent"
    s.round += 1
    s.added_this_cycle = 0
    resetSpoken(draft, order)
    return { speaker: unspoken(draft, order) || order[0], phase: "independent", round: s.round }
  }
  const next = step[s.phase] || "dissent"
  s.phase = next
  resetSpoken(draft, order)
  return { speaker: unspoken(draft, order) || order[0], phase: next, round: s.round }
}

function finish(draft: Draft, s: any, reason: string) {
  s.phase = "done"
  s.done = true
  s.done_reason = reason
  s.spoken = {}
  draft.session = s
  return { speaker: "", phase: "done", round: s.round }
}

function replyText(cfg: any, draft: Draft, t: { speaker: string; phase: string; round: number }) {
  if (t.phase === "done") {
    const s = draft.session
    return [
      `consult: 会诊结束（${s.done_reason}）。`,
      `目标: ${draft.goal}`,
      `共识(${draft.agreed.length}): ${draft.agreed.join(" | ") || "-"}`,
      `未决分歧(${draft.open_issues.length}): ${draft.open_issues.join(" | ") || "-"}`,
      `风险(${draft.risks.length}): ${draft.risks.join(" | ") || "-"}`,
      `代码变更: ${draft.code_changes.join(" | ") || "-"}`,
      `调用 consult_summary 生成最终汇总。`,
    ].join("\n")
  }
  return [
    `round=${t.round} phase=${t.phase}`,
    `让「${roleName(cfg, t.speaker)}（${t.speaker}）」发言:`,
    phasePrompt(cfg, draft, t.speaker),
    `发言后调用 consult_speak 记录（speaker=角色, text=发言, dissent/agreed/risks/code_changes 为 JSON 字符串数组）。`,
  ].join("\n")
}

async function schedule7b(cfg: any, draft: Draft, raws: RawMsg[]): Promise<string> {
  const model = cfg.scheduler.model || "ollama/qwen2.5:7b"
  if (!String(model).startsWith("ollama/")) return ""
  const recent = raws.slice(-10).map((m) => `[${m.speaker}] ${m.text}`).join("\n") || "-"
  const prompt = [
    `你是会诊调度器，判断下一位发言人或能否收敛结束。`,
    `角色: ${roleOrder(cfg, draft).join(", ")}`,
    `轮次: ${draft.session.round}, 阶段: ${draft.session.phase}`,
    `草稿: goal=${draft.goal} | 共识=${draft.agreed.join(";")} | 未决=${draft.open_issues.join(";")} | 风险=${draft.risks.join(";")}`,
    `最近发言:\n${recent}`,
    `只输出 JSON: {"action":"speak"|"done","speaker":"角色名","reason":"一句话"}。done 表示观点已收敛或拉锯无进展，结束。`,
  ].join("\n")
  try {
    const res = await fetch("http://localhost:11434/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: String(model).replace("ollama/", ""), messages: [{ role: "user", content: prompt }], temperature: 0.2, stream: false }),
    })
    if (!res.ok) return ""
    const data = (await res.json()) as any
    const content: string = data?.choices?.[0]?.message?.content || ""
    const m = content.match(/\{[\s\S]*\}/)
    if (!m) return ""
    const j = JSON.parse(m[0])
    if (j?.action === "done") return "DONE"
    if (j?.action === "speak" && j?.speaker) return j.speaker
    return ""
  } catch {
    return ""
  }
}

function saveAndReply(cfg: any, draft: Draft, directory: string) {
  const t = nextTurn(draft, cfg)
  writeJson(paths(directory).draft, draft)
  return replyText(cfg, draft, t)
}

function makeTaskId(draft: Draft): string {
  const td = draft.session.team_dev
  const n = td ? td.tasks.length + 1 : 1
  return `task-${n}`
}

function boardText(td: TeamDevState): string {
  if (!td || !td.tasks.length) return "任务看板为空。"
  return td.tasks
    .map((t) => `[${t.taskId}] ${t.title} | 模块:${t.module} | 分配:${t.assignee} | 状态:${t.status} | 驳回:${t.reject_count}/${td.max_reject}${t.last_reject_reason ? ` | 驳回理由:${t.last_reject_reason}` : ""}`)
    .join("\n")
}

export const ConsultPlugin: Plugin = async ({ directory = process.cwd(), client }) => {
  const p = paths(directory)
  return {
    tool: {
      consult_security: tool({
        description: "会诊模式：第一步必做——用户选定保密档位(0~5)。会锁定本次会诊权限规则，不可中途切换。level=0完全开放/1只读/2只读屏蔽敏感/3沙盒/4片段沙盒/5纯文字。档3/4自动追问 sandbox_bash。",
        args: {
          level: tool.schema.number(),
          sandbox_bash: tool.schema.boolean().optional(),
        },
        async execute(args, ctx) {
          const cfg = readConfig(directory)
          const levels = cfg.security?.levels || []
          const lv = levels.find((l: any) => l.level === args.level)
          if (!lv) return `consult: 无效档位 ${args.level}，可选: ${levels.map((l: any) => l.level).join("/")}`
          const draft = loadDraftValidated(directory, ctx.sessionID)
          const denied = checkSessionOwner(directory, draft, ctx.sessionID, "consult_security")
          if (denied) return denied
          if (draft.session.active) return `consult: 会诊已进行中（running），禁止中途改保密档位。需先 consult_reset 结束本次会诊。`
          if (lv.sandbox_bash !== "ask" || args.sandbox_bash === true || args.sandbox_bash === false) {
            if (draft.session.security) return `consult: 保密档位已锁定为「${draft.session.security.name}」，本次会诊不可切换。需 consult_reset 后重选。`
            draft.session.security = { level: lv.level, name: lv.name, model_policy: lv.model_policy, sandbox_bash: lv.sandbox_bash === "ask" ? (args.sandbox_bash ?? false) : null, ownerId: ctx.sessionID }
            writeJson(p.draft, draft)
            writeAuditEvent(directory, "security-selected", { level: lv.level, name: lv.name, model_policy: lv.model_policy })
            return [
              `consult: 保密档位已锁定 → 等级${lv.level}「${lv.name}」`,
              `暴露范围: ${lv.privacy}`,
              `权限规则: ${lv.rules}`,
              `模型策略: ${lv.model_policy}${draft.session.security.sandbox_bash !== null ? `；沙盒bash=${draft.session.security.sandbox_bash ? "允许" : "禁止"}` : ""}`,
              `接下来调用 consult_invite 拉取符合该档位的模型名单。`,
            ].join("\n")
          }
          return `consult: 请先确认档${lv.level}沙盒内是否允许 bash：再传 sandbox_bash=true/false。`
        },
      }),
      consult_probe: tool({
        description: "会诊模式：连通性探测——对名单中每个模型发最小请求，结果落盘 probe_results.json（测通名单），标注 可用✓/失败✗+原因，打分前必须先测通。默认只测未测过的模型（增量）；同厂商只取 max_per_provider 个代表；配置 probe.skip 可跳过明显不通的模型；force=true 强制重测全部。",
        args: {
          ids: tool.schema.array(tool.schema.string()).optional(),
          force: tool.schema.boolean().optional(),
        },
        async execute(args, ctx) {
          const cfg = readConfig(directory)
          const annotations = cfg.agents || {}
          const pc = (cfg.probe || {}) as Record<string, any>
          const timeoutMs = Number(pc.timeout_ms) || 8000
          const concurrency = Number(pc.concurrency) || 4
          const maxPerProvider = Number(pc.max_per_provider) || 2
          const skipSet = new Set((pc.skip as string[]) || [])
          const probeRec = readJson<ProbeRec>(paths(directory).probe, { probed_at: "", results: {} })
          let list: any[] = []
          try {
            const res = (await (client as any).config.providers({})) as any
            list = res?.data?.providers || []
          } catch (e: any) {
            return `consult: 实时拉取模型失败：${e?.message || e}`
          }
          const targets: { prov: any; key: string; m: any; fullId: string }[] = []
          let perProv = new Map<string, number>()
          for (const prov of list) {
            const models = prov?.models || {}
            for (const key of Object.keys(models)) {
              const m = models[key]
              const fullId = m?.id || `${prov?.id}/${key}`
              if (skipSet.has(fullId) || skipSet.has(key)) continue
              const want = args.ids && args.ids.length
              if (want && !args.ids!.includes(fullId) && !args.ids!.includes(key)) continue
              if (!want) {
                const n = perProv.get(prov?.id) || 0
                if (n >= maxPerProvider) continue
                perProv.set(prov?.id, n + 1)
              }
              if (!args.force && probeRec.results[fullId]) continue
              targets.push({ prov, key, m, fullId })
            }
          }
          if (!targets.length) return "consult: 无待探测模型（已测或已被 skip/厂商取样过滤；force=true 可全量重测）。"
          const withTimeout = (p: Promise<any>, ms: number) =>
            Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout=${ms}ms`)), ms)).then(() => Promise.reject(new Error(`timeout=${ms}ms`)))])
          const out: string[] = [`consult: 连通性探测开始，待测 ${targets.length} 个（超时${timeoutMs}ms，并发${concurrency}，厂商${maxPerProvider}代表/厂）。`]
          let okN = 0
          let failN = 0
          const probeOne = async (t: { prov: any; key: string; m: any; fullId: string }) => {
            const ann = annotations[t.key] || annotations[t.key.split(":")[0]] || null
            const start = Date.now()
            let ok = false
            let err = ""
            try {
              const ses = await withTimeout((client as any).session.create({ body: { title: `probe-${t.key}` } }), timeoutMs)
              const sid = ses?.data?.id || ses?.id
              if (sid) {
                try {
                  const res = await withTimeout((client as any).session.prompt({
                    path: { id: sid },
                    body: { model: { providerID: t.prov.id, modelID: t.key }, parts: [{ type: "text", text: "hi" }] },
                  }), timeoutMs)
                  ok = !!(res?.data?.text || res?.data?.info || res?.data)
                } finally {
                  try { await (client as any).session.delete({ path: { id: sid } }) } catch { /* cleanup */ }
                }
              } else {
                err = "session.create 未返回 id"
              }
            } catch (e: any) {
              err = (e?.message || String(e)).slice(0, 160)
            }
            const ms = Date.now() - start
            probeRec.results[t.fullId] = { ok, ms, error: ok ? undefined : err || "unknown" }
            if (ok) okN += 1
            else failN += 1
            const company = ann?.company || t.prov.id
            out.push(`${ok ? "✓" : "✗"} ${t.fullId} (${company}) ${ok ? `${ms}ms` : `失败: ${err || "无响应"}`}`)
          }
          const pool: Promise<void>[] = []
          for (const t of targets) {
            const task = (async () => { await probeOne(t) })()
            pool.push(task)
            if (pool.length >= concurrency) {
              await Promise.all(pool)
              pool.length = 0
            }
          }
          if (pool.length) await Promise.all(pool)
          probeRec.probed_at = new Date().toISOString()
          writeJson(paths(directory).probe, probeRec)
          writeAuditEvent(directory, "probe_completed", { sessionId: ctx.sessionID, total: targets.length, ok: okN, failed: failN })
          out.push(`探测完成：可用 ${okN} / 失败 ${failN}。结果已落盘 probe_results.json（测通名单）。`)
          out.push(`提示：consult_invite only_ok=true 可直接拉取测通名单，无需重复探测。`)
          return out.join("\n")
        },
      }),
      consult_invite: tool({
        description: "会诊模式：实时拉取 opencode 当前可用模型名单（与切模型器同源，非死名单），按当前保密档位的模型策略过滤，合并探测结果(可用✓/失败✗)与群配置注解展示。only_ok=true 只展示测通的模型（拉测通名单），不列出未测/失败项。调用后由用户选择成员。",
        args: {
          only_ok: tool.schema.boolean().optional(),
        },
        async execute(args) {
          const cfg = readConfig(directory)
          const annotations = cfg.agents || {}
          const draft = readDraft(directory)
          const sec = draft.session.security
          const scoreRec = readJson<ScoreRec>(paths(directory).score, { scored_at: "", scores: {} })
          const probeRec = readJson<ProbeRec>(paths(directory).probe, { probed_at: "", results: {} })
          let list: any[] = []
          try {
            const res = (await (client as any).config.providers({})) as any
            list = res?.data?.providers || []
          } catch (e: any) {
            return `consult: 实时拉取模型失败，降级读配置注解：${e?.message || e}`
          }
          const lines: string[] = []
          let idx = 0
          for (const prov of list) {
            const models = prov?.models || {}
            for (const key of Object.keys(models)) {
              const m = models[key]
              const annKey = key.split(":")[0]
              const norm = (s: string) => s.replace(/[\.\-]/g, "")
              const ann = annotations[key] || annotations[annKey] || annotations[norm(key)] || null
              const fullId = m?.id || `${prov?.id}/${key}`
              const local = !!prov?.options?.baseURL || prov?.id === "ollama"
              if (sec?.model_policy === "local_only" && !local) continue
              if (sec?.model_policy === "text_only") continue
              const pr = probeRec.results[fullId]
              if (args.only_ok && (!pr || !pr.ok)) continue
              idx += 1
              const company = ann?.company || ""
              const cost = ann?.cost || (m?.cost?.input ? `付费 in=${m.cost.input}` : "免费")
              const privacy = ann?.privacy || (prov?.options?.baseURL ? "自设端点" : "云端")
              const sc = scoreRec.scores[fullId] || scoreRec.scores[key] || null
              const cap = sc ? `${sc.score}分(${sc.grade})·${sc.recommendation}` : (ann?.capability || "-")
              const policy = ann?.data_policy || "待核"
              const probeTag = pr ? (pr.ok ? "✓可用" : "✗不通") : "·未测"
              lines.push(`${idx}. ${probeTag} ${key} | 公司=${company || "-"} | 能力=${cap} | 费用=${cost} | 数据保存政策=${policy} | 保密=${privacy} | provider=${prov?.id} | fullId=${fullId}${pr && !pr.ok ? ` | 失败原因=${pr.error}` : ""}`)
            }
          }
          if (!lines.length) return args.only_ok ? "consult: 测通名单为空。先用 consult_probe 测通模型（可 ids 指定），再拉 only_ok。" : "consult: 实时名单为空（无 provider 或未解析）。可检查 opencode 模型配置。"
          const scoreNote = scoreRec.scored_at ? `打分时间: ${scoreRec.scored_at}（consult_score 可复用或重打）` : "能力分未评估（调用 consult_score action=score 按标准打分）"
          return [
            `consult: ${args.only_ok ? "测通名单" : "可用模型实时名单"}（当前保密档位: ${sec ? `等级${sec.level}「${sec.name}」` : "未选"}）：`,
            ...lines,
            `注：标注"公司/费用/隐私/数据保存政策"来自 group_config 注解（政策按核查流程查官方原文，标日期）；能力分来自 capability_scores.json。${scoreNote}`,
            `（提示：复选入选模型请在 consult_start 传 selectedModels: fullId1,fullId2；team_dev 模式需另传 architect=fullId。only_ok=true 只列测通模型）`,
          ].join("\n")
        },
      }),
      consult_score: tool({
        description: "会诊模式：对候选模型按《大模型能力评分标准 V3.2.2》打分，结果落盘 capability_scores.json（自动记录打分时间）。前置：必须先 consult_probe 测通，未测或不通的模型拒绝打分。已打分时再次调用会先提示上次打分时间，由用户决定复用上次结果还是重新打分。action=score 打分写入；action=reuse 复用上次结果；缺省时查询当前打分记录。scores 为 JSON 字符串，结构 {\"fullId\":{\"score\":数字,\"grade\":\"等级\",\"recommendation\":\"一句话\",\"sources\":\"来源说明\"}}。",
        args: {
          action: tool.schema.string().optional(),
          scores: tool.schema.string().optional(),
        },
        async execute(args) {
          const action = (args.action || "").trim()
          const rec = readJson<ScoreRec>(paths(directory).score, { scored_at: "", scores: {} })
          if (action === "score") {
            const raw = (args.scores || "").trim()
            if (!raw) return "consult: 缺少 scores。"
            let parsed: Record<string, CapItem>
            try {
              parsed = JSON.parse(raw) as Record<string, CapItem>
            } catch {
              return "consult: scores 不是合法 JSON。"
            }
            const probeRec = readJson<ProbeRec>(paths(directory).probe, { probed_at: "", results: {} })
            const gone: string[] = []
            const noprobe: string[] = []
            const clean: Record<string, CapItem> = {}
            for (const [k, v] of Object.entries(parsed)) {
              const pr = probeRec.results[k]
              if (pr && !pr.ok) {
                gone.push(`${k}(${pr.error || "失败"})`)
                continue
              }
              if (!pr) {
                noprobe.push(k)
                continue
              }
              const num = Number(v?.score)
              clean[k] = {
                score: Number.isFinite(num) ? Math.max(0, Math.min(100, Math.round(num))) : 0,
                grade: String(v?.grade || ""),
                recommendation: String(v?.recommendation || ""),
                sources: String(v?.sources || ""),
              }
            }
            const warns: string[] = []
            if (noprobe.length) warns.push(`未探测跳过: ${noprobe.join(", ")}`)
            if (gone.length) warns.push(`探测不通跳过: ${gone.join("; ")}`)
            if (warns.length) warns.push(`先对跳过模型跑 consult_probe 测通后再说。`)
            if (!Object.keys(clean).length) return `consult: 打分全部被挡板拦下。\n${warns.join("\n")}`
            const now = new Date().toISOString()
            rec.scored_at = now
            rec.scores = clean
            writeJson(paths(directory).score, rec)
            return `consult: 能力分已落盘，打分时间 ${now}\n${warns.join("\n") || "全部模型已测通。"}\n${fmtScoreRec(rec)}`
          }
          if (action === "reuse") {
            return `consult: 复用上次打分（${rec.scored_at || "无记录"}）：\n${fmtScoreRec(rec)}`
          }
          if (!rec.scored_at) return "consult: 尚无打分记录。调用 consult_score action=score 并传 scores 打分。"
          return `consult: 上次打分时间 ${rec.scored_at}。本次是使用上次打分（action=reuse），还是重新打分（action=score）？`
        },
      }),
      consult_start: tool({
        description: "会诊模式：开启一轮多角色会诊。question=待会诊问题。支持 selectedModels 预选模型、mode 选择对话方式（independent/dissent/redteam/team_dev）。team_dev 模式需指定 architect=fullId，其余入选模型为开发（1~5 个），角色在创建时固定。返回指示后按顺序让各角色发言。",
        args: {
          question: tool.schema.string(),
          selectedModels: tool.schema.array(tool.schema.string()).optional(),
          mode: tool.schema.enum(["independent", "dissent", "redteam", "team_dev"]).optional(),
          architect: tool.schema.string().optional(),
        },
        async execute(args, ctx) {
          const q = (args.question || "").trim()
          if (!q) return "consult: 缺少 question。"
          const draft0 = loadDraftValidated(directory, ctx.sessionID)
          if (!draft0.session.security) return "consult: 开启会诊前必须先选保密档位。先调用 consult_security 选定等级(0~5)，再 consult_start。"
          const deniedStart = checkSessionOwner(directory, draft0, ctx.sessionID, "consult_start")
          if (deniedStart) return deniedStart

          const mode = args.mode || draft0.session.mode || "independent"
          let selectedModels = args.selectedModels || draft0.session.selectedModels || []
          let architect = args.architect || (draft0.session.team_dev?.architect as string | undefined) || ""

          const allowDup = draft0.session.allowDuplicateAgents
          const seen = new Set()
          const uniqueModels: string[] = []
          const removed: string[] = []
          for (const id of selectedModels) {
            if (seen.has(id)) {
              if (!allowDup) {
                removed.push(id)
                writeAuditEvent(directory, "duplicate_model_removed", { removedId: id, reason: "auto-dedup" })
                continue
              }
            }
            seen.add(id)
            uniqueModels.push(id)
          }
          if (uniqueModels.length) {
            draft0.session.selectedModels = uniqueModels
            writeJson(p.draft, draft0)
            writeAuditEvent(directory, "model-selected", { selectedModels: uniqueModels, removedCount: removed.length, allowDup })
          }

          const draft = empty_draft()
          draft.goal = q
          draft.session.active = true
          draft.session.security = draft0.session.security
          draft.session.sessionId = ctx.sessionID
          draft.session.expireAt = Date.now() + SESSION_TTL_MS
          draft.session.mode = mode
          draft.session.selectedModels = uniqueModels.length ? uniqueModels : (draft0.session.selectedModels || undefined)

          if (mode === "team_dev") {
            if (!architect) return "consult: team_dev 模式必须指定架构师，请传 architect=fullId（从 selectedModels 中选取）。"
            if (!uniqueModels.includes(architect)) return `consult: 架构师 ${architect} 不在入选模型 selectedModels 中。`
            const devs = uniqueModels.filter((m) => m !== architect)
            if (devs.length < 1) return "consult: team_dev 至少需要 1 个开发模型（selectedModels 中除架构师外至少 1 个）。"
            if (devs.length > TEAMDEV_MAX_DEVS) return `consult: 开发模型最多 ${TEAMDEV_MAX_DEVS} 个，当前 ${devs.length} 个，请精简入选模型。`
            draft.session.team_dev = { architect, devs, tasks: [], max_reject: TEAMDEV_MAX_REJECT }
            draft.session.phase = "team_dev"
            resetSpoken(draft, [architect, ...devs])
            writeAuditEvent(directory, "teamdev_architect_assign", {
              sessionId: ctx.sessionID,
              architect,
              devs,
              extension: { fixed_at: "session-creation", dynamic_reassign: false },
            })
          }

          writeJson(p.draft, draft)
          const raws = readRaw(directory)
          raws.push({ id: raws.length + 1, ts: new Date().toISOString(), speaker: "user", tags: ["goal"], text: q })
          writeJson(p.raw, raws)
          writeAuditEvent(directory, "consult-start", { sessionId: ctx.sessionID, level: draft.session.security.level, goal: q.slice(0, 80), mode })
          writeAuditEvent(directory, "mode-selected", { mode })

          return saveAndReply(readConfig(directory), draft, directory)
        },
      }),
      consult_next: tool({
        description: "会诊模式：请求调度器决定下一位发言人。phase=done 表示已收敛或达轮次上限。",
        args: {},
        async execute(args, ctx) {
          const cfg = readConfig(directory)
          const draft = loadDraftValidated(directory, ctx.sessionID)
          if (!draft.session.active) return "consult: 会话未激活。先用 consult_start 开启。"
          if (draft.session.done) return replyText(cfg, draft, { speaker: "", phase: "done", round: draft.session.round })
          if (draft.session.mode === "team_dev") {
            const roleOrderArr = roleOrder(cfg, draft)
            const un = unspoken(draft, roleOrderArr)
            if (un) {
              return [
                `round=${draft.session.round} phase=team_dev`,
                `让「${roleName(cfg, un)}（${un}）」发言:`,
                phasePrompt(cfg, draft, un),
                `发言后调用 consult_speak 记录；任务流转请调用 consult_task。`,
              ].join("\n")
            }
            return saveAndReply(cfg, draft, directory)
          }
          if (cfg.scheduler.mode === "7b") {
            const s7 = await schedule7b(cfg, draft, readRaw(directory))
            if (s7 === "DONE") {
              draft.session.phase = "done"
              draft.session.done = true
              draft.session.done_reason = "scheduler_7b"
              writeJson(p.draft, draft)
              return replyText(cfg, draft, { speaker: "", phase: "done", round: draft.session.round })
            }
            const order = roleOrder(cfg, draft)
            if (s7 && order.includes(s7)) {
              return [
                `round=${draft.session.round} phase=${draft.session.phase}`,
                `让「${roleName(cfg, s7)}（${s7}）」发言（7b 调度）:`,
                phasePrompt(cfg, draft, s7),
                `发言后调用 consult_speak 记录。`,
              ].join("\n")
            }
          }
          return saveAndReply(cfg, draft, directory)
        },
      }),
      consult_speak: tool({
        description: "会诊模式：记录一名角色发言并写入共享草稿。speaker=角色(arch/impl/review 或 team_dev 中的模型 fullId), text=发言, dissent/agreed/risks/code_changes=JSON 字符串数组。",
        args: {
          speaker: tool.schema.string(),
          text: tool.schema.string(),
          dissent: tool.schema.string(),
          agreed: tool.schema.string(),
          risks: tool.schema.string(),
          code_changes: tool.schema.string(),
        },
        async execute(args, ctx) {
          const cfg = readConfig(directory)
          const draft = loadDraftValidated(directory, ctx.sessionID)
          if (!draft.session.active) return "consult: 会话未激活。先用 consult_start 开启。"
          const speaker = (args.speaker || "").trim()
          const order = roleOrder(cfg, draft)
          if (!order.includes(speaker)) return `consult: 未知角色 ${speaker}，可选: ${order.join(", ")}`
          if (draft.session.phase === "redteam" && speaker !== draft.session.redteam_target) {
            return `consult: 红队轮只由「${roleName(cfg, draft.session.redteam_target || "")}」发言，${speaker} 稍候。`
          }
          if (draft.session.mode === "team_dev") {
            const td = draft.session.team_dev
            if (!td) return "consult: team_dev 状态缺失，请 consult_reset 后重建。"
            if (speaker !== td.architect && !td.devs.includes(speaker)) return `consult: ${speaker} 不是本团队角色（架构师: ${td.architect}，开发: ${td.devs.join(", ")}）。`
          }
          const text = (args.text || "").trim()
          if (!text) return "consult: 缺少 text。"
          if (draft.session.spoken[speaker]) return `consult: ${speaker} 本阶段已发言。`

          const parseArr = (s: string): string[] => {
            if (!s) return []
            try {
              const v = JSON.parse(s)
              return Array.isArray(v) ? v.map(String) : []
            } catch {
              return [s]
            }
          }
          const dissents = parseArr(args.dissent).map((s) => s.trim()).filter(Boolean)
          if ((draft.session.phase === "dissent" || draft.session.phase === "recap") && dissents.length === 0) {
            return "consult: 本阶段必须点名分歧；若确实无分歧，请显式传 dissent=['无分歧']。"
          }

          const raws = readRaw(directory)
          raws.push({ id: raws.length + 1, ts: new Date().toISOString(), speaker, tags: [PHASE_TAGS[draft.session.phase] || draft.session.phase], text })
          writeJson(p.raw, raws)

          const speechPath = join(groupchat_dir(directory), "speeches", `${speaker}.md`)
          const phase = draft.session.phase
          appendText(speechPath, `\n## [${new Date().toISOString()}] round=${draft.session.round} phase=${phase}\n\n${text}\n\n---\n`)

          const pushUnique = (arr: string[], items: string[]) => {
            for (const it of items) if (it && !arr.includes(it)) arr.push(it)
          }
          pushUnique(draft.open_issues, dissents)
          pushUnique(draft.agreed, parseArr(args.agreed).map((s) => s.trim()).filter((s) => s !== "无分歧"))
          pushUnique(draft.risks, parseArr(args.risks).map((s) => s.trim()).filter(Boolean))
          pushUnique(draft.code_changes, parseArr(args.code_changes).map((s) => s.trim()).filter(Boolean))
          draft.session.added_this_cycle += dissents.length
          draft.session.spoken[speaker] = true
          writeJson(p.draft, draft)

          const t = nextTurn(draft, cfg)
          writeJson(p.draft, draft)
          return replyText(cfg, draft, t)
        },
      }),
      consult_task: tool({
        description: "team_dev 模式专用：任务看板操作。action=board 查看全部任务；action=assign 架构师下发/重拆任务（title/module/files/assignee）；action=submit 开发提交任务（taskId）；action=review 架构师评审（taskId, pass=true/false, reason）；action=reject 架构师驳回（taskId, reason）。连续驳回达 max_reject 次自动告警，防止死循环。",
        args: {
          action: tool.schema.string(),
          taskId: tool.schema.string().optional(),
          title: tool.schema.string().optional(),
          module: tool.schema.string().optional(),
          files: tool.schema.string().optional(),
          assignee: tool.schema.string().optional(),
          pass: tool.schema.boolean().optional(),
          reason: tool.schema.string().optional(),
        },
        async execute(args, ctx) {
          const draft = loadDraftValidated(directory, ctx.sessionID)
          if (!draft.session.active) return "consult: 会话未激活。先用 consult_start 开启。"
          if (draft.session.mode !== "team_dev" || !draft.session.team_dev) return "consult: consult_task 仅限 team_dev 模式。"
          const td = draft.session.team_dev
          const action = (args.action || "").trim()
          const save = (msg: string) => {
            writeJson(p.draft, draft)
            return msg
          }
          if (action === "board") {
            return save(`【任务看板】架构师=${td.architect} 开发=${td.devs.join(", ")}\n${boardText(td)}`)
          }
          if (action === "assign") {
            const title = (args.title || "").trim()
            const module = (args.module || "").trim()
            const assignee = (args.assignee || "").trim()
            if (!title || !module || !assignee) return "consult: assign 需要 title/module/assignee(目标开发 fullId)。"
            if (assignee === td.architect) return "consult: 任务应下发给开发模型，架构师不承担实现。"
            if (!td.devs.includes(assignee)) return `consult: ${assignee} 不是开发模型（开发: ${td.devs.join(", ")}）。`
            const filesRaw = (args.files || "").split(",").map((s) => s.trim()).filter(Boolean)
            const task: TeamTask = {
              taskId: makeTaskId(draft),
              title,
              module,
              files: filesRaw,
              assignee,
              status: "assigned",
              reject_count: 0,
              last_reject_reason: "",
            }
            td.tasks.push(task)
            writeAuditEvent(directory, "teamdev_architect_assign", {
              sessionId: ctx.sessionID,
              architect: td.architect,
              taskId: task.taskId,
              module,
              assignee,
              extension: { files: task.files },
            })
            return save(`consult: 任务已下发 ${task.taskId}「${title}」→ ${assignee}（模块 ${module}，文件 ${task.files.join(",") || "待定"}）。`)
          }
          const task = td.tasks.find((t) => t.taskId === args.taskId)
          if (!task) return `consult: 任务 ${args.taskId} 不存在。调用 action=board 查看。`
          if (action === "submit") {
            if (task.status !== "assigned" && task.status !== "in_progress") return `consult: 任务 ${task.taskId} 当前状态 ${task.status}，不能提交。`
            task.status = "submitted"
            writeAuditEvent(directory, "task_completion", {
              sessionId: ctx.sessionID,
              taskId: task.taskId,
              assignee: task.assignee,
              module: task.module,
              extension: { files: task.files },
            })
            return save(`consult: ${task.assignee} 已提交任务 ${task.taskId}「${task.title}」，待架构师评审。`)
          }
          if (action === "review" || action === "reject") {
            const pass = action === "review" ? (args.pass === true ? true : args.pass === false ? false : null) : false
            const reason = (args.reason || "").trim()
            if (action === "review" && pass === null) return "consult: review 需要 pass=true/false。"
            if (pass === false && !reason) return "consult: 驳回需要 reason。"
            if (pass === true) {
              task.status = "reviewed"
              writeAuditEvent(directory, "module_review", {
                sessionId: ctx.sessionID,
                taskId: task.taskId,
                module: task.module,
                result: "through",
                reviewer: td.architect,
                extension: {},
              })
              return save(`consult: ${td.architect} 评审通过任务 ${task.taskId}「${task.title}」。`)
            }
            task.status = "rejected"
            task.reject_count += 1
            task.last_reject_reason = reason
            writeAuditEvent(directory, "task_reject", {
              sessionId: ctx.sessionID,
              taskId: task.taskId,
              module: task.module,
              reason,
              reject_count: task.reject_count,
              assignee: task.assignee,
              extension: { max_reject: td.max_reject },
            })
            if (task.reject_count >= td.max_reject) {
              return save(`consult: 任务 ${task.taskId} 连续驳回达 ${td.max_reject} 次，触发防死循环保护。建议：consult_summary decision=finalize 终止，或架构师重拆任务（assign 重新下发新任务）。`)
            }
            task.status = "assigned"
            return save(`consult: ${td.architect} 驳回任务 ${task.taskId}（${task.reject_count}/${td.max_reject}），已回退给 ${task.assignee} 重做。理由:${reason}`)
          }
          return `consult: 未知 action=${action}。可选: board/assign/submit/review/reject。`
        },
      }),
      consult_summary: tool({
        description: "会诊模式：生成最终结构化汇总并写入草稿 summary；同时支持总结决策闭环 decision=continue/converge/finalize（continue 重置轮次继续讨论；converge 标记收敛结束；finalize 强制终止，用户拥有最高优先级）。modelId 可指定总结模型。",
        args: {
          decision: tool.schema.enum(["continue", "converge", "finalize"]).optional(),
          modelId: tool.schema.string().optional(),
        },
        async execute(args, ctx) {
          const draft = loadDraftValidated(directory, ctx.sessionID)
          if (!draft.session.active) {
            return "consult: 当前会话未运行，无法执行总结决策。请先 consult_start 启动会诊。"
          }
          const wasDone = draft.session.done

          const collect = () => {
            draft.session.summary = [
              `## 会诊汇总 (轮次 ${draft.session.round}, 模式 ${draft.session.mode || "independent"})`,
              `目标: ${draft.goal}`,
              `共识: ${draft.agreed.join(" | ") || "-"}`,
              `未决分歧: ${draft.open_issues.join(" | ") || "-"}`,
              `风险: ${draft.risks.join(" | ") || "-"}`,
              `代码变更: ${draft.code_changes.join(" | ") || "-"}`,
              `完整原始发言: .opencode/groupchat/raw_messages.json`,
            ].join("\n")
            if (draft.session.mode === "team_dev" && draft.session.team_dev) {
              draft.session.summary += `\n【任务看板】\n${boardText(draft.session.team_dev)}`
            }
          }

          if (!args.decision) {
            draft.session.phase = "summary"
            collect()
            writeJson(p.draft, draft)
            writeAuditEvent(directory, "summary_selected", { sessionId: ctx.sessionID, decision: "pending", modelId: args.modelId })
            return [
              draft.session.summary,
              `决策选项：`,
              `① continue - 保留模式和成员，轮次重置为 1，重新开始讨论`,
              `② converge - 所有任务完成，标记收敛结束`,
              `③ finalize - 强制终止整个会话（用户拥有最高优先级，无论任务是否完成）`,
              `请回复 decision=continue/converge/finalize，如需指定总结模型再传 modelId=fullId。`,
            ].join("\n")
          }

          const valid = ["continue", "converge", "finalize"]
          if (!valid.includes(args.decision)) {
            return `consult: 无效决策 '${args.decision}'。有效选项: continue, converge, finalize`
          }
          if (args.decision === "continue") {
            draft.session.phase = draft.session.mode === "team_dev" ? "team_dev" : "independent"
            draft.session.round = 1
            draft.session.done = false
            draft.session.done_reason = undefined
            if (draft.session.team_dev) resetSpoken(draft, [draft.session.team_dev.architect, ...draft.session.team_dev.devs])
            writeAuditEvent(directory, "summary_selected", { sessionId: ctx.sessionID, decision: "continue", modelId: args.modelId })
            writeJson(p.draft, draft)
            return "consult: 已清除总结阶段，轮次重置为 1，继续讨论循环。"
          }
          draft.session.done = true
          draft.session.done_reason = args.decision === "converge" ? "user_converge" : "final_answer_confirmed"
          writeAuditEvent(directory, "summary_selected", { sessionId: ctx.sessionID, decision: args.decision, modelId: args.modelId })
          writeJson(p.draft, draft)
          return args.decision === "converge" && !wasDone
            ? "consult: 已收敛结束。会话标记 done，done_reason=user_converge。"
            : args.decision === "finalize"
              ? "consult: 确定答案，会话强制终止，done_reason=final_answer_confirmed。"
              : "consult: 会话已处于结束状态，汇总如上（decision 已确认）。"
        },
      }),
      consult_rotate: tool({
        description: "手动触发审计日志轮转：当前 audit.log 归档到 archive/audit-archive-N.log，记录 audit_archived 事件，extension 字段预留扩展。",
        args: {},
        async execute() {
          const before = getArchiveNumber(groupchat_dir(directory))
          rotateAuditLog(directory)
          const after = getArchiveNumber(groupchat_dir(directory))
          return after > before ? `consult: 审计日志已轮转，归档至 archive/audit-archive-${after}.log。` : "consult: 当前无 audit.log，无需轮转。"
        },
      }),
      consult_status: tool({
        description: "会诊模式：查看完整状态（草稿 + 最近发言）。",
        args: {},
        async execute(args, ctx) {
          const draft = loadDraftValidated(directory, ctx.sessionID)
          const raws = readRaw(directory)
          const recent = raws.slice(-8).map((m) => `[${m.id}] ${m.speaker}: ${m.text.slice(0, 300)}`).join("\n") || "-"
          const lines: string[] = [
            `active=${draft.session.active} round=${draft.session.round} phase=${draft.session.phase} mode=${draft.session.mode || "-"} done=${draft.session.done}`,
            `goal: ${draft.goal}`,
            `agreed(${draft.agreed.length}): ${draft.agreed.join(" | ") || "-"}`,
            `open_issues(${draft.open_issues.length}): ${draft.open_issues.join(" | ") || "-"}`,
            `risks: ${draft.risks.join(" | ") || "-"}`,
            `code_changes: ${draft.code_changes.join(" | ") || "-"}`,
            `recent:\n${recent}`,
            `文件: .opencode/groupchat/ 下的 shared_draft.json / raw_messages.json`,
          ]
          if (draft.session.mode === "team_dev" && draft.session.team_dev) {
            lines.push(`【任务看板】\n${boardText(draft.session.team_dev)}`)
          }
          return lines.join("\n")
        },
      }),
      consult_reset: tool({
        description: "会诊模式：清空会话状态与消息（含 /reset-consult 逃生指令，解除保密档位锁定与超时状态）。主会话独占，子代理调用将被拒绝。",
        args: {},
        async execute(args, ctx) {
          const draft = loadDraftValidated(directory, ctx.sessionID)
          const deniedReset = checkSessionOwner(directory, draft, ctx.sessionID, "consult_reset")
          if (deniedReset) return deniedReset
          writeAuditEvent(directory, "consult-reset", { sessionId: ctx.sessionID })
          writeJson(p.draft, empty_draft())
          writeJson(p.raw, [])
          return "consult: 已重置，保密档位锁定已解除，会诊状态已清空。"
        },
      }),
    },
  }
}