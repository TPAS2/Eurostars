'use strict';

// Who a company's emails to landlords come from: its own settings (Rent run → Edit sender),
// else the defaults (EMAIL_FROM, the agency name, the account email).
function senderFor(db, mailer, accountId) {
  const c = db.prepare('SELECT agency_name, email, statement_from_email, statement_from_name, statement_reply_to FROM users WHERE id = ?').get(accountId);
  return {
    from: c.statement_from_email || '',
    fromName: c.statement_from_name || c.agency_name,
    replyTo: c.statement_reply_to || c.email || '',
    saved: { from: c.statement_from_email || '', name: c.statement_from_name || '', replyTo: c.statement_reply_to || '' },
    defaults: { from: mailer.defaultFrom || '', name: c.agency_name, replyTo: c.email || '' },
  };
}

module.exports = { senderFor };
