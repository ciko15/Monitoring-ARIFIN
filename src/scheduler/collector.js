/**
 * Data Collection Scheduler
 * Manages scheduled data collection from all equipment
 */

const cron = require('node-cron');

class DataCollectorScheduler {
    constructor(equipmentService) {
        this.equipmentService = equipmentService;
        this.cronJobs = new Map(); // equipment_id -> cron job
        this.isRunning = false;
        this.collectionStats = {
            totalCollections: 0,
            successfulCollections: 0,
            failedCollections: 0,
            lastCollection: null
        };
    }

    /**
     * Start scheduler with default configuration
     * Collects from all active equipment every minute
     */
    start() {
        if (this.isRunning) {
            console.log('[Scheduler] Already running');
            return;
        }

        console.log('[Scheduler] Starting data collection scheduler...');
        
        // Main collection job - runs every minute
        this.mainJob = cron.schedule('* * * * *', async () => {
            await this.collectAll();
        }, {
            scheduled: true
        });

        this.isRunning = true;
        console.log('[Scheduler] Scheduler started - collecting every minute');
    }

    /**
     * Stop scheduler
     */
    stop() {
        console.log('[Scheduler] Stopping...');
        
        if (this.mainJob) {
            this.mainJob.stop();
        }

        // Stop all individual cron jobs
        for (const [equipmentId, job] of this.cronJobs) {
            job.stop();
            console.log(`[Scheduler] Stopped job for equipment ${equipmentId}`);
        }
        this.cronJobs.clear();

        this.isRunning = false;
        console.log('[Scheduler] Stopped');
    }

    /**
     * Collect data from all active equipment
     */
    async collectAll() {
        console.log(`[Scheduler] Starting collection cycle at ${new Date().toISOString()}`);
        
        try {
            const equipmentList = await this.equipmentService.getAllActiveEquipment();
            
            console.log(`[Scheduler] Found ${equipmentList.length} active equipment`);
            
            let successCount = 0;
            let failCount = 0;

            // Collect from each equipment with connection config
            for (const equipment of equipmentList) {
                if (equipment.connect_enabled && equipment.host && equipment.port) {
                    try {
                        const result = await this.equipmentService.collectFromEquipment(equipment.id);
                        
                        if (result.success) {
                            successCount++;
                        } else {
                            failCount++;
                        }
                    } catch (error) {
                        console.error(`[Scheduler] Error collecting from equipment ${equipment.id}:`, error);
                        failCount++;
                    }
                }
            }

            // Update stats
            this.collectionStats.totalCollections++;
            this.collectionStats.successfulCollections += successCount;
            this.collectionStats.failedCollections += failCount;
            this.collectionStats.lastCollection = new Date();

            console.log(`[Scheduler] Collection complete - Success: ${successCount}, Failed: ${failCount}`);

        } catch (error) {
            console.error('[Scheduler] Collection cycle error:', error);
        }
    }

    /**
     * Start collection for specific equipment with custom interval
     * @param {number} equipmentId - Equipment ID
     * @param {string} cronExpression - Cron expression
     */
    addEquipmentJob(equipmentId, cronExpression = '* * * * *') {
        // Remove existing job if any
        this.removeEquipmentJob(equipmentId);

        const job = cron.schedule(cronExpression, async () => {
            await this.equipmentService.collectFromEquipment(equipmentId);
        }, {
            scheduled: true
        });

        this.cronJobs.set(equipmentId, job);
        console.log(`[Scheduler] Added job for equipment ${equipmentId} with schedule: ${cronExpression}`);
    }

    /**
     * Remove equipment job
     * @param {number} equipmentId - Equipment ID
     */
    removeEquipmentJob(equipmentId) {
        const job = this.cronJobs.get(equipmentId);
        if (job) {
            job.stop();
            this.cronJobs.delete(equipmentId);
            console.log(`[Scheduler] Removed job for equipment ${equipmentId}`);
        }
    }

    /**
     * Manually trigger collection for single equipment
     * @param {number} equipmentId - Equipment ID
     * @returns {Promise<Object>} Collection result
     */
    async collectOne(equipmentId) {
        console.log(`[Scheduler] Manual collection for equipment ${equipmentId}`);
        return await this.equipmentService.collectFromEquipment(equipmentId);
    }

    /**
     * Get scheduler statistics
     * @returns {Object} Stats
     */
    getStats() {
        return {
            ...this.collectionStats,
            isRunning: this.isRunning,
            activeJobs: this.cronJobs.size
        };
    }

    /**
     * Get scheduler status
     * @returns {Object} Status info
     */
    getStatus() {
        return {
            running: this.isRunning,
            mainJobActive: this.mainJob ? true : false,
            equipmentJobs: Array.from(this.cronJobs.keys()),
            stats: this.collectionStats
        };
    }
}

module.exports = DataCollectorScheduler;
