export class Queue {
    queue = [];
    processing = new Set();
    queueListeners = new Map();
    /**
     * Add an item to the queue with a unique id.
     * @param id Unique identifier for the item.
     * @param item The item to enqueue.
     */
    enqueue(id, item) {
        if (this.queue.find((q) => q.id === id) || this.processing.has(id)) {
            throw new Error('Duplicate id in queue or processing');
        }
        this.queue.push({ id, item });
        return {
            initialPosition: this.queue.length,
            wait: (update) => new Promise((resolve) => {
                const listener = (pos, cancelled) => {
                    if (cancelled) {
                        resolve('cancelled');
                        return;
                    }
                    console.log('pos', pos, 'processing #', this.processing.size);
                    if (pos === 1 && this.processing.size === 0) {
                        update(pos);
                        resolve('fulfilled');
                        return;
                    }
                    update(pos);
                };
                this.queueListeners.set(id, listener);
                if (this.queue.length === 1 && this.processing.size === 0) {
                    // automatically dequeue if there is only one item in the queue
                    listener(this.queue.length, false);
                    this.dequeue();
                }
                else {
                    listener(this.queue.length + this.processing.size, false);
                }
            }),
            cancelHandler: (cancel) => {
                cancel(() => {
                    this.queueListeners.get(id)?.(0, true);
                    this.remove(id);
                });
            },
            finish: () => {
                console.log('[Queue] Finishing download: ' + id);
                this.finish(id);
            },
        };
    }
    /**
     * Remove and return the next item in the queue.
     * Marks the id as processing.
     * Only allows one item to be processing at a time.
     */
    dequeue() {
        if (this.processing.size > 0) {
            // Only allow one item to be processed at a time
            return undefined;
        }
        const next = this.queue.shift();
        if (next) {
            // Notify listener that this item is now being processed (position 1)
            this.queueListeners.get(next.id)?.(1, false);
            this.processing.add(next.id);
            this.queueListeners.delete(next.id);
            // Update positions for remaining items
            this.queue.forEach((q, index) => {
                this.queueListeners.get(q.id)?.(index + 1 + this.processing.size);
            });
            return next;
        }
        return undefined;
    }
    /**
     * Mark an id as finished processing.
     * @param id The id to remove from processing.
     */
    finish(id) {
        if (!this.processing.has(id)) {
            return;
        }
        this.processing.delete(id);
        console.log('[Queue] Finished. Next in queue: ', this.dequeue());
    }
    /**
     * Remove an item from the queue by id (if not processing yet).
     * @param id The id to remove.
     */
    remove(id) {
        const idx = this.queue.findIndex((q) => q.id === id);
        if (idx !== -1) {
            this.queue.splice(idx, 1);
            this.queueListeners.delete(id);
            this.queue.forEach((q, index) => {
                this.queueListeners.get(q.id)?.(index + 1 + this.processing.size);
            });
            return true;
        }
        return false;
    }
    /**
     * Check if an id is in the queue or processing.
     */
    has(id) {
        return this.queue.some((q) => q.id === id) || this.processing.has(id);
    }
    /**
     * Get the current queue length (not including processing).
     */
    get length() {
        return this.queue.length;
    }
    /**
     * Get all ids currently in the queue (not processing).
     */
    get queuedIds() {
        return this.queue.map((q) => q.id);
    }
    /**
     * Get all ids currently being processed.
     */
    get processingIds() {
        return Array.from(this.processing);
    }
    /**
     * Get the first item in the queue (not processing).
     */
    get first() {
        return this.queue[0];
    }
    /**
     * Get the last item in the queue (not processing).
     */
    get last() {
        return this.queue[this.queue.length - 1];
    }
}
export class DownloadQueue extends Queue {
}
export const DOWNLOAD_QUEUE = new DownloadQueue();
//# sourceMappingURL=manager.queue.js.map