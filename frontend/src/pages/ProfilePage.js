import React, { useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import axios from 'axios';
import { useAuth } from '../context/AuthContext';
import { ProfileDetails } from '../components/ProfileDetails';
import '../App.css';

const ProfilePage = () => {
  const { user, loadingMe, authHeader } = useAuth();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [pwBusy, setPwBusy] = useState(false);
  const [pwMessage, setPwMessage] = useState(null);
  const [pwOk, setPwOk] = useState(false);

  const onChangePassword = useCallback(
    async (e) => {
      e.preventDefault();
      setPwMessage(null);
      setPwOk(false);
      if (newPassword !== confirmPassword) {
        setPwMessage('New password and confirmation do not match');
        return;
      }
      setPwBusy(true);
      try {
        const { data } = await axios.post(
          '/api/auth/change-password',
          { currentPassword, newPassword },
          { headers: { ...authHeader() } }
        );
        if (data.success) {
          setPwOk(true);
          setPwMessage(data.message || 'Password updated.');
          setCurrentPassword('');
          setNewPassword('');
          setConfirmPassword('');
        }
      } catch (err) {
        setPwMessage(err.response?.data?.error || err.message || 'Failed to update password');
      } finally {
        setPwBusy(false);
      }
    },
    [currentPassword, newPassword, confirmPassword, authHeader]
  );

  if (loadingMe) {
    return (
      <div className="page-content profile-page">
        <p className="server-ping-readonly-text">Loading…</p>
      </div>
    );
  }

  if (!user) {
    return null;
  }

  const backHref = user.role === 'admin' ? '/admin/business-servers' : '/server-ping';

  return (
    <div className="page-content profile-page">
      <div className="profile-page-card">
        <p className="profile-page-back">
          <Link to={backHref}>← Back to app</Link>
        </p>
        <h1>Your profile</h1>
        <ProfileDetails user={user} />
      </div>

      <div className="profile-page-card profile-page-card-spaced">
        <h2 className="profile-page-section-title">Change password</h2>
        <form className="profile-password-form" onSubmit={onChangePassword}>
          <label className="public-home-label" htmlFor="pp-current">
            Current password
          </label>
          <input
            id="pp-current"
            type="password"
            className="public-home-input"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            disabled={pwBusy}
            required
          />
          <label className="public-home-label" htmlFor="pp-new">
            New password
          </label>
          <input
            id="pp-new"
            type="password"
            className="public-home-input"
            autoComplete="new-password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            disabled={pwBusy}
            required
            minLength={8}
          />
          <label className="public-home-label" htmlFor="pp-confirm">
            Confirm new password
          </label>
          <input
            id="pp-confirm"
            type="password"
            className="public-home-input"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            disabled={pwBusy}
            required
            minLength={8}
          />
          {pwMessage && (
            <p className={pwOk ? 'public-home-msg ok' : 'public-home-msg'}>{pwMessage}</p>
          )}
          <button type="submit" className="btn btn-primary profile-password-submit" disabled={pwBusy}>
            {pwBusy ? '…' : 'Update password'}
          </button>
        </form>
      </div>
    </div>
  );
};

export default ProfilePage;
