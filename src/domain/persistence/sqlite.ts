import { CapacitorSQLite, SQLiteConnection, SQLiteDBConnection } from '@capacitor-community/sqlite'
import { restoreState, serializeState, type Persistence, type State } from '../store'

/* Capacitor 原生端的 SQLite 持久化。整份 State 作为文档存在一张表里，
   写入走事务；Persistence 接口是同步的，所以 load 在 init 时预取，
   save 异步排队（微任务合批已在 Store 层做过）。
   结构版本升级时，迁移前的原文另存一行（按来源版本），只留第一份。 */

const DB_NAME = 'timetable'
const TABLE = 'app_state'
const BACKUP = 'app_state_backup'

export async function createSqlitePersistence(): Promise<Persistence> {
  const conn = new SQLiteConnection(CapacitorSQLite)
  let db: SQLiteDBConnection
  const consistency = await conn.checkConnectionsConsistency()
  const exists = (await conn.isConnection(DB_NAME, false)).result
  if (consistency.result && exists) {
    db = await conn.retrieveConnection(DB_NAME, false)
  } else {
    db = await conn.createConnection(DB_NAME, false, 'no-encryption', 1, false)
  }
  await db.open()
  await db.execute(`CREATE TABLE IF NOT EXISTS ${TABLE} (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL);`)
  await db.execute(`CREATE TABLE IF NOT EXISTS ${BACKUP} (version INTEGER PRIMARY KEY, json TEXT NOT NULL, at INTEGER NOT NULL);`)

  const res = await db.query(`SELECT json FROM ${TABLE} WHERE id = 1;`)
  const raw = res.values?.[0]?.json as string | undefined
  const backups: Promise<unknown>[] = []
  let initial: State | null = null
  if (raw) {
    try {
      initial = restoreState(raw, (json, version) => {
        backups.push(db.run(`INSERT OR IGNORE INTO ${BACKUP} (version, json, at) VALUES (?, ?, ?);`, [version, json, Date.now()]))
      })
    } catch {
      /* 库里这份解析不了：原文另存一行（负数版本号避开正常迁移备份），
         这次先从空状态启动，但数据还在表里，可以被人工捞回来。直接抛会让 App 打不开。 */
      backups.push(db.run(`INSERT OR REPLACE INTO ${BACKUP} (version, json, at) VALUES (?, ?, ?);`, [-Date.now(), raw, Date.now()]).catch(() => undefined))
      initial = null
    }
  }
  await Promise.all(backups)

  let writing = false
  let queued: string | null = null
  const flush = async (json: string) => {
    writing = true
    try {
      await db.run(`INSERT INTO ${TABLE} (id, json) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json;`, [json])
    } catch (e) {
      console.error('sqlite save failed', e) // 内存里还是新状态，下次 commit 会再写
    } finally {
      writing = false
      if (queued !== null) {
        const next = queued
        queued = null
        void flush(next)
      }
    }
  }

  return {
    load: () => initial,
    save: (s: State) => {
      const json = serializeState(s)
      if (writing) queued = json
      else void flush(json)
    },
  }
}
