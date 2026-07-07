const fs = require('fs');
const path = require('path');

// This utility pushes configuration payloads to all branch nodes when changes are made at the central node.
class SyncManager {
    constructor(db) {
        this.db = db;
    }

    /**
     * Pushes a specific configuration update to all registered branches.
     * @param {string} configType The type of config (e.g., 'equipment', 'parsers')
     * @param {any} payload The full JSON payload to overwrite at the branch
     */
    async pushConfigToBranches(configType, payload) {
        try {
            // Check if this node is configured to push (only Central should push)
            if (process.env.IS_CENTRAL !== 'true' && process.env.IS_PUSAT !== 'true') {
                return;
            }

            const airports = await this.db.getAllAirports();
            if (!airports || airports.length === 0) return;

            console.log(`[SyncManager] Pushing ${configType} config to branches...`);

            for (const airport of airports) {
                // Skip if no IP is defined
                if (!airport.ipBranch || airport.ipBranch === '127.0.0.1' || airport.ipBranch === 'localhost') {
                    continue;
                }

                const targetUrl = `http://${airport.ipBranch}:3100/api/sync/config`;
                try {
                    const response = await fetch(targetUrl, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'X-Sync-Token': 'ARIFIN-SYNC-2026' // simple shared secret
                        },
                        body: JSON.stringify({
                            configType,
                            payload
                        }),
                    });

                    if (response.ok) {
                        console.log(`[SyncManager] Successfully pushed ${configType} to ${airport.name}.`);
                    } else {
                        console.error(`[SyncManager] Failed to push to ${airport.name}: HTTP ${response.status}`);
                    }
                } catch (err) {
                    console.error(`[SyncManager] Error pushing to ${airport.name} (${airport.ipBranch}):`, err.message);
                }
            }
        } catch (err) {
            console.error('[SyncManager] Global error in pushConfigToBranches:', err);
        }
    }
}

module.exports = { SyncManager };
