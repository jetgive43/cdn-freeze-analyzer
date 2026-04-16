import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

/**
 * Top-right session control: avatar trigger, dropdown (Profile, Sign out), logout confirm via portal (above sticky tables).
 * @param {'admin' | 'solo'} layout — solo shows admin console link for admins
 */
function UserAccountMenu({ layout = 'solo' }) {
  const navigate = useNavigate();
  const { user, loadingMe, logout, isAdmin } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const [logoutConfirmOpen, setLogoutConfirmOpen] = useState(false);
  const rootRef = useRef(null);

  const closeLogoutModal = useCallback(() => {
    setLogoutConfirmOpen(false);
  }, []);

  useEffect(() => {
    if (!menuOpen && !logoutConfirmOpen) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') {
        if (logoutConfirmOpen) closeLogoutModal();
        else setMenuOpen(false);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [menuOpen, logoutConfirmOpen, closeLogoutModal]);

  useEffect(() => {
    if (!menuOpen) return undefined;
    const onDoc = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [menuOpen]);

  const profilePath = isAdmin ? '/admin/profile' : '/profile';

  const requestLogout = () => {
    setMenuOpen(false);
    setLogoutConfirmOpen(true);
  };

  const doLogout = () => {
    logout();
    closeLogoutModal();
    navigate('/login', { replace: true });
  };

  const logoutModal =
    logoutConfirmOpen &&
    createPortal(
      <div
        className="user-account-modal-backdrop user-account-modal-portal"
        role="presentation"
        onClick={closeLogoutModal}
      >
        <div
          className="user-account-modal user-account-modal-compact"
          role="dialog"
          aria-modal="true"
          aria-labelledby="logout-modal-title"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="user-account-modal-header">
            <h2 id="logout-modal-title">Sign out</h2>
            <button
              type="button"
              className="user-account-modal-close"
              onClick={closeLogoutModal}
              aria-label="Close"
            >
              ×
            </button>
          </div>
          <div className="user-account-modal-body">
            <p className="user-account-logout-prompt">Sign out of this account?</p>
            <div className="user-account-modal-actions">
              <button type="button" className="btn btn-secondary" onClick={closeLogoutModal}>
                Cancel
              </button>
              <button type="button" className="btn btn-primary" onClick={doLogout}>
                Sign out
              </button>
            </div>
          </div>
        </div>
      </div>,
      document.body
    );

  if (loadingMe) {
    return (
      <div className="user-account-menu user-account-menu-loading" aria-busy="true">
        <span className="user-account-skeleton" />
      </div>
    );
  }

  if (!user) {
    return null;
  }

  const initial = (user.email || '?').charAt(0).toUpperCase();
  const shortEmail = user.email && user.email.length > 28 ? `${user.email.slice(0, 26)}…` : user.email;

  return (
    <>
      <div className="user-account-menu" ref={rootRef}>
        <button
          type="button"
          className="user-account-trigger"
          aria-expanded={menuOpen}
          aria-haspopup="menu"
          onClick={() => setMenuOpen((o) => !o)}
        >
          <span className="user-account-avatar" aria-hidden="true">
            {initial}
          </span>
          <span className="user-account-email">{shortEmail}</span>
          <span className="user-account-chevron" aria-hidden="true">
            ▾
          </span>
        </button>
        {menuOpen ? (
          <div className="user-account-dropdown" role="menu">
            <Link
              to={profilePath}
              className="user-account-dropdown-item"
              role="menuitem"
              onClick={() => setMenuOpen(false)}
            >
              Profile
            </Link>
            {layout === 'solo' && isAdmin ? (
              <Link
                to="/admin/business-servers"
                className="user-account-dropdown-item"
                role="menuitem"
                onClick={() => setMenuOpen(false)}
              >
                Admin console
              </Link>
            ) : null}
            <button type="button" className="user-account-dropdown-item danger" role="menuitem" onClick={requestLogout}>
              Sign out
            </button>
          </div>
        ) : null}
      </div>
      {logoutModal}
    </>
  );
}

export default UserAccountMenu;
