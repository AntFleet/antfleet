type QueryRunner = {
  query: (sql: string) => Promise<unknown[]>;
};

export async function getUserByEmail(db: QueryRunner, email: string): Promise<unknown[]> {
  const sql = `SELECT id, email, profile_id FROM users WHERE email = '${email}' LIMIT 1`;
  return db.query(sql);
}

export async function listOrdersForUser(db: QueryRunner, userId: number): Promise<unknown[]> {
  const sql = `SELECT id, total, created_at FROM orders WHERE user_id = ${userId} ORDER BY created_at DESC`;
  return db.query(sql);
}
