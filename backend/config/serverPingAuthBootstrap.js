const bcrypt = require('bcryptjs');

const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'sprite12131@outlook.com').toLowerCase().trim();

/**
 * Ensures admin user exists, assigns legacy server_ping_targets to admin, tightens schema.
 */
async function bootstrapServerPingAuth(db) {
  const [colRows] = await db.execute(
    `SELECT COUNT(*) AS c FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = 'server_ping_targets' AND column_name = 'user_id'`
  );
  if (Number(colRows[0]?.c) === 0) {
    return;
  }

  let adminId;
  const [existing] = await db.execute('SELECT id FROM users WHERE email = ?', [ADMIN_EMAIL]);
  if (existing.length === 0) {
    const pw = process.env.ADMIN_BOOTSTRAP_PASSWORD || 'ChangeMeAdmin!SetInEnv';
    const hash = await bcrypt.hash(pw, 10);
    const [ins] = await db.execute(
      `INSERT INTO users (email, password_hash, role, email_verified_at)
       VALUES (?, ?, 'admin', UTC_TIMESTAMP())`,
      [ADMIN_EMAIL, hash]
    );
    adminId = ins.insertId;
    console.log(
      `✅ Created admin user ${ADMIN_EMAIL} (role admin, verified). Set ADMIN_BOOTSTRAP_PASSWORD in production.`
    );
  } else {
    adminId = existing[0].id;
  }

  await db.execute('UPDATE server_ping_targets SET user_id = ? WHERE user_id IS NULL', [adminId]);

  try {
    await db.execute(
      'ALTER TABLE server_ping_targets MODIFY user_id BIGINT UNSIGNED NOT NULL'
    );
  } catch (e) {
    console.warn('⚠️ server_ping_targets.user_id NOT NULL:', e.message);
  }

  try {
    await db.execute(`
      ALTER TABLE server_ping_targets
      ADD CONSTRAINT fk_server_ping_targets_user
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    `);
  } catch (e) {
    if (![1061, 1826, 1005, 121].includes(e.errno)) {
      console.warn('⚠️ FK server_ping_targets.user_id:', e.message);
    }
  }
}

module.exports = { bootstrapServerPingAuth, ADMIN_EMAIL };
