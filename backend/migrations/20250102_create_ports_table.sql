-- Reference schema for proxy ports (runtime DDL lives in backend/config/database.js).
-- Table name: proxy_ports (legacy `ports` is migrated on first empty proxy_ports).

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
) ENGINE=InnoDB;

INSERT INTO proxy_ports (port_number, country, country_code, isp_name, asn, status)
VALUES
  (10220, 'Spain', 'ES', 'Telecomunicaciones Publicas Andaluzas S.L.', NULL, 1),
  (10041, 'United Kingdom', 'UK', 'Virgin Media', NULL, 1),
  (10079, 'Canada', 'CA', 'Bell Canada', NULL, 1),
  (10238, 'Italy', 'IT', 'EOLO S.p.A.', NULL, 1),
  (10038, 'Portugal', 'PT', 'NOS Comunicacoes', NULL, 1)
ON DUPLICATE KEY UPDATE
  country = VALUES(country),
  country_code = VALUES(country_code),
  isp_name = VALUES(isp_name),
  asn = VALUES(asn),
  status = VALUES(status);
