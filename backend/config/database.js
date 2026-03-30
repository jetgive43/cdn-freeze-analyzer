const mysql = require('mysql2/promise');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

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

    await db.execute(`
        CREATE TABLE IF NOT EXISTS server_metrics (
          id INT AUTO_INCREMENT PRIMARY KEY,
          server VARCHAR(255) NOT NULL,
          timestamp DATETIME NOT NULL,
          cpu_usage DECIMAL(5,2) DEFAULT 0,
          mem_usage DECIMAL(5,2) DEFAULT 0,
          disk_read_mb DECIMAL(12,2) DEFAULT 0,
          disk_write_mb DECIMAL(12,2) DEFAULT 0,
          disk_read_mb_per_min DECIMAL(12,2) DEFAULT 0,
          disk_write_mb_per_min DECIMAL(12,2) DEFAULT 0,
          nginx_request_count_per_min INT DEFAULT 0,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_server (server),
          INDEX idx_timestamp (timestamp),
          INDEX idx_server_timestamp (server, timestamp),
          INDEX idx_created_at (created_at)
        ) ENGINE=InnoDB
      `);

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
          sort_order INT NOT NULL DEFAULT 0,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE KEY uniq_server_ping_group_ip (group_name, ip_address),
          INDEX idx_server_ping_group (group_name)
        ) ENGINE=InnoDB
      `);

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