import React, { useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import axios from 'axios';
import '../App.css';

const ForgotPasswordPage = () => {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  const [ok, setOk] = useState(false);

  const onSubmit = useCallback(
    async (e) => {
      e.preventDefault();
      setBusy(true);
      setMessage(null);
      try {
        const { data } = await axios.post('/api/auth/forgot-password', { email: email.trim() });
        if (data.success) {
          setOk(true);
          setMessage(data.message || 'Check your email for a reset link.');
        }
      } catch (err) {
        setMessage(err.response?.data?.error || err.message || 'Request failed');
      } finally {
        setBusy(false);
      }
    },
    [email]
  );

  return (
    <div className="public-home">
      <div className="public-home-inner">
        <header className="public-home-header">
          <h1>Reset password</h1>
          <p className="public-home-lead">
            Enter the email you use to sign in. If we find an account, we will send a reset link when email is configured.
          </p>
        </header>

        <div className="public-home-card">
          {ok ? (
            <p className="public-home-msg ok">{message}</p>
          ) : (
            <form className="public-home-form" onSubmit={onSubmit}>
              <label className="public-home-label" htmlFor="fp-email">
                Email
              </label>
              <input
                id="fp-email"
                type="email"
                className="public-home-input"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={busy}
                required
              />
              {message && <p className="public-home-msg">{message}</p>}
              <button type="submit" className="btn btn-primary public-home-submit" disabled={busy}>
                {busy ? '…' : 'Send reset link'}
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

export default ForgotPasswordPage;
