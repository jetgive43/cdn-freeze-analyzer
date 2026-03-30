import React, { useCallback, useEffect, useState } from 'react';
import { format } from 'date-fns';
import './PortsPanel.css';

const INITIAL_FORM = {
  portNumber: '',
  country: '',
  countryCode: '',
  ispName: '',
  asn: '',
  status: '1',
};

const formatTs = (v) => {
  if (!v) return '—';
  try {
    return format(new Date(v), 'yyyy-MM-dd HH:mm');
  } catch {
    return String(v);
  }
};

const PortsPanel = () => {
  const [ports, setPorts] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [form, setForm] = useState(INITIAL_FORM);
  const [formError, setFormError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [editingPort, setEditingPort] = useState(null);
  const [togglingPort, setTogglingPort] = useState(null);
  const [modalOpen, setModalOpen] = useState(false);

  const fetchPorts = useCallback(async () => {
    try {
      setLoading(true);
      setError('');
      const response = await fetch('/api/ports');
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || `Request failed (${response.status})`);
      }
      const data = await response.json();
      if (!data.success) {
        throw new Error(data.error || 'Failed to load proxy ports');
      }
      const list = Array.isArray(data.ports) ? data.ports : [];
      list.sort((a, b) => Number(a.portNumber) - Number(b.portNumber));
      setPorts(list);
    } catch (err) {
      console.error('❌ Failed to fetch proxy ports:', err);
      setError(err.message || 'Failed to load proxy ports');
      setPorts([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPorts();
  }, [fetchPorts]);

  const resetForm = useCallback(() => {
    setForm(INITIAL_FORM);
    setFormError('');
    setEditingPort(null);
  }, []);

  const closeModal = useCallback(() => {
    setModalOpen(false);
    resetForm();
  }, [resetForm]);

  const openAddModal = useCallback(() => {
    resetForm();
    setModalOpen(true);
  }, [resetForm]);

  const openEditModal = useCallback((port) => {
    setEditingPort(port.portNumber);
    setForm({
      portNumber: String(port.portNumber),
      country: port.country || '',
      countryCode: port.countryCode || port.countryShort || '',
      ispName: port.ispName || port.provider || '',
      asn: port.asn != null && port.asn !== '' ? String(port.asn) : '',
      status: String(port.status ?? 1),
    });
    setFormError('');
    setModalOpen(true);
  }, []);

  useEffect(() => {
    if (!modalOpen) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') {
        closeModal();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [modalOpen, closeModal]);

  const handleInputChange = (event) => {
    const { name, value } = event.target;
    setForm((prev) => ({
      ...prev,
      [name]: value,
    }));
  };

  const handleStatusToggle = async (port, nextActive) => {
    const nextStatus = nextActive ? 1 : 0;
    if (Number(port.status) === nextStatus) {
      return;
    }
    const portKey = port.portNumber;
    const portsBeforeToggle = ports;
    setPorts((list) =>
      list.map((p) =>
        Number(p.portNumber) === Number(portKey) ? { ...p, status: nextStatus } : p
      )
    );
    setTogglingPort(portKey);
    setError('');
    try {
      const asnRaw = port.asn;
      let asnVal = null;
      if (asnRaw != null && asnRaw !== '') {
        const n = Number(asnRaw);
        if (Number.isFinite(n) && n >= 0) {
          asnVal = Math.floor(n);
        }
      }
      const response = await fetch('/api/ports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          portNumber: Number(port.portNumber),
          country: (port.country || '').trim(),
          countryCode: (port.countryCode || port.countryShort || '').trim().toUpperCase(),
          ispName: (port.ispName || port.provider || '').trim(),
          asn: asnVal,
          status: nextStatus,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.success) {
        throw new Error(data.error || `Update failed (${response.status})`);
      }
      await fetchPorts();
      if (editingPort === port.portNumber) {
        setForm((f) => ({ ...f, status: String(nextStatus) }));
      }
    } catch (err) {
      console.error('❌ Failed to toggle proxy port status:', err);
      setPorts(portsBeforeToggle);
      setError(err.message || 'Failed to update status');
    } finally {
      setTogglingPort(null);
    }
  };

  const handleDelete = async (portNumber) => {
    if (!window.confirm(`Delete proxy port ${portNumber}?`)) {
      return;
    }
    try {
      const response = await fetch(`/api/ports/${portNumber}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.success) {
        throw new Error(data.error || `Delete failed (${response.status})`);
      }
      await fetchPorts();
      if (editingPort === portNumber) {
        closeModal();
      }
    } catch (err) {
      console.error('❌ Failed to delete proxy port:', err);
      setError(err.message || 'Failed to delete proxy port');
    }
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!form.portNumber || !form.country || !form.countryCode || !form.ispName) {
      setFormError('Port number, country, country code, and ISP name are required.');
      return;
    }
    const portNumber = Number(form.portNumber);
    if (!Number.isFinite(portNumber) || portNumber <= 0) {
      setFormError('Port number must be a positive number.');
      return;
    }

    setSubmitting(true);
    setFormError('');
    try {
      const response = await fetch('/api/ports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          portNumber,
          country: form.country.trim(),
          countryCode: form.countryCode.trim().toUpperCase(),
          ispName: form.ispName.trim(),
          asn: form.asn.trim() === '' ? null : form.asn.trim(),
          status: Number(form.status),
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.success) {
        throw new Error(data.error || `Save failed (${response.status})`);
      }
      await fetchPorts();
      closeModal();
    } catch (err) {
      console.error('❌ Failed to save proxy port:', err);
      setFormError(err.message || 'Failed to save proxy port');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="page-content ports-panel">
      <header className="ports-header">
        <div>
          <h1>Proxy ports</h1>
          <p className="ports-subtitle">
            CRUD for SOAX proxy ports: country, ISP, ASN, and active status. Only active rows are used for
            measurements and dropdowns.
          </p>
        </div>
        <div className="ports-header-actions">
          <button type="button" className="ports-btn-secondary" onClick={openAddModal}>
            Add proxy port
          </button>
          <button type="button" onClick={fetchPorts} disabled={loading}>
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </header>

      {error && <div className="ports-banner warning">{error}</div>}

      <div className="ports-content">
        <section className="ports-list-section">
          <h2>Configured proxy ports</h2>
          {ports.length === 0 ? (
            <div className="ports-placeholder">
              <p>No proxy ports configured yet.</p>
              <button type="button" className="ports-placeholder-add" onClick={openAddModal}>
                Add proxy port
              </button>
            </div>
          ) : (
            <div className="ports-table-wrap">
              <table className="ports-table">
                <thead>
                  <tr>
                    <th>Port</th>
                    <th>Status</th>
                    <th>Country</th>
                    <th>Code</th>
                    <th>ISP</th>
                    <th>ASN</th>
                    <th>Updated</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {ports.map((port) => (
                    <tr key={port.portNumber}>
                      <td>{port.portNumber}</td>
                      <td className="ports-status-cell">
                        <label className="ports-switch">
                          <input
                            type="checkbox"
                            role="switch"
                            checked={Number(port.status) === 1}
                            onChange={(e) => handleStatusToggle(port, e.target.checked)}
                            disabled={loading || togglingPort === port.portNumber}
                            aria-label={
                              Number(port.status) === 1
                                ? `Deactivate port ${port.portNumber}`
                                : `Activate port ${port.portNumber}`
                            }
                          />
                          <span className="ports-switch-track" aria-hidden="true">
                            <span className="ports-switch-thumb" />
                          </span>
                        </label>
                      </td>
                      <td>{port.country}</td>
                      <td>{port.countryCode || port.countryShort}</td>
                      <td className="ports-isp-cell">{port.ispName || port.provider}</td>
                      <td>{port.asn != null ? port.asn : '—'}</td>
                      <td className="ports-ts">{formatTs(port.updatedAt)}</td>
                      <td className="ports-actions">
                        <button type="button" onClick={() => openEditModal(port)}>
                          Edit
                        </button>
                        <button
                          type="button"
                          className="danger"
                          onClick={() => handleDelete(port.portNumber)}
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      {modalOpen && (
        <div
          className="ports-modal-backdrop"
          role="presentation"
          onClick={closeModal}
        >
          <div
            className="ports-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="ports-modal-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="ports-modal-header">
              <h2 id="ports-modal-title">
                {editingPort ? `Edit port ${editingPort}` : 'Add proxy port'}
              </h2>
              <button
                type="button"
                className="ports-modal-close"
                onClick={closeModal}
                disabled={submitting}
                aria-label="Close"
              >
                ×
              </button>
            </div>
            <form className="ports-form ports-form-modal" onSubmit={handleSubmit}>
              <label>
                Port number
                <input
                  name="portNumber"
                  type="number"
                  min="1"
                  value={form.portNumber}
                  onChange={handleInputChange}
                  required
                  disabled={submitting || editingPort != null}
                />
              </label>
              <label>
                Country
                <input
                  name="country"
                  type="text"
                  value={form.country}
                  onChange={handleInputChange}
                  required
                  disabled={submitting}
                />
              </label>
              <label>
                Country code
                <input
                  name="countryCode"
                  type="text"
                  value={form.countryCode}
                  onChange={handleInputChange}
                  required
                  disabled={submitting}
                  placeholder="e.g. ES"
                />
              </label>
              <label>
                ISP name
                <input
                  name="ispName"
                  type="text"
                  value={form.ispName}
                  onChange={handleInputChange}
                  required
                  disabled={submitting}
                />
              </label>
              <label>
                ASN (optional)
                <input
                  name="asn"
                  type="number"
                  min="0"
                  value={form.asn}
                  onChange={handleInputChange}
                  disabled={submitting}
                  placeholder="Autonomous system number"
                />
              </label>
              <label>
                Status
                <select name="status" value={form.status} onChange={handleInputChange} disabled={submitting}>
                  <option value="1">Active (used for monitoring)</option>
                  <option value="0">Inactive</option>
                </select>
              </label>
              {formError && <div className="ports-banner warning ports-modal-error">{formError}</div>}
              <div className="ports-form-actions">
                <button type="submit" disabled={submitting}>
                  {submitting ? 'Saving…' : editingPort ? 'Save changes' : 'Add'}
                </button>
                <button type="button" className="secondary" onClick={closeModal} disabled={submitting}>
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

export default PortsPanel;
