import { CircularBuffer } from '../src/models/circular-buffer';

describe('CircularBuffer', () => {
  it('keeps items up to maxSize and drops the oldest', () => {
    const buffer = new CircularBuffer<number>(3);
    buffer.push(1);
    buffer.push(2);
    buffer.push(3);
    buffer.push(4);
    expect(buffer.getAll()).toEqual([2, 3, 4]);
  });

  it('getLast returns the N most recent items', () => {
    const buffer = new CircularBuffer<string>(10);
    ['a', 'b', 'c', 'd'].forEach((x) => buffer.push(x));
    expect(buffer.getLast(2)).toEqual(['c', 'd']);
    expect(buffer.getLast(100)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('clear empties the buffer', () => {
    const buffer = new CircularBuffer<string>(5);
    buffer.push('x');
    buffer.clear();
    expect(buffer.getAll()).toEqual([]);
  });
});
