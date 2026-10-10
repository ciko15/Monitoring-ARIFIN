const fs = require('fs');
const file = 'db/equipment_parsing_config.json';
const data = JSON.parse(fs.readFileSync(file, 'utf8'));

// Check if ils_mm_normac exists
if (!data.find(d => d.id === 'ils_mm_normac')) {
    data.push({
        id: "ils_mm_normac",
        name: "ILS MM Normarc 7000",
        description: "Parser TCP untuk Middle Marker Normarc NM7050",
        category: "Navigation",
        files: "/src/parsers/ils_mm_normac.js",
        defaultPort: 950,
        supportedTypes: ["ILS_MM"],
        fields: [
            { key: "tx_main_label", name: "TX Main", type: "string" },
            { key: "tx_stby_label", name: "TX Standby", type: "string" },
            { key: "mon1_rf_level", name: "MON1 RF Level (V)", type: "number", unit: "V" },
            { key: "mon1_mod_depth", name: "MON1 Mod Depth (%)", type: "number", unit: "%" },
            { key: "mon1_keying", name: "MON1 Keying", type: "string" },
            { key: "mon2_rf_level", name: "MON2 RF Level (V)", type: "number", unit: "V" },
            { key: "mon2_mod_depth", name: "MON2 Mod Depth (%)", type: "number", unit: "%" },
            { key: "mon2_keying", name: "MON2 Keying", type: "string" }
        ],
        createdAt: new Date().toISOString()
    });
}

// Update OTE fields just in case
const ote = data.find(d => d.id === 'ote_dtr100');
if (ote) {
    const newFields = [
        { key: "forward_power_w", name: "Output Power (W)", type: "number", unit: "W" },
        { key: "frequency_mhz", name: "Frequency (MHz)", type: "number", unit: "MHz" },
        { key: "vswr", name: "VSWR", type: "number" },
        { key: "supply_voltage_v", name: "Supply Voltage (V)", type: "number", unit: "V" }
    ];
    for (const nf of newFields) {
        if (!ote.fields.find(f => f.key === nf.key)) {
            ote.fields.push(nf);
        }
    }
}

fs.writeFileSync(file, JSON.stringify(data, null, 4));
console.log("Updated equipment_parsing_config.json");
