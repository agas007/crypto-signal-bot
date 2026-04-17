const express = require('express');
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

function startDashboard() {
    const app = express();
    const port = process.env.PORT || 3000;
    app.use(express.static(path.join(__dirname)));
    app.get('/api/signals', (req, res) => {
        const filePath = path.join(process.cwd(), 'signals_store.json');
        if (fs.existsSync(filePath)) {
            const data = fs.readFileSync(filePath, 'utf8');
            res.json(JSON.parse(data));
        } else {
            res.json([]);
        }
    });
    app.listen(port, '0.0.0.0', () => {
        console.log('🚀 Dashboard active at http://localhost:' + port);
    });
}
module.exports = { startDashboard };