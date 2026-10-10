const fs = require('fs');
const file = 'db/templates_config.json';
const data = JSON.parse(fs.readFileSync(file, 'utf8'));

const mmTemplate = {
    "id": "ils_mm_normac",
    "name": "ILS MM Normarc",
    "protocol": "tcp",
    "category": "Navigation",
    "description": "Standard ILS MM Normarc template",
    "parameters": [
      {
        "name": "tx_main_label",
        "label": "TX MAIN",
        "unit": ""
      },
      {
        "name": "tx_stby_label",
        "label": "TX STANDBY",
        "unit": ""
      },
      {
        "name": "tx_data",
        "label": "DATA SOURCE",
        "unit": ""
      },
      {
        "name": "RF_POWER",
        "label": "RF POWER",
        "unit": "W"
      }
    ],
    "isDefault": true,
    "isSystem": true
};

// Insert after ils_gp_normac or at the end
data.push(mmTemplate);
fs.writeFileSync(file, JSON.stringify(data, null, 2));
console.log("Template added");
