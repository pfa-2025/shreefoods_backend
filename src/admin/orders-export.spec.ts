import { orderRef, wallClock } from './orders-export';

describe('wallClock (instant -> the wall-clock time the viewer sees)', () => {
  it('shifts to the named time zone, winter and summer', () => {
    expect(wallClock(new Date('2026-01-15T03:30:00Z'), 'America/New_York').toISOString()).toBe('2026-01-14T22:30:00.000Z'); // EST, UTC-5
    expect(wallClock(new Date('2026-07-01T01:00:00Z'), 'America/New_York').toISOString()).toBe('2026-06-30T21:00:00.000Z'); // EDT, UTC-4
    expect(wallClock(new Date('2026-01-15T03:30:00Z'), 'Asia/Kolkata').toISOString()).toBe('2026-01-15T09:00:00.000Z'); // +5:30
  });
  it('is the identity for UTC', () => {
    expect(wallClock(new Date('2026-03-08T12:34:56Z'), 'UTC').toISOString()).toBe('2026-03-08T12:34:56.000Z');
  });
  it('handles midnight and the daylight-saving change day', () => {
    expect(wallClock(new Date('2026-03-08T05:00:00Z'), 'America/New_York').toISOString()).toBe('2026-03-08T00:00:00.000Z'); // midnight, just before the spring-forward
    expect(wallClock(new Date('2026-03-08T07:30:00Z'), 'America/New_York').toISOString()).toBe('2026-03-08T03:30:00.000Z'); // 2:00 never exists that day
  });
});

describe('orderRef', () => {
  it('pads like the rest of the app', () => {
    expect(orderRef(7)).toBe('SF-0007');
    expect(orderRef(1616)).toBe('SF-1616');
  });
});
