class AuthController {
  constructor(authService) {
    this.authService = authService;
  }

  async signup(req, res) {
    try {
      const { email, password } = req.body || {};
      const out = await this.authService.signup(email, password);
      res.status(201).json({
        success: true,
        message: 'Account created. You can sign in.',
        userId: out.userId,
      });
    } catch (e) {
      const msg = e.message || 'Signup failed';
      const st = msg.includes('already') || msg.includes('reserved') ? 409 : 400;
      res.status(st).json({ success: false, error: msg });
    }
  }

  async verifyEmail(req, res) {
    try {
      const token = req.query.token || req.body?.token;
      const out = await this.authService.verifyEmail(token);
      if (out.already) {
        return res.json({ success: true, message: 'Email was already verified.' });
      }
      res.json({ success: true, message: 'Email verified. You can sign in.' });
    } catch (e) {
      res.status(400).json({ success: false, error: e.message || 'Verification failed' });
    }
  }

  async login(req, res) {
    try {
      const { email, password } = req.body || {};
      const out = await this.authService.login(email, password);
      res.json({ success: true, token: out.token, user: out.user });
    } catch (e) {
      const msg = e.message || 'Login failed';
      const st = 401;
      res.status(st).json({ success: false, error: msg });
    }
  }

  async me(req, res) {
    if (!req.authUser || req.authUser.legacyBasic) {
      return res.status(401).json({ success: false, error: 'Not signed in' });
    }
    const row = await this.authService.findUserById(req.authUser.id);
    if (!row) {
      return res.status(401).json({ success: false, error: 'Not signed in' });
    }
    res.json({
      success: true,
      user: {
        id: row.id,
        email: row.email,
        role: row.role,
        emailVerified: !!row.email_verified_at,
      },
    });
  }

  async forgotPassword(req, res) {
    try {
      const { email } = req.body || {};
      const out = await this.authService.requestPasswordReset(email);
      res.json(out);
    } catch (e) {
      res.status(400).json({ success: false, error: e.message || 'Request failed' });
    }
  }

  async resetPassword(req, res) {
    try {
      const { token, newPassword } = req.body || {};
      await this.authService.resetPasswordWithToken(token, newPassword);
      res.json({ success: true, message: 'Password updated. You can sign in.' });
    } catch (e) {
      res.status(400).json({ success: false, error: e.message || 'Reset failed' });
    }
  }

  async changePassword(req, res) {
    try {
      if (!req.authUser || req.authUser.legacyBasic) {
        return res.status(401).json({ success: false, error: 'Sign in with your account to change password' });
      }
      const { currentPassword, newPassword } = req.body || {};
      await this.authService.changePassword(req.authUser.id, currentPassword, newPassword);
      res.json({ success: true, message: 'Password updated.' });
    } catch (e) {
      const msg = e.message || 'Failed';
      const st = msg.includes('incorrect') ? 403 : 400;
      res.status(st).json({ success: false, error: msg });
    }
  }
}

module.exports = AuthController;
