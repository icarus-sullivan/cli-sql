import pg from "pg"
import { search, input } from '@inquirer/prompts';

const { Client } = pg

interface Column {
  name: string
  type: string
  default?: string
  nullable: boolean
  primary?: boolean
}

interface Relation {
  type: "f" | "u"
  source_table: string
  source_column: string
  target_table?: string
  target_column?: string
}

interface TableDefinition {
  name: string
  columns: Column[]
  relations: Relation[]
}

const data: TableDefinition[] = []

const host = process.env.HOST || "localhost"
const port = process.env.PORT || "5432"
const user = process.env.USERNAME || "postgres"
const password = process.env.PASSWORD || "example"
const database = process.env.DATABASE || "foundation"

async function getTables(client: pg.Client): Promise<string[]> {
  return await client
    .query({
      name: "get-table-names",
      text: `select c.relname as table 
from pg_class c
JOIN
    pg_namespace n ON n.oid = c.relnamespace
where c.relkind = 'r'
and n.nspname = 'public'`,
    })
    .then(res => res.rows.map(it => it.table))
}

async function getTableColumns(client: pg.Client, table: string): Promise<Column[]> {
  return await client
    .query({
      name: "get-table-oid",
      text: `SELECT 
  a.attname as "name", 
  pg_catalog.format_type(a.atttypid, a.atttypmod) as "type", 
  (
    SELECT 
      pg_catalog.pg_get_expr(d.adbin, d.adrelid, true) 
    FROM 
      pg_catalog.pg_attrdef d 
    WHERE 
      d.adrelid = a.attrelid 
      AND d.adnum = a.attnum 
      AND a.atthasdef
  ) as "default", 
  a.attnotnull is false as "nullable", 
  (
    select 
      true 
    from 
      pg_constraint pgc 
    where 
      pgc.conrelid = a.attrelid 
      and pgc.contype = 'p' 
      and position(
        a.attname in pg_get_constraintdef(pgc.oid)
      ) > 0 
    limit 
      1
  ) as primary 
FROM 
  pg_class c 
  LEFT JOIN pg_catalog.pg_attribute a on a.attrelid = c.oid 
WHERE 
  c.relname = $1
  AND a.attnum > 0 
  and NOT a.attisdropped 
ORDER BY 
  a.attnum
`,
      values: [table],
    })
    .then(res => res.rows)
}

async function getTableRelations(client: pg.Client, table: string): Promise<Relation[]> {
  return await client
    .query({
      name: "get-table-relations",
      text: `
   SELECT
        o.contype,
        m.relname AS source_table,
        (SELECT
            a.attname 
        FROM
            pg_attribute a 
        WHERE
            a.attrelid = m.oid 
            AND a.attnum = o.conkey[1] 
            AND a.attisdropped = false) AS source_column,
        f.relname AS target_table,
        (SELECT
            a.attname 
        FROM
            pg_attribute a 
        WHERE
            a.attrelid = f.oid 
            AND a.attnum = o.confkey[1] 
            AND a.attisdropped = false) AS target_column 
    FROM
        pg_constraint o 
    LEFT JOIN
        pg_class f 
            ON f.oid = o.confrelid 
    LEFT JOIN
        pg_class m 
            ON m.oid = o.conrelid 
    WHERE
        o.contype in ('f', 'u')
        AND o.conrelid IN (
            SELECT
                oid 
            FROM
                pg_class c 
            WHERE
                c.relkind = 'r'
        )   
        and m.relname = $1
`,
      values: [table],
    })
    .then(res => res.rows)
}


async function loop(client: pg.Client, controller: AbortController) {
  
  const close = () => controller.abort('user requested')

  process.stdin.on('keypress', (_, key) => {
    if (key.ctrl && key.name === 'c') {
      close()
    }
    if (key.name === 'escape') {
      close()
    }
  });

  const whatTable = await search({
    message: 'Table?',
    source: async (input) => {
      if (!data) return []

      return data.filter((def) => input ? def.name.includes(input) : true).map((def: TableDefinition) => ({
        name: def.name,
        value: def.name,
      }))
    },

  }, {
    signal: controller.signal
  });

  if (whatTable) {
    const tableDef: TableDefinition = data.find((it) => it.name === whatTable)

    const whatColumn = await search({
      message: 'Columns?',
      source: async (input) => {
        if (!data) return []

        return tableDef.columns.filter((def) => input ? def.name.includes(input) : true).map((it) => ({
          name: it.name,
          value: it.name,
        }))
      },
    }, { signal: controller.signal });

    if (whatColumn) {
      const condition = await input({ message: 'Query?' }, { signal: controller.signal });

      const results = await client
        .query({
          text: `select * from ${whatTable} where "${whatColumn}" ${condition}`
        }).then((r) => r.rows).catch(console.error)

      console.table(results)
      console.log('')
    }
  }
}

void (async () => {
  const client = new Client({
    user,
    password,
    host,
    port: parseInt(port, 10),
    database,
  })
  await client.connect()

  const tables = await getTables(client)

  for (const table of tables) {
    const [columns, relations] = await Promise.all([getTableColumns(client, table), getTableRelations(client, table)])

    const def: TableDefinition = {
      name: table,
      columns,
      relations,
    }

    data.push(def)
  }

  const controller = new AbortController();
  controller.signal.onabort = () => {
    console.log('calling onabort')
    client.end()
  }

  while(true) {
    await loop(client, controller)
  }
})()
