/*
 * opencode (>= 1.0) keeps everything in one SQLite file,
 * ~/.local/share/opencode/opencode.db: session rows (parent_id set for
 * subagent sessions spawned by the task tool), message rows (one per model
 * step, JSON data with role, modelID, path.cwd, finish, error) and part rows
 * (JSON data: text, reasoning, tool {tool, state {status, input, metadata}},
 * step-finish {tokens}, patch, ...). Parts are updated in place as a tool goes
 * pending -> running -> completed | error, so the parser diffs each poll
 * against what it has seen per part id. The SQL pulls only the handful of
 * fields a label needs through json_extract (never prompt text or file
 * contents; a bash output tail only to judge piped test runs), and is shaped
 * to hit opencode's own indexes so a multi-GB database costs a few ms a poll.
 */
import type { RawEvent, ToolCategory } from "../shared/events.ts";
import { categorize } from "./categories.ts";
import { patchFiles } from "./codex.ts";
import { emit, newCtx, setCwd, toolFields, type ParserState, type PendingTool, type WorkerCtx } from "./common.ts";
import { isTestCommand, mcpSummary, outputLooksFailed, shellCategory, shellSummary, testExitHidden, testGuarded, testVerdict, toolSummary } from "./redact.ts";

export interface OcSession {
  id: string;
  parent_id?: string | null;
  directory?: string | null;
  agent?: string | null;
  time_created?: number | null;
  time_updated: number;
}

export interface OcMessage {
  id: string;
  session_id: string;
  time_created: number;
  time_updated: number;
  role?: string | null;
  model?: string | null;
  cwd?: string | null;
  finish?: string | null;
  completed?: number | null;
  err?: string | null;
  /** opencode >= 2: the user message's text length (its text lives on the message, not in a part). */
  text_len?: number | null;
  /** opencode >= 2: tokens are on the message, with no step-finish part. */
  tokens?: number | null;
}

export interface OcPart {
  id: string;
  message_id: string;
  time_created: number;
  time_updated: number;
  type?: string | null;
  tool?: string | null;
  status?: string | null;
  command?: string | null;
  file?: string | null;
  path?: string | null;
  pattern?: string | null;
  include?: string | null;
  url?: string | null;
  subagent?: string | null;
  skill?: string | null;
  exit?: number | null;
  out?: string | null;
  files?: string | null;
  patch?: string | null;
  synthetic?: number | boolean | null;
  text_len?: number | null;
  tokens?: number | null;
}

interface MsgSeen {
  prompted: boolean;
  done: boolean;
  errored: boolean;
  /** Whether a v2 message's tokens have already been counted. */
  counted?: boolean;
}

export interface OpencodeState extends ParserState {
  msgs: Map<string, MsgSeen>;
  /** Part id -> last status seen ("" for parts without one). */
  parts: Map<string, string>;
}

/** opencode's own tools; anything else named server_tool is an MCP tool. */
const BUILTIN = new Set(
  `bash read write edit multiedit patch apply_patch grep glob list ls webfetch websearch codesearch todowrite
   todoread task skill question lsp batch invalid plan_enter plan_exit pty_spawn pty_read pty_write pty_kill
   pty_list aside_repl`.split(/\s+/),
);
const DONE = new Set(["completed", "error"]);
const MID_TURN = new Set(["tool-calls", "unknown"]);

export function createOpencodeState(s: OcSession): OpencodeState {
  const main = newCtx("opencode", s.id, s.parent_id ? { parentId: s.parent_id, role: s.agent || "subagent" } : {});
  if (s.directory) setCwd(main, s.directory);
  return { main, workers: new Map([[main.workerId, main]]), msgs: new Map(), parts: new Map() };
}

const iso = (ms: unknown) => new Date(typeof ms === "number" && Number.isFinite(ms) ? ms : Date.now()).toISOString();

function trim<K, V>(m: Map<K, V>, max: number): void {
  while (m.size > max) m.delete(m.keys().next().value!);
}

/** Fold one poll's rows for a session in; returns only what changed since the last poll. */
export function applyOpencode(state: OpencodeState, messages: OcMessage[], parts: OcPart[]): RawEvent[] {
  const ctx = state.main;
  const byMsg = new Map<string, OcPart[]>();
  for (const p of parts) {
    let l = byMsg.get(p.message_id);
    if (!l) byMsg.set(p.message_id, (l = []));
    l.push(p);
  }
  const out: RawEvent[] = [];
  const msgs = [...messages].sort((a, b) => a.time_created - b.time_created || (a.id < b.id ? -1 : 1));
  for (const m of msgs) {
    let ms = state.msgs.get(m.id);
    if (!ms) {
      state.msgs.set(m.id, (ms = { prompted: false, done: false, errored: false }));
      trim(state.msgs, 400);
    }
    const ps = (byMsg.get(m.id) ?? []).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    if (m.role === "user") {
      if (ms.prompted) continue;
      if (ps.some((p) => p.type === "compaction")) {
        ms.prompted = true;
        continue;
      }
      // In opencode >= 2 the user text sits on the message itself (no text part).
      if (ps.some((p) => (p.type === "text" && !p.synthetic && (p.text_len ?? 0) > 0) || p.type === "file") || (m.text_len ?? 0) > 0) {
        ms.prompted = true;
        ctx.pending.clear();
        out.push(...emit(ctx, "prompt", iso(m.time_created), { summary: "New prompt" }));
      }
      continue;
    }
    if (m.role !== "assistant") continue;
    if (m.model) ctx.model = m.model;
    if (m.cwd) setCwd(ctx, m.cwd);
    for (const p of ps) out.push(...part(state, ctx, p));
    // opencode >= 2 has no step-finish part: the message carries the tokens. Count
    // them after the parts, where 1.x's step-finish part used to contribute them.
    if (typeof m.tokens === "number" && m.tokens > 0 && !ms.counted) {
      ms.counted = true;
      ctx.pendingTokens += m.tokens;
    }
    if (m.err && !ms.errored) {
      ms.errored = ms.done = true;
      ctx.pending.clear();
      const aborted = /Abort/i.test(m.err);
      out.push(...emit(ctx, "error", iso(m.completed ?? m.time_updated), { summary: aborted ? "Interrupted" : /API/i.test(m.err) ? "API error" : "Error", isError: true }));
    } else if (m.completed && !ms.done) {
      ms.done = true;
      if (!MID_TURN.has(m.finish ?? "")) {
        const ts = iso(m.completed);
        ctx.pending.clear();
        out.push(...emit(ctx, "reply", ts, { summary: "Replied" }));
        out.push(...(ctx.parentId ? emit(ctx, "subagent_end", ts) : emit(ctx, "waiting", ts, { summary: "Waiting" })));
      }
    }
  }
  return out;
}

function part(state: OpencodeState, ctx: WorkerCtx, p: OcPart): RawEvent[] {
  const prev = state.parts.get(p.id);
  const status = p.status ?? "";
  if (prev !== undefined && (p.type !== "tool" || prev === status || DONE.has(prev))) return [];
  state.parts.set(p.id, status);
  trim(state.parts, 2_000);
  switch (p.type) {
    case "reasoning":
      return emit(ctx, "thinking", iso(p.time_created), { summary: "Thinking" });
    case "text":
      return (p.text_len ?? 0) > 0 ? emit(ctx, "thinking", iso(p.time_created), { summary: "Thinking" }) : [];
    case "step-finish":
      if (typeof p.tokens === "number" && p.tokens > 0) ctx.pendingTokens += p.tokens;
      return [];
    case "tool":
      return tool(ctx, p, prev, status);
    default:
      return [];
  }
}

function tool(ctx: WorkerCtx, p: OcPart, prev: string | undefined, status: string): RawEvent[] {
  const out: RawEvent[] = [];
  let pend = ctx.pending.get(p.id);
  if (prev === undefined) {
    pend = pendingFor(p);
    ctx.pending.set(p.id, pend);
    out.push(...emit(ctx, "tool_start", iso(p.time_created), toolFields(pend)));
    if (pend.tool === "question" && !DONE.has(status)) out.push(...emit(ctx, "waiting", iso(p.time_created), { summary: "Needs you" }));
  }
  if (!DONE.has(status)) return out;
  ctx.pending.delete(p.id);
  const ts = iso(p.time_updated);
  const exit = typeof p.exit === "number" ? p.exit : undefined;
  const isError = status === "error" || (exit !== undefined && exit !== 0);
  out.push(...emit(ctx, "tool_end", ts, { ...toolFields(pend), ...(isError ? { isError: true } : {}) }));
  if (pend?.test) {
    const failed = isError || (!!pend.piped && outputLooksFailed(p.out ?? ""));
    const verdict = testVerdict(pend, failed, p.out ?? "");
    if (verdict) out.push(...emit(ctx, verdict, ts, { ...toolFields(pend), ...(verdict === "test_fail" ? { isError: true } : {}) }));
  }
  return out;
}

