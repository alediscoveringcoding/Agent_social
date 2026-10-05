/**
 * A Supabase client for tests: the subset of supabase-js this app uses,
 * answered by PGlite the way PostgREST would (rows as JSON, timestamps as
 * strings, Postgres error codes passed through), plus an in-memory Storage.
 *
 * Supported: select (columns, `alias:col`, `*`, embeds `rel(...)` /
 * `alias:rel!hint(...)` resolved through foreign keys, `col->>key`), filters
 * eq / neq / in / is / not(is) / lt / lte / gt / gte / ilike, order, limit,
 * range, single, maybeSingle, count/head, insert / update / upsert / delete
 * with an optional `.select()`, and rpc. Anything else throws, so a test
 * never passes on a feature the fake silently ignores.
 */

import type { PGlite } from '@electric-sql/pglite'

export interface PgError {
  code: string
  message: string
  details: string | null
  hint: string | null
}

export interface Result<T = unknown> {
  data: T | null
  error: PgError | null
  count?: number | null
}

interface ForeignKey {
  name: string
  table: string
  column: string
  ftable: string
  fcolumn: string
}

const IDENT = /^[a-z_][a-z0-9_]*$/i

function ident(name: string): string {
  if (!IDENT.test(name)) throw new Error(`fake-supabase: bad identifier ${name}`)
  return `"${name}"`
}

function toPgError(e: unknown): PgError {
  const err = e as { code?: string; message?: string; detail?: string; hint?: string }
  return {
    code: err.code ?? 'UNKNOWN',
    message: err.message ?? String(e),
    details: err.detail ?? null,
    hint: err.hint ?? null,
  }
}

class Params {
  values: unknown[] = []
  add(value: unknown): string {
    this.values.push(value)
    return `$${this.values.length}`
  }
}

/** `col`, `col->key`, `col->>key` on a table alias. */
function columnExpr(alias: string, column: string): string {
  const m = /^([a-z_][a-z0-9_]*)((?:->>?[a-z0-9_]+)*)$/i.exec(column.trim())
  if (!m) throw new Error(`fake-supabase: unsupported column ${column}`)
  let expr = `${alias}.${ident(m[1])}`
  for (const part of m[2].match(/->>?[a-z0-9_]+/gi) ?? []) {
    const op = part.startsWith('->>') ? '->>' : '->'
    expr += `${op}'${part.slice(op.length)}'`
  }
  return expr
}

function splitTopLevel(s: string): string[] {
  const out: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of s) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) {
      if (cur.trim()) out.push(cur.trim())
      cur = ''
    } else cur += ch
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

let aliasSeq = 0

class FakeDb {
  private fks: ForeignKey[] | null = null
  private ready: Promise<void> | null = null
  readonly db: PGlite
  constructor(db: PGlite) {
    this.db = db
  }

  init(): Promise<void> {
    this.ready ??= this.db.exec(`set time zone 'UTC'`).then(() => undefined)
    return this.ready
  }

  async foreignKeys(): Promise<ForeignKey[]> {
    if (this.fks) return this.fks
    const { rows } = await this.db.query<ForeignKey>(`
      select con.conname as name, cl.relname as table, a.attname as column,
             clf.relname as ftable, af.attname as fcolumn
        from pg_constraint con
        join pg_class cl on cl.oid = con.conrelid
        join pg_class clf on clf.oid = con.confrelid
        join pg_attribute a on a.attrelid = con.conrelid and a.attnum = con.conkey[1]
        join pg_attribute af on af.attrelid = con.confrelid and af.attnum = con.confkey[1]
       where con.contype = 'f' and cl.relnamespace = 'public'::regnamespace`)
    this.fks = rows
    return rows
  }

  /** A jsonb expression for one row of `table` aliased `alias`, projected by `select`. */
  async projection(table: string, alias: string, select: string): Promise<string> {
    const items = splitTopLevel(select || '*')
    const parts: string[] = []
    const pairs: string[] = []
    for (const item of items) {
      if (item === '*') {
        parts.push(`to_jsonb(${alias})`)
        continue
      }
      const embed = /^(?:([a-z_][a-z0-9_]*):)?([a-z_][a-z0-9_]*)(?:!([a-z_][a-z0-9_]*))?\((.*)\)$/is.exec(item)
      if (embed) {
        const [, as, rel, hint, inner] = embed
        pairs.push(`'${as ?? rel}'`, await this.embedExpr(table, alias, rel, hint, inner))
        continue
      }
      const plain = /^(?:([a-z_][a-z0-9_]*):)?(.+)$/i.exec(item)
      if (!plain) throw new Error(`fake-supabase: unsupported select item ${item}`)
      const [, as, col] = plain
      const key = as ?? col.split(/->>?/).pop()!
      pairs.push(`'${key}'`, columnExpr(alias, col))
    }
    if (pairs.length) parts.push(`jsonb_build_object(${pairs.join(', ')})`)
    return parts.length ? parts.join(' || ') : `'{}'::jsonb`
  }

