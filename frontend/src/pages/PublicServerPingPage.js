import React from 'react';
import { useParams } from 'react-router-dom';
import ServerPingPanel from '../components/ServerPingPanel';

/**
 * Client-facing server ping at `/` or `/group/:publicGroup` — no login/signup chrome;
 * targets are scoped by client IP on the server. The group path shows one group only.
 */
export default function PublicServerPingPage() {
	const { publicGroup } = useParams();
	return (
		<div className="App app-solo">
			<main className="content-area app-solo-main">
				<ServerPingPanel publicMode publicGroupSlug={publicGroup} />
			</main>
		</div>
	);
}
