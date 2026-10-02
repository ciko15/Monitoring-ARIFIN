const fs = require('fs');
const path = require('path');
const authFile = path.join(__dirname, 'db', 'equipment_otentication_config.json');
const authData = JSON.parse(fs.readFileSync(authFile, 'utf8'));

for (let item of authData) {
    if (item.equipt_id === 'pae_tx_1') {
        item.extra_config = JSON.stringify({ rse_configs: [ { rse_id: 2, ports: [2,3,4,5] } ] });
    }
    if (item.equipt_id === 'pae_rx_1') {
        item.extra_config = JSON.stringify({ rse_configs: [ { rse_id: 16, ports: [2,3,4,5,6,7] } ] });
    }
}

fs.writeFileSync(authFile, JSON.stringify(authData, null, 2));
console.log("Fixed configs!");
