const fs = require('fs');
const path = require('path');
const logger = require('../../utils/logger');

const SIGNALS_FILE = path.join(process.cwd(), 'signals_store.json');

function saveSignal(signalData) {
    try {
        let store = [];
        if (fs.existsSync(SIGNALS_FILE)) {
            const content = fs.readFileSync(SIGNALS_FILE, 'utf8');
            store = JSON.parse(content || '[]');
        }
        const entry = {
            id: `${signalData.symbol}_${Date.now()}`,
            timestamp: new Date().toISOString(),
            ...signalData,
            outcome: null
        };
        store.push(entry);
        if (store.length > 100) store = store.slice(-100);
        fs.writeFileSync(SIGNALS_FILE, JSON.stringify(store, null, 2));
    } catch (err) {
        logger.error('Failed to save to signal store:', err.message);
    }
}
module.exports = { saveSignal };