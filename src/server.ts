import { Elysia, t } from 'elysia';
import { cors } from '@elysiajs/cors';
import { staticPlugin } from '@elysiajs/static';
import { serverTiming } from '@elysiajs/server-timing';
import dotenv from 'dotenv';
// Bun supports both import and require natively in .ts files
// const require = createRequire(import.meta.url);

dotenv.config();

import ping from 'ping';

// Global error handlers for better stability
process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ [FATAL] Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (err) => {
    console.error('❌ [FATAL] Uncaught Exception:', err);
    // Kita tidak keluar (process.exit) agar PM2 tidak masuk ke restart loop yang terlalu cepat jika memungkinkan
    // Namun biasanya uncaughtException sebaiknya exit. Kita biarkan PM2 yang menangani restart.
});

process.on('SIGINT', () => {
    console.warn('⚠️ [SYSTEM] Received SIGINT. Graceful shutdown...');
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.warn('⚠️ [SYSTEM] Received SIGTERM. Graceful shutdown...');
    process.exit(0);
});

// Authorization middleware
function authorize(allowedRoles: string[]) {
    return ({ user, set }: any) => {
        const userRole = user?.role;
        if (!userRole || !allowedRoles.includes(userRole)) {
            set.status = 403;
            throw new Error('Unauthorized');
        }
    };
}

function authenticate(app: any) {
    return app.derive(({ set, request, query }: any) => {
        let token = '';
        const auth = request.headers.get('authorization');

        if (auth && auth.startsWith('Bearer ')) {
            token = auth.substring(7);
        } else if (query && query.token) {
            token = query.token;
        }

        if (!token) {
            set.status = 401;
            return { user: null, error: 'Authentication required', success: false };
        }

        // Security Fix: Do not allow arbitrary static-token-admin
        // For now, we still use the token format but we should validate it.
        // In a production environment, this should be a JWT verified with a secret.
        const parts = token.split('-');
        if (parts[0] === 'session' && parts.length >= 3) {
            const role = parts[1];
            const username = parts[2];
            return { user: { role, username } };
        }

        console.warn(`[AUTH-GATE] Denied access to ${request.url} - Invalid Token`);
        set.status = 401;
        return { user: null, error: 'Invalid or expired token', success: false };
    });
}


// Import services and managers
const db = require('../db/database');
const EquipmentService = require('./services/equipment');
const equipmentService = new EquipmentService(db);
const DataCollectorScheduler = require('./scheduler/collector');
const connectionManager = require('./connection/manager');
const thresholdEvaluator = require('./utils/thresholdEvaluator');
const {
    getLocalSiteId,
    publishThresholdApplyCommand,
    publishThresholdResult,
    publishEquipmentSnapshotRequested,
    publishEquipmentSnapshotResponded,
    publishEquipmentConfigurationChanged,
    publishDataSourceConfigurationChanged,
    buildEquipmentSnapshot
} = require('./services/message_bus');

// const websocketServer = require('./websocket/server'); // We'll handle WS separately in Elysia
const templateService = require('./services/template');
const { pushSyncToTOC } = require('./utils/syncTOC');



const PORT = process.env.PORT || 3100;
const SERVICE_ROLE = process.env.SERVICE_ROLE || 'all';
const PIPELINE_MODE = process.env.PIPELINE_MODE || 'inline';
const SHOULD_START_WEB = SERVICE_ROLE === 'all' || SERVICE_ROLE === 'web';
const SHOULD_START_COLLECTOR = SERVICE_ROLE === 'all' || SERVICE_ROLE === 'collector';
const SHOULD_START_PROCESSOR = SERVICE_ROLE === 'all' || SERVICE_ROLE === 'processor';

// Global State
export const state = {
    snmpTemplatesCache: null as any,
    snmpDataCache: {} as Record<string, any>,
    customSnmpData: {
        moxa_ioThinx_4150: null,
        radar_system: null,
        generic_snmp: null
    } as Record<string, any>,
    simulationMode: true,
    ping: {
        interval: null as any,
        results: [] as any[],
        currentIp: null as string | null,
        maxResults: 100
    }
};




// --- BACKGROUND TASKS ---
async function collectEquipmentData() {
    try {
        const networkUtils = require('./utils/network');
        const fetchAndParseData = networkUtils.fetchAndParseData;
        console.log('[SCHEDULER] Starting equipment data collection (direct connect)...');
        const allEquipment = await db.getAllEquipment({ limit: 10000 });
        const equipmentList = allEquipment.data || allEquipment;

        for (const item of equipmentList) {
            // Only process active equipment
            const isActive = item.isActive === true || item.isActive === 'true' || item.is_active === 1 || item.is_active === '1' || item.is_active === true;
            if (!isActive) continue;

            const config = item.snmpConfig || item.snmp_config;

            try {
                const { parsedData, status, triggeredParameters, isProcessed } = await fetchAndParseData(item);

                // Only update status and logs if we actually had sources to monitor
                if (isProcessed) {
                    // Status is now handled by the watchdog consolidation
                    // await equipmentService.updateEquipmentStatus(item.id, status);
                    await equipmentService.saveToLogs(
                        item.id,
                        {
                            ...parsedData,
                            triggeredParameters: triggeredParameters || [],
                            _ip: parsedData._ip || (parsedData._sources && parsedData._sources[0]?.ip)
                        },
                        config?.templateId || 'ping_monitor',
                        status
                    );
                }
            } catch (err: any) {
                console.error(`[SCHEDULER] Error for ${item.name}:`, err.message);
                // If it's a critical failure for a monitored device, mark as Disconnect
                if (config?.enabled) {
                    await db.updateEquipmentStatus(item.id, 'Disconnect');
                }
            }
        }

    } catch (error) {
        console.error('[SCHEDULER] Error:', error);
    }
}



async function seedUpsJakarta() {
    try {
        console.log('[SEED] Checking initial data...');
        const airports = await db.getAllAirports();
        let jakarta = airports.find((a: any) => a.city.toLowerCase().includes('jakarta'));
        if (!jakarta) {
            jakarta = await db.createAirport({ name: 'Bandara Soekarno-Hatta', city: 'Jakarta', lat: -6.1256, lng: 106.6558 });
            console.log('[SEED] Created Jakarta airport');
        }
    } catch (e: any) {
        console.error('[SEED] Failed:', e.message);
    }
}

/**
 * Watchdog to check if any equipment has timed out (no updates for 4 minutes)
 */
