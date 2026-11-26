import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

type Row = Record<string, unknown>;
type Db = {
  query(sql: string, params?: unknown[]): Promise<{ rows: Row[] }>;
};

const identifier = (name: string) => {
  if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error(`Invalid fixture identifier: ${name}`);
  return `"${name}"`;
};

const databaseValue = (value: unknown) =>
  value !== null && typeof value === "object" ? JSON.stringify(value) : value;

// A narrow PostgREST adapter. The routes and all stored procedures are real.
export function fixtureDatabase(db: Db) {
  return {
    from(table: string) {
      const relation = `public.${identifier(table)}`;
      const filters: string[] = [];
      const params: unknown[] = [];
      const bind = (value: unknown) => `$${params.push(databaseValue(value))}`;
      let columns = "*";
      let countOnly = false;
      let sort = "";
      let insertion: Row | undefined;
      let update: Row | undefined;

      async function run(single: boolean, required = false) {
        const where = filters.length ? ` where ${filters.join(" and ")}` : "";
        let sql: string;
        if (insertion) {
          const entries = Object.entries(insertion);
          sql = `insert into ${relation} (${entries.map(([name]) => identifier(name)).join(",")}) values (${entries.map(([, value]) => bind(value)).join(",")}) returning ${columns}`;
        } else if (update) {
          const assignments = Object.entries(update).map(([name, value]) => `${identifier(name)} = ${bind(value)}`);
          if (!where) throw new Error("Fixture updates require a filter");
          sql = `update ${relation} set ${assignments.join(",")}${where} returning ${columns}`;
        } else {
          sql = `select ${countOnly ? "count(*)::int as count" : columns} from ${relation}${where}${sort}`;
        }
        const result = await db.query(sql, params);
        // PostgREST delivers timestamps as JSON strings.
        const rows = result.rows.map(row => Object.fromEntries(Object.entries(row).map(
          ([name, value]) => [name, value instanceof Date ? value.toISOString() : value],
        )));
        if (single && (rows.length > 1 || (required && !rows.length))) {
          return { data: null, error: { code: "PGRST116" } };
        }
        return { data: countOnly ? null : single ? rows[0] ?? null : rows, count: rows[0]?.count, error: null };
      }

      const query = {
        select(value: string, options?: { head?: boolean }) {
          columns = value === "*" ? value : value.split(",").map(column => identifier(column.trim())).join(",");
          countOnly = options?.head === true;
          return query;
        },
        eq(column: string, value: unknown) {
          filters.push(`${identifier(column)} = ${bind(value)}`);
          return query;
        },
        is(column: string, value: null) {
          if (value !== null) throw new Error("Fixture only supports the IS NULL check");
          filters.push(`${identifier(column)} is null`);
          return query;
        },
        in(column: string, values: unknown[]) {
          filters.push(values.length ? `${identifier(column)} in (${values.map(bind).join(",")})` : "false");
          return query;
        },
        order(column: string, options?: { ascending?: boolean }) {
          sort = ` order by ${identifier(column)} ${options?.ascending === false ? "desc" : "asc"}`;
          return query;
        },
        insert(value: Row) { insertion = value; return query; },
        update(value: Row) { update = value; return query; },
        single() { return run(true, true); },
        maybeSingle() { return run(true); },
        then(resolve: (result: unknown) => unknown, reject: (reason: unknown) => unknown) {
          return run(false).then(resolve, reject);
        },
      };
      return query;
    },
    async rpc(name: string, inputs: Row) {
      const args = Object.entries(inputs);
      const parameters = args.map(([key], index) => `${identifier(key)} => $${index + 1}`);
      const { rows } = await db.query(
        `select public.${identifier(name)}(${parameters.join(",")}) as result`,
        args.map(([, value]) => databaseValue(value)),
      );
      return { data: rows[0].result, error: null };
    },
  };
}

export async function openPaymentDatabase(entry: string) {
  const { PGlite } = await import(/* @vite-ignore */ pathToFileURL(resolve(entry)).href);
  const db = new PGlite();
  const files = [
    "scripts/fixtures/partner-schema.sql",
    "supabase/migrations/20260824101500_atomic_slickpay_observations.sql",
    "supabase/migrations/20261114193941_partner_program.sql",
    "supabase/migrations/20261126190500_order_activation_revision.sql",
    "supabase/migrations/20261126192500_link_orders_to_customer_identity.sql",
    "supabase/migrations/20261126193500_expire_stalled_wallet_deposits.sql",
  ];
  try {
    for (const file of files) await db.exec(await readFile(new URL(`../../../../${file}`, import.meta.url), "utf8"));
    return db;
  } catch (error) {
    await db.close();
    throw error;
  }
}
