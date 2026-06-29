const fs = require('fs');
const path = require('path');

class RawEventQueue {
    constructor(baseDir = path.resolve(process.cwd(), 'data', 'raw-queue')) {
        this.baseDir = baseDir;
        this.pendingDir = path.join(baseDir, 'pending');
        this.processingDir = path.join(baseDir, 'processing');
        this.failedDir = path.join(baseDir, 'failed');
        this._sequence = 0;

        // Cleanup TTL (ms). Default: 30 minutes as requested.
        this.ttlMs = parseInt(process.env.QUEUE_TTL_MS || process.env.RAW_EVENT_QUEUE_TTL_MS || '') || 30 * 60 * 1000;
        // How often to run cleanup (ms)
        this.cleanupIntervalMs = parseInt(process.env.RAW_EVENT_QUEUE_CLEANUP_INTERVAL_MS || '') || 60 * 1000;
        this.maxPending = parseInt(process.env.QUEUE_MAX_PENDING || '') || 5000;

        this._cleanupTimer = null;
        this._limitWarningAt = 0;

        this._ensureDir(this.baseDir);
        this._ensureDir(this.pendingDir);
        this._ensureDir(this.processingDir);
        this._ensureDir(this.failedDir);

        this.startCleanup();
    }


    _ensureDir(targetDir) {
        if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir, { recursive: true });
        }
    }

    _nextFileName() {
        this._sequence = (this._sequence + 1) % 1000000;
        return `${Date.now()}-${process.pid}-${this._sequence.toString().padStart(6, '0')}.json`;
    }

    async enqueue(event) {
        await this._enforcePendingLimit();

        const fileName = this._nextFileName();
        const tempPath = path.join(this.pendingDir, `${fileName}.tmp`);
        const finalPath = path.join(this.pendingDir, fileName);
        const body = JSON.stringify(event, null, 2);

        await fs.promises.writeFile(tempPath, body, 'utf8');
        await fs.promises.rename(tempPath, finalPath);
        return finalPath;
    }

    async _enforcePendingLimit() {
        if (!this.maxPending || this.maxPending <= 0) return;

        const now = Date.now();
        if (now - (this._lastEnforceTime || 0) < 5000) return;
        this._lastEnforceTime = now;

        const entries = (await fs.promises.readdir(this.pendingDir))
            .filter(name => name.endsWith('.json'))
            .sort((a, b) => a.localeCompare(b));

        if (entries.length < this.maxPending) return;

        const overflowCount = entries.length - this.maxPending + 1;
        const toRemove = entries.slice(0, overflowCount);

        for (const fileName of toRemove) {
            await fs.promises.unlink(path.join(this.pendingDir, fileName)).catch(() => {});
        }

        const warnNow = Date.now();
        if (warnNow - this._limitWarningAt > 60000) {
            this._limitWarningAt = warnNow;
            console.warn(`[RawEventQueue] pending limit reached max=${this.maxPending}; dropped oldest=${toRemove.length}`);
        }
    }

    startCleanup() {
        if (this._cleanupTimer) return;
        console.log(`[RawEventQueue] cleanup enabled ttlMs=${this.ttlMs} cleanupIntervalMs=${this.cleanupIntervalMs}`);
        this._cleanupTimer = setInterval(() => {
            this.cleanupExpired().catch(err => {
                console.error('[RawEventQueue] cleanupExpired error:', err?.message || err);
            });
        }, this.cleanupIntervalMs);
    }


    async cleanupExpired() {
        const now = Date.now();
        const cutoff = now - this.ttlMs;

        const dirs = [this.pendingDir, this.processingDir, this.failedDir];
        for (const dir of dirs) {
            if (!fs.existsSync(dir)) continue;

            const entries = await fs.promises.readdir(dir);
            for (const fileName of entries) {
                if (!fileName.endsWith('.json')) continue;

                const filePath = path.join(dir, fileName);
                try {
                    const stat = await fs.promises.stat(filePath);
                    // Use mtime as “read/exists” age proxy
                    const mtime = new Date(stat.mtime).getTime();
                    if (mtime < cutoff) {
                        await fs.promises.unlink(filePath).catch(() => {});
                    }
                } catch (_) {
                    // ignore
                }
            }
        }
    }


    async claimBatch(limit = 20) {
        if (!this._cachedPending || this._cachedPending.length === 0) {
            const entries = await fs.promises.readdir(this.pendingDir);
            this._cachedPending = entries
                .filter(name => name.endsWith('.json'))
                .sort((a, b) => a.localeCompare(b));
        }

        const fileNames = this._cachedPending.splice(0, limit);
        if (fileNames.length === 0) return [];

        const claimed = [];
        for (const fileName of fileNames) {
            const sourcePath = path.join(this.pendingDir, fileName);
            const targetPath = path.join(this.processingDir, fileName);

            try {
                await fs.promises.rename(sourcePath, targetPath);
                const content = await fs.promises.readFile(targetPath, 'utf8');
                claimed.push({
                    fileName,
                    path: targetPath,
                    event: JSON.parse(content)
                });
            } catch (error) {
                // Another worker may have claimed the file first, or the file is malformed.
                if (fs.existsSync(targetPath)) {
                    try {
                        await fs.promises.rename(targetPath, path.join(this.failedDir, fileName));
                    } catch (_) {}
                }
            }
        }

        return claimed;
    }

    async acknowledge(fileName) {
        const targetPath = path.join(this.processingDir, fileName);
        if (fs.existsSync(targetPath)) {
            await fs.promises.unlink(targetPath);
        }
    }

    async release(fileName) {
        const sourcePath = path.join(this.processingDir, fileName);
        const targetPath = path.join(this.pendingDir, fileName);
        if (fs.existsSync(sourcePath)) {
            await fs.promises.rename(sourcePath, targetPath);
        }
    }

    async fail(fileName) {
        const sourcePath = path.join(this.processingDir, fileName);
        const targetPath = path.join(this.failedDir, fileName);
        if (fs.existsSync(sourcePath)) {
            await fs.promises.rename(sourcePath, targetPath);
        }
    }
}

module.exports = RawEventQueue;