function pendingFor(p: OcPart): PendingTool {
  const name = p.tool || "tool";
  if (name === "bash") {
    const cmd = p.command ?? "";
    const pend: PendingTool = { tool: name, category: shellCategory(cmd), summary: shellSummary(cmd), test: false };
    if (isTestCommand(cmd)) {
      pend.test = true;
      pend.piped = testExitHidden(cmd);
      pend.guarded = testGuarded(cmd);
    }
    return pend;
  }
  if (!BUILTIN.has(name) && name.includes("_")) {
    const i = name.indexOf("_");
    return { tool: name, category: "mcp", summary: mcpSummary(`mcp__${name.slice(0, i)}__${name.slice(i + 1)}`), test: false };
  }
  const category: ToolCategory = categorize(name);
  const files = p.files ? p.files.split("\n").filter(Boolean) : p.patch ? patchFiles(p.patch) : undefined;
  const summary = toolSummary(name, category, {
    file: p.file,
    ...(files?.length ? { files } : {}),
    url: p.url,
    glob: name === "glob" ? p.pattern : p.include,
    path: p.path,
    subagentType: p.subagent,
    skill: p.skill,
  });
  return { tool: name, category, summary, test: false };
}

/* ------------------------------------------------------------------- SQL */

/** Columns of opencode's session table vary by version; only ask for what exists. */
export function sessionSql(cols: Set<string>, where: "updated" | "id", table = "session"): string {
  const agent = cols.has("agent") ? "agent" : "null as agent";
  const archived = cols.has("time_archived") ? " and time_archived is null" : "";
  return where === "updated"
    ? `select id, parent_id, directory, ${agent}, time_created, time_updated from ${table} where time_updated > ?${archived} order by time_updated limit 200`
    : `select id, parent_id, directory, ${agent}, time_created, time_updated from ${table} where id = ?`;
}

const ph = (n: number) => Array.from({ length: n }, () => "?").join(",");

/** The latest `limit` messages of each session (the index on (session_id, time_created, id) does the work). */
export function messagesSql(sessions: number): string {
  return `with r as (select id, row_number() over (partition by session_id order by time_created desc, id desc) as rn from message where session_id in (${ph(sessions)}))
select m.id as id, m.session_id as session_id, m.time_created as time_created, m.time_updated as time_updated,
json_extract(m.data,'$.role') as role, json_extract(m.data,'$.modelID') as model, json_extract(m.data,'$.path.cwd') as cwd,
json_extract(m.data,'$.finish') as finish, json_extract(m.data,'$.time.completed') as completed, json_extract(m.data,'$.error.name') as err
from message m join r on r.id = m.id where r.rn <= ?`;
}

const J = (path: string) => `json_extract(p.data,'${path}')`;

/** Parts of the latest `limit` messages of each session: same window as messagesSql, so both can run at once. */
export function partsSql(sessions: number): string {
  return `with r as (select id, row_number() over (partition by session_id order by time_created desc, id desc) as rn from message where session_id in (${ph(sessions)})),
m as (select id from r where rn <= ?)
select p.id as id, p.message_id as message_id, p.time_created as time_created, p.time_updated as time_updated,
${J("$.type")} as type, ${J("$.tool")} as tool, ${J("$.state.status")} as status,
substr(${J("$.state.input.command")},1,4000) as command,
coalesce(${J("$.state.input.filePath")}, ${J("$.state.input.file_path")}) as file,
${J("$.state.input.path")} as path, ${J("$.state.input.pattern")} as pattern, ${J("$.state.input.include")} as include,
${J("$.state.input.url")} as url, ${J("$.state.input.subagent_type")} as subagent, ${J("$.state.input.name")} as skill,
${J("$.state.metadata.exit")} as exit,
case when ${J("$.tool")} = 'bash' and ${J("$.state.status")} in ('completed','error') then substr(${J("$.state.output")}, -20000) end as out,
case when ${J("$.tool")} = 'apply_patch' then (select group_concat(coalesce(json_extract(f.value,'$.relativePath'), json_extract(f.value,'$.filePath')), char(10)) from json_each(p.data,'$.state.metadata.files') f) end as files,
case when ${J("$.tool")} = 'apply_patch' then substr(${J("$.state.input.patchText")},1,4000) end as patch,
${J("$.synthetic")} as synthetic,
case when ${J("$.type")} = 'text' then length(${J("$.text")}) end as text_len,
case when ${J("$.type")} = 'step-finish' then coalesce(${J("$.tokens.total")}, coalesce(${J("$.tokens.input")},0) + coalesce(${J("$.tokens.output")},0) + coalesce(${J("$.tokens.reasoning")},0) + coalesce(${J("$.tokens.cache.read")},0) + coalesce(${J("$.tokens.cache.write")},0)) end as tokens
from part p where p.message_id in (select id from m)`;
}

/* -------------------------------------------- opencode >= 2.x schema */

