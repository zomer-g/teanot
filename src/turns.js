// The request log: one row per user request, finished with a status when the work ends.
import { query } from './db.js';

export async function startTurn({ account, conversationId, kind, text = null, fileName = null, answers = null }) {
  const { rows } = await query(
    `INSERT INTO turns (user_id, user_email, conversation_id, request_kind, request_text, file_name, answers)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb) RETURNING id`,
    [account.id, account.email, conversationId, kind, text ? text.slice(0, 4000) : null, fileName,
      answers ? JSON.stringify(answers) : null],
  );
  return rows[0].id;
}

export async function finishTurn(turnId, status, error = null) {
  await query(
    'UPDATE turns SET status = $2, error = $3, finished_at = now() WHERE id = $1',
    [turnId, status, error ? String(error).slice(0, 1000) : null],
  );
}

export async function lastTurn(conversationId) {
  const { rows } = await query(
    `SELECT id, status, error, started_at, finished_at FROM turns
     WHERE conversation_id = $1 AND request_kind <> 'more' ORDER BY id DESC LIMIT 1`,
    [conversationId],
  );
  return rows[0] ?? null;
}
