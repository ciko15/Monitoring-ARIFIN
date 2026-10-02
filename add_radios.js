const fs = require('fs');
const path = require('path');

const eqFile = path.join(__dirname, 'db', 'equipment_config.json');
const authFile = path.join(__dirname, 'db', 'equipment_otentication_config.json');

const eqData = JSON.parse(fs.readFileSync(eqFile, 'utf8'));
const authData = JSON.parse(fs.readFileSync(authFile, 'utf8'));

const txEqId = 'pae_tx_' + Date.now();
const rxEqId = 'pae_rx_' + Date.now();

eqData.push({
    id: txEqId,
    name: "Radio PAE TX",
    category: "Communication",
    sup_category: "VHF",
    merk: "Park Air Systems",
    type: "T6T",
    status: "Normal",
    airportId: 1,
    lat: -8.7481,
    lng: 115.1671,
    description: "Radio TX (Auto Added)",
    isActive: true,
    branchId: 1
});

eqData.push({
    id: rxEqId,
    name: "Radio PAE RX",
    category: "Communication",
    sup_category: "VHF",
    merk: "Park Air Systems",
    type: "T6R",
    status: "Normal",
    airportId: 1,
    lat: -8.7481,
    lng: 115.1671,
    description: "Radio RX (Auto Added)",
    isActive: true,
    branchId: 1
});

authData.push({
    id: Date.now() + 1,
    name: "Radio PAE TX",
    equipt_id: txEqId,
    ip_address: "172.19.7.196",
    tcp_port: "950",
    udp_port: null,
    parsing_id: "marc_pae",
    protocol: "tcp",
    sup_category: "VHF",
    extra_config: JSON.stringify({ rse_id: 2 }),
    poll_interval: 15
});

authData.push({
    id: Date.now() + 2,
    name: "Radio PAE RX",
    equipt_id: rxEqId,
    ip_address: "172.19.7.197",
    tcp_port: "950",
    udp_port: null,
    parsing_id: "marc_pae",
    protocol: "tcp",
    sup_category: "VHF",
    extra_config: JSON.stringify({ rse_id: 16 }),
    poll_interval: 15
});

fs.writeFileSync(eqFile, JSON.stringify(eqData, null, 2));
fs.writeFileSync(authFile, JSON.stringify(authData, null, 2));

console.log("Success adding radios!");