  private async embedExpr(table: string, alias: string, rel: string, hint: string | undefined, inner: string) {
    const fks = await this.foreignKeys()
    const matches = (fk: ForeignKey) => !hint || fk.name === hint || fk.column === hint
    const toOne = fks.filter((fk) => fk.table === table && fk.ftable === rel && matches(fk))
    const toMany = fks.filter((fk) => fk.table === rel && fk.ftable === table && matches(fk))
    if (toOne.length + toMany.length !== 1) {
      throw new Error(`fake-supabase: ${toOne.length + toMany.length} relationships between ${table} and ${rel}; add a !hint`)
    }
    const sub = `e${++aliasSeq}`
    const proj = await this.projection(rel, sub, inner)
    if (toOne.length) {
      const fk = toOne[0]
      return `(select ${proj} from public.${ident(rel)} ${sub} where ${sub}.${ident(fk.fcolumn)} = ${alias}.${ident(fk.column)})`
    }
    const fk = toMany[0]
    return `coalesce((select jsonb_agg(${proj}) from public.${ident(rel)} ${sub} where ${sub}.${ident(fk.column)} = ${alias}.${ident(fk.fcolumn)}), '[]'::jsonb)`
  }

  async run<T>(sql: string, params: Params): Promise<{ rows: T[] }> {
    await this.init()
    return this.db.query<T>(sql, params.values)
  }
}

type Op = 'select' | 'insert' | 'update' | 'upsert' | 'delete'

class QueryBuilder implements PromiseLike<Result> {
  private op: Op = 'select'
  private columns = '*'
  private returning: string | null = null
  private filters: Array<(alias: string, p: Params) => string> = []
  private orders: string[] = []
  private limitN: number | null = null
  private offsetN: number | null = null
  private mode: 'many' | 'single' | 'maybe' = 'many'
  private countMode: { head: boolean } | null = null
  private payload: Record<string, unknown>[] = []
  private conflict: { columns: string[]; ignore: boolean } | null = null

  private readonly fake: FakeDb
  private readonly table: string
  constructor(fake: FakeDb, table: string) {
    ident(table)
    this.fake = fake
    this.table = table
  }

  select(columns = '*', opts?: { count?: 'exact'; head?: boolean }) {
    if (this.op === 'select') this.columns = columns
    else this.returning = columns
    if (opts?.count) this.countMode = { head: opts.head === true }
    return this
  }
  insert(rows: Record<string, unknown> | Record<string, unknown>[]) {
    this.op = 'insert'
    this.payload = Array.isArray(rows) ? rows : [rows]
    return this
  }
  upsert(rows: Record<string, unknown> | Record<string, unknown>[], opts: { onConflict?: string; ignoreDuplicates?: boolean } = {}) {
    this.op = 'upsert'
    this.payload = Array.isArray(rows) ? rows : [rows]
    this.conflict = {
      columns: (opts.onConflict ?? 'id').split(',').map((c) => c.trim()),
      ignore: opts.ignoreDuplicates === true,
    }
    return this
  }
  update(patch: Record<string, unknown>) {
    this.op = 'update'
    this.payload = [patch]
    return this
  }
  delete() {
    this.op = 'delete'
    return this
  }

