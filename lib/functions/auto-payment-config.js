const SITE_URL = process.env.SITE_URL || process.env.URL || process.env.DEPLOY_PRIME_URL || "http://localhost:8888";
const AUTO_CONFIRM_URL = `${SITE_URL.replace(/\/$/, "")}/api/auto-payment-confirm`;

const AUTO_PAYMENT_CONFIG = {
  autoPaymentExpiryMs: 180000,
  enablePyWatcher: true,
  preferPyWatcher: true,
  pythonBin: "python",
  pyWatcherScript: "C:\\Premium smm growth panel\\scripts\\gmail_auto_watcher.py",
  pyWatcherIntervalSec: 8,
  pyWatcherMaxRuntimeSec: 240,
  autoConfirmUrl: AUTO_CONFIRM_URL,
  gmailFromMatch: "famapp.in,famapp",
  gmailMessageMaxAgeSec: 30,
  gmailSearchHint: "FamX account OR FamApp OR received",
  gmailCreditKeywords: "credited,received,success,payment,upi,money received",
};

module.exports = { AUTO_PAYMENT_CONFIG };

