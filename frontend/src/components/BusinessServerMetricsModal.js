import React from 'react';
import BusinessServerMetricsCharts from './BusinessServerMetricsCharts';

export default function BusinessServerMetricsModal({ server, onClose, authHeader }) {
	if (!server) return null;

	const title = server.display_name || `Server ${server.id}`;

	return (
		<div
			className="server-ping-modal-backdrop business-servers-metrics-modal-backdrop"
			role="presentation"
			onClick={(e) => {
				if (e.target === e.currentTarget) onClose();
			}}
		>
			<div
				className="server-ping-modal business-servers-metrics-modal"
				role="dialog"
				aria-modal="true"
				aria-labelledby="business-servers-metrics-title"
				onClick={(e) => e.stopPropagation()}
			>
				<div className="server-ping-modal-header">
					<h2 id="business-servers-metrics-title">Metrics — {title}</h2>
					<button type="button" className="server-ping-modal-close" onClick={onClose} aria-label="Close">
						×
					</button>
				</div>
				<BusinessServerMetricsCharts server={server} authHeader={authHeader} embedded={false} />
			</div>
		</div>
	);
}
