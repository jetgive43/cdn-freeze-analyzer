import React, { useState, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import '../App.css';

/**
 * Pre-login dashboard: no app sidebar. Auth only; server ping is after sign-in.
 */
const PublicHomePage = () => {
  const { login, signup } = useAuth();
  const navigate = useNavigate();
  const [mode, setMode] = useState('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  const onSubmit = useCallback(
    async (e) => {
      e.preventDefault();
      setBusy(true);
      setMessage(null);
      try {
        if (mode === 'signup') {
          const data = await signup(email, password);
          setMessage(data.message || 'Account created. Sign in with your email and password.');
          setMode('login');
          setPassword('');
        } else {
          const u = await login(email, password);
          navigate(u.role === 'admin' ? '/admin/business-servers' : '/server-ping', { replace: true });
        }
      } catch (err) {
        setMessage(err.message || 'Something went wrong');
      } finally {
        setBusy(false);
      }
    },
    [mode, email, password, login, signup, navigate]
  );

  return (
    <div className="public-home">
      <div className="public-home-inner">
        <header className="public-home-header">
          <h1>Server monitoring platform</h1>
          <p className="public-home-lead">
            Sign in to run TCP checks and server ping toward your targets.
          </p>
        </header>

        <div className="public-home-card">
          <div className="public-home-tabs">
            <button
              type="button"
              className={mode === 'login' ? 'public-home-tab active' : 'public-home-tab'}
              onClick={() => {
                setMode('login');
                setMessage(null);
              }}
            >
              Sign in
            </button>
            <button
              type="button"
              className={mode === 'signup' ? 'public-home-tab active' : 'public-home-tab'}
              onClick={() => {
                setMode('signup');
                setMessage(null);
              }}
            >
              Sign up
            </button>
          </div>

          <form className="public-home-form" onSubmit={onSubmit}>
            <label className="public-home-label" htmlFor="ph-email">
              Email
            </label>
            <input
              id="ph-email"
              type="email"
              className="public-home-input"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={busy}
              required
            />
            <label className="public-home-label" htmlFor="ph-pass">
              Password
            </label>
            <input
              id="ph-pass"
              type="password"
              className="public-home-input"
              autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={busy}
              required
              minLength={mode === 'signup' ? 8 : undefined}
            />
            {message && (
              <p className={mode === 'signup' ? 'public-home-msg ok' : 'public-home-msg'}>{message}</p>
            )}
            <button type="submit" className="btn btn-primary public-home-submit" disabled={busy}>
              {busy ? '…' : mode === 'signup' ? 'Create account' : 'Continue'}
            </button>
            {mode === 'login' ? (
              <p className="public-home-forgot">
                <Link to="/forgot-password">Forgot password?</Link>
              </p>
            ) : null}
          </form>

          <p className="public-home-foot">
            Password reset uses email if SMTP is configured on the server.
          </p>
        </div>
      </div>
    </div>
  );
};

export default PublicHomePage;
