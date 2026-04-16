import React, { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import axios from 'axios';
import '../App.css';

const VerifyEmailPage = () => {
  const [params] = useSearchParams();
  const [status, setStatus] = useState('loading');
  const [message, setMessage] = useState('');

  useEffect(() => {
    const token = params.get('token');
    if (!token) {
      setStatus('error');
      setMessage('Missing verification token.');
      return;
    }
    axios
      .get('/api/auth/verify-email', { params: { token } })
      .then((res) => {
        setStatus('ok');
        setMessage(res.data.message || 'Email verified.');
      })
      .catch((err) => {
        setStatus('error');
        setMessage(err.response?.data?.error || 'Verification failed.');
      });
  }, [params]);

  return (
    <div className="status-table-container" style={{ maxWidth: '32rem', margin: '2rem auto' }}>
      <h2>Email verification</h2>
      {status === 'loading' && <p>Verifying…</p>}
      {status === 'ok' && (
        <p className="server-ping-readonly-text" style={{ color: '#198754' }}>
          {message}
        </p>
      )}
      {status === 'error' && (
        <p className="error-message" style={{ display: 'block' }}>
          {message}
        </p>
      )}
      <p style={{ marginTop: '1.5rem' }}>
        <Link to="/login">Back to sign in</Link>
      </p>
    </div>
  );
};

export default VerifyEmailPage;