/*
 * 2.x renamed the tables (session_v2, session_message) and folded parts into
 * each message's data.content[] JSON; there is no step-finish part any more
 * (tokens live on the message). These queries reshape that layout into the
 * OcMessage / OcPart rows applyOpencode() already understands, and map the
 * renamed tools back to their 1.x names so the rest of the parser is shared:
 * shell/execute -> bash, subagent -> task, patch -> apply_patch. As with the
 * 1.x queries, no prompt, reasoning or file text is ever selected.
 */
export function messagesSqlV2(sessions: number): string {
  return `with r as (select id, row_number() over (partition by session_id order by time_created desc, id desc) as rn from session_message where session_id in (${ph(sessions)}))
select m.id as id, m.session_id as session_id, m.time_created as time_created, m.time_updated as time_updated,
m.type as role, json_extract(m.data,'$.model.id') as model, null as cwd,
json_extract(m.data,'$.finish') as finish,
case when json_extract(m.data,'$.finish') is not null and json_extract(m.data,'$.finish') not in ('tool-calls','unknown') then m.time_updated end as completed,
coalesce(json_extract(m.data,'$.error.name'), json_extract(m.data,'$.error.type'), json_extract(m.data,'$.error.message')) as err,
case when m.type = 'user' then length(json_extract(m.data,'$.text')) end as text_len,
coalesce(json_extract(m.data,'$.tokens.total'),
  coalesce(json_extract(m.data,'$.tokens.input'),0) + coalesce(json_extract(m.data,'$.tokens.output'),0)
  + coalesce(json_extract(m.data,'$.tokens.reasoning'),0)
  + coalesce(json_extract(m.data,'$.tokens.cache.read'),0)
  + coalesce(json_extract(m.data,'$.tokens.cache.write'),0)) as tokens
from session_message m join r on r.id = m.id where r.rn <= ?`;
}

export function partsSqlV2(sessions: number): string {
  const V = (path: string) => `json_extract(p.value,'${path}')`;
  const name = V("$.name");
  const tool = `case ${name} when 'shell' then 'bash' when 'execute' then 'bash' when 'subagent' then 'task' when 'patch' then 'apply_patch' else ${name} end`;
  return `with r as (select id, row_number() over (partition by session_id order by time_created desc, id desc) as rn from session_message where session_id in (${ph(sessions)})),
m as (select id from r where rn <= ?),
w as (select id, data, time_created, time_updated from session_message where id in (select id from m))
select coalesce(${V("$.id")}, w.id || ':' || p.key) as id, w.id as message_id,
coalesce(${V("$.time.created")}, w.time_created) as time_created,
coalesce(${V("$.time.completed")}, w.time_updated) as time_updated,
${V("$.type")} as type, ${tool} as tool, ${V("$.state.status")} as status,
substr(${V("$.state.input.command")},1,4000) as command,
coalesce(${V("$.state.input.filePath")}, ${V("$.state.input.file_path")}, ${V("$.state.input.path")}) as file,
${V("$.state.input.path")} as path, ${V("$.state.input.pattern")} as pattern, ${V("$.state.input.include")} as include,
${V("$.state.input.url")} as url,
coalesce(${V("$.state.input.subagent_type")}, ${V("$.state.input.agent")}) as subagent,
${V("$.state.input.name")} as skill,
${V("$.state.metadata.exit")} as exit,
case when ${name} in ('shell','bash','execute') and ${V("$.state.status")} in ('completed','error')
  then substr(coalesce(${V("$.state.content[0].text")}, ${V("$.state.output")}), -20000) end as out,
case when ${name} in ('patch','apply_patch') then (select group_concat(coalesce(json_extract(f.value,'$.relativePath'), json_extract(f.value,'$.filePath'), json_extract(f.value,'$.file')), char(10)) from json_each(p.value,'$.state.metadata.files') f) end as files,
case when ${name} in ('patch','apply_patch') then substr(${V("$.state.input.patchText")},1,4000) end as patch,
${V("$.synthetic")} as synthetic,
case when ${V("$.type")} = 'text' then length(${V("$.text")}) end as text_len
from w, json_each(w.data, '$.content') p`;
}

/** Rows come back loosely typed (and from a remote's sqlite3 CLI); keep only well-formed ones. */
export function asSession(r: Record<string, unknown>): OcSession | null {
  if (typeof r.id !== "string" || typeof r.time_updated !== "number") return null;
  return r as unknown as OcSession;
}
export function asMessage(r: Record<string, unknown>): OcMessage | null {
  if (typeof r.id !== "string" || typeof r.session_id !== "string" || typeof r.time_created !== "number") return null;
  return r as unknown as OcMessage;
}
export function asPart(r: Record<string, unknown>): OcPart | null {
  if (typeof r.id !== "string" || typeof r.message_id !== "string" || typeof r.time_created !== "number") return null;
  return r as unknown as OcPart;
}
