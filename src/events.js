// Reveal event bus. Anything that gives away a position emits
// { type, position, time, sourceTeam, sourceId, ...extra }.
// Types: 'shot' (sound), 'flash' (muzzle flash), 'birds' (flushed flock), 'splash',
// 'glint' (sustained scope glint toward targetId), 'footstep', 'impact'.

export class EventBus {
  constructor() {
    this.listeners = [];
    this.log = [];
  }

  on(fn) { this.listeners.push(fn); return () => { this.listeners = this.listeners.filter((f) => f !== fn); }; }

  emit(ev) {
    this.log.push(ev);
    if (this.log.length > 600) this.log.splice(0, this.log.length - 600);
    for (const fn of this.listeners) fn(ev);
  }

  recent(now, seconds) { return this.log.filter((e) => now - e.time <= seconds); }

  clear() { this.log.length = 0; }
}
