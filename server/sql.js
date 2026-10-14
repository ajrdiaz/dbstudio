// SQL helpers: safe identifier/value quoting and schema introspection queries.

export function quoteId(name) {
  return '`' + String(name).replace(/`/g, '``') + '`';
}

export function quoteVal(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? '1' : '0';
  // Escape per MySQL string literal rules.
  const s = String(v).replace(/[\0\x08\x09\x1a\n\r"'\\%]/g, (ch) => {
    switch (ch) {
      case '\0': return '\\0';
      case '\x08': return '\\b';
      case '\x09': return '\\t';
      case '\x1a': return '\\Z';
      case '\n': return '\\n';
      case '\r': return '\\r';
      case '"':
      case "'":
      case '\\':
        return '\\' + ch;
      default:
        return ch;
    }
  });
  return "'" + s + "'";
}

export async function listDatabases(pool) {
  const [rows] = await pool.query(
    `SELECT schema_name AS name, default_character_set_name AS charset,
            default_collation_name AS collation
       FROM information_schema.schemata
      ORDER BY schema_name`
  );
  return rows;
}

export async function listObjects(pool, db) {
  const [tables] = await pool.query(
    `SELECT table_name AS name, table_type AS type, engine, table_rows AS \`rows\`,
            data_length AS dataLength, table_comment AS comment
       FROM information_schema.tables
      WHERE table_schema = ?
      ORDER BY table_name`,
    [db]
  );
  const [routines] = await pool.query(
    `SELECT routine_name AS name, routine_type AS type
       FROM information_schema.routines
      WHERE routine_schema = ?
      ORDER BY routine_name`,
    [db]
  );
  const [triggers] = await pool.query(
    `SELECT trigger_name AS name, event_manipulation AS event,
            event_object_table AS tableName, action_timing AS timing
       FROM information_schema.triggers
      WHERE trigger_schema = ?
      ORDER BY trigger_name`,
    [db]
  );
  return {
    tables: tables.filter((t) => t.type === 'BASE TABLE'),
    views: tables.filter((t) => t.type === 'VIEW'),
    procedures: routines.filter((r) => r.type === 'PROCEDURE'),
    functions: routines.filter((r) => r.type === 'FUNCTION'),
    triggers,
  };
}

export async function tableColumns(pool, db, table) {
  const [rows] = await pool.query(
    `SELECT column_name AS name, column_type AS type, is_nullable AS nullable,
            column_key AS keyType, column_default AS defaultValue, extra,
            column_comment AS comment, character_set_name AS charset,
            collation_name AS collation, ordinal_position AS position
       FROM information_schema.columns
      WHERE table_schema = ? AND table_name = ?
      ORDER BY ordinal_position`,
    [db, table]
  );
  return rows;
}

export async function tableIndexes(pool, db, table) {
  const [rows] = await pool.query(
    `SELECT index_name AS name, non_unique AS nonUnique, seq_in_index AS seq,
            column_name AS columnName, index_type AS type
       FROM information_schema.statistics
      WHERE table_schema = ? AND table_name = ?
      ORDER BY index_name, seq_in_index`,
    [db, table]
  );
  // group by index name
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.name)) {
      map.set(r.name, { name: r.name, unique: r.nonUnique === 0, type: r.type, columns: [] });
    }
    map.get(r.name).columns.push(r.columnName);
  }
  return [...map.values()];
}

export async function tableForeignKeys(pool, db, table) {
  const [rows] = await pool.query(
    `SELECT k.constraint_name AS name, k.column_name AS columnName,
            k.referenced_table_name AS refTable, k.referenced_column_name AS refColumn,
            r.update_rule AS onUpdate, r.delete_rule AS onDelete
       FROM information_schema.key_column_usage k
       JOIN information_schema.referential_constraints r
         ON r.constraint_schema = k.table_schema
        AND r.constraint_name = k.constraint_name
      WHERE k.table_schema = ? AND k.table_name = ?
        AND k.referenced_table_name IS NOT NULL
      ORDER BY k.constraint_name, k.ordinal_position`,
    [db, table]
  );
  return rows;
}

export async function createTableDDL(pool, db, table) {
  const [rows] = await pool.query(
    `SHOW CREATE TABLE ${quoteId(db)}.${quoteId(table)}`
  );
  const row = rows[0];
  return row['Create Table'] || row['Create View'] || '';
}

// Primary-key column names for a table (used to build safe UPDATE/DELETE).
// Per-column metadata used by the grid editor: nullability, full column type
// (enum/set values), default and extra (auto_increment, generated columns).
export async function columnMeta(pool, db, table) {
  const [rows] = await pool.query(
    `SELECT column_name AS name, is_nullable AS nullable, column_type AS columnType,
            column_default AS def, extra
       FROM information_schema.columns
      WHERE table_schema = ? AND table_name = ?
      ORDER BY ordinal_position`,
    [db, table]
  );
  const out = {};
  for (const r of rows) {
    const enumMatch = /^(enum|set)\((.*)\)$/i.exec(r.columnType);
    out[r.name] = {
      nullable: r.nullable === 'YES',
      columnType: r.columnType,
      default: r.def,
      autoIncrement: /auto_increment/i.test(r.extra || ''),
      generated: /generated/i.test(r.extra || ''),
      options: enumMatch && enumMatch[1].toLowerCase() === 'enum'
        ? [...enumMatch[2].matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'"))
        : null,
    };
  }
  return out;
}

export async function primaryKey(pool, db, table) {
  const [rows] = await pool.query(
    `SELECT column_name AS name
       FROM information_schema.key_column_usage
      WHERE table_schema = ? AND table_name = ? AND constraint_name = 'PRIMARY'
      ORDER BY ordinal_position`,
    [db, table]
  );
  return rows.map((r) => r.name);
}
