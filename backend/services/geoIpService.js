/**
 * GeoLite2-Country.mmdb → country code/name (MMDB_COUNTRY_PATH or backend/data/ or repo root).
 * GeoLite2-ASN.mmdb → ISP-style org name (MMDB_ASN_PATH or same layout); optional but recommended for viewer_isp.
 */
const fs = require('fs');
const path = require('path');
const maxmind = require('maxmind');

const pathUnderBackendData = path.join(__dirname, '../data/GeoLite2-Country.mmdb');
const pathAtRepoRoot = path.join(__dirname, '../../GeoLite2-Country.mmdb');
const pathAsnUnderBackendData = path.join(__dirname, '../data/GeoLite2-ASN.mmdb');
const pathAsnAtRepoRoot = path.join(__dirname, '../../GeoLite2-ASN.mmdb');

function resolveCountryMmdbPath() {
  if (process.env.MMDB_COUNTRY_PATH) {
    return process.env.MMDB_COUNTRY_PATH;
  }
  if (fs.existsSync(pathUnderBackendData)) {
    return pathUnderBackendData;
  }
  if (fs.existsSync(pathAtRepoRoot)) {
    return pathAtRepoRoot;
  }
  return pathUnderBackendData;
}

function resolveAsnMmdbPath() {
  if (process.env.MMDB_ASN_PATH) {
    return process.env.MMDB_ASN_PATH;
  }
  if (fs.existsSync(pathAsnUnderBackendData)) {
    return pathAsnUnderBackendData;
  }
  if (fs.existsSync(pathAsnAtRepoRoot)) {
    return pathAsnAtRepoRoot;
  }
  return pathAsnUnderBackendData;
}

class GeoIpService {
  constructor() {
    this.reader = null;
    this.loadError = null;
    this.openPromise = null;
    this.asnReader = null;
    this.asnOpenPromise = null;
    this.asnLoadError = null;
  }

  getDbPath() {
    return resolveCountryMmdbPath();
  }

  isDatabasePresent() {
    try {
      return fs.existsSync(this.getDbPath());
    } catch {
      return false;
    }
  }

  isAsnDatabasePresent() {
    try {
      return fs.existsSync(resolveAsnMmdbPath());
    } catch {
      return false;
    }
  }

  async ensureReader() {
    if (this.reader) {
      return this.reader;
    }
    if (this.openPromise) {
      return this.openPromise;
    }
    const dbPath = this.getDbPath();
    this.openPromise = maxmind
      .open(dbPath)
      .then((reader) => {
        this.reader = reader;
        this.loadError = null;
        return reader;
      })
      .catch((err) => {
        this.loadError = err;
        this.reader = null;
        return null;
      });
    return this.openPromise;
  }

  async ensureAsnReader() {
    if (this.asnReader) {
      return this.asnReader;
    }
    if (this.asnOpenPromise) {
      return this.asnOpenPromise;
    }
    const dbPath = resolveAsnMmdbPath();
    if (!fs.existsSync(dbPath)) {
      return null;
    }
    this.asnOpenPromise = maxmind
      .open(dbPath)
      .then((reader) => {
        this.asnReader = reader;
        this.asnLoadError = null;
        return reader;
      })
      .catch((err) => {
        this.asnLoadError = err;
        this.asnReader = null;
        return null;
      });
    return this.asnOpenPromise;
  }

  /**
   * Organization name from GeoLite2-ASN (often ISP / network name).
   * @returns {Promise<string|null>}
   */
  async lookupIsp(ip) {
    await this.ensureAsnReader();
    if (!this.asnReader) {
      return null;
    }
    try {
      const rec = this.asnReader.get(ip);
      const org = rec?.autonomous_system_organization;
      return org ? String(org) : null;
    } catch {
      return null;
    }
  }

  /**
   * Country + optional ISP for the connecting client IP.
   * @returns {Promise<{ ip: string, countryCode: string|null, countryName: string, isp: string|null }>}
   */
  async lookupVisitor(ip) {
    const raw = String(ip || '').trim();
    const { code, name } = await this.lookupCountry(raw);
    const isp = await this.lookupIsp(raw);
    return {
      ip: raw,
      countryCode: code,
      countryName: name || 'Unknown',
      isp,
    };
  }

  /**
   * @returns {{ code: string | null, name: string }}
   */
  async lookupCountry(ip) {
    await this.ensureReader();
    if (!this.reader) {
      return { code: null, name: 'Unknown' };
    }
    try {
      const rec = this.reader.get(ip);
      const code = rec?.country?.iso_code || null;
      const name = rec?.country?.names?.en || code || 'Unknown';
      return { code, name };
    } catch {
      return { code: null, name: 'Unknown' };
    }
  }
}

module.exports = new GeoIpService();
