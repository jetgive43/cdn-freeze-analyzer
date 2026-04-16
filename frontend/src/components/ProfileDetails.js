import React from 'react';

/**
 * Read-only account summary (used in profile modal and /profile page).
 */
export function ProfileDetails({ user }) {
  if (!user) return null;

  return (
    <div className="profile-details">
      <div className="profile-details-avatar" aria-hidden="true">
        {(user.email || '?').charAt(0).toUpperCase()}
      </div>
      <dl className="profile-details-grid">
        <dt>Email</dt>
        <dd title={user.email}>{user.email}</dd>
        <dt>Role</dt>
        <dd>
          <span className={`profile-role-badge role-${user.role || 'user'}`}>{user.role || 'user'}</span>
        </dd>
      </dl>
    </div>
  );
}
