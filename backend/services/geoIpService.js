const fs = require('fs');
const path = require('path');
const maxmind = require('maxmind');

const pathUnderBackendData = path.join(__dirname, '../data/GeoLite2-Country.mmdb');
const pathAtRepoRoot = path.join(__dirname, '../../GeoLite2-Country.mmdb');

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

class GeoIpService {
  constructor() {
    this.reader = null;
    this.loadError = null;
    this.openPromise = null;
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
