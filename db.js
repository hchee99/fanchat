// ─────────────────────────────────────────────────────────────
// 데이터베이스 연결 — 두 가지 모드로 동작해요:
//
//  1) Turso 클라우드 (영구 저장) — 환경변수 TURSO_DATABASE_URL이 있으면
//     인터넷 너머의 무료 DB에 저장. Render를 재배포해도 데이터가 안 사라져요!
//  2) 로컬 파일 (fanchat.db) — 환경변수가 없으면 이전처럼 파일에 저장.
//     내 컴퓨터에서 개발할 때는 이 모드로 돌아가요.
//
// 코드는 똑같고 저장 위치만 달라져요. 클라우드 DB는 응답을 기다려야 해서
// 모든 조회가 async(비동기)로 바뀌었어요 — 그래서 server.js도 await를 써요.
// ─────────────────────────────────────────────────────────────
const { createClient } = require('@libsql/client');
const path = require('path');

const useRemote = !!process.env.TURSO_DATABASE_URL;

const client = createClient(
  useRemote
    ? { url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN }
    : { url: 'file:' + (process.env.DB_PATH || path.join(__dirname, 'fanchat.db')).replace(/\\/g, '/') }
);

// 조회 결과를 평범한 객체 배열로 바꿔주기 { 컬럼이름: 값 }
function rowsToObjects(rs) {
  return rs.rows.map((row) => {
    const obj = {};
    rs.columns.forEach((col, i) => { obj[col] = row[i]; });
    return obj;
  });
}

// ── server.js가 쓰는 세 가지 도구 ──
// run: 쓰기(INSERT/UPDATE). 새로 생긴 줄의 id를 돌려줌
async function run(sql, args = []) {
  const rs = await client.execute({ sql, args });
  return {
    lastInsertRowid: rs.lastInsertRowid !== undefined ? Number(rs.lastInsertRowid) : undefined,
    rowsAffected: rs.rowsAffected,
  };
}
// get: 한 줄만 조회
async function get(sql, args = []) {
  const rs = await client.execute({ sql, args });
  return rowsToObjects(rs)[0];
}
// all: 여러 줄 조회
async function all(sql, args = []) {
  const rs = await client.execute({ sql, args });
  return rowsToObjects(rs);
}

// 테이블 준비 (없으면 만들고, 예전 DB에는 빠진 칸 추가)
async function init() {
  const tables = [
    `CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nickname TEXT UNIQUE NOT NULL,
      pw_hash TEXT NOT NULL,
      pw_salt TEXT NOT NULL,
      is_broadcaster INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      security_q TEXT,
      sa_hash TEXT,
      sa_salt TEXT,
      avatar TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS rooms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      broadcaster_id INTEGER NOT NULL,
      fan_id INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE (broadcaster_id, fan_id)
    )`,
    `CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id INTEGER NOT NULL,
      sender_id INTEGER NOT NULL,
      text TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      read INTEGER NOT NULL DEFAULT 0,
      kind TEXT NOT NULL DEFAULT 'text'
    )`,
    `CREATE INDEX IF NOT EXISTS idx_messages_room ON messages (room_id, id)`,
  ];
  for (const sql of tables) await client.execute(sql);

  // 예전 DB 마이그레이션 (이미 칸이 있으면 에러가 나는데, 무시해도 안전)
  const migrations = [
    `ALTER TABLE users ADD COLUMN security_q TEXT`,
    `ALTER TABLE users ADD COLUMN sa_hash TEXT`,
    `ALTER TABLE users ADD COLUMN sa_salt TEXT`,
    `ALTER TABLE messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'text'`,
    `ALTER TABLE users ADD COLUMN avatar TEXT`,
  ];
  for (const sql of migrations) {
    try { await client.execute(sql); } catch { /* 이미 있음 */ }
  }

  console.log(useRemote
    ? '데이터베이스: Turso 클라우드 (영구 저장 — 재배포해도 유지)'
    : '데이터베이스: 로컬 파일 fanchat.db');
}

module.exports = { run, get, all, init };