async function checkEquipmentWatchdog() {
    try {
        console.log('[WATCHDOG] Checking for timed-out equipment and partial failures...');
        const result = await db.getAllEquipment({ includeData: true, isActive: true });
        const equipmentList = result.data || [];
        const now = Date.now();
        const TIMEOUT_MS = 4 * 60 * 1000; // 4 minutes

        for (const item of equipmentList) {
            let finalStatus = item.status || 'Normal';

            if (item.lastData) {
                const sourceNames = Object.keys(item.lastData);
                const sourceStatuses = sourceNames.map(name => {
                    const src = item.lastData[name];
                    const age = now - new Date(src._logged_at).getTime();
                    // Each source has its own age check
                    if (age > TIMEOUT_MS) return 'Disconnect';
                    return src._status || 'Normal';
                });

                // Rule-based consolidation
                if (sourceStatuses.length > 0) {
                    const lowerStatuses = sourceStatuses.map(s => String(s).toLowerCase());
                    if (lowerStatuses.some(s => s === 'alert' || s === 'alarm' || s === 'fail' || s === 'critical')) {
                        finalStatus = 'Alert';
                    } else if (lowerStatuses.some(s => s === 'warning')) {
                        finalStatus = 'Warning';
                    } else if (lowerStatuses.every(s => s === 'disconnect' || s === 'offline')) {
                        finalStatus = 'Disconnect';
                    } else {
                        finalStatus = 'Normal';
                    }
                }
            } else if (item.lastUpdate) {
                // Fallback for equipment without grouped data
                const lastUpdate = new Date(item.lastUpdate).getTime();
                if (now - lastUpdate > TIMEOUT_MS) finalStatus = 'Disconnect';
            }

            // Update only if status changed
            if (item.status !== finalStatus) {
                console.log(`[WATCHDOG] Equipment ${item.name} status changed: ${item.status} -> ${finalStatus}`);
                await equipmentService.updateEquipmentStatus(item.id, finalStatus);
            }
        }
    } catch (error) {
        console.error('[WATCHDOG] Error:', error);
    }
}

// --- HELPER FUNCTIONS ---
function getAirportStatus(airportId: number, equipmentList: any[]) {
    if (!equipmentList || equipmentList.length === 0) return 'Normal';
    if (equipmentList.some(e => e.status === 'Alert')) return 'Alert';
    if (equipmentList.some(e => e.status === 'Warning')) return 'Warning';
    if (equipmentList.some(e => e.status === 'Disconnect')) return 'Disconnect';
    return 'Normal';
}

function getEquipmentCountByCategory(equipmentList: any[]) {
    return {
        Communication: equipmentList?.filter(e => e.category === 'Communication').length || 0,
        Navigation: equipmentList?.filter(e => e.category === 'Navigation').length || 0,
        Surveillance: equipmentList?.filter(e => e.category === 'Surveillance').length || 0,
        'Data Processing': equipmentList?.filter(e => e.category === 'Data Processing').length || 0,
        Support: equipmentList?.filter(e => e.category === 'Support').length || 0
    };
}



