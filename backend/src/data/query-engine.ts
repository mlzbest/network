import { query } from '../db/pool.js';
import { isKnownTable, isKnownColumn } from '../db/schema-map.js';
import { ownershipWhere, enforceInsertOwner, type Op } from './ownership.js';

export interface Filter {
  t: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'is' | 'like' | 'ilike' | 'in' | 'or' | 'filter';
  c?: string;
  v?: unknown;
  /** or 专用：逗号分隔的 col.op.val 解析后的子条件 */
  parts?: Array<{ c: string; op: string; v: unknown }>;
  /** filter 通用操作符 */
  op?: string;
}

export interface OrderSpec {
  c: string;
  asc?: boolean;
  nullsFirst?: boolean;
}

export interface QuerySpec {
  op: Op;
  table: string;
  columns?: string;
  values?: Record<string, unknown>;
  filters?: Filter[];
  order?: OrderSpec[];
  limit?: number;
  offset?: number;
  single?: boolean;
  maybeSingle?: boolean;
}

const SIMPLE_OP: Record<string, string> = {
  eq: '=',
  neq: '<>',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
  like: 'LIKE',
  ilike: 'ILIKE',
};

class Builder {
  private params: unknown[] = [];
  private idx = 0;

  next(value: unknown): string {
    this.idx += 1;
    this.params.push(value);
    return `$${this.idx}`;
  }

  get length() {
    return this.idx;
  }

  get values() {
    return this.params;
  }
}

function buildFilter(f: Filter, b: Builder): string {
  // .or('col.op.val,col2.op2.val') 原始字符串：客户端直接透传，这里解析
  if (f.t === 'or' && (f as any).raw && !f.parts) {
    f = parseOr((f as any).raw as string);
  }
  const col = f.c!;
  if (f.t === 'in') {
    const arr = Array.isArray(f.v) ? (f.v as unknown[]) : [];
    if (arr.length === 0) return '1=0'; // 空集 → 不匹配任何行
    const placeholders = arr.map((x) => b.next(x));
    return `${col} IN (${placeholders.join(', ')})`;
  }
  if (f.t === 'or') {
    const parts = (f.parts ?? []).map((p) => {
      const inner = buildSimple(p.c, p.op, p.v, b);
      return `(${inner})`;
    });
    return parts.length ? parts.join(' OR ') : '1=0';
  }
  if (f.t === 'is') {
    if (f.v === null || f.v === 'null') return `${col} IS NULL`;
    if (f.v === true || f.v === 'true') return `${col} IS TRUE`;
    if (f.v === false || f.v === 'false') return `${col} IS FALSE`;
    return `${col} IS NULL`;
  }
  if (f.t === 'filter') {
    return buildSimple(col, f.op ?? 'eq', f.v, b);
  }
  return buildSimple(col, f.t, f.v, b);
}

function buildSimple(col: string, op: string, value: unknown, b: Builder): string {
  const sqlOp = SIMPLE_OP[op] ?? '=';
  return `${col} ${sqlOp} ${b.next(value)}`;
}

/**
 * 解析 PostgREST 风格的 `.or('user1_id.eq.x,user2_id.eq.y')` 文本。
 * 仅支持 `col.op.val` 逗号分隔，op ∈ {eq,neq,gt,gte,lt,lte}。
 */
export function parseOr(raw: string): Filter {
  const parts: Array<{ c: string; op: string; v: unknown }> = [];
  for (const seg of raw.split(',')) {
    const m = seg.trim().match(/^(\w+)\.(\w+)\.(.+)$/);
    if (!m) continue;
    parts.push({ c: m[1], op: m[2], v: m[3] });
  }
  return { t: 'or', parts };
}

/**
 * 不允许经 /api/db 下发的敏感列。
 * `profiles` 的 SELECT 对全体登录用户开放（联系人列表/对端资料需要），
 * 若直接 `SELECT *` 会把口令哈希与找回令牌哈希一起返回给前端，必须剔除。
 * 后端 auth 层读这些列走的是 pool.query 直连，不经过本引擎，因此不受影响。
 */
const SENSITIVE_COLUMNS: Record<string, string[]> = {
  profiles: ['password_hash', 'recovery_token_hash'],
};

function stripSensitive(table: string, rows: any[]): any[] {
  const cols = SENSITIVE_COLUMNS[table];
  if (!cols || cols.length === 0) return rows;
  return rows.map((row) => {
    if (!row) return row;
    const copy = { ...row };
    for (const c of cols) delete copy[c];
    return copy;
  });
}

/**
 * 执行一次查询。返回 { data, error }，形状对齐 supabase-js。
 */
