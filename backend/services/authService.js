const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const { ADMIN_EMAIL } = require('../config/serverPingAuthBootstrap');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-change-JWT_SECRET-in-production';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';
const PASSWORD_RESET_TOKEN_HOURS = Number(process.env.PASSWORD_RESET_TOKEN_HOURS || 1);
const APP_PUBLIC_URL = (process.env.APP_PUBLIC_URL || 'http://localhost:3000').replace(/\/$/, '');
const PING_CHECK_LIMIT = Number(process.env.SERVER_PING_CHECKS_PER_10MIN || 3);
const PING_CHECK_WINDOW_MIN = Number(process.env.SERVER_PING_CHECK_WINDOW_MINUTES || 10);

function sha256Hex(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function createTransporter() {
  const host = process.env.SMTP_HOST;
  if (!host) return null;
  return nodemailer.createTransport({
    host,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth:
      process.env.SMTP_USER && process.env.SMTP_PASS
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        : undefined,
  });
}

class AuthService {
  constructor(db) {
    this.db = db;
  }

  async findUserByEmail(email) {
    const em = normalizeEmail(email);
    const [rows] = await this.db.execute(
      `SELECT id, email, password_hash, role, email_verified_at
       FROM users WHERE email = ? LIMIT 1`,
      [em]
    );
    return rows[0] || null;
  }

  async findUserById(id) {
    const [rows] = await this.db.execute(
      `SELECT id, email, role, email_verified_at FROM users WHERE id = ? LIMIT 1`,
      [id]
    );
    return rows[0] || null;
  }

  signAccessToken(userRow) {
    return jwt.sign(
      {
        sub: userRow.id,
        email: userRow.email,
        role: userRow.role,
        verified: true,
      },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );
  }

  verifyAccessToken(token) {
    try {
      const p = jwt.verify(token, JWT_SECRET);
      return {
        id: Number(p.sub),
        email: p.email,
        role: p.role,
        verified: !!p.verified,
        legacyBasic: false,
      };
    } catch {
      return null;
    }
  }

  async signup(email, password) {
    const em = normalizeEmail(email);
    if (!em || !em.includes('@')) {
      throw new Error('Valid email is required');
    }
    if (em === ADMIN_EMAIL) {
      throw new Error('This email is reserved for the administrator account');
    }
    if (!password || String(password).length < 8) {
      throw new Error('Password must be at least 8 characters');
    }
    const existing = await this.findUserByEmail(em);
    if (existing) {
      throw new Error('An account with this email already exists');
    }
    const hash = await bcrypt.hash(String(password), 10);
    const [ins] = await this.db.execute(
      `INSERT INTO users (email, password_hash, role, email_verified_at)
       VALUES (?, ?, 'user', UTC_TIMESTAMP())`,
      [em, hash]
    );

    return {
      userId: ins.insertId,
      email: em,
    };
  }

  async verifyEmail(plainToken) {
    if (!plainToken || String(plainToken).length < 16) {
      throw new Error('Invalid verification link');
    }
    const tokenHash = sha256Hex(String(plainToken).trim());
    const [rows] = await this.db.execute(
      `SELECT id, email_verified_at, verification_token_expires_at FROM users
       WHERE verification_token_hash = ? LIMIT 1`,
      [tokenHash]
    );
    const row = rows[0];
    if (!row) {
      throw new Error('Invalid or expired verification link');
    }
    if (row.email_verified_at) {
      return { already: true, email: null };
    }
    if (new Date(row.verification_token_expires_at) < new Date()) {
      throw new Error('Verification link has expired; sign up again or contact support');
    }
    await this.db.execute(
      `UPDATE users SET email_verified_at = UTC_TIMESTAMP(), verification_token_hash = NULL, verification_token_expires_at = NULL
       WHERE id = ?`,
      [row.id]
    );
    const u = await this.findUserById(row.id);
    return { already: false, email: u.email };
  }

  async getPasswordRowByUserId(userId) {
    const [rows] = await this.db.execute(
      `SELECT id, password_hash FROM users WHERE id = ? LIMIT 1`,
      [userId]
    );
    return rows[0] || null;
  }

  async changePassword(userId, currentPassword, newPassword) {
    const row = await this.getPasswordRowByUserId(userId);
    if (!row) {
      throw new Error('Account not found');
    }
    const ok = await bcrypt.compare(String(currentPassword), row.password_hash);
    if (!ok) {
      throw new Error('Current password is incorrect');
    }
    if (!newPassword || String(newPassword).length < 8) {
      throw new Error('New password must be at least 8 characters');
    }
    const hash = await bcrypt.hash(String(newPassword), 10);
    await this.db.execute(`UPDATE users SET password_hash = ? WHERE id = ?`, [hash, userId]);
  }

  async sendPasswordResetEmail(email, resetUrl) {
    const from = process.env.SMTP_FROM || process.env.SMTP_USER || 'noreply@localhost';
    const subject = 'Reset your password';
    const text = `Reset your password by opening this link (it expires in about ${PASSWORD_RESET_TOKEN_HOURS} hour(s)):\n${resetUrl}\n\nIf you did not request this, ignore this email.`;
    const transporter = createTransporter();
    if (transporter) {
      await transporter.sendMail({ from, to: email, subject, text });
    } else {
      console.log(`\n📧 Password reset (SMTP not configured) for ${email}:\n   ${resetUrl}\n`);
    }
  }

  async requestPasswordReset(email) {
    const em = normalizeEmail(email);
    const generic = {
      success: true,
      message: 'If an account exists for that email, we sent reset instructions.',
    };
    if (!em || !em.includes('@')) {
      return generic;
    }
    const u = await this.findUserByEmail(em);
    if (!u) {
      return generic;
    }
    const plainToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = sha256Hex(plainToken);
    const expires = new Date(Date.now() + PASSWORD_RESET_TOKEN_HOURS * 3600 * 1000);
    await this.db.execute(
      `UPDATE users SET password_reset_token_hash = ?, password_reset_expires_at = ? WHERE id = ?`,
      [tokenHash, expires, u.id]
    );
    const resetUrl = `${APP_PUBLIC_URL}/reset-password?token=${encodeURIComponent(plainToken)}`;
    await this.sendPasswordResetEmail(em, resetUrl);
    return generic;
  }

  async resetPasswordWithToken(plainToken, newPassword) {
    if (!plainToken || String(plainToken).length < 16) {
      throw new Error('Invalid or expired reset link');
    }
    if (!newPassword || String(newPassword).length < 8) {
      throw new Error('Password must be at least 8 characters');
    }
    const tokenHash = sha256Hex(String(plainToken).trim());
    const [rows] = await this.db.execute(
      `SELECT id FROM users WHERE password_reset_token_hash = ? AND password_reset_expires_at > UTC_TIMESTAMP() LIMIT 1`,
      [tokenHash]
    );
    if (!rows[0]) {
      throw new Error('Invalid or expired reset link');
    }
    const hash = await bcrypt.hash(String(newPassword), 10);
    await this.db.execute(
      `UPDATE users SET password_hash = ?, password_reset_token_hash = NULL, password_reset_expires_at = NULL WHERE id = ?`,
      [hash, rows[0].id]
    );
  }

  async login(email, password) {
    const u = await this.findUserByEmail(email);
    if (!u) {
      throw new Error('Invalid email or password');
    }
    const ok = await bcrypt.compare(String(password), u.password_hash);
    if (!ok) {
      throw new Error('Invalid email or password');
    }
    const token = this.signAccessToken(u);
    return {
      token,
      user: {
        id: u.id,
        email: u.email,
        role: u.role,
        emailVerified: !!u.email_verified_at,
      },
    };
  }

  async getAdminUserId() {
    const [rows] = await this.db.execute(
      `SELECT id FROM users WHERE email = ? LIMIT 1`,
      [ADMIN_EMAIL]
    );
    return rows[0] ? Number(rows[0].id) : null;
  }

  async countRecentPingChecks(userId) {
    const [rows] = await this.db.execute(
      `SELECT COUNT(*) AS c FROM server_ping_check_events
       WHERE user_id = ? AND created_at > DATE_SUB(UTC_TIMESTAMP(), INTERVAL ${PING_CHECK_WINDOW_MIN} MINUTE)`,
      [userId]
    );
    return Number(rows[0]?.c || 0);
  }

  async recordPingCheck(userId) {
    await this.db.execute(`INSERT INTO server_ping_check_events (user_id) VALUES (?)`, [userId]);
  }

  pingCheckLimit() {
    return PING_CHECK_LIMIT;
  }

  pingCheckWindowMinutes() {
    return PING_CHECK_WINDOW_MIN;
  }
}

module.exports = AuthService;
