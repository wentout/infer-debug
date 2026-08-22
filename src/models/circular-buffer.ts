export class CircularBuffer<T> {
  private buffer: T[] = [];

  constructor(private readonly maxSize: number) {}

  push(item: T): void {
    this.buffer.push(item);
    if (this.buffer.length > this.maxSize) {
      this.buffer.shift();
    }
  }

  getAll(): T[] {
    return [...this.buffer];
  }

  getLast(n: number): T[] {
    return this.buffer.slice(-n);
  }

  clear(): void {
    this.buffer = [];
  }
}
