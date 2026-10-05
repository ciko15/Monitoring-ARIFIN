const fs = require('fs');
const path = require('path');

const authFile = path.join(__dirname, 'db', 'equipment_otentication_config.json');
const uiFile = path.join(__dirname, 'db', 'equipment_config.json');

let authData = [];
let uiData = [];
try { authData = JSON.parse(fs.readFileSync(authFile, 'utf8')); } catch (e) {}
try { uiData = JSON.parse(fs.readFileSync(uiFile, 'utf8')); } catch (e) {}

// Filter UI data to remove any old radar/dvor if present
uiData = uiData.filter(item => !item.id.toString().startsWith('radar_') && !item.id.toString().startsWith('dvor_'));

// Find the 4 newly added equipments in authData
const newEquipments = authData.filter(item => 
    item.equipt_id.startsWith('radar_') || item.equipt_id.startsWith('dvor_')
);

// Map them to the UI format
for (const eq of newEquipments) {
    const extra = JSON.parse(eq.extra_config);
    uiData.push({
        id: eq.equipt_id,
        name: eq.name,
        category: eq.sup_category,
        parsing_id: eq.parsing_id,
        mappings: extra.mappings,
        dashboardConfig: {
            layout: "list",
            showGraph: true
        }
    });
}

fs.writeFileSync(uiFile, JSON.stringify(uiData, null, 2));
console.log("Ditambahkan ke equipment_config.json (UI)");
