const fs = require('fs');
const path = require('path');
const { formatJakartaTime } = require('./time');

const LOG_FILE = path.join(process.cwd(), 'scan_audit.log');

/**
 * Append a structured log entry to the audit file.
 * Format: [Timestamp] | Symbol | Phase | Status | Score | Details
 */
function logAudit(symbol, phase, status, score, details) {
    const timestamp = formatJakartaTime(new Date(), 'terminal');
    const entry = `[${timestamp}] | ${symbol.padEnd(10)} | ${phase.padEnd(10)} | ${status.padEnd(10)} | ${score.toString().padEnd(5)} | ${details}\n`;
    
    try {
        fs.appendFileSync(LOG_FILE, entry);
    } catch (err) {
        console.error('Failed to write to audit log:', err.message);
    }
}

/**
 * Initialize the log file with a header if it doesn't exist.
 */
function initAudit() {
    if (!fs.existsSync(LOG_FILE)) {
        const header = `[Timestamp]           | Symbol     | Phase      | Status     | Score | Details\n` +
                       `--------------------------------------------------------------------------------------------------\n`;
        fs.writeFileSync(LOG_FILE, header);
    }
}

module.exports = { logAudit, initAudit };