  private cmp(col: string, op: string, value: unknown) {
    this.filters.push((a, p) => `${columnExpr(a, col)} ${op} ${p.add(value)}`)
    return this
  }
  eq(col: string, v: unknown) {
    return this.cmp(col, '=', v)
  }
  neq(col: string, v: unknown) {
    return this.cmp(col, '<>', v)
  }
  lt(col: string, v: unknown) {
    return this.cmp(col, '<', v)
  }
  lte(col: string, v: unknown) {
    return this.cmp(col, '<=', v)
  }
  gt(col: string, v: unknown) {
    return this.cmp(col, '>', v)
  }
  gte(col: string, v: unknown) {
    return this.cmp(col, '>=', v)
  }
  ilike(col: string, v: string) {
    return this.cmp(col, 'ilike', v)
  }
  in(col: string, values: readonly unknown[]) {
    this.filters.push((a, p) => {
      if (values.length === 0) return 'false'
      return `${columnExpr(a, col)} in (${values.map((v) => p.add(v)).join(', ')})`
    })
    return this
  }
  is(col: string, value: null | boolean) {
    const v = value === null ? 'null' : value ? 'true' : 'false'
    this.filters.push((a) => `${columnExpr(a, col)} is ${v}`)
    return this
  }
  not(col: string, op: string, value: null) {
    if (op !== 'is' || value !== null) throw new Error('fake-supabase: only not(col, "is", null)')
    this.filters.push((a) => `${columnExpr(a, col)} is not null`)
    return this
  }
  order(col: string, opts: { ascending?: boolean; nullsFirst?: boolean } = {}) {
    const asc = opts.ascending !== false
    const nulls = opts.nullsFirst ?? !asc
    this.orders.push(`${col}|${asc ? 'asc' : 'desc'} nulls ${nulls ? 'first' : 'last'}`)
    return this
  }
  limit(n: number) {
    this.limitN = n
    return this
  }
  range(from: number, to: number) {
    this.offsetN = from
    this.limitN = to - from + 1
    return this
  }
  single() {
    this.mode = 'single'
    return this
  }
  maybeSingle() {
    this.mode = 'maybe'
    return this
  }

  private where(alias: string, p: Params): string {
    return this.filters.length ? ` where ${this.filters.map((f) => f(alias, p)).join(' and ')}` : ''
  }

  private async execute(): Promise<Result> {
    const p = new Params()
    const t = ident(this.table)
    let sql: string
    try {
      if (this.op === 'select') {
        if (this.countMode?.head) {
          sql = `select count(*)::int as n from public.${t} t${this.where('t', p)}`
          const { rows } = await this.fake.run<{ n: number }>(sql, p)
          return { data: null, error: null, count: rows[0]?.n ?? 0 }
        }
        const proj = await this.fake.projection(this.table, 't', this.columns)
        const order = this.orders.length
          ? ` order by ${this.orders.map((o) => { const [c, dir] = o.split('|'); return `${columnExpr('t', c)} ${dir}` }).join(', ')}`
          : ''
        const lim = this.limitN !== null ? ` limit ${Number(this.limitN)}` : ''
        const off = this.offsetN !== null ? ` offset ${Number(this.offsetN)}` : ''
        sql = `select ${proj} as row from public.${t} t${this.where('t', p)}${order}${lim}${off}`
        const { rows } = await this.fake.run<{ row: unknown }>(sql, p)
        return this.shape(rows.map((r) => r.row), this.countMode ? rows.length : null)
      }

      let core: string
      if (this.op === 'insert' || this.op === 'upsert') {
        const cols = [...new Set(this.payload.flatMap((r) => Object.keys(r)))]
        cols.forEach(ident)
        const list = cols.map(ident).join(', ')
        core =
          `insert into public.${t} (${list}) select ${list} from ` +
          `json_populate_recordset(null::public.${t}, ${p.add(JSON.stringify(this.payload))}::json)`
        if (this.conflict) {
          const target = this.conflict.columns.map(ident).join(', ')
          const updates = cols.filter((c) => !this.conflict!.columns.includes(c)).map((c) => `${ident(c)} = excluded.${ident(c)}`)
          core += this.conflict.ignore || !updates.length ? ` on conflict (${target}) do nothing` : ` on conflict (${target}) do update set ${updates.join(', ')}`
        }
        core += ' returning *'
      } else if (this.op === 'update') {
        const cols = Object.keys(this.payload[0])
        const sets = cols.map((c) => `${ident(c)} = _r.${ident(c)}`).join(', ')
        core =
          `update public.${t} t set ${sets} from json_populate_record(null::public.${t}, ${p.add(JSON.stringify(this.payload[0]))}::json) _r` +
          `${this.where('t', p)} returning t.*`
      } else {
        core = `delete from public.${t} t${this.where('t', p)} returning t.*`
      }
      const proj = await this.fake.projection(this.table, 'w', this.returning ?? '*')
      sql = `with w as (${core}) select ${proj} as row from w`
      const { rows } = await this.fake.run<{ row: unknown }>(sql, p)
      if (this.returning === null) return { data: null, error: null }
      return this.shape(rows.map((r) => r.row), null)
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('fake-supabase:')) throw e
      return { data: null, error: toPgError(e) }
    }
  }

  private shape(rows: unknown[], count: number | null): Result {
    if (this.mode === 'many') return { data: rows, error: null, count }
    if (rows.length === 1) return { data: rows[0], error: null, count }
    if (rows.length === 0 && this.mode === 'maybe') return { data: null, error: null, count }
    return {
      data: null,
      error: { code: 'PGRST116', message: `JSON object requested, ${rows.length} rows returned`, details: null, hint: null },
      count,
    }
  }

  then<R1 = Result, R2 = never>(
    onfulfilled?: ((value: Result) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null
  ): PromiseLike<R1 | R2> {
    return this.execute().then(onfulfilled, onrejected)
  }
}