// Initialize Elysia
const app = new Elysia()
    .use(cors())
    .use(serverTiming())
    .derive(({ request, set }: any) => {
        const auth = request.headers.get('authorization');
        if (auth && auth.startsWith('Bearer ')) {
            const token = auth.substring(7);
            const parts = token.split('-');
            if (parts[0] === 'session' && parts.length >= 3) {
                return { user: { role: parts[1], username: parts[2] } };
            }
        }
        return { user: null };
    })

    // Web Application SEO & Aesthetics Implementation
    // This server serves the modern Bun/Elysia backend and the static TOC frontend

    // --- GLOBAL ERROR HANDLER ---
    .onError(({ code, error, set }) => {
        if (code === 'NOT_FOUND') {
            set.status = 404;
            return {
                success: false,
                message: 'Endpoint NOT_FOUND. Pastikan URL dan Method (GET/POST) sudah benar.',
                error: 'Route not found in Elysia'
            };
        }

        // Detailed logging for debugging
        const err = error as any;
        console.error(`[SERVER-ERROR] ${code} (${err.name || 'Unknown Error'}): ${err.message}`);
        if (err.stack) console.error(err.stack);

        if (!set.status || set.status === 200) set.status = 500;
        return {
            success: false,
            message: err.message || 'Internal Server Error',
            type: err.name || code
        };
    })

    .state('simulationMode', true)

    .post('/api/login', async ({ body, set }) => {
        const { username, password } = body as any;
        const user = await db.verifyUser(username, password);

        if (!user) {
            set.status = 401;
            return { success: false, message: 'Invalid username or password' };
        }

        // Secure session token format: session-{role}-{username}-{timestamp}
        const token = `session-${user.role}-${user.username}-${Date.now()}`;
        return {
            success: true,
            token,
            user: { username: user.username, role: user.role }
        };
    })

    .post('/api/register', async ({ body, set }) => {
        const { username, password, name } = body as any;

        // Check if user already exists
        const existingUser = await db.getUserByUsername(username);
        if (existingUser) {
            set.status = 400;
            return { success: false, message: 'Username sudah terdaftar' };
        }

        // Create user with role 'user' strictly
        const newUser = await db.createUser({
            username,
            password,
            name: name || username,
            role: 'user' // Hardcoded as requested
        });

        return {
            success: true,
            message: 'Registrasi berhasil! Silakan login.',
            user: { username: newUser.username, role: newUser.role }
        };
    })

    // --- HISTORY LOGS ROUTES (File-based) ---
    .group('/api/history-logs', app => app
        .use(authenticate)
        .get('', async ({ query }) => {
            const fileLogger = require('./utils/fileLogger');
            const page = parseInt(query.page as string) || 1;
            const limit = parseInt(query.limit as string) || 50;
            const search = (query.search as string) || '';
            const startDate = (query.startDate as string) || null;
            const endDate = (query.endDate as string) || null;

            return await fileLogger.getHistoryLogs({ page, limit, search, startDate, endDate });
        })
    )

    // --- USER MANAGEMENT ROUTES ---
    .group('/api/users', app => app
        .use(authenticate)
        .get('', async () => await db.getAllUsers(), { beforeHandle: authorize(['superadmin', 'admin']) })
        .post('', async ({ body, set }) => {
            const newUser = await db.createUser(body as any);
            set.status = 201;
            return newUser;
        }, { beforeHandle: authorize(['superadmin']) })
        .put('/:id', async ({ params, body, set }) => {
            const updated = await db.updateUser(params.id, body);
            if (!updated) { set.status = 404; return { message: 'User not found' }; }
            return updated;
        }, { beforeHandle: authorize(['superadmin']) })
        .delete('/:id', async ({ params, set }) => {
            const deleted = await db.deleteUser(params.id);
            if (!deleted) { set.status = 404; return { message: 'User not found' }; }
            return { message: 'User deleted' };
        }, { beforeHandle: authorize(['superadmin']) })
    )

    // Public Equipment Stats
    .get('/api/equipment/stats', async () => {
        try {
            const stats = await db.getEquipmentStatsSummary();

            const response = {
                total: stats?.total || 0,
                normal: 0,
                warning: 0,
                alert: 0,
                disconnect: 0,
                byCategory: {
                    Communication: 0,
                    Navigation: 0,
                    Surveillance: 0,
                    'Data Processing': 0,
                    Support: 0
                }
            };

            // Map Statuses
            if (stats && Array.isArray(stats.statuses)) {
                stats.statuses.forEach((row: any) => {
                    const status = row.status.toLowerCase();
                    if (status === 'normal') response.normal = parseInt(row.count) || 0;
                    else if (status === 'warning') response.warning = parseInt(row.count) || 0;
                    else if (status === 'alert') response.alert = parseInt(row.count) || 0;
                    else if (status === 'disconnect') response.disconnect = parseInt(row.count) || 0;
                });
            }

            // Map Categories
            if (stats && Array.isArray(stats.categories)) {
                stats.categories.forEach((row: any) => {
                    if (response.byCategory[row.category as keyof typeof response.byCategory] !== undefined) {
                        response.byCategory[row.category as keyof typeof response.byCategory] = parseInt(row.count) || 0;
                    }
                });
            }

            return response;
        } catch (error: any) {
            console.error('[API] Error fetching equipment stats:', error);
            return {
                total: 0, normal: 0, warning: 0, alert: 0, disconnect: 0,
                byCategory: { Communication: 0, Navigation: 0, Surveillance: 0, 'Data Processing': 0, Support: 0 }
            };
        }
    })

    // Public Airports Data (Required for Public Dashboard)
    .get('/api/airports', async () => {
        const airports = await db.getAllAirports();
        const allEquipment = await db.getAllEquipment({ limit: 10000, isActive: 'all' });
        const equipmentData = allEquipment.data || allEquipment;

        return (airports || []).map((airport: any) => {
            const airportId = airport.id;
            const airportEquipment = (equipmentData || []).filter((e: any) =>
                e.airport_id === airportId || e.branch_id === airportId || e.airportId === airportId || e.branchId === airportId
            );

            // Only consider equipment that is active for calculations
            const activeEquipment = (airportEquipment || []).filter((e: any) =>
                e.isActive === true || e.isActive === 'true' || e.is_active === 1 || e.is_active === '1' || e.is_active === true
            );

            return {
                ...airport,
                status: getAirportStatus(airportId, activeEquipment),
                equipmentCount: getEquipmentCountByCategory(activeEquipment),
                activeEquipmentCount: getEquipmentCountByCategory(activeEquipment),
                totalEquipment: activeEquipment.length,
                totalActiveEquipment: activeEquipment.length
            };
        });
    })

    .get('/health', () => ({ status: 'ok', runtime: 'Bun', framework: 'Elysia' }))

    // --- PUBLIC PARSING CONFIG ROUTES ---
    .get('/api/parsing-configs', async () => await db.getAllParsingConfigs())
    .get('/api/parsing-configs/:id', async ({ params, set }) => {
        const config = await db.getParsingConfigById(params.id);
        if (!config) {
            set.status = 404;
            return { message: 'Config not found' };
        }
        return config;
    })
    // Legacy mapping
    .get('/api/snmp/templates', async () => await db.getAllParsingConfigs())

    // --- PUBLIC PING TOOL ---
    .group('/api/ping', (app) =>
        app
            .post('/start', async ({ body, set }) => {
                const { ip, interval } = body as any;

                if (!ip || !interval) {
                    set.status = 400;
                    return { error: 'IP dan interval wajib diisi' };
                }

                const ipRegex = /^(\d{1,3}\.){3}\d{1,3}$/;
                if (!ipRegex.test(ip)) {
                    set.status = 400;
                    return { error: 'Format IP tidak valid' };
                }

                if (interval < 1 || interval > 60) {
                    set.status = 400;
                    return { error: 'Interval harus antara 1-60 detik' };
                }

                // Clear existing
                if (state.ping.interval) {
                    clearInterval(state.ping.interval);
                    state.ping.results = [];
                }

                state.ping.currentIp = ip;
                const intervalMs = interval * 1000;

                try {
                    // Initial ping
                    const { ping } = require('./utils/network');
                    const result = await ping.promise.probe(ip, { timeout: 5 });

                    state.ping.results.push({
                        time: new Date().toISOString(),
                        alive: result.alive,
                        responseTime: result.time,
                        host: ip
                    });

                    // Start interval
                    state.ping.interval = setInterval(async () => {
                        try {
                            const pResult = await ping.promise.probe(ip, { timeout: 5 });
                            state.ping.results.push({
                                time: new Date().toISOString(),
                                alive: pResult.alive,
                                responseTime: pResult.time || 0,
                                host: ip
                            });

                            if (state.ping.results.length > state.ping.maxResults) {
                                state.ping.results = state.ping.results.slice(-state.ping.maxResults);
                            }
                        } catch (e: any) {
                            console.error('[Ping] Error:', e.message);
                        }
                    }, intervalMs);

                    return {
                        message: `Ping ke ${ip} setiap ${interval} detik dimulai`,
                        ip: ip,
                        interval: interval,
                        status: result.alive ? 'online' : 'offline',
                        responseTime: result.time
                    };
                } catch (error: any) {
                    set.status = 500;
                    return { error: error.message };
                }
            })
            .post('/stop', () => {
                if (state.ping.interval) {
                    clearInterval(state.ping.interval);
                    state.ping.interval = null;

                    const result = {
                        message: 'Ping dihentikan',
                        ip: state.ping.currentIp,
                        results: state.ping.results.length
                    };

                    state.ping.currentIp = null;
                    return result;
                }
                return { message: 'Tidak ada ping aktif' };
            })
            .get('/status', () => {
                return {
                    active: state.ping.interval !== null,
                    ip: state.ping.currentIp,
                    results: state.ping.results,
                    totalResults: state.ping.results.length
                };
            })
            .get('/results', () => {
                return {
                    ip: state.ping.currentIp,
                    active: state.ping.interval !== null,
                    results: state.ping.results
                };
            })
    )
    .group('/api/equipment', (app) =>
        app
            // Equipment List
            .get('/', async ({ query, set }) => {
                try {
                    const { airportId, branchId, category, isActive, page = 1, limit = 1000, includeData } = query;

                    const result = await db.getAllEquipment({
                        branchId: branchId ? parseInt(branchId as string) : undefined,
                        category: (category as string) || undefined,
                        isActive: isActive === 'all' ? 'all' : isActive === 'false' ? false : true,
                        page: parseInt(page as string),
                        limit: parseInt(limit as string),
                        includeData: includeData === 'true'
                    });

                    return result;
                } catch (error: any) {
                    set.status = 500;
                    return { message: error.message };
                }
            })
            // Equipment Logs
            .get('/logs', async ({ query, set }) => {
                try {
                    const { equipmentId, source, from, to, page = 1, limit = 100 } = query;
                    const result = await db.getEquipmentLogs({
                        equipmentId: equipmentId ? parseInt(equipmentId as string) : undefined,
                        source: (source as string) || undefined,
                        from: (from as string) || undefined,
                        to: (to as string) || undefined,
                        page: parseInt(page as string),
                        limit: parseInt(limit as string)
                    });
                    return result;
                } catch (error: any) {
                    set.status = 500;
                    return { message: error.message };
                }
            })
            // Individual Equipment
            .get('/:id', async ({ params, set }) => {
                try {
                    const item = await equipmentService.getEquipmentWithConfig(params.id);
                    if (!item) {
                        set.status = 404;
                        return { message: 'Equipment not found' };
                    }
                    return item;
                } catch (error: any) {
                    set.status = 500;
                    return { message: error.message };
                }
            })
            // Create Equipment
            .post('/', async ({ body, set }) => {
                try {
                    const b = body as any;
                    const branchId = b.branchId || b.airportId;
                    const ipAddress = b.ipAddress || (b.snmpConfig && b.snmpConfig.ip);

                    const newEquipment = await db.createEquipment({
                        ...b,
                        branchId: branchId ? parseInt(branchId.toString()) : undefined,
                        airportId: b.airportId ? parseInt(b.airportId.toString()) : undefined,
                        ipAddress
                    });
                    set.status = 201;
                    pushSyncToTOC();
                    publishEquipmentConfigurationChanged('add', newEquipment).catch((e: any) => console.error('[EMS] Failed to publish config change:', e.message));
                    return newEquipment;
                } catch (error: any) {
                    set.status = 500;
                    return { message: error.message };
                }
            }, { beforeHandle: authorize(['superadmin', 'admin', 'user_pusat', 'teknisi_cabang']) })
            // Update Equipment
            .put('/:id', async ({ params, body, set }) => {
                try {
                    const b = body as any;
                    const branchId = b.branchId || b.airportId;
                    const ipAddress = b.ipAddress || (b.snmpConfig && b.snmpConfig.ip);

                    const updated = await db.updateEquipment(params.id, {
                        ...b,
                        branchId: branchId ? parseInt(branchId.toString()) : undefined,
                        airportId: b.airportId ? parseInt(b.airportId.toString()) : undefined,
                        ipAddress
                    });

                    if (!updated) {
                        set.status = 404;
                        return { message: 'Equipment not found' };
                    }
                    pushSyncToTOC();
                    publishEquipmentConfigurationChanged('update', updated).catch((e: any) => console.error('[EMS] Failed to publish config change:', e.message));
                    return updated;
                } catch (error: any) {
                    set.status = 500;
                    return { message: error.message };
                }
            }, { beforeHandle: authorize(['superadmin', 'admin', 'user_pusat', 'teknisi_cabang']) })
            // Delete Equipment
            .delete('/remove/:id', async ({ params, set }) => {
                try {
                    const eqId = parseInt(params.id.toString());
                    await db.deleteEquipment(params.id);
                    pushSyncToTOC();
                    publishEquipmentConfigurationChanged('delete', { id: eqId }).catch((e: any) => console.error('[EMS] Failed to publish config change:', e.message));
                    return { message: 'Equipment deleted' };
                } catch (error: any) {
                    set.status = 500;
                    return { message: error.message };
                }
            }, { beforeHandle: authorize(['superadmin', 'admin', 'user_pusat']) })
            // Ping Equipment (Multi-tier)
            .get('/:id/ping', async ({ params, set }) => {
                const { pingTiered } = require('./utils/network');
                try {
                    const result = await pingTiered(params.id);
                    if (!result.success && result.tier === 0) { // Error
                        set.status = 500;
                        return result;
                    }
                    return result;
                } catch (error: any) {
                    set.status = 500;
                    return { message: error.message };
                }
            })
            // Manual Ping Test (Custom IP)
            .post('/ping', async ({ body, set }) => {
                const { pingHost, isValidIP } = require('./utils/network');
                try {
                    const { ip } = body as any;
                    if (!ip || !isValidIP(ip)) {
                        set.status = 400;
                        return { success: false, message: 'Invalid IP address format' };
                    }

                    const result = await pingHost(ip, 3);
                    return {
                        success: result.alive,
                        ip: ip,
                        status: result.alive ? 'online' : 'offline',
                        statistics: result.alive ? { avg: result.avg } : null,
                        timestamp: new Date().toISOString()
                    };
                } catch (error: any) {
                    set.status = 500;
                    return { success: false, message: error.message };
                }
            })
            // Aggregated Chart Data
            .get('/:id/chart/aggregated', async ({ params, query, set }) => {
                try {
                    const { tf = '24h' } = query;
                    const fileLogger = require('./utils/fileLogger');
                    const equipment = await db.getEquipmentById(params.id);
                    if (!equipment) {
                        set.status = 404;
                        return { message: 'Equipment not found' };
                    }
                    return await fileLogger.getAggregatedChartData(equipment.name, equipment.id, tf);
                } catch (error: any) {
                    set.status = 500;
                    return { message: error.message };
                }
            })
    )

    // --- SUP CATEGORY ROUTES ---
    .group('/api/sup-categories', (app) =>
        app.get('/', async () => await db.getAllSupCategories())
            .get('/:category', async ({ params }) => await db.getSupCategoriesByCategory(params.category))
            .put('/:category', async ({ params, body }) => {
                const result = await db.updateSupCategory(params.category, (body as any).sub_categories);
                pushSyncToTOC();
                return result;
            })
    )

    // --- EQUIPMENT OTENTICATION ROUTES ---
    .group('/api/otentication', (app) =>
        app.get('/:equipmentId', async ({ params }) => await db.getOtenticationByEquipment(params.equipmentId))
            .post('/', async ({ body }) => {
                const b = body as any;
                const result = await db.createOtentication(b);
                pushSyncToTOC();
                publishDataSourceConfigurationChanged('add', b).catch((e: any) => console.error('[EMS] Failed to publish datasource update:', e.message));
                return result;
            })
            .delete('/:equipmentId', async ({ params }) => {
                const result = await db.deleteOtenticationByEquipment(params.equipmentId);
                pushSyncToTOC();
                publishDataSourceConfigurationChanged('delete', { equipmentId: params.equipmentId }).catch((e: any) => console.error('[EMS] Failed to publish datasource delete:', e.message));
                return result;
            })
    )

    // --- LIMITATION CONFIG ROUTES ---
    .group('/api/limitations', (app) =>
        app.get('/:equipmentId', async ({ params }) => await db.getLimitationsByEquipment(params.equipmentId))
            .put('/', async ({ body }) => {
                const result = await db.updateLimitation(body as any);
                pushSyncToTOC();
                return result;
            })
    )

    // --- AIRPORT ROUTES ---
    .group('/api/airports', (app) =>
        app
            .get('/:id', async ({ params, set }) => {
                const item = await db.getAirportById(params.id);
                if (!item) {
                    set.status = 404;
                    return { success: false, message: 'Airport not found' };
                }
                return item;
            })
            .post('/', async ({ body, set }) => {
                const item = await db.createAirport(body);
                set.status = 201;
                pushSyncToTOC();
                return item;
            }, { beforeHandle: authorize(['superadmin', 'admin', 'user_pusat']) })
            .put('/:id', async ({ params, body, set }) => {
                const updated = await db.updateAirport(params.id, body);
                if (!updated) {
                    set.status = 404;
                    return { success: false, message: 'Airport not found' };
                }
                pushSyncToTOC();
                return updated;
            }, { beforeHandle: authorize(['superadmin', 'admin', 'user_pusat']) })
            .delete('/:id', async ({ params }) => {
                await db.deleteAirport(params.id);
                pushSyncToTOC();
                return { success: true, message: 'Airport deleted' };
            }, { beforeHandle: authorize(['superadmin', 'admin']) })
            .get('/gateway-status', async ({ query: { airportId }, set }) => {
                try {
                    if (!airportId) {
                        set.status = 400;
                        return { success: false, error: 'airportId query parameter required' };
                    }
                    const airportIdNum = parseInt(airportId as string);
                    const airport = await db.getAirportById(airportIdNum);

                    if (!airport) {
                        set.status = 404;
                        return {
                            success: false,
                            error: 'Airport not found',
                            gatewayHealthy: false
                        };
                    }

                    const gatewayIp = airport.ipBranch || airport.ip_branch;

                    if (!gatewayIp || gatewayIp.trim() === '') {
                        return {
                            success: true,
                            gatewayHealthy: false,
                            ip: null,
                            message: 'No gateway IP configured for this airport',
                            responseTime: null
                        };
                    }

                    // Ping gateway IP (timeout 3s)
                    const ping = require('ping');
                    const result = await ping.promise.probe(gatewayIp, { timeout: 3 });

                    const gatewayHealthy = result.alive;

                    return {
                        success: true,
                        gatewayHealthy,
                        ip: gatewayIp,
                        responseTime: gatewayHealthy ? result.time : null,
                    };
                } catch (error: any) {
                    if (!set.status || set.status === 200) set.status = 500;
                    return { success: false, error: error.message };
                }
            })
    )

    // --- BRANCH ROUTES ---
    .get('/api/branches', async () => await db.getAllAirports())

    // --- SNMP TEMPLATE ROUTES (MAIN) ---
    .group('/api/templates', (app) =>
        app
            .get('/', async () => await db.getAllSnmpTemplates())
            .get('/:id', async ({ params, set }) => {
                const item = await db.getSnmpTemplateById(params.id);
                if (!item) {
                    set.status = 404;
                    return { message: 'Template not found' };
                }
                return item;
            })
            .post('/', async ({ body, set }) => {
                try {
                    const id = 'custom_' + Date.now();
                    const newTemplate = await db.createSnmpTemplate({ ...(body as any), id, isDefault: false });
                    set.status = 201;
                    return newTemplate;
                } catch (error: any) {
                    set.status = 500;
                    return { message: error.message };
                }
            }, { beforeHandle: authorize(['superadmin', 'admin', 'user_pusat']) })
            .put('/:id', async ({ params, body, set }) => {
                const updated = await db.updateSnmpTemplate(params.id, body);
                if (!updated) {
                    set.status = 404;
                    return { message: 'Template not found' };
                }
                return updated;
            }, { beforeHandle: authorize(['superadmin', 'admin', 'user_pusat']) })
            .delete('/:id', async ({ params, set }) => {
                const deleted = await db.deleteSnmpTemplate(params.id);
                if (!deleted) {
                    set.status = 404;
                    return { message: 'Template not found' };
                }
                return { message: 'Template deleted' };
            }, { beforeHandle: authorize(['superadmin', 'admin', 'user_pusat']) })
    )

    // --- SNMP TEST ROUTES (BACKWARD COMPATIBILITY) ---
    .group('/api/snmp', (app) =>
        app
            .post('/test', async ({ body, set }) => {
                const { snmpGet } = require('./utils/network');
                const { ip, port, community, oid } = body as any;
                try {
                    const result = await snmpGet(oid, ip, port, community);
                    return { success: true, ...result };
                } catch (error: any) {
                    set.status = 500;
                    return { success: false, message: error.message };
                }
            })
            .get('/data/:id', async ({ params, set }) => {
                const { fetchAndParseData } = require('./utils/network');
                try {
                    const item = await equipmentService.getEquipmentWithConfig(params.id);
                    if (!item) {
                        set.status = 404;
                        return { message: 'Equipment not found' };
                    }

                    const config = item.snmpConfig || item.snmp_config;
                    if (!config || !config.enabled) {
                        set.status = 404;
                        return { message: 'SNMP not configured for this equipment' };
                    }

                    const { parsedData: data, status, triggeredParameters } = await fetchAndParseData(item);
                    const enrichedData = { ...data, _status: status, _triggered: triggeredParameters || [] };
                    state.snmpDataCache[item.id] = enrichedData;
                    return enrichedData;
                } catch (error: any) {
                    console.error(`[SNMP] Error for ${params.id}:`, error.message);
                    if (state.snmpDataCache[params.id]) {
                        return { ...state.snmpDataCache[params.id], error: error.message, cached: true };
                    }
                    set.status = 500;
                    return { message: 'Failed to fetch SNMP data', error: error.message };
                }
            })
    )



    // --- USER MANAGEMENT ROUTES ---


    // --- THRESHOLD ROUTES ---
    .group('/api/equipment/:id/thresholds', (app) =>
        app
            .get('/', async ({ params }) => await db.getThresholdsByEquipment(params.id))
            .post('/', async ({ params, body, set, request }) => {
                const correlationId = request.headers.get('x-correlation-id') || undefined;
                try {
                    const threshold = await db.createThreshold({ ...(body as any), equipment_id: parseInt(params.id) });
                    await publishThresholdResult('configuration.threshold.applied', {
                        equipmentId: parseInt(params.id),
                        thresholdId: threshold.id,
                        threshold,
                        result: 'created',
                        correlationId
                    }).catch((e: any) => console.warn('[EMS] Failed to publish threshold.applied:', e.message));
                    set.status = 201;
                    return threshold;
                } catch (error: any) {
                    await publishThresholdResult('configuration.threshold.failed', {
                        equipmentId: parseInt(params.id),
                        threshold: body,
                        result: 'create_failed',
                        reason: error.message,
                        correlationId
                    }).catch((e: any) => console.warn('[EMS] Failed to publish threshold.failed:', e.message));
                    set.status = 500;
                    return { message: 'Failed to create threshold', error: error.message };
                }
            }, { beforeHandle: authorize(['superadmin', 'admin', 'user_pusat']) })
            .put('/:thresholdId', async ({ params, body, set, request }) => {
                const correlationId = request.headers.get('x-correlation-id') || undefined;
                try {
                    const updated = await db.updateThreshold(params.thresholdId, body);
                    if (!updated) {
                        set.status = 404;
                        return { message: 'Threshold not found' };
                    }

                    await publishThresholdResult('configuration.threshold.applied', {
                        equipmentId: parseInt(params.id),
                        thresholdId: updated.id || params.thresholdId,
                        threshold: updated,
                        result: 'updated',
                        correlationId
                    }).catch((e: any) => console.warn('[EMS] Failed to publish threshold.applied:', e.message));

                    return updated;
                } catch (error: any) {
                    await publishThresholdResult('configuration.threshold.failed', {
                        equipmentId: parseInt(params.id),
                        thresholdId: params.thresholdId,
                        threshold: body,
                        result: 'update_failed',
                        reason: error.message,
                        correlationId
                    }).catch((e: any) => console.warn('[EMS] Failed to publish threshold.failed:', e.message));
                    set.status = 500;
                    return { message: 'Failed to update threshold', error: error.message };
                }
            }, { beforeHandle: authorize(['superadmin', 'admin', 'user_pusat']) })
            .delete('/:thresholdId', async ({ params }) => {
                await db.deleteThreshold(params.thresholdId);
                return { message: 'Threshold deleted' };
            }, { beforeHandle: authorize(['superadmin', 'admin', 'user_pusat']) })
    )

    .post('/api/messaging/threshold/apply', async ({ body, set, request }) => {
        try {
            const payload = body as any;
            const correlationId = payload.correlationId || request.headers.get('x-correlation-id') || undefined;
            const targetSiteId = payload.targetSiteId || getLocalSiteId();

            const command = await publishThresholdApplyCommand({
                equipmentId: payload.equipmentId,
                threshold: payload.threshold,
                requestedBy: payload.requestedBy || 'api',
                targetSiteId,
                correlationId
            });

            if (payload.applyLocally) {
                let thresholdResult;
                if (payload.threshold?.id) {
                    thresholdResult = await db.updateThreshold(payload.threshold.id, payload.threshold);
                } else {
                    thresholdResult = await db.createThreshold({
                        ...(payload.threshold || {}),
                        equipment_id: parseInt(payload.equipmentId)
                    });
                }

                await publishThresholdResult('configuration.threshold.applied', {
                    equipmentId: parseInt(payload.equipmentId),
                    thresholdId: thresholdResult?.id,
                    threshold: thresholdResult,
                    result: payload.threshold?.id ? 'updated' : 'created',
                    correlationId
                }).catch((e: any) => console.warn('[EMS] Failed to publish threshold.applied:', e.message));

                return {
                    success: true,
                    command_queue: command.queue,
                    applied_locally: true,
                    threshold: thresholdResult,
                    correlation_id: correlationId
                };
            }

            return {
                success: true,
                command_queue: command.queue,
                applied_locally: false,
                correlation_id: correlationId
            };
        } catch (error: any) {
            set.status = 500;
            return { success: false, message: 'Failed to publish threshold apply command', error: error.message };
        }
    }, { beforeHandle: authorize(['superadmin', 'admin', 'user_pusat']) })

    .post('/api/messaging/equipment-snapshot/request', async ({ body, set, request }) => {
        try {
            const payload = body as any;
            const equipmentId = parseInt(payload.equipmentId);
            const correlationId = payload.correlationId || request.headers.get('x-correlation-id') || undefined;
            const targetSiteId = payload.targetSiteId || getLocalSiteId();

            const requestResult = await publishEquipmentSnapshotRequested({
                equipmentId,
                sourceName: payload.sourceName,
                requestedBy: payload.requestedBy || 'api',
                targetSiteId,
                correlationId
            });

            let snapshot = null;
            if (payload.respondInline !== false) {
                snapshot = await buildEquipmentSnapshot(equipmentId);
                if (!snapshot) {
                    set.status = 404;
                    return { success: false, message: 'Equipment not found' };
                }

                await publishEquipmentSnapshotResponded({
                    equipmentId,
                    snapshot,
                    targetSiteId: payload.responseTargetSiteId || 'PUSAT',
                    correlationId
                }).catch((e: any) => console.warn('[EMS] Failed to publish snapshot response:', e.message));
            }

            return {
                success: true,
                request_queue: requestResult.queue,
                correlation_id: correlationId,
                snapshot
            };
        } catch (error: any) {
            set.status = 500;
            return { success: false, message: 'Failed to process equipment snapshot request', error: error.message };
        }
    }, { beforeHandle: authorize(['superadmin', 'admin', 'user_pusat']) })

    // --- PARSER ROUTES ---
    .post('/api/parser/test', async ({ body, set }) => {
        try {
            const ParserFactory = require('./parsers/factory');
            const { connectionType, parserConfig, sampleData } = body as any;
            const parser = ParserFactory.createParser(connectionType, { parser_config: parserConfig });
            if (!parser) {
                set.status = 400;
                return { message: `Unsupported connection type: ${connectionType}` };
            }
            const result = parser.parse(sampleData);
            return { success: true, parsed: result };
        } catch (error: any) {
            set.status = 500;
            return { success: false, error: error.message };
        }
    })

    // --- NETWORK MONITORING ROUTES ---
    // --- NETWORK MONITORING & SNIFFER ROUTES ---
    .group('/api/network', app => app
        .use(authenticate)
        .get('/interfaces', async () => ({ success: true, data: await require('./network/monitor').getNetworkInterfaces() }))
        .get('/ifstats', async () => ({ success: true, data: await require('./network/monitor').getInterfacesWithStats() }))
        .get('/stats', async () => ({ success: true, data: await require('./network/monitor').getNetworkStats() }))
        .post('/ping', async ({ body }) => {
            const { host, count } = body as any;
            return { success: true, data: await require('./network/monitor').pingHost(host, count || 4) };
        })
        .get('/sniffer/packets', ({ query }) => {
            const sniffer = require('./network/sniffer');
            return { success: true, data: sniffer.getPackets(query) };
        })
        .get('/sniffer/stats', () => {
            const sniffer = require('./network/sniffer');
            return { success: true, data: sniffer.getStatistics() };
        })
        .post('/sniffer/start', async ({ body, set }) => {
            const sniffer = require('./network/sniffer');
            const { interface: iface } = body as any;
            await sniffer.start(iface);
            if (sniffer.captureMode === 'none') {
                set.status = 400;
                return { success: false, mode: sniffer.captureMode, error: sniffer.lastError || 'Capture failed to start' };
            }
            return { success: true, mode: sniffer.captureMode };
        })
        .post('/sniffer/stop', () => {
            const sniffer = require('./network/sniffer');
            sniffer.stop();
            return { success: true };
        })
        .post('/sniffer/clear', () => {
            const sniffer = require('./network/sniffer');
            sniffer.clear();
            return { success: true };
        })
        .get('/local-info', async () => ({ success: true, data: await require('./network/monitor').getLocalNetworkInfo() }))
        .get('/system-info', async () => ({ success: true, data: await require('./network/monitor').getSystemNetworkInfo() }))
        .get('/arp-table', async () => ({ success: true, data: await require('./network/monitor').getArpTable() }))
        .get('/discover-devices', async () => ({ success: true, data: await require('./network/monitor').discoverNetworkDevices() }))
        .get('/discover-snmp', async ({ query }) => ({ success: true, data: await require('./network/monitor').discoverSnmpDevices((query.community as string) || 'public') }))
        .post('/tcp-test', async ({ body }) => {
            const { testTcpConnection } = require('./network/tcp-tester');
            const { gatewayIp, deviceIp, port, syncMarker } = body as any;
            const result = await testTcpConnection(gatewayIp, deviceIp, parseInt(port), syncMarker);
            return { success: true, data: result };
        })
        .post('/tcp-scan', async ({ body }) => {
            const { scanPorts } = require('./network/tcp-tester');
            const { deviceIp, startPort, endPort } = body as any;
            const openPorts = await scanPorts(deviceIp, parseInt(startPort), parseInt(endPort));
            return { success: true, data: { openPorts } };
        })
        .post('/snmp-walk', async ({ body }) => {
            const { ip, community, version, oid } = body as any;
            const snmp = require('snmp-native');

            try {
                // Security: sanitize inputs
                const safeIp = ip.replace(/[^a-zA-Z0-9.:]/g, '');
                const safeCommunity = community ? community.replace(/[^a-zA-Z0-9_-]/g, '') : 'public';
                const safeOid = oid ? oid.replace(/[^0-9.]/g, '') : '';

                console.log(`[SNMP Terminal] Walking ${safeIp} with community ${safeCommunity} and OID ${safeOid}`);

                const session = new snmp.Session({ host: safeIp, community: safeCommunity, timeouts: [4000, 4000] });

                const cleanOid = safeOid.startsWith('.') ? safeOid.substring(1) : safeOid;
                const targetOid = cleanOid ? cleanOid.split('.').map(Number) : [1, 3, 6, 1];

                const vbs = await new Promise<any[]>((resolve, reject) => {
                    session.getSubtree({ oid: targetOid, combinedTimeout: 15000 }, (err: any, bindings: any[]) => {
                        if (err) reject(err);
                        else resolve(bindings || []);
                    });
                });

                session.close();

                let output = '';
                if (vbs.length === 0) {
                    output = 'No data returned or error.';
                } else {
                    output = vbs.map((vb: any) => {
                        const oidStr = vb.oid.join('.');
                        return `.${oidStr} = ${vb.value}`;
                    }).join('\n');
                }

                return {
                    success: true,
                    data: {
                        output: output
                    }
                };
            } catch (error: any) {
                console.error('[SNMP Terminal] Error:', error);
                return {
                    success: true,
                    data: {
                        output: `Error: ${error.message}`
                    }
                };
            }
        })
    )

    // --- PACKET EXPORT ROUTE ---
    .group('/api/sniffer', app => app
        .use(authenticate)
        .get('/export', async ({ query, set }) => {
            const sniffer = require('./network/sniffer');
            const format = (query.format as string) || 'json';
            const data = sniffer.export(format);

            if (format === 'csv') {
                set.headers['Content-Type'] = 'text/csv';
                set.headers['Content-Disposition'] = `attachment; filename=packets_${Date.now()}.csv`;
            }
            return data;
        })
    )

    // --- CONFIGURATION MANAGEMENT ROUTES (Issue #12) ---
    .group('/api/config', (app) =>
        app
            // Public read-only access for lookups (required for UI initialization)
            .get('/limitations', async () => await db.getAllLimitations())
            .get('/authentications', async () => await db.getAllOtentication())
            .get('/parsings', async () => await db.getAllParsingConfigs())
            .get('/categories', async () => await db.getAllCategories())
            .get('/sup-categories', async () => await db.getAllSupCategories())

            // Require authentication for modifications
            .use(authenticate)
            // Limitations
            .post('/limitations', async ({ body, set }) => {
                const item = await db.createLimitation(body as any);
                set.status = 201;
                pushSyncToTOC();
                return item;
            }, { beforeHandle: authorize(['superadmin', 'admin']) })
            .put('/limitations/:id', async ({ params, body, set }) => {
                const updated = await db.updateLimitation(params.id, body);
                if (!updated) { set.status = 404; return { message: 'Not found' }; }
                pushSyncToTOC();
                return updated;
            }, { beforeHandle: authorize(['superadmin', 'admin']) })
            .delete('/limitations/:id', async ({ params }) => {
                await db.deleteLimitation(params.id);
                pushSyncToTOC();
                return { message: 'Deleted' };
            }, { beforeHandle: authorize(['superadmin', 'admin']) })

            // Authentications (IP Components)
            .post('/authentications', async ({ body, set }) => {
                const item = await db.createOtentication(body as any);
                set.status = 201;
                pushSyncToTOC();
                return item;
            }, { beforeHandle: authorize(['superadmin', 'admin']) })
            .put('/authentications/:id', async ({ params, body, set }) => {
                const updated = await db.updateOtentication(params.id, body);
                if (!updated) { set.status = 404; return { message: 'Not found' }; }
                pushSyncToTOC();
                return updated;
            }, { beforeHandle: authorize(['superadmin', 'admin']) })
            .delete('/authentications/:id', async ({ params }) => {
                await db.deleteOtentication(params.id);
                pushSyncToTOC();
                // We use 'delete' and pass equipmentId as null because we only have authentication id here. The payload processor should handle it or it's just a purge event.
                publishDataSourceConfigurationChanged('delete', { equipt_id: null, id: params.id }).catch((e: any) => console.error('[EMS] Failed to publish datasource delete:', e.message));
                return { message: 'Deleted' };
            }, { beforeHandle: authorize(['superadmin', 'admin']) })

            // Parsing Templates
            .post('/parsings', async ({ body, set }) => {
                const item = await db.createParsingConfig(body as any);
                set.status = 201;
                pushSyncToTOC();
                return item;
            }, { beforeHandle: authorize(['superadmin', 'admin']) })
            .put('/parsings/:id', async ({ params, body, set }) => {
                const updated = await db.updateParsingConfig(params.id, body);
                if (!updated) { set.status = 404; return { message: 'Not found' }; }
                pushSyncToTOC();
                return updated;
            }, { beforeHandle: authorize(['superadmin', 'admin']) })
            .delete('/parsings/:id', async ({ params }) => {
                await db.deleteParsingConfig(params.id);
                pushSyncToTOC();
                return { message: 'Deleted' };
            }, { beforeHandle: authorize(['superadmin', 'admin']) })

            // Categories & Sup Categories
            .post('/sup-categories', async ({ body, set }) => {
                const item = await db.createSupCategory(body as any);
                set.status = 201;
                return item;
            }, { beforeHandle: authorize(['superadmin', 'admin']) })
            .delete('/sup-categories/:id', async ({ params }) => {
                await db.deleteSupCategory(params.id);
                return { message: 'Deleted' };
            }, { beforeHandle: authorize(['superadmin', 'admin']) })
    )

    // --- UTILS ROUTES ---

    .group('/api/utils', (app) => {
        return app.use(authenticate)
            .get('/ping', () => ({ success: true, message: 'Utils API is active' }))
            .get('/list-files', async ({ query, set }) => {
                const { readdir } = require('node:fs/promises');
                const { join, normalize, resolve, sep } = require('node:path');

                try {
                    const requestedPath = (query.path as string) || '.';
                    const rootDir = process.cwd();

                    // Normalize requested path to remove .. etc
                    let safePath = normalize(requestedPath).replace(/^(\.\.(\/|\\|$))+/, '');
                    if (safePath === '.' || safePath === './' || safePath === '/') safePath = '';

                    const targetDir = resolve(rootDir, safePath);

                    // Security: ensure targetDir is within rootDir
                    if (!targetDir.startsWith(rootDir)) {
                        set.status = 403;
                        return { error: 'Access denied: Path is outside project directory' };
                    }

                    const entries = await readdir(targetDir, { withFileTypes: true });
                    const contents = entries.map((entry: any) => {
                        const relativeEntryPath = join(safePath, entry.name);
                        const webPath = '/' + relativeEntryPath.split(sep).join('/');

                        return {
                            name: entry.name,
                            isDir: entry.isDirectory(),
                            path: webPath
                        };
                    });

                    // Filtering for security and relevance
                    const filteredContents = contents.filter((c: any) =>
                        !c.name.startsWith('.') &&
                        !c.name.includes('node_modules')
                    );

                    return {
                        success: true,
                        currentPath: '/' + safePath.split(sep).join('/'),
                        parentPath: (safePath === '' || safePath === '.') ? null : '/' + normalize(join(safePath, '..')).split(sep).join('/'),
                        contents: filteredContents.sort((a: any, b: any) => (b.isDir ? 1 : 0) - (a.isDir ? 1 : 0) || a.name.localeCompare(b.name))
                    };
                } catch (error: any) {
                    set.status = 500;
                    return { success: false, error: error.message };
                }
            });
    })
    // Move Static Plugin to the END to avoid intercepting API calls
    .use(staticPlugin({ assets: 'public', prefix: '' }))

    // Root Dashboard Serving (Direct Bun file serving via Response)
    .get('/favicon.ico', () => (globalThis as any).Bun?.file('public/icon.png'))

    .get('/api/test-chain', () => {
        console.log('[DEBUG-ROUTER] Hit /api/test-chain');
        return { chain: 'complete', timestamp: new Date().toISOString() };
    });

