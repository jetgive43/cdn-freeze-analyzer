class PortController {
  constructor(portService, onChange = null) {
    this.portService = portService;
    this.onChange = typeof onChange === 'function' ? onChange : null;
  }

  listPorts = async (req, res) => {
    try {
      const ports = await this.portService.listPorts();
      res.json({
        success: true,
        ports,
      });
    } catch (error) {
      console.error('❌ Error listing ports:', error.message);
      res.status(500).json({
        success: false,
        error: 'Failed to list ports',
      });
    }
  };

  upsertPort = async (req, res) => {
    try {
      const body = req.body || {};
      const portNumber = body.portNumber;
      const country = (body.country ?? '').trim();
      const countryCode = (body.countryCode ?? body.countryShort ?? '').trim();
      const ispName = (body.ispName ?? body.provider ?? '').trim();
      const asn = body.asn;
      const status = body.status !== undefined && body.status !== '' ? Number(body.status) : 1;

      if (!portNumber || !country || !countryCode || !ispName) {
        return res.status(400).json({
          success: false,
          error: 'portNumber, country, countryCode, and ispName are required',
        });
      }

      const num = Number(portNumber);
      if (!Number.isFinite(num) || num <= 0) {
        return res.status(400).json({
          success: false,
          error: 'Invalid port number',
        });
      }

      if (![0, 1].includes(status)) {
        return res.status(400).json({
          success: false,
          error: 'status must be 0 (inactive) or 1 (active)',
        });
      }

      let asnVal = null;
      if (asn !== undefined && asn !== null && asn !== '') {
        const n = Number(asn);
        if (!Number.isFinite(n) || n < 0) {
          return res.status(400).json({
            success: false,
            error: 'asn must be a non-negative integer or empty',
          });
        }
        asnVal = Math.floor(n);
      }

      const portData = {
        portNumber: num,
        country,
        countryCode,
        ispName,
        asn: asnVal,
        status,
      };

      const port = await this.portService.upsertPort(portData);
      if (this.onChange) {
        await this.onChange();
      }

      res.json({
        success: true,
        port,
      });
    } catch (error) {
      console.error('❌ Error saving port:', error.message);
      res.status(500).json({
        success: false,
        error: 'Failed to save port',
      });
    }
  };

  deletePort = async (req, res) => {
    try {
      const { portNumber } = req.params;
      if (!portNumber) {
        return res.status(400).json({
          success: false,
          error: 'portNumber is required',
        });
      }

      const deleted = await this.portService.deletePort(Number(portNumber));
      if (deleted && this.onChange) {
        await this.onChange();
      }

      res.json({
        success: true,
        deleted,
      });
    } catch (error) {
      console.error('❌ Error deleting port:', error.message);
      res.status(500).json({
        success: false,
        error: 'Failed to delete port',
      });
    }
  };
}

module.exports = PortController;


