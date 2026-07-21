// ─────────────────────────────────────────────────────────────
// 데이터베이스 = 서버가 꺼져도 사라지지 않는 "장부"
// 미니 카카오톡은 메모리(RAM)에만 저장해서 재시작하면 리셋됐지만,
// 여기서는 모든 것을 fanchat.db 파일에 기록합니다.
// Node.js에 내장된 SQLite를 사용해요 (별도 설치 불필요).
// ─────────────────────────────────────────────────────────────
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const db = new DatabaseSync(process.env.DB_PATH || path.join(__dirname, 'fanchat.db'));

// 테이블 = 장부의 페이지. 없으면 만들고, 있으면 그대로 사용
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nickname TEXT UNIQUE NOT NULL,
    pw_hash TEXT NOT NULL,
    pw_salt TEXT NOT NULL,
    is_broadcaster INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    security_q TEXT,
    sa_hash TEXT,
    sa_salt TEXT
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS rooms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    broadcaster_id INTEGER NOT NULL,
    fan_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (broadcaster_id, fan_id)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id INTEGER NOT NULL,
    sender_id INTEGER NOT NULL,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    read INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_messages_room ON messages (room_id, id);
`);

// 마이그레이션: 예전에 만들어진 DB에는 보안 질문 칸이 없으므로 있으면 추가
// (이미 있으면 SQLite가 에러를 내는데, 그건 무시해도 안전해요)
for (const col of ['security_q TEXT', 'sa_hash TEXT', 'sa_salt TEXT']) {
  try { db.exec(`ALTER TABLE users ADD COLUMN ${col}`); } catch { /* 이미 있음 */ }
}

module.exports = db;
