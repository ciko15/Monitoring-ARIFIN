const fs = require('fs');
const path = require('path');

class RawEventQueue {
    constructor(baseDir = path.resolve(process.cwd(), 'data', 'raw-queue')) {
        this.baseDir = baseDir;
        this.pendingDir = path.join(baseDir, 'pending');
        this.processingDir = path.join(baseDir, 'processing');
        this.failedDir = path.join(baseDir, 'failed');
        this._sequence = 0;

        this._ensureDir(this.baseDir);
        this._ensureDir(this.pendingDir);
        this._ensureDir(this.processingDir);
        this._ensureDir(this.failedDir);
    }

    _ensureDir(targetDir) {
        if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir, { recursive: true });
        }
    }

    _nextFileName() {
        this._sequence = (this._sequence + 1) % 1000000;
        return `${Date.now()}-${process.pid}-${this._sequence}.json`;
    }

    async enqueue(event) {
        const fileName = this._nextFileName();
        const tempPath = path.join(this.pendingDir, `${fileName}.tmp`);
        const finalPath = path.join(this.pendingDir, fileName);
        const body = JSON.stringify(event, null, 2);

        await fs.promises.writeFile(tempPath, body, 'utf8');
        await fs.promises.rename(tempPath, finalPath);
        return finalPath;
    }

    async claimBatch(limit = 20) {
        const entries = await fs.promises.readdir(this.pendingDir);
        const fileNames = entries
            .filter(name => name.endsWith('.json'))
            .sort((a, b) => a.localeCompare(b))
            .slice(0, limit);

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
