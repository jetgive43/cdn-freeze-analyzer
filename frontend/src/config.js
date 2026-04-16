/**
 * Empty: browser calls /api on the same origin (nginx proxy or CRA dev proxy).
 * Set REACT_APP_API_BASE_URL when the UI is served on one host:port and the API on another
 * (e.g. http://194.120.230.185:3000 + http://194.120.230.185:5000). No trailing slash.
 */
const raw = process.env.REACT_APP_API_BASE_URL || '';
export const backendApiUrl = typeof raw === 'string' ? raw.replace(/\/$/, '') : '';

/** WebSocket for measurements: same host as page, or API host if REACT_APP_API_BASE_URL is set. */
export function getBackendWebSocketUrl() {
	if (backendApiUrl) {
		try {
			const u = new URL(backendApiUrl);
			const wsProto = u.protocol === 'https:' ? 'wss:' : 'ws:';
			return `${wsProto}//${u.host}/ws`;
		} catch {
			/* fall through */
		}
	}
	if (typeof window !== 'undefined') {
		return `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`;
	}
	return 'ws://localhost:5000/ws';
}