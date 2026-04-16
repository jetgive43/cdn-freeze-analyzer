const mysql = require('mysql2/promise');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

/** HTTP-only targets: drop legacy check_type / SSH rows and enforce one row per (user, group, IP). */
async function migrateServerPingTargetsHttpOnly(db) {
  const [[ctCol]] = await db.execute(
    `SELECT COUNT(*) AS c FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = 'server_ping_targets' AND column_name = 'check_type'`
  );
  if (Number(ctCol.c) > 0) {
    try {
      await db.execute("DELETE FROM server_ping_targets WHERE check_type = 'ssh'");
    } catch (e) {
      console.warn('⚠️ server_ping_targets delete ssh:', e.message);
    }
    for (const name of ['uniq_server_ping_user_group_ip_check', 'uniq_server_ping_group_ip_check']) {
      try {
        await db.execute(`ALTER TABLE server_ping_targets DROP INDEX ${name}`);
      } catch (e) {
        if (e.errno !== 1091) {
          console.warn(`⚠️ drop index ${name}:`, e.message);
        }
      }
    }
    try {
      await db.execute(`DELETE t1 FROM server_ping_targets t1
        INNER JOIN server_ping_targets t2
        ON t1.user_id <=> t2.user_id AND t1.group_name = t2.group_name AND t1.ip_address = t2.ip_address AND t1.id > t2.id`);
    } catch (e) {
      console.warn('⚠️ server_ping_targets dedupe:', e.message);
    }
    try {
      await db.execute('ALTER TABLE server_ping_targets DROP COLUMN check_type');
    } catch (e) {
      console.warn('⚠️ drop server_ping_targets.check_type:', e.message);
    }
  }
  try {
    await db.execute(
      'ALTER TABLE server_ping_targets ADD UNIQUE KEY uniq_server_ping_user_group_ip (user_id, group_name, ip_address)'
    );
  } catch (e) {
    if (e.errno !== 1061) {
      console.warn('⚠️ add uniq_server_ping_user_group_ip:', e.message);
    }
  }
}

/** Client IP + creator_key for public / non-admin server-ping targets (replaces per-user_id for normal users). */
async function migrateServerPingTargetsCreatorKey(db) {
  const addCol = async (sql, ctx) => {
    try {
      await db.execute(sql);
    } catch (e) {
      if (e.errno !== 1060) {
        throw e;
      }
      console.log(`ℹ️  Schema change skipped for ${ctx}: already applied`);
    }
  };
  await addCol(
    'ALTER TABLE server_ping_targets ADD COLUMN client_ip VARCHAR(64) NULL AFTER user_id',
    'server_ping_targets.client_ip'
  );
  await addCol(
    'ALTER TABLE server_ping_targets ADD COLUMN creator_key VARCHAR(160) NULL AFTER client_ip',
    'server_ping_targets.creator_key'
  );
  try {
    await db.execute(
      `UPDATE server_ping_targets SET creator_key = CONCAT('uid:', user_id) WHERE user_id IS NOT NULL AND (creator_key IS NULL OR creator_key = '')`
    );
    await db.execute(
      `UPDATE server_ping_targets SET creator_key = CONCAT('legacy:', id) WHERE (creator_key IS NULL OR creator_key = '')`
    );
  } catch (e) {
    console.warn('⚠️ server_ping_targets creator_key backfill:', e.message);
  }
  try {
    await db.execute('ALTER TABLE server_ping_targets MODIFY creator_key VARCHAR(160) NOT NULL');
  } catch (e) {
    console.warn('⚠️ server_ping_targets creator_key NOT NULL:', e.message);
  }
  try {
    await db.execute('ALTER TABLE server_ping_targets DROP INDEX uniq_server_ping_user_group_ip');
  } catch (e) {
    if (e.errno !== 1091) {
      console.warn('⚠️ drop uniq_server_ping_user_group_ip:', e.message);
    }
  }
  try {
    await db.execute(
      'ALTER TABLE server_ping_targets ADD UNIQUE KEY uniq_spt_creator_group_ip (creator_key, group_name, ip_address)'
    );
  } catch (e) {
    if (e.errno !== 1061) {
      console.warn('⚠️ add uniq_spt_creator_group_ip:', e.message);
    }
  }
}

async function migrateServerMtrRunsDropCheckType(db) {
  const [[ctCol]] = await db.execute(
    `SELECT COUNT(*) AS c FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = 'server_mtr_runs' AND column_name = 'check_type'`
  );
  if (Number(ctCol.c) === 0) {
    return;
  }
  try {
    await db.execute('ALTER TABLE server_mtr_runs DROP COLUMN check_type');
  } catch (e) {
    console.warn('⚠️ drop server_mtr_runs.check_type:', e.message);
  }
}

const createDbConnection = () => {
  const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'network_monitor',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    timezone: '+00:00'
  });
  pool.on('connection', (connection) => {
    connection.query("SET time_zone = '+00:00'");
  });
  return pool;
};

const initializeDatabase = async (db) => {
  try {
    // Remove legacy account/contact/chat tables (Accounts feature removed)
    await db.execute('SET FOREIGN_KEY_CHECKS = 0');
    for (const tableName of [
      'cdn_server_domains',
      'cdn_servers',
      'chat_messages',
      'contacts',
      'accounts',
    ]) {
      try {
        await db.execute(`DROP TABLE IF EXISTS ${tableName}`);
      } catch (dropError) {
        console.error(`⚠️ Failed to drop ${tableName}:`, dropError.message);
      }
    }
    await db.execute('SET FOREIGN_KEY_CHECKS = 1');

    // Main measurements table
    await db.execute(`
        CREATE TABLE IF NOT EXISTS measurements (
          id INT AUTO_INCREMENT PRIMARY KEY,
          target_host VARCHAR(255) NOT NULL,
          target_port INT NOT NULL,
          proxy_host VARCHAR(255) NOT NULL,
          proxy_port INT NOT NULL,
          status VARCHAR(50) NOT NULL,
          rtt_ms DECIMAL(10,2),
          error_message TEXT,
          message TEXT,
          measurement_type VARCHAR(32) NULL DEFAULT 'http',
          check_type VARCHAR(16) NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_target (target_host, target_port),
          INDEX idx_proxy (proxy_host, proxy_port),
          INDEX idx_status (status),
          INDEX idx_created_at (created_at)
        )
      `);

    // PERFORMANCE OPTIMIZATION: Add composite index for better query performance on time-range queries
    // This index is critical for getRangeMeasurementsSmart queries
    // Uncomment and run manually if queries are slow:
    // await db.execute(`CREATE INDEX IF NOT EXISTS idx_proxy_port_created_target ON measurements (proxy_port, created_at, target_host)`);

    // InnoDB table for IP information - Use DECIMAL for large numbers
    await db.execute(`
        CREATE TABLE IF NOT EXISTS ip_ranges (
          start_ip_numeric DECIMAL(39, 0) UNSIGNED NOT NULL,
          end_ip_numeric DECIMAL(39, 0) UNSIGNED NOT NULL,
          start_ip VARCHAR(45) NOT NULL,
          end_ip VARCHAR(45) NOT NULL,
          asn VARCHAR(20) NOT NULL,
          company VARCHAR(255) NOT NULL,
          domain VARCHAR(255),
          ip_type ENUM('ipv4', 'ipv6') NOT NULL,
          PRIMARY KEY (start_ip_numeric, end_ip_numeric),
          INDEX idx_range (start_ip_numeric, end_ip_numeric),
          INDEX idx_asn (asn),
          INDEX idx_company (company(100)),
          INDEX idx_ip_type (ip_type)
        ) ENGINE=InnoDB
      `);
    await db.execute(`
        CREATE TABLE IF NOT EXISTS ip_company_cache (
          ip VARCHAR(45) PRIMARY KEY,
          company VARCHAR(255) NOT NULL,
          country VARCHAR(100),
          asn VARCHAR(20),
          ip_numeric DECIMAL(39, 0) UNSIGNED,  -- For binary search compatibility
          last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          source ENUM('ip_ranges', 'manual') DEFAULT 'ip_ranges',
          INDEX idx_company (company),
          INDEX idx_ip_numeric (ip_numeric)  -- Important for fast lookups
      ) ENGINE=MEMORY
      `);

    await db.execute(`
        CREATE TABLE IF NOT EXISTS error_logs (
          id INT AUTO_INCREMENT PRIMARY KEY,
          server_ip VARCHAR(45) NOT NULL,
          log_level ENUM('error', 'warn', 'alert', 'info', 'debug') NOT NULL,
          original_timestamp DATETIME NOT NULL,
          nginx_pid INT,
          client_ip VARCHAR(45),
          upstream TEXT,
          server_name VARCHAR(255),
          request TEXT,
          host VARCHAR(255),
          error_message TEXT NOT NULL,
          full_log_text TEXT NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_server_ip (server_ip),
          INDEX idx_log_level (log_level),
          INDEX idx_timestamp (original_timestamp),
          INDEX idx_created_at (created_at),
          INDEX idx_client_ip (client_ip)
        ) ENGINE=InnoDB
      `);
    await db.execute(`
        CREATE TABLE IF NOT EXISTS bandwidth_measurements (
          id INT AUTO_INCREMENT PRIMARY KEY,
          ip_address VARCHAR(45) NOT NULL,
          proxy_port INT NOT NULL DEFAULT 0,
          up_bandwidth DECIMAL(10,2) NOT NULL,
          timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_ip_timestamp (ip_address, timestamp),
          INDEX idx_proxy_port (proxy_port),
          INDEX idx_proxy_port_timestamp (proxy_port, timestamp)
        )
      `);

    const addColumnIfMissing = async (query, context, duplicateCodes = [1060]) => {
      try {
        await db.execute(query);
      } catch (error) {
        if (!duplicateCodes.includes(error.errno)) {
          console.error(`❌ Failed to execute schema change for ${context}:`, error.message);
          throw error;
        }
        console.log(`ℹ️  Schema change skipped for ${context}: already applied`);
      }
    };

    const dropColumnIfExists = async (tableName, columnName, context) => {
      try {
        const [[col]] = await db.execute(
          `SELECT COUNT(*) AS c FROM information_schema.columns
           WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
          [tableName, columnName]
        );
        if (Number(col.c) === 0) {
          return;
        }
        await db.execute(`ALTER TABLE \`${tableName}\` DROP COLUMN \`${columnName}\``);
        console.log(`✅ Dropped ${context}`);
      } catch (error) {
        console.warn(`⚠️ Drop column skipped for ${context}:`, error.message);
      }
    };

    await addColumnIfMissing(
      'ALTER TABLE bandwidth_measurements ADD COLUMN proxy_port INT NOT NULL DEFAULT 0 AFTER ip_address',
      'bandwidth_measurements.proxy_port'
    );

    await addColumnIfMissing(
      'ALTER TABLE bandwidth_measurements ADD INDEX idx_proxy_port (proxy_port)',
      'bandwidth_measurements.idx_proxy_port',
      [1061]
    );

    await addColumnIfMissing(
      'ALTER TABLE bandwidth_measurements ADD INDEX idx_proxy_port_timestamp (proxy_port, timestamp)',
      'bandwidth_measurements.idx_proxy_port_timestamp',
      [1061]
    );

    await addColumnIfMissing(
      `ALTER TABLE measurements ADD COLUMN measurement_type VARCHAR(32) NULL DEFAULT 'http' AFTER message`,
      'measurements.measurement_type'
    );

    await addColumnIfMissing(
      `ALTER TABLE measurements ADD COLUMN check_type VARCHAR(16) NULL AFTER measurement_type`,
      'measurements.check_type'
    );

    await addColumnIfMissing(
      `ALTER TABLE measurements ADD COLUMN viewer_country_code VARCHAR(8) NULL AFTER check_type`,
      'measurements.viewer_country_code'
    );
    await addColumnIfMissing(
      `ALTER TABLE measurements ADD COLUMN viewer_country_name VARCHAR(128) NULL AFTER viewer_country_code`,
      'measurements.viewer_country_name'
    );
    await addColumnIfMissing(
      `ALTER TABLE measurements ADD COLUMN viewer_isp VARCHAR(256) NULL AFTER viewer_country_name`,
      'measurements.viewer_isp'
    );
    await addColumnIfMissing(
      `ALTER TABLE measurements ADD INDEX idx_meas_server_ping_viewer (measurement_type, viewer_country_code, created_at)`,
      'measurements.idx_meas_server_ping_viewer',
      [1061]
    );

    try {
      await db.execute(
        `UPDATE measurements SET check_type = 'http' WHERE measurement_type = 'server_ping' AND check_type IS NULL`
      );
    } catch (e) {
      console.warn('ℹ️  measurements check_type backfill skipped:', e.message);
    }

    try {
      await db.execute('ALTER TABLE measurements DROP COLUMN proxy_protocol');
    } catch (dropErr) {
      if (dropErr.errno !== 1091) {
        throw dropErr;
      }
    }

    try {
      await db.execute('DROP TABLE IF EXISTS server_metrics');
      console.log('✅ Removed legacy server_metrics table (Server metrics UI removed)');
    } catch (e) {
      console.warn('⚠️ Drop server_metrics skipped:', e.message);
    }

    await db.execute(`
        CREATE TABLE IF NOT EXISTS proxy_ports (
          id INT AUTO_INCREMENT PRIMARY KEY,
          port_number INT NOT NULL,
          country VARCHAR(128) NOT NULL,
          country_code VARCHAR(16) NOT NULL,
          isp_name VARCHAR(255) NOT NULL,
          asn INT NULL,
          status INT NOT NULL DEFAULT 1,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          UNIQUE KEY uq_proxy_ports_number (port_number),
          KEY idx_proxy_ports_status (status)
        ) ENGINE=InnoDB
      `);

    const [[proxyCountRow]] = await db.execute(
      'SELECT COUNT(*) AS cnt FROM proxy_ports'
    );
    if (Number(proxyCountRow.cnt) === 0) {
      const [legacyTableRows] = await db.execute(
        `SELECT COUNT(*) AS c FROM information_schema.tables
         WHERE table_schema = DATABASE() AND table_name = 'ports'`
      );
      if (Number(legacyTableRows[0]?.c) > 0) {
        await db.execute(`
          INSERT INTO proxy_ports (port_number, country, country_code, isp_name, asn, status)
          SELECT port_number, country, country_short, provider, NULL, 1 FROM ports
        `);
        await db.execute('DROP TABLE IF EXISTS ports');
        console.log('✅ Migrated legacy ports → proxy_ports and dropped old ports table');
      } else {
        const seedPorts = [
          [10220, 'Spain', 'ES', 'Telecomunicaciones Publicas Andaluzas S.L.', null, 1],
          [10041, 'United Kingdom', 'UK', 'Virgin Media', null, 1],
          [10079, 'Canada', 'CA', 'Bell Canada', null, 1],
          [10238, 'Italy', 'IT', 'EOLO S.p.A.', null, 1],
          [10038, 'Portugal', 'PT', 'NOS Comunicacoes', null, 1],
        ];
        for (const row of seedPorts) {
          await db.execute(
            `INSERT INTO proxy_ports (port_number, country, country_code, isp_name, asn, status)
             VALUES (?, ?, ?, ?, ?, ?)`,
            row
          );
        }
        console.log('✅ Seeded proxy_ports with default proxy ports');
      }
    }

    await db.execute(`
        CREATE TABLE IF NOT EXISTS server_ping_targets (
          id INT AUTO_INCREMENT PRIMARY KEY,
          group_name VARCHAR(128) NOT NULL,
          location VARCHAR(255) NOT NULL,
          ip_address VARCHAR(45) NOT NULL,
          target_port INT NOT NULL DEFAULT 80,
          ssh_port INT NOT NULL DEFAULT 22,
          sort_order INT NOT NULL DEFAULT 0,
          user_id BIGINT UNSIGNED NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_server_ping_group (group_name)
        ) ENGINE=InnoDB
      `);

    await addColumnIfMissing(
      'ALTER TABLE server_ping_targets ADD COLUMN target_port INT NOT NULL DEFAULT 80 AFTER ip_address',
      'server_ping_targets.target_port'
    );

    await addColumnIfMissing(
      'ALTER TABLE server_ping_targets ADD COLUMN ssh_port INT NOT NULL DEFAULT 22 AFTER target_port',
      'server_ping_targets.ssh_port'
    );

    await addColumnIfMissing(
      `ALTER TABLE server_ping_targets ADD COLUMN http_probe_path VARCHAR(512) NOT NULL DEFAULT '' AFTER ssh_port`,
      'server_ping_targets.http_probe_path'
    );

    try {
      await db.execute('ALTER TABLE server_ping_targets DROP INDEX uniq_server_ping_group_ip');
    } catch (e) {
      if (e.errno !== 1091) {
        throw e;
      }
    }
    try {
      await db.execute('ALTER TABLE server_ping_targets DROP INDEX uniq_server_ping_group_ip_port');
    } catch (e) {
      if (e.errno !== 1091) {
        throw e;
      }
    }

    await db.execute(`
        CREATE TABLE IF NOT EXISTS users (
          id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
          email VARCHAR(255) NOT NULL,
          password_hash VARCHAR(255) NOT NULL,
          role ENUM('admin','user') NOT NULL DEFAULT 'user',
          email_verified_at DATETIME NULL,
          verification_token_hash CHAR(64) NULL,
          verification_token_expires_at DATETIME NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          UNIQUE KEY uq_users_email (email),
          KEY idx_users_role (role)
        ) ENGINE=InnoDB
      `);

    await addColumnIfMissing(
      'ALTER TABLE users ADD COLUMN password_reset_token_hash CHAR(64) NULL AFTER verification_token_expires_at',
      'users.password_reset_token_hash'
    );
    await addColumnIfMissing(
      'ALTER TABLE users ADD COLUMN password_reset_expires_at DATETIME NULL AFTER password_reset_token_hash',
      'users.password_reset_expires_at'
    );

    await db.execute(`
        CREATE TABLE IF NOT EXISTS server_ping_check_events (
          id BIGINT AUTO_INCREMENT PRIMARY KEY,
          user_id BIGINT UNSIGNED NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          KEY idx_check_user_time (user_id, created_at),
          CONSTRAINT fk_server_ping_check_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        ) ENGINE=InnoDB
      `);

    await addColumnIfMissing(
      'ALTER TABLE server_ping_targets ADD COLUMN user_id BIGINT UNSIGNED NULL AFTER sort_order',
      'server_ping_targets.user_id'
    );

    await db.execute(`
        CREATE TABLE IF NOT EXISTS proxy_groups (
          group_key VARCHAR(64) PRIMARY KEY,
          label VARCHAR(128) NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB
      `);

    await db.execute(`
        CREATE TABLE IF NOT EXISTS proxy_group_regions (
          region_name VARCHAR(128) PRIMARY KEY,
          group_key VARCHAR(64) NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX idx_proxy_group_regions_group (group_key)
        ) ENGINE=InnoDB
      `);

    await db.execute(`
        CREATE TABLE IF NOT EXISTS proxy_port_group_links (
          port_number INT NOT NULL,
          group_key VARCHAR(64) NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (port_number, group_key),
          INDEX idx_proxy_port_group_links_group (group_key)
        ) ENGINE=InnoDB
      `);

    const [[countRow]] = await db.execute(
      'SELECT COUNT(*) AS cnt FROM server_ping_targets'
    );
    if (Number(countRow.cnt) === 0) {
      console.log('ℹ️ server_ping_targets is empty; no code-based seeding is applied.');
    }

    // Seed default group dictionary (includes fallback Others group)
    const defaultGroups = [
      ['CANADA', 'Canada'],
      ['UK', 'United Kingdom'],
      ['SPAIN', 'Spain'],
      ['ITALY', 'Italy'],
      ['GERMANY', 'Germany'],
      ['US_EAST', 'US East'],
      ['OTHERS', 'Others'],
    ];
    for (const [groupKey, label] of defaultGroups) {
      await db.execute(
        `INSERT INTO proxy_groups (group_key, label)
         VALUES (?, ?)
         ON DUPLICATE KEY UPDATE label = VALUES(label)`,
        [groupKey, label]
      );
    }

    // Seed region->group defaults once if empty. Operators can change in Group Management page.
    const [[regionMapCount]] = await db.execute(
      'SELECT COUNT(*) AS cnt FROM proxy_group_regions'
    );
    if (Number(regionMapCount.cnt) === 0) {
      const defaultRegionMappings = [
        ['Canada', 'CANADA'],
        ['UK', 'UK'],
        ['Spain', 'SPAIN'],
        ['Italy', 'ITALY'],
        ['Germany', 'GERMANY'],
        ['US_EAST', 'US_EAST'],
      ];
      for (const [regionName, groupKey] of defaultRegionMappings) {
        await db.execute(
          `INSERT INTO proxy_group_regions (region_name, group_key)
           VALUES (?, ?)`,
          [regionName, groupKey]
        );
      }
    }

    // Seed port->group defaults once if empty using active proxy_ports country code.
    const [[linkCountRow]] = await db.execute(
      'SELECT COUNT(*) AS cnt FROM proxy_port_group_links'
    );
    if (Number(linkCountRow.cnt) === 0) {
      const [activePorts] = await db.execute(
        `SELECT port_number, country_code
         FROM proxy_ports
         WHERE status = 1
         ORDER BY port_number`
      );
      const inferGroupFromCountry = (countryCode) => {
        const cc = String(countryCode || '').toUpperCase();
        if (['CA', 'US', 'ZX'].includes(cc)) return 'CANADA';
        if (['UK', 'GB', 'IE', 'ZY'].includes(cc)) return 'UK';
        if (['ES', 'PT', 'SP', 'ML', 'MU', 'ZZ'].includes(cc)) return 'SPAIN';
        if (['IT', 'CY'].includes(cc)) return 'ITALY';
        if (['DE', 'AL', 'GR', 'TR'].includes(cc)) return 'GERMANY';
        return 'US_EAST';
      };
      for (const p of activePorts) {
        await db.execute(
          `INSERT INTO proxy_port_group_links (port_number, group_key)
           VALUES (?, ?)
           ON DUPLICATE KEY UPDATE group_key = VALUES(group_key)`,
          [p.port_number, inferGroupFromCountry(p.country_code)]
        );
      }
    }

    await db.execute(`
        CREATE TABLE IF NOT EXISTS system_settings (
          setting_key VARCHAR(100) PRIMARY KEY,
          setting_value TEXT,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB
      `);

    await db.execute(`
        CREATE TABLE IF NOT EXISTS business_servers (
          id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
          display_name VARCHAR(255) NOT NULL,
          ingest_token CHAR(64) NOT NULL,
          ssh_host VARCHAR(255) NULL,
          ssh_port INT UNSIGNED NOT NULL DEFAULT 22,
          ssh_user VARCHAR(128) NULL,
          deploy_status VARCHAR(32) NULL DEFAULT 'pending',
          deploy_message VARCHAR(512) NULL,
          bandwidth_capacity_mbps DECIMAL(12,4) NULL,
          last_ip VARCHAR(64) NULL,
          last_seen_at DATETIME(3) NULL,
          created_at TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP(3),
          updated_at TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
          UNIQUE KEY uq_business_ingest (ingest_token),
          KEY idx_business_seen (last_seen_at)
        ) ENGINE=InnoDB
      `);

    await addColumnIfMissing(
      'ALTER TABLE business_servers ADD COLUMN bandwidth_capacity_mbps DECIMAL(12,4) NULL AFTER deploy_message',
      'business_servers.bandwidth_capacity_mbps'
    );

    await addColumnIfMissing(
      `ALTER TABLE business_servers ADD COLUMN group_name VARCHAR(128) NOT NULL DEFAULT 'General' AFTER display_name`,
      'business_servers.group_name'
    );
    await addColumnIfMissing(
      'ALTER TABLE business_servers ADD COLUMN cpu_cores SMALLINT UNSIGNED NULL AFTER bandwidth_capacity_mbps',
      'business_servers.cpu_cores'
    );
    await addColumnIfMissing(
      'ALTER TABLE business_servers ADD COLUMN ram_total_mb INT UNSIGNED NULL AFTER cpu_cores',
      'business_servers.ram_total_mb'
    );

    await db.execute(`
        CREATE TABLE IF NOT EXISTS business_server_metrics (
          id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
          business_server_id BIGINT UNSIGNED NOT NULL,
          recorded_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
          cpu_percent DECIMAL(8,2) NULL,
          ram_percent DECIMAL(8,2) NULL,
          disk_percent DECIMAL(8,2) NULL,
          dl_mbps DECIMAL(12,4) NULL,
          ul_mbps DECIMAL(12,4) NULL,
          rps DECIMAL(12,4) NULL,
          db_qps DECIMAL(12,4) NULL,
          KEY idx_bsm_server_time (business_server_id, recorded_at),
          KEY idx_bsm_recorded (recorded_at),
          CONSTRAINT fk_bsm_server FOREIGN KEY (business_server_id) REFERENCES business_servers(id) ON DELETE CASCADE
        ) ENGINE=InnoDB
      `);

    try {
      const [[{ mc }]] = await db.execute(`SELECT COUNT(*) AS mc FROM business_server_metrics`);
      const [[{ cc }]] = await db.execute(
        `SELECT COUNT(*) AS cc FROM information_schema.columns
         WHERE table_schema = DATABASE() AND table_name = 'business_servers' AND column_name = 'last_cpu'`
      );
      if (Number(mc) === 0 && Number(cc) > 0) {
        await db.execute(`
          INSERT INTO business_server_metrics (
            business_server_id, recorded_at, cpu_percent, ram_percent, disk_percent,
            dl_mbps, ul_mbps, rps, db_qps
          )
          SELECT
            id,
            COALESCE(last_seen_at, UTC_TIMESTAMP(3)),
            last_cpu, last_ram, last_disk, last_dl_mbps, last_ul_mbps, last_rps, last_db_qps
          FROM business_servers
          WHERE last_seen_at IS NOT NULL
        `);
        console.log('✅ Backfilled business_server_metrics from business_servers snapshot');
      }
    } catch (e) {
      console.warn('⚠️ business_server_metrics backfill skipped:', e.message);
    }

    for (const col of [
      'last_cpu',
      'last_ram',
      'last_disk',
      'last_dl_mbps',
      'last_ul_mbps',
      'last_rps',
      'last_db_qps'
    ]) {
      await dropColumnIfExists('business_servers', col, `business_servers.${col}`);
    }

    await db.execute(`
        CREATE TABLE IF NOT EXISTS server_mtr_runs (
          id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
          server_ping_target_id INT NOT NULL,
          proxy_host VARCHAR(255) NOT NULL,
          proxy_port INT NOT NULL,
          path_mode VARCHAR(24) NOT NULL DEFAULT 'direct',
          target_port INT NOT NULL,
          status VARCHAR(32) NOT NULL,
          report_text MEDIUMTEXT NULL,
          summary_json JSON NULL,
          error_message TEXT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          KEY idx_mtr_target_proxy_time (server_ping_target_id, proxy_port, created_at),
          CONSTRAINT fk_server_mtr_target
            FOREIGN KEY (server_ping_target_id) REFERENCES server_ping_targets(id) ON DELETE CASCADE
        ) ENGINE=InnoDB
      `);

    await migrateServerMtrRunsDropCheckType(db);

    const { bootstrapServerPingAuth } = require('./serverPingAuthBootstrap');
    await bootstrapServerPingAuth(db);

    await migrateServerPingTargetsHttpOnly(db);
    await migrateServerPingTargetsCreatorKey(db);

    await db.execute("SET time_zone = '+00:00';");
    console.log('✅ Database tables initialized successfully');
  } catch (error) {
    console.error('❌ Database initialization failed:', error.message);
    throw error;
  }
};

module.exports = {
  createDbConnection,
  initializeDatabase
};