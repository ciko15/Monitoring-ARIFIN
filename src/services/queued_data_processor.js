const ParserFactory = require('../parsers/factory');
const EquipmentService = require('./equipment');
const db = require('../../db/database');
const RawEventQueue = require('./raw_event_queue');

class QueuedDataProcessor {
    constructor(options = {}) {
        this.queue = options.queue || null; // [BYPASS] Tidak menggunakan RawEventQueue lagi
        this.equipmentService = options.equipmentService || new EquipmentService(db);
        this.parserCache = new Map();
        this.warningTimestamps = new Map();
        this.isRunning = false;
        this.isProcessing = false;
        this.pollIntervalMs = options.pollIntervalMs || 200;
        this.batchSize = options.batchSize || 100;
        this._timer = null;
    }

    start() {
        if (this.isRunning) return;
        this.isRunning = true;
        this._timer = setInterval(() => {
            this.processBatch().catch(err => {
                console.error('[QueueProcessor] Batch error:', err.message);
            });
        }, this.pollIntervalMs);
        console.log('[QueueProcessor] Started');
    }

    stop() {
        this.isRunning = false;
        if (this._timer) clearInterval(this._timer);
        this._timer = null;
        console.log('[QueueProcessor] Stopped');
    }

    _getParser(source) {
        const cacheKey = `${source.id}:${source.parsing_id}`;
        if (!this.parserCache.has(cacheKey)) {
            const parser = ParserFactory.createParser(source.parsing_id, { equipt_id: source.equipt_id });
            this.parserCache.set(cacheKey, parser);
        }
        return this.parserCache.get(cacheKey);
    }

    _shouldLogWarning(sourceId, errorKey, throttleMs = 15000) {
        const key = `${sourceId}:${errorKey}`;
        const now = Date.now();
        const lastLoggedAt = this.warningTimestamps.get(key) || 0;

        if (now - lastLoggedAt < throttleMs) {
            return false;
        }

        this.warningTimestamps.set(key, now);
        return true;
    }

    async processBatch() {
        if (!this.isRunning || this.isProcessing || !this.queue) return;
        this.isProcessing = true;

        try {
            const claimed = await this.queue.claimBatch(this.batchSize);
            for (const item of claimed) {
                try {
                    await this.processEvent(item.event);
                    await this.queue.acknowledge(item.fileName);
                } catch (error) {
                    console.error(`[QueueProcessor] Failed processing ${item.fileName}:`, error.message);
                    await this.queue.release(item.fileName);
                }
            }
        } finally {
            this.isProcessing = false;
        }
    }

    async processEvent(event) {
        if (!event || !event.type) return;

        if (event.type === 'raw') {
            await this.processRawEvent(event);
            return;
        }

        if (event.type === 'parsed') {
            await this.processParsedEvent(event);
            return;
        }

        console.warn(`[QueueProcessor] Unknown event type: ${event.type}`);
    }

    async processRawEvent(event) {
        const { source, rawBase64 } = event;
        const parser = this._getParser(source);
        if (!parser) {
            console.warn(`[QueueProcessor] No parser for ${source.name} (${source.parsing_id})`);
            return;
        }

        const rawData = Buffer.from(rawBase64, 'base64');
        const parsedResult = parser.parse(rawData);
        const transientParseErrors = new Set([
            'No valid GP frames',
            'No valid DME frames',
            'No valid LLZ frames',
            'Menunggu data'
        ]);

        if (!parsedResult || !parsedResult.success) {
            if (parsedResult?.error && !transientParseErrors.has(parsedResult.error)) {
                console.warn(`[QueueProcessor] Parse skipped for ${source.name}: ${parsedResult.error}`);
            } else if (parsedResult?.error && this._shouldLogWarning(source.id, parsedResult.error)) {
                console.log(`[QueueProcessor] Waiting for complete frame from ${source.name}: ${parsedResult.error}`);
            }
            return;
        }

        const logData = {
            ...(parsedResult.success ? parsedResult : { data: { raw: rawData.toString('hex') } }),
            source: source.name,
            _ip: source.ip_address || 'unknown'
        };

        await this.equipmentService.saveToLogs(
            source.equipt_id,
            logData,
            source.parsing_id || 'raw',
            parsedResult.status || 'Normal'
        );
    }

    async processParsedEvent(event) {
        const { source, parsedData, connectionType, status } = event;
        await this.equipmentService.saveToLogs(
            source.equipt_id,
            parsedData,
            connectionType || source.parsing_id || 'raw',
            status || 'Normal'
        );
    }
}

module.exports = QueuedDataProcessor;
