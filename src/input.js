// Keyboard + mouse input with pointer lock and an arrow-key look fallback.

export class Input {
  constructor(element) {
    this.el = element;
    this.keys = new Set();
    this.pressed = new Set();   // keys pressed this frame
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.buttons = 0;
    this.clicked = new Set();   // mouse buttons pressed this frame
    this.locked = false;
    this.fallback = false;      // pointer lock unavailable -> arrow keys look
    this.onLockChange = null;

    window.addEventListener('keydown', (e) => {
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(e.code)) e.preventDefault();
      if (!this.keys.has(e.code)) this.pressed.add(e.code);
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => { this.keys.delete(e.code); });
    window.addEventListener('blur', () => { this.keys.clear(); this.buttons = 0; });
    window.addEventListener('mousemove', (e) => {
      if (this.locked) { this.mouseDX += e.movementX || 0; this.mouseDY += e.movementY || 0; }
    });
    element.addEventListener('mousedown', (e) => {
      if (!this.locked && !this.fallback) return;
      this.buttons |= 1 << e.button;
      this.clicked.add(e.button);
    });
    window.addEventListener('mouseup', (e) => { this.buttons &= ~(1 << e.button); });
    element.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.el;
      if (this.locked) this.fallback = false;
      if (this.onLockChange) this.onLockChange(this.locked);
    });
    document.addEventListener('pointerlockerror', () => {
      this.fallback = true;
      if (this.onLockChange) this.onLockChange(false, true);
    });
  }

  requestLock() {
    try {
      const p = this.el.requestPointerLock();
      if (p && p.catch) p.catch(() => { this.fallback = true; if (this.onLockChange) this.onLockChange(false, true); });
    } catch (e) {
      this.fallback = true;
      if (this.onLockChange) this.onLockChange(false, true);
    }
  }

  down(code) { return this.keys.has(code); }
  wasPressed(code) { return this.pressed.has(code); }
  mouse(btn) { return (this.buttons & (1 << btn)) !== 0; }
  wasClicked(btn) { return this.clicked.has(btn); }

  endFrame() {
    this.pressed.clear();
    this.clicked.clear();
    this.mouseDX = 0;
    this.mouseDY = 0;
  }
}
