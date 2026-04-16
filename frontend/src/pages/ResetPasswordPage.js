import React, { useState, useCallback, useMemo } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import axios from 'axios';
import '../App.css';

const ResetPasswordPage = () => {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const token = useMemo(() => searchParams.get('token') || '', [searchParams]);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  const [ok, setOk] = useState(false);

  const onSubmit = useCallback(
    async (e) => {
      e.preventDefault();
      if (password !== confirm) {
        setMessage('Passwords do not match');
        return;
      }
      setBusy(true);
      setMessage(null);
      try {
        const { data } = await axios.post('/api/auth/reset-password', {
          token: token.trim(),
          newPassword: password,
        });
        if (data.success) {
          setOk(true);
          setTimeout(() => navigate('/login', { replace: true }), 2000);
        }
      } catch (err) {
        setMessage(err.response?.data?.error || err.message || 'Reset failed');
      } finally {
        setBusy(false);
      }
    },
    [token, password, confirm, navigate]
  );

  if (!token) {
    return (
      <div className="public-home">
        <div className="public-home-inner">
          <div className="public-home-card">
            <p className="public-home-msg">This reset link is missing a token. Open the link from your email.</p>
            <p className="public-home-foot">
              <Link to="/forgot-password">Request a new link</Link> · <Link to="/login">Sign in</Link>
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="public-home">
      <div className="public-home-inner">
        <header className="public-home-header">
          <h1>New password</h1>
          <p className="public-home-lead">Choose a new password for your account.</p>
        </header>

        <div className="public-home-card">
          {ok ? (
            <p className="public-home-msg ok">Password updated. Redirecting to sign in…</p>
          ) : (
            <form className="public-home-form" onSubmit={onSubmit}>
              <label className="public-home-label" htmlFor="rp-pass">
                New password
              </label>
              <input
                id="rp-pass"
                type="password"
                className="public-home-input"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={busy}
                required
                minLength={8}
              />
              <label className="public-home-label" htmlFor="rp-confirm">
                Confirm password
              </label>
              <input
                id="rp-confirm"
                type="password"
                className="public-home-input"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                disabled={busy}
                required
                minLength={8}
              />
              {message && <p className="public-home-msg">{message}</p>}
              <button type="submit" className="btn btn-primary public-home-submit" disabled={busy}>
                {busy ? '…' : 'Update password'}
              </button>
            </form>
          )}
          <p className="public-home-foot">
            <Link to="/login">Back to sign in</Link>
          </p>
        </div>
      </div>
    </div>
  );
};

export default ResetPasswordPage;
