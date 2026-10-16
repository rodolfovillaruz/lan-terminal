// The window shortcuts (Ctrl+Shift+Alt+<key>) read from the keyboards themselves, under
// the window system. A page that holds the keyboard, such as a webtop in fullscreen,
// keeps keys from the window's own key hook, but not from the kernel's input devices.
//
// It reads /dev/input/by-path/*-event-kbd (and by-id), which needs the user in the
// input group: any program the user runs can then read every key typed. Without it,
// it says so once and the window's key hook does the job alone. Each keyboard is read
// by a cat process, so a blocking read never holds one of Node's few pool threads.
// Keyboards plugged in later are found within a few seconds.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const DIRS = ['/dev/input/by-path', '/dev/input/by-id'];
const EVENT_SIZE = 24; // struct input_event on 64-bit Linux: timeval, type, code, value
const EV_KEY = 1;
// Linux key codes (linux/input-event-codes.h), by physical position like
// KeyboardEvent.code.
const MODIFIERS = { 29: 'control', 97: 'control', 42: 'shift', 54: 'shift', 56: 'alt', 100: 'alt', 125: 'meta', 126: 'meta' };
const KEYS = { 44: 'KeyZ', 33: 'KeyF', 19: 'KeyR' };

// onKey(code) gets 'KeyZ', 'KeyF' or 'KeyR' when one is pressed with Ctrl, Shift and
// Alt held and no Super key, on any keyboard.
function watch(onKey) {
  const readers = new Map(); // device path -> cat process
  let warned = false;
  const warn = () => {
    if (warned) return;
    warned = true;
    console.warn('Window shortcuts: cannot read the keyboards; add the user to the input group to catch them in fullscreen pages');
  };

  const read = (device) => {
    const held = new Set(); // modifier key codes held on this keyboard
    let rest = Buffer.alloc(0);
    const cat = spawn('cat', [device], { stdio: ['ignore', 'pipe', 'pipe'] });
    readers.set(device, cat);
    cat.stdout.on('data', (chunk) => {
      const buf = Buffer.concat([rest, chunk]);
      const whole = buf.length - (buf.length % EVENT_SIZE);
      for (let at = 0; at < whole; at += EVENT_SIZE) {
        if (buf.readUInt16LE(at + 16) !== EV_KEY) continue;
        const code = buf.readUInt16LE(at + 18);
        const value = buf.readInt32LE(at + 20); // 1 press, 2 repeat, 0 release
        if (MODIFIERS[code]) {
          if (value === 0) held.delete(code);
          else held.add(code);
        } else if (KEYS[code] && value === 1) {
          const mods = new Set([...held].map((c) => MODIFIERS[c]));
          if (mods.has('control') && mods.has('shift') && mods.has('alt') && !mods.has('meta')) onKey(KEYS[code]);
        }
      }
      rest = buf.subarray(whole);
    });
    let err = '';
    cat.stderr.on('data', (d) => { err += d; });
    cat.on('exit', () => {
      readers.delete(device);
      if (/permission denied/i.test(err)) warn();
    });
    cat.on('error', () => readers.delete(device));
  };

  // A keyboard that cannot be read is not tried again until it is plugged in again.
  const denied = new Set();
  const scan = () => {
    const found = new Set();
    for (const dir of DIRS) {
      let names = [];
      try {
        names = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of names.filter((n) => n.endsWith('-event-kbd'))) {
        try {
          found.add(fs.realpathSync(path.join(dir, name)));
        } catch {}
      }
    }
    for (const d of denied) if (!found.has(d)) denied.delete(d);
    for (const device of found) {
      if (readers.has(device) || denied.has(device)) continue;
      try {
        fs.accessSync(device, fs.constants.R_OK);
      } catch {
        denied.add(device);
        warn();
        continue;
      }
      read(device);
    }
  };
  scan();
  const timer = setInterval(scan, 5000);
  return () => {
    clearInterval(timer);
    for (const cat of readers.values()) cat.kill();
  };
}

module.exports = { watch };
