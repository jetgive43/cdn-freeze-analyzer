/**
 * Time-series rows in `server_metrics` (see database.js). Used for optional host metrics charts.
 */
class MetricsController {
	constructor(db) {
		this.db = db;
	}

	async listServers(req, res) {
		try {
			const [rows] = await this.db.execute(
				`SELECT DISTINCT server FROM server_metrics ORDER BY server ASC LIMIT 500`
			);
			res.json({ success: true, servers: rows.map((r) => r.server) });
		} catch (error) {
			console.error('❌ metrics listServers:', error.message);
			res.status(500).json({ success: false, error: 'Failed to list metric servers' });
		}
	}

	async getSeries(req, res) {
		try {
			const server = req.query.server;
			if (!server || String(server).trim() === '') {
				return res.status(400).json({ success: false, error: 'server query parameter is required' });
			}
			const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 2000);
			const [rows] = await this.db.execute(
				`SELECT id, server, timestamp, cpu_usage, mem_usage, disk_read_mb, disk_write_mb,
            disk_read_mb_per_min, disk_write_mb_per_min, nginx_request_count_per_min, created_at
         FROM server_metrics WHERE server = ? ORDER BY timestamp DESC LIMIT ?`,
				[String(server).trim(), limit]
			);
			res.json({ success: true, data: rows });
		} catch (error) {
			console.error('❌ metrics getSeries:', error.message);
			res.status(500).json({ success: false, error: 'Failed to load metrics series' });
		}
	}
}

module.exports = MetricsController;
