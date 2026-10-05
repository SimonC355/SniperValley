// Keyboard + mouse input with pointer lock, an arrow-key look fallback and rebindable
// actions (CONFIG.controls.binds maps action -> key codes or Mouse0/Mouse1/Mouse2).
import { CONFIG } from './config.js';

export class Input {
  constructor(element) {
    this.el = element;
    this.keys = new Set();
    this.pressed = new Set();   // keys pressed this frame
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheel = 0;             // wheel steps this frame (+ = toward the user)
    this.buttons = 0;
    this.clicked = new Set();   // mouse buttons pressed this frame
    this.locked = false;
    this.fallback = false;      // pointer lock unavailable -> arrow keys look
    this.onLockChange = null;
    this.capture = null;        // rebinding: fn(code|null) receives the next key or button

    window.addEventListener('keydown', (e) => {
      if (this.capture) {
        e.preventDefault();
        const cb = this.capture;
        this.capture = null;
        cb(e.code === 'Escape' ? null : e.code);
        return;
      }
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(e.code)) e.preventDefault();
      if (!this.keys.has(e.code)) this.pressed.add(e.code);
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => { this.keys.delete(e.code); });
    window.addEventListener('blur', () => { this.keys.clear(); this.buttons = 0; });
    window.addEventListener('mousemove', (e) => {
      if (this.locked) { this.mouseDX += e.movementX || 0; this.mouseDY += e.movementY || 0; }
    });
    window.addEventListener('mousedown', (e) => {
      if (!this.capture) return;
      e.preventDefault();
      e.stopPropagation();
      const cb = this.capture;
      this.capture = null;
      cb(`Mouse${e.button}`);
    }, true);
    element.addEventListener('mousedown', (e) => {
      if (!this.locked && !this.fallback) return;
      this.buttons |= 1 << e.button;
      this.clicked.add(e.button);
    });
    element.addEventListener('wheel', (e) => {
      if (!this.locked && !this.fallback) return;
      e.preventDefault();
      this.wheel += Math.sign(e.deltaY);
    }, { passive: false });
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

  down(code) {
    if (code.startsWith('Mouse')) return this.mouse(+code.slice(5));
    return this.keys.has(code);
  }
  wasPressed(code) {
    if (code.startsWith('Mouse')) return this.clicked.has(+code.slice(5));
    return this.pressed.has(code);
  }
  mouse(btn) { return (this.buttons & (1 << btn)) !== 0; }
  wasClicked(btn) { return this.clicked.has(btn); }

  // rebindable actions
  act(name) { const b = CONFIG.controls.binds[name]; return !!b && b.some((c) => this.down(c)); }
  actPressed(name) { const b = CONFIG.controls.binds[name]; return !!b && b.some((c) => this.wasPressed(c)); }

  endFrame() {
    this.pressed.clear();
    this.clicked.clear();
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheel = 0;
  }
}

// Short label for a key code ("KeyW" -> "W", "Mouse2" -> "RMB").
export function keyLabel(code) {
  if (!code) return '-';
  const named = {
    Mouse0: 'LMB', Mouse1: 'MMB', Mouse2: 'RMB', Mouse3: 'MOUSE 4', Mouse4: 'MOUSE 5',
    ShiftLeft: 'L-SHIFT', ShiftRight: 'R-SHIFT', ControlLeft: 'L-CTRL', ControlRight: 'R-CTRL',
    AltLeft: 'L-ALT', AltRight: 'R-ALT', Space: 'SPACE', Tab: 'TAB', CapsLock: 'CAPS', Enter: 'ENTER',
    Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'",
    Comma: ',', Period: '.', Slash: '/', Backslash: '\\',
  };
  if (named[code]) return named[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return 'NUM ' + code.slice(6);
  return code.toUpperCase();
}
