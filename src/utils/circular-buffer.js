/**
 * 循环缓冲区 - 固定容量的缓冲区，满了自动淘汰最旧项
 * 参考 Claude Code 源码 CircularBuffer.ts
 */
export class CircularBuffer {
    constructor(capacity) {
        this.capacity = capacity;
        this.buffer = new Array(capacity);
        this.head = 0;
        this.size = 0;
    }

    /**
     * 添加一项到缓冲区，满了则淘汰最旧的
     */
    add(item) {
        this.buffer[this.head] = item;
        this.head = (this.head + 1) % this.capacity;
        if (this.size < this.capacity) {
            this.size++;
        }
    }

    /**
     * 批量添加多项
     */
    addAll(items) {
        for (const item of items) {
            this.add(item);
        }
    }

    /**
     * 获取最近N项（从旧到新排序）
     */
    getRecent(count) {
        const result = [];
        const start = this.size < this.capacity ? 0 : this.head;
        const available = Math.min(count, this.size);

        for (let i = 0; i < available; i++) {
            const index = (start + this.size - available + i) % this.capacity;
            result.push(this.buffer[index]);
        }

        return result;
    }

    /**
     * 获取所有项（从旧到新排序）
     */
    toArray() {
        if (this.size === 0) return [];

        const result = [];
        const start = this.size < this.capacity ? 0 : this.head;

        for (let i = 0; i < this.size; i++) {
            const index = (start + i) % this.capacity;
            result.push(this.buffer[index]);
        }

        return result;
    }

    /**
     * 清空缓冲区
     */
    clear() {
        this.buffer = new Array(this.capacity);
        this.head = 0;
        this.size = 0;
    }

    /**
     * 返回当前项数
     */
    length() {
        return this.size;
    }
}

export default CircularBuffer;