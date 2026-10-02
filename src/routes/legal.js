'use strict';

// Public pages anyone can read, signed in or not: the privacy notice and the terms of use.
// The agency's own details come from settings (LEGAL_NAME, PRIVACY_EMAIL, ICO_NUMBER, LEGAL_ADDRESS).

const express = require('express');

module.exports = function legalRoutes(config, { aiEnabled = false } = {}) {
  const router = express.Router();
  const info = () => ({
    legalName: config.legalName || config.appName,
    privacyEmail: config.privacyEmail || '',
    icoNumber: config.icoNumber || '',
    legalAddress: config.legalAddress || '',
    aiEnabled,
    updated: '2 October 2026',
  });
  const missing = (req) => !!(req.user && req.user.is_admin && (!config.privacyEmail || !config.icoNumber || !config.legalName));
  router.get('/privacy', (req, res) => res.render('legal/privacy', { title: 'Privacy notice', bodyClass: 'legal', section: '', legal: info(), missing: missing(req) }));
  router.get('/terms', (req, res) => res.render('legal/terms', { title: 'Terms of use', bodyClass: 'legal', section: '', legal: info(), missing: missing(req) }));
  return router;
};
