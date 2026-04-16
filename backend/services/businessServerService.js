'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Client } = require('ssh2');

/** Safe single-quoted literal for bash. */
function bashSingleQuote(str) {
  return `'${String(str).replace(/'/g, `'\\''`)}'`;
}

class BusinessServerService {
  constructor(db) {
    this.db = db;
    this.scriptPathLoop = path.join(__dirname, '../scripts/business-server-agent.sh');
    this.scriptPathOnce = path.join(__dirname, '../scripts/business-server-agent-once.sh');
  }

  genToken() {
    return crypto.randomBytes(32).toString('hex');
  }

  ingestUrl() {
    const base = (process.env.BUSINESS_METRICS_PUBLIC_BASE || '').replace(/\/$/, '');
    if (!base) return null;
    return `${base}/api/business-servers/ingest`;
  }

  async list() {
    const [rows] = await this.db.execute(
      `SELECT
        bs.id,
        bs.display_name,
        bs.group_name,
        bs.ssh_host,
        bs.ssh_port,
        bs.ssh_user,
        bs.deploy_status,
        bs.deploy_message,
        bs.bandwidth_capacity_mbps,
        bs.cpu_cores,
        bs.ram_total_mb,
        bs.last_ip,
        lm.cpu_percent AS last_cpu,
        lm.ram_percent AS last_ram,
        lm.disk_percent AS last_disk,
        lm.dl_mbps AS last_dl_mbps,
        lm.ul_mbps AS last_ul_mbps,
        lm.rps AS last_rps,
        lm.db_qps AS last_db_qps,
        bs.last_seen_at,
        bs.created_at
      FROM business_servers bs
      LEFT JOIN (
        SELECT
          business_server_id,
          recorded_at,
          cpu_percent,
          ram_percent,
          disk_percent,
          dl_mbps,
          ul_mbps,
          rps,
          db_qps
        FROM (
          SELECT
            business_server_id,
            recorded_at,
            cpu_percent,
            ram_percent,
            disk_percent,
            dl_mbps,
            ul_mbps,
            rps,
            db_qps,
            ROW_NUMBER() OVER (
              PARTITION BY business_server_id
              ORDER BY recorded_at DESC, id DESC
            ) AS rn
          FROM business_server_metrics
        ) ranked
        WHERE ranked.rn = 1
      ) lm ON lm.business_server_id = bs.id
      ORDER BY bs.group_name ASC, bs.display_name ASC`
    );
    return rows;
  }

  /** Up to 3 days of samples (same retention as DB cleanup). */
  async metricsHistory(serverId) {
    const idNum = Number(serverId);
    if (!Number.isFinite(idNum) || idNum <= 0) {
      const err = new Error('Invalid server id');
      err.statusCode = 400;
      throw err;
    }
    const [[row]] = await this.db.execute(`SELECT id FROM business_servers WHERE id = ?`, [idNum]);
    if (!row) {
      const err = new Error('Not found');
      err.statusCode = 404;
      throw err;
    }
    const [points] = await this.db.execute(
      `SELECT recorded_at, cpu_percent, ram_percent, disk_percent, dl_mbps, ul_mbps, rps, db_qps
       FROM business_server_metrics
       WHERE business_server_id = ?
         AND recorded_at >= UTC_TIMESTAMP(3) - INTERVAL 3 DAY
       ORDER BY recorded_at ASC, id ASC`,
      [idNum]
    );
    return points;
  }

  parseGroupName(raw) {
    const g = String(raw == null ? '' : raw).trim().slice(0, 128);
    return g || 'General';
  }

  parseCpuCores(raw) {
    if (raw == null || raw === '') return null;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0 || n > 65535) {
      const err = new Error('Thread count must be a positive integer (1–65535) or empty');
      err.statusCode = 400;
      throw err;
    }
    return Math.round(n);
  }

  parseRamTotalMbFromGb(raw) {
    if (raw == null || raw === '') return null;
    const g = Number(raw);
    if (!Number.isFinite(g) || g <= 0) {
      const err = new Error('ramTotalGb must be a positive number or empty');
      err.statusCode = 400;
      throw err;
    }
    return Math.min(4294967295, Math.round(g * 1024));
  }

  async create({
    displayName,
    groupName,
    sshHost,
    sshPort,
    sshUser,
    sshPassword,
    bandwidthCapacityMbps,
    cpuCores,
    ramTotalGb,
  }) {
    const name = String(displayName || '').trim().slice(0, 255);
    if (!name) {
      const err = new Error('displayName is required');
      err.statusCode = 400;
      throw err;
    }
    const group = this.parseGroupName(groupName);
    const cpuInsert = cpuCores != null && cpuCores !== '' ? this.parseCpuCores(cpuCores) : null;
    const ramMbInsert = ramTotalGb != null && ramTotalGb !== '' ? this.parseRamTotalMbFromGb(ramTotalGb) : null;
    const token = this.genToken();
    const bwCap = this.num(bandwidthCapacityMbps);
    const bwInsert = bwCap != null && bwCap >= 0 ? bwCap : null;
    const [ins] = await this.db.execute(
      `INSERT INTO business_servers (display_name, group_name, ingest_token, ssh_host, ssh_port, ssh_user, deploy_status, bandwidth_capacity_mbps, cpu_cores, ram_total_mb)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      [
        name,
        group,
        token,
        sshHost ? String(sshHost).trim() : null,
        Math.min(65535, Math.max(1, Number(sshPort) || 22)),
        sshUser ? String(sshUser).trim() : null,
        bwInsert,
        cpuInsert,
        ramMbInsert,
      ]
    );
    const id = ins.insertId;
    const postUrl = this.ingestUrl();
    let deployStatus = 'pending';
    let deployMessage = 'Copy agent script; set POST_URL and INGEST_TOKEN';

    const canSsh =
      postUrl &&
      sshHost &&
      sshUser &&
      (Boolean(sshPassword) || (process.env.BUSINESS_SSH_PRIVATE_KEY_PATH && fs.existsSync(process.env.BUSINESS_SSH_PRIVATE_KEY_PATH)));

    if (!postUrl) {
      deployMessage =
        'Set BUSINESS_METRICS_PUBLIC_BASE (e.g. http://server-monitor-platform.com) then redeploy or run agent manually';
    } else if (!sshHost || !sshUser) {
      deployMessage = 'No SSH target saved; run agent manually with POST_URL and token';
    } else if (!canSsh) {
      deployMessage = 'Provide sshPassword once on create, or set BUSINESS_SSH_PRIVATE_KEY_PATH on this host';
    } else {
      try {
        await this.deployViaSsh(
          {
            host: String(sshHost).trim(),
            port: Number(sshPort) || 22,
            user: String(sshUser).trim(),
            password: sshPassword || undefined,
          },
          postUrl,
          token,
          name,
          id
        );
        deployStatus = 'ok';
        deployMessage = 'Cron runs every minute; first metrics push completed.';
      } catch (e) {
        deployStatus = 'failed';
        deployMessage = String(e.message || e).slice(0, 500);
      }
    }

    await this.db.execute(`UPDATE business_servers SET deploy_status = ?, deploy_message = ? WHERE id = ?`, [
      deployStatus,
      deployMessage,
      id,
    ]);

    const sshAutoOk = deployStatus === 'ok';
    return {
      id,
      ingestToken: sshAutoOk ? null : token,
      deployStatus,
      deployMessage,
      ingestUrl: sshAutoOk ? null : postUrl,
      cronInstalled: Boolean(sshAutoOk),
    };
  }

  async remove(id) {
    const [r] = await this.db.execute(`DELETE FROM business_servers WHERE id = ?`, [Number(id)]);
    return r.affectedRows > 0;
  }

  async updateFields(id, body) {
    const idNum = Number(id);
    const [[row]] = await this.db.execute(
      `SELECT id, display_name, group_name, ssh_host, ssh_port, ssh_user, bandwidth_capacity_mbps, cpu_cores, ram_total_mb FROM business_servers WHERE id = ?`,
      [idNum]
    );
    if (!row) {
      const err = new Error('Not found');
      err.statusCode = 404;
      throw err;
    }

    let displayName = row.display_name;
    if (Object.prototype.hasOwnProperty.call(body || {}, 'displayName')) {
      displayName = String(body.displayName || '').trim().slice(0, 255);
      if (!displayName) {
        const err = new Error('displayName cannot be empty');
        err.statusCode = 400;
        throw err;
      }
    }

    let sshHost = row.ssh_host;
    if (Object.prototype.hasOwnProperty.call(body || {}, 'sshHost')) {
      const h = body.sshHost;
      sshHost = h == null || String(h).trim() === '' ? null : String(h).trim().slice(0, 255);
    }

    let sshPort = row.ssh_port;
    if (Object.prototype.hasOwnProperty.call(body || {}, 'sshPort')) {
      sshPort = Math.min(65535, Math.max(1, Number(body.sshPort) || 22));
    }

    let sshUser = row.ssh_user;
    if (Object.prototype.hasOwnProperty.call(body || {}, 'sshUser')) {
      const u = body.sshUser;
      sshUser = u == null || String(u).trim() === '' ? null : String(u).trim().slice(0, 128);
    }

    let bw = row.bandwidth_capacity_mbps;
    if (Object.prototype.hasOwnProperty.call(body || {}, 'bandwidthCapacityMbps')) {
      const raw = body.bandwidthCapacityMbps;
      if (raw === '' || raw == null) {
        bw = null;
      } else {
        const n = Number(raw);
        if (!Number.isFinite(n) || n < 0) {
          const err = new Error('bandwidthCapacityMbps must be a non-negative number');
          err.statusCode = 400;
          throw err;
        }
        bw = Math.round(n);
      }
    }

    let groupName = row.group_name;
    if (Object.prototype.hasOwnProperty.call(body || {}, 'groupName')) {
      groupName = this.parseGroupName(body.groupName);
    }

    let cpuCoresOut = row.cpu_cores;
    if (Object.prototype.hasOwnProperty.call(body || {}, 'cpuCores')) {
      const raw = body.cpuCores;
      cpuCoresOut = raw === '' || raw == null ? null : this.parseCpuCores(raw);
    }

    let ramTotalMb = row.ram_total_mb;
    if (Object.prototype.hasOwnProperty.call(body || {}, 'ramTotalGb')) {
      const raw = body.ramTotalGb;
      ramTotalMb = raw === '' || raw == null ? null : this.parseRamTotalMbFromGb(raw);
    }

    await this.db.execute(
      `UPDATE business_servers SET display_name = ?, group_name = ?, ssh_host = ?, ssh_port = ?, ssh_user = ?, bandwidth_capacity_mbps = ?, cpu_cores = ?, ram_total_mb = ? WHERE id = ?`,
      [displayName, groupName, sshHost, sshPort, sshUser, bw, cpuCoresOut, ramTotalMb, idNum]
    );

    return {
      id: idNum,
      displayName,
      groupName,
      sshHost,
      sshPort,
      sshUser,
      bandwidthCapacityMbps: bw,
      cpuCores: cpuCoresOut,
      ramTotalGb: ramTotalMb == null ? null : Math.round((ramTotalMb / 1024) * 1000) / 1000,
    };
  }

  async reinstallAgent(id, sshPassword) {
    const idNum = Number(id);
    const postUrl = this.ingestUrl();
    if (!postUrl) {
      const err = new Error('Set BUSINESS_METRICS_PUBLIC_BASE on the monitor host');
      err.statusCode = 400;
      throw err;
    }
    const [[row]] = await this.db.execute(
      `SELECT id, display_name, ingest_token, ssh_host, ssh_port, ssh_user FROM business_servers WHERE id = ?`,
      [idNum]
    );
    if (!row) {
      const err = new Error('Not found');
      err.statusCode = 404;
      throw err;
    }
    if (!row.ssh_host || !row.ssh_user) {
      const err = new Error('SSH host and user must be set; use Edit to add them');
      err.statusCode = 400;
      throw err;
    }

    const keyPath = process.env.BUSINESS_SSH_PRIVATE_KEY_PATH;
    const hasKey = keyPath && fs.existsSync(keyPath);
    if (!sshPassword && !hasKey) {
      const err = new Error('Provide sshPassword or configure BUSINESS_SSH_PRIVATE_KEY_PATH on this host');
      err.statusCode = 400;
      throw err;
    }

    let deployStatus = 'failed';
    let deployMessage = '';
    try {
      await this.deployViaSsh(
        {
          host: String(row.ssh_host).trim(),
          port: Number(row.ssh_port) || 22,
          user: String(row.ssh_user).trim(),
          password: sshPassword || undefined,
        },
        postUrl,
        row.ingest_token,
        row.display_name,
        idNum
      );
      deployStatus = 'ok';
      deployMessage = 'Reinstalled: cron every minute; first metrics push completed.';
    } catch (e) {
      deployStatus = 'failed';
      deployMessage = String(e.message || e).slice(0, 500);
    }

    await this.db.execute(`UPDATE business_servers SET deploy_status = ?, deploy_message = ? WHERE id = ?`, [
      deployStatus,
      deployMessage,
      idNum,
    ]);

    return {
      id: idNum,
      deployStatus,
      deployMessage,
      cronInstalled: deployStatus === 'ok',
    };
  }

  num(v) {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  async ingest(body) {
    const token = String(body.ingest_token || body.token || '').trim();
    if (!/^[a-f0-9]{64}$/i.test(token)) {
      const err = new Error('Invalid ingest_token');
      err.statusCode = 401;
      throw err;
    }
    const ip = String(body.ip || '').trim().slice(0, 64);
    const cpu = this.num(body.cpu_percent);
    const ram = this.num(body.ram_percent);
    const disk = this.num(body.disk_percent);
    const dl = this.num(body.download_mbps);
    const ul = this.num(body.upload_mbps);
    const rps = this.num(body.request_per_sec);
    const dbq = this.num(body.db_qps);

    const [[srv]] = await this.db.execute(`SELECT id FROM business_servers WHERE ingest_token = ?`, [token]);
    if (!srv) {
      const err = new Error('Unknown ingest_token');
      err.statusCode = 404;
      throw err;
    }
    const serverId = srv.id;
    await this.db.execute(
      `INSERT INTO business_server_metrics (
        business_server_id, recorded_at,
        cpu_percent, ram_percent, disk_percent,
        dl_mbps, ul_mbps, rps, db_qps
      ) VALUES (?, UTC_TIMESTAMP(3), ?, ?, ?, ?, ?, ?, ?)`,
      [serverId, cpu, ram, disk, dl, ul, rps, dbq]
    );
    await this.db.execute(`UPDATE business_servers SET last_ip = ?, last_seen_at = UTC_TIMESTAMP(3) WHERE id = ?`, [
      ip,
      serverId,
    ]);
    await this.db.execute(
      `DELETE FROM business_server_metrics WHERE recorded_at < UTC_TIMESTAMP(3) - INTERVAL 3 DAY`
    );
    return { ok: true };
  }

  exec(conn, cmd) {
    return new Promise((resolve, reject) => {
      conn.exec(cmd, (err, stream) => {
        if (err) return reject(err);
        let out = '';
        let errOut = '';
        stream
          .on('close', (code, signal) => resolve({ code, signal, out, err: errOut }))
          .on('data', (d) => {
            out += d.toString();
          });
        stream.stderr.on('data', (d) => {
          errOut += d.toString();
        });
      });
    });
  }

  buildEnvFileBody(postUrl, token, metricName) {
    const name = String(metricName || '').replace(/\r?\n/g, ' ').trim() || 'server';
    return [
      `POST_URL=${bashSingleQuote(postUrl)}`,
      `INGEST_TOKEN=${bashSingleQuote(token)}`,
      `METRIC_NAME=${bashSingleQuote(name)}`,
      'METRIC_TYPE=pdns',
      'SAMPLE_SECONDS=2',
      '',
    ].join('\n');
  }

  buildCronInstallerScript({ serverId, remoteEnvPath, remoteOncePath }) {
    const marker = `# cdn-monitor-bm-id-${serverId}`;
    const cronLine = `* * * * * set -a; . ${bashSingleQuote(remoteEnvPath)}; set +a; /bin/bash ${bashSingleQuote(remoteOncePath)} >> /tmp/business-metrics-cron.log 2>&1`;
    return `#!/bin/bash
set -euo pipefail
MARK=${bashSingleQuote(marker)}
CRONLINE=${bashSingleQuote(cronLine)}
TMP=$(mktemp)
{
  crontab -l 2>/dev/null | awk -v m="$MARK" '$0==m{skip=1;next} skip==1{skip=0;next} {print}' || true
  echo "$MARK"
  echo "$CRONLINE"
} > "$TMP"
crontab "$TMP"
rm -f "$TMP"
`;
  }

  async deployViaSsh({ host, port, user, password }, postUrl, token, metricName, serverId) {
    const onceScript = fs.readFileSync(this.scriptPathOnce, 'utf8');
    const envBody = this.buildEnvFileBody(postUrl, token, metricName);
    const keyPath = process.env.BUSINESS_SSH_PRIVATE_KEY_PATH;
    let privateKey;
    if (keyPath && fs.existsSync(keyPath)) {
      privateKey = fs.readFileSync(keyPath);
    }
    const conn = new Client();
    await new Promise((resolve, reject) => {
      conn
        .on('ready', resolve)
        .on('error', reject)
        .connect({
          host,
          port: port || 22,
          username: user,
          password: password || undefined,
          privateKey: privateKey || undefined,
          readyTimeout: 25000,
        });
    });
    try {
      const { out: homeOut } = await this.exec(conn, 'echo $HOME');
      const home = String(homeOut || '').trim() || '/root';
      const remoteOnce = `${home}/.business-metrics-agent-once.sh`;
      const remoteEnv = `${home}/.business-metrics-bm-${serverId}.env`;
      const remoteInstaller = `${home}/.business-metrics-install-cron-${serverId}.sh`;
      const installerScript = this.buildCronInstallerScript({
        serverId,
        remoteEnvPath: remoteEnv,
        remoteOncePath: remoteOnce,
      });

      await new Promise((resolve, reject) => {
        conn.sftp(async (err, sftp) => {
          if (err) return reject(err);
          const write = (remotePath, buf) =>
            new Promise((res, rej) => {
              const w = sftp.createWriteStream(remotePath);
              w.on('error', rej);
              w.on('close', res);
              w.end(Buffer.from(buf, 'utf8'));
            });
          try {
            await write(remoteOnce, onceScript);
            await write(remoteEnv, envBody);
            await write(remoteInstaller, installerScript);
            resolve();
          } catch (e) {
            reject(e);
          }
        });
      });

      const shQ = (p) => `'${String(p).replace(/'/g, "'\"'\"'")}'`;
      await this.exec(conn, `chmod +x ${shQ(remoteOnce)} ${shQ(remoteInstaller)}`);
      await this.exec(conn, `pkill -f 'business-metrics-agent.sh' 2>/dev/null || true`);
      await this.exec(conn, `pkill -f 'business-metrics-agent-once.sh' 2>/dev/null || true`);
      const firstRunCmd = `bash -c "set -a; . ${shQ(remoteEnv)} && set +a && bash ${shQ(remoteOnce)}"`;
      const firstRun = await this.exec(conn, firstRunCmd);
      if (firstRun.code !== 0) {
        const detail = [firstRun.err, firstRun.out].filter(Boolean).join('\n').trim();
        throw new Error(detail || `First metrics push failed (exit ${firstRun.code}). Cron was not installed.`);
      }
      const { code: cronCode, err: cronErr } = await this.exec(conn, `bash ${shQ(remoteInstaller)}`);
      if (cronCode !== 0) {
        throw new Error(cronErr || `Cron install exited ${cronCode}`);
      }
    } finally {
      conn.end();
    }
  }
}

module.exports = BusinessServerService;
