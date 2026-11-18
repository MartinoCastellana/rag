export class ExtractionQueue {
  constructor() {
    this.waiting = [];
    this.active = false;
  }

  enqueue(job) {
    return new Promise((resolve, reject) => {
      this.waiting.push({ job, resolve, reject });
      this.drain();
    });
  }

  async drain() {
    if (this.active) return;
    this.active = true;
    try {
      while (this.waiting.length > 0) {
        const item = this.waiting.shift();
        try {
          item.resolve(await item.job());
        } catch (error) {
          item.reject(error);
        }
      }
    } finally {
      this.active = false;
    }
  }

  status() {
    return { active: this.active, waiting: this.waiting.length, concurrency: 1 };
  }
}
