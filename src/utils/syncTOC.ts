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
    
    // We fetch auth info separately just in case and attach it
    for (let eq of equipmentData) {
       const authInfo = await db.getOtenticationByEquipment(eq.id);
       if (authInfo && authInfo.length > 0) {
          // Merge auth
          const auth = authInfo[0];
          eq.ipAddress = auth.ip_address;
          eq.tcp_port = auth.tcp_port;
          eq.udp_port = auth.udp_port;
          eq.parsing_id = auth.parsing_id;
          eq.extra_config = auth.extra_config;
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
