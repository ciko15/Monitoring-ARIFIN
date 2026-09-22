const db = require('../../db/database');

// Configure this URL depending on where TOC is running
const TOC_API_URL = process.env.TOC_API_URL || 'http://localhost:3000/api/sync/config';
let isSyncing = false;

async function pushSyncToTOC() {
  if (isSyncing) return;
  isSyncing = true;
  
  try {
    const airports = await db.getAllAirports();
    const branchInfo = airports[0] || { id: 1, name: 'Cabang' }; // Assuming single branch
    const branchId = branchInfo.id;
    
    const equipment = await db.getAllEquipment({});
    const limitConfigs = await db.getAllLimitations ? await db.getAllLimitations() : require('../../db/limitation_config.json');
    const parseConfigs = await db.getAllParsingConfigs();
    
    // Auth info is likely merged in getAllEquipment if not we fetch it
    const equipmentData = equipment.data || equipment;
    
    // Fetch all auth configs once to avoid reading the file in a loop
    const allAuths = await db.getAllOtentication();
    
    // Attach auth info
    for (let eq of equipmentData) {
       const authInfo = allAuths.find((a: any) => a.equipt_id == eq.id);
       if (authInfo) {
          eq.ipAddress = authInfo.ip_address;
          eq.tcp_port = authInfo.tcp_port;
          eq.udp_port = authInfo.udp_port;
          eq.parsing_id = authInfo.parsing_id;
          eq.extra_config = authInfo.extra_config;
       }
    }

    const payload = {
      branchId,
      branchInfo,
      equipment: equipmentData,
      limitations: limitConfigs,
      parsing_configs: parseConfigs
    };

    const response = await fetch(TOC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      console.error('[SYNC TOC] Failed to sync with TOC', await response.text());
    } else {
      console.log('[SYNC TOC] Successfully synced with TOC');
    }
  } catch (error: any) {
    console.error('[SYNC TOC] Error syncing with TOC:', error.message);
  } finally {
    isSyncing = false;
  }
}

module.exports = { pushSyncToTOC };