if (SHOULD_START_WEB) {
    app.listen(PORT);
    console.log(`🦊 Elysia is running at ${app.server?.hostname}:${app.server?.port}`);
} else {
    console.log(`[SYSTEM] SERVICE_ROLE=${SERVICE_ROLE} running without web server`);
}

// Initialize Services (similar to server.js)
let isInitializing = false;
async function startServices() {
    if (isInitializing) return;
    isInitializing = true;

    try {
        console.log(`[SYSTEM] Initializing core services... role=${SERVICE_ROLE} pipeline=${PIPELINE_MODE}`);

        // 1. Sync Data Sources with Equipment Categories (NEW)
        try {
            await db.syncOtenticationSupCategory();
        } catch (e) {
            console.error('[SYSTEM] Error syncing categories:', e);
        }

        // 2. Load SNMP Templates into cache
        try {
            state.snmpTemplatesCache = await templateService.getAllTemplates();
            console.log(`[SNMP] ${state.snmpTemplatesCache?.length || 0} templates loaded from JSON`);
        } catch (e) {
            console.error('[SYSTEM] Error loading templates:', e);
        }

        // 3. Start Background Schedulers
        if (PIPELINE_MODE === 'inline' && SHOULD_START_PROCESSOR) {
            const collector = new DataCollectorScheduler(new EquipmentService(db));

            // Run testing every 60 seconds as requested
            setInterval(async () => {
                try {
                    await collectEquipmentData();
                } catch (e) {
                    console.error('[SCHEDULER] collectEquipmentData error:', e);
                }
            }, 60000);

            // Initial run after a short delay
            setTimeout(async () => {
                try {
                    await collectEquipmentData();
                } catch (e) {
                    console.error('[SCHEDULER] Initial collectEquipmentData error:', e);
                }
            }, 5000);
        }

        if (SHOULD_START_PROCESSOR) {
            setInterval(async () => {
                try {
                    await checkEquipmentWatchdog();
                } catch (e) {
                    console.error('[WATCHDOG] Error:', e);
                }
            }, 60000);
        }

        // 5. Start History Log Cleanup (Scheduled at 00:00 UTC)
        const fileLogger = require('./utils/fileLogger');

        const scheduleCleanup = () => {
            try {
                const now = new Date();
                const nextRun = new Date(now);
                nextRun.setUTCHours(24, 0, 0, 0); // Next day 00:00 UTC

                const delay = nextRun.getTime() - now.getTime();
                if (delay < 0) return; // Prevent negative delay

                console.log(`[SYSTEM] Next log cleanup scheduled in ${Math.round(delay / 3600000)} hours (at 00:00 UTC)`);

                setTimeout(async () => {
                    try {
                        await fileLogger.cleanupOldLogs();
                    } catch (e) {
                        console.error('[CLEANUP] Error:', e);
                    }
                    scheduleCleanup(); // Schedule for next day
                }, delay);
            } catch (e) {
                console.error('[SYSTEM] scheduleCleanup setup error:', e);
            }
        };

        // Initial check on startup
        setTimeout(async () => {
            try {
                await fileLogger.cleanupOldLogs();
            } catch (e) {
                console.error('[CLEANUP] Initial cleanup error:', e);
            }
        }, 5000);

        // Start scheduler
        if (SHOULD_START_PROCESSOR) {
            scheduleCleanup();
        }

        if (PIPELINE_MODE === 'split' && SHOULD_START_PROCESSOR) {
            try {
                const QueuedDataProcessor = require('./services/queued_data_processor');
                const queuedProcessor = new QueuedDataProcessor();
                queuedProcessor.start();
            } catch (e) {
                console.error('[SYSTEM] queued processor init error:', e);
            }
        }

        // 6. Start Network Listener for modular parsers (UDP/TCP)
        if (SHOULD_START_COLLECTOR) {
            try {
                const networkListener = require('./services/network_listener');
                networkListener.initialize();
            } catch (e) {
                console.error('[SYSTEM] networkListener init error:', e);
            }
        }

        if (SHOULD_START_WEB) {
            try {
                const CommandConsumer = require('./services/command_consumer');
                const commandConsumer = new CommandConsumer({
                    equipmentService,
                    templateService,
                    state,
                    serviceRole: SERVICE_ROLE,
                    pipelineMode: PIPELINE_MODE
                });
                await commandConsumer.start();
            } catch (e) {
                console.error('[SYSTEM] commandConsumer init error:', e);
            }
        }

        console.log('[SYSTEM] Core services initialized (30s polling & 4min watchdog active)');
    } catch (err) {
        console.error('[SYSTEM] Critical error during service initialization:', err);
    } finally {
        isInitializing = false;
    }
}

try {
    startServices();
} catch (e) {
    console.error('[SYSTEM] Failed to invoke startServices:', e);
}