export async function runQuery(spec: QuerySpec, uid: string): Promise<{ data: any; error: any }> {
  const { op, table } = spec;
  if (!isKnownTable(table)) {
    return { data: null, error: { message: `未知表: ${table}` } };
  }

  // 列名校验（select 列、values 列）
  if (spec.columns && spec.columns.trim() !== '*') {
    for (const c of spec.columns.split(',')) {
      const col = c.trim();
      if (!isKnownColumn(table, col)) {
        return { data: null, error: { message: `未知列: ${table}.${col}` } };
      }
    }
  }

  const b = new Builder();
  const ownership = ownershipWhere(table, op, uid);

  try {
    if (op === 'select') {
      // ownershipWhere 返回的谓词固定以 $1 引用当前用户，因此必须在任何
      // 过滤参数之前占用 $1，否则 $1 会被第一个 filter 值抢占（越权）或空缺（报错）。
      if (ownership) b.next(uid);
      const cols = spec.columns && spec.columns.trim() !== '*' ? spec.columns : '*';
      let sql = `SELECT ${cols} FROM ${table}`;
      const where: string[] = [];
      if (ownership) where.push(ownership.sql);
      for (const f of spec.filters ?? []) {
        where.push(buildFilter(f, b));
      }
      if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
      for (const o of spec.order ?? []) {
        if (!isKnownColumn(table, o.c)) {
          return { data: null, error: { message: `未知排序列: ${table}.${o.c}` } };
        }
      }
      if (spec.order?.length) {
        sql +=
          ' ORDER BY ' +
          spec.order
            .map((o) => {
              const dir = o.asc === false ? 'DESC' : 'ASC';
              const nulls = o.nullsFirst ? ' NULLS FIRST' : o.asc === false ? ' NULLS LAST' : '';
              return `${o.c} ${dir}${nulls}`;
            })
            .join(', ');
      }
      if (typeof spec.limit === 'number') sql += ` LIMIT ${Math.max(0, Math.floor(spec.limit))}`;
      if (typeof spec.offset === 'number') sql += ` OFFSET ${Math.max(0, Math.floor(spec.offset))}`;
      const res = await query(sql, b.values);
      return finalizeSelect(stripSensitive(table, res.rows), spec);
    }

    if (op === 'insert') {
      const values = await enforceInsertOwner(table, spec.values ?? {}, uid);
      const cols = Object.keys(values);
      if (cols.length === 0) {
        return { data: null, error: { message: 'insert 至少需要一个字段' } };
      }
      const placeholders = cols.map((c) => b.next((values as any)[c]));
      const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders.join(
        ', ',
      )}) RETURNING *`;
      const res = await query(sql, b.values);
      // insert 同样要支持 .select(...).single()：PostgREST 语义下返回插入行本身
      return finalizeSelect(stripSensitive(table, res.rows), spec);
    }

    if (op === 'update') {
      // 同 select：先占用 $1 供 ownership 谓词使用，再生成 SET 参数
      if (ownership) b.next(uid);
      const values = spec.values ?? {};
      const setCols = Object.keys(values);
      if (setCols.length === 0) {
        return { data: null, error: { message: 'update 至少需要一个字段' } };
      }
      const sets = setCols.map((c) => `${c} = ${b.next((values as any)[c])}`);
      let sql = `UPDATE ${table} SET ${sets.join(', ')}`;
      const where: string[] = [];
      if (ownership) where.push(ownership.sql);
      for (const f of spec.filters ?? []) where.push(buildFilter(f, b));
      if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
      sql += ' RETURNING *';
      const res = await query(sql, b.values);
      return finalizeSelect(stripSensitive(table, res.rows), spec);
    }

    if (op === 'delete') {
      // 同 select：先占用 $1 供 ownership 谓词使用
      if (ownership) b.next(uid);
      let sql = `DELETE FROM ${table}`;
      const where: string[] = [];
      if (ownership) where.push(ownership.sql);
      for (const f of spec.filters ?? []) where.push(buildFilter(f, b));
      if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
      sql += ' RETURNING *';
      const res = await query(sql, b.values);
      return finalizeSelect(stripSensitive(table, res.rows), spec);
    }

    return { data: null, error: { message: `不支持的操作: ${op}` } };
  } catch (e: any) {
    return { data: null, error: { message: e?.message ?? String(e) } };
  }
}

function finalizeSelect(
  rows: any[],
  spec: QuerySpec,
): { data: any; error: any } {
  if (spec.single || spec.maybeSingle) {
    if (rows.length > 1) {
      return { data: null, error: { message: '结果多于 1 行（single/maybeSingle 要求唯一）' } };
    }
    if (rows.length === 0) {
      if (spec.single) return { data: null, error: { message: '没有找到结果', code: 'PGRST116' } };
      return { data: null, error: null };
    }
    return { data: rows[0], error: null };
  }
  return { data: rows, error: null };
}