class FakeBucket {
  private readonly store: Map<string, { bytes: Uint8Array; contentType: string }>
  private readonly bucket: string
  constructor(store: Map<string, { bytes: Uint8Array; contentType: string }>, bucket: string) {
    this.store = store
    this.bucket = bucket
  }
  private key(path: string) {
    return `${this.bucket}/${path}`
  }
  async createSignedUrls(paths: string[], ttl: number) {
    return {
      data: paths.map((path) => ({ path, signedUrl: `http://storage.test/sign/${this.bucket}/${path}?ttl=${ttl}`, error: null })),
      error: null,
    }
  }
  async createSignedUrl(path: string, ttl: number) {
    return { data: { signedUrl: `http://storage.test/sign/${this.bucket}/${path}?ttl=${ttl}` }, error: null }
  }
  async createSignedUploadUrl(path: string) {
    return {
      data: { path, token: `token-${path}`, signedUrl: `http://storage.test/upload/${this.bucket}/${path}?token=t` },
      error: null,
    }
  }
  async upload(path: string, body: Uint8Array | ArrayBuffer | Blob, opts: { contentType?: string; upsert?: boolean } = {}) {
    if (this.store.has(this.key(path)) && !opts.upsert) {
      return { data: null, error: { message: 'The resource already exists', statusCode: '409' } }
    }
    const bytes =
      body instanceof Blob ? new Uint8Array(await body.arrayBuffer()) : body instanceof ArrayBuffer ? new Uint8Array(body) : body
    this.store.set(this.key(path), { bytes, contentType: opts.contentType ?? 'application/octet-stream' })
    return { data: { path }, error: null }
  }
  async download(path: string) {
    const obj = this.store.get(this.key(path))
    if (!obj) return { data: null, error: { message: 'Object not found', statusCode: '404' } }
    return { data: new Blob([obj.bytes as BlobPart], { type: obj.contentType }), error: null }
  }
  async remove(paths: string[]) {
    for (const p of paths) this.store.delete(this.key(p))
    return { data: paths.map((name) => ({ name })), error: null }
  }
}

export interface FakeSupabase {
  from(table: string): QueryBuilder
  rpc(fn: string, params?: Record<string, unknown>): Promise<Result>
  storage: { from(bucket: string): FakeBucket }
  /** Test helper: the bytes stored at bucket/path. */
  objects: Map<string, { bytes: Uint8Array; contentType: string }>
}

export function createFakeSupabase(db: PGlite): FakeSupabase {
  const fake = new FakeDb(db)
  const objects = new Map<string, { bytes: Uint8Array; contentType: string }>()
  return {
    from: (table: string) => new QueryBuilder(fake, table),
    async rpc(fn: string, params: Record<string, unknown> = {}) {
      const p = new Params()
      const args = Object.entries(params).map(([k, v]) => {
        const value = v !== null && typeof v === 'object' ? JSON.stringify(v) : v
        return `${ident(k)} => ${p.add(value)}`
      })
      try {
        const { rows } = await fake.run<{ result: unknown }>(`select to_jsonb(public.${ident(fn)}(${args.join(', ')})) as result`, p)
        return { data: rows[0]?.result ?? null, error: null }
      } catch (e) {
        return { data: null, error: toPgError(e) }
      }
    },
    storage: { from: (bucket: string) => new FakeBucket(objects, bucket) },
    objects,
  }
}
