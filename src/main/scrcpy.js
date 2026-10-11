// Android screens through scrcpy's server: the app runs the server that the installed
// scrcpy ships (its version must match exactly), reads the H.264 stream itself and
// hands it to the window, which decodes and draws it inside the pane. No scrcpy
// window opens, so the phone shows up in a window capture like any other pane.
//
// A mirror lasts as long as its pane: closing the pane ends the server on the device.

const { execFile, spawn } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const mux = require('./mux');

const REMOTE_PATH = '/data/local/tmp/scrcpy-server.jar'; // where scrcpy itself puts it
const DEVICE_NAME_LENGTH = 64;
const HEADER = 12; // session packet, or a media packet's flags, PTS and size

// adb serials: USB serials, "host:port" and mDNS names like
// "adb-0921...-wXz3Kg._adb-tls-connect._tcp". Never a leading '-' (an option).
const validSerial = (s) => typeof s === 'string' && /^[A-Za-z0-9_.:\[\]@%+-]+$/.test(s) && !s.startsWith('-');

// A new virtual display instead of the device's own screen, as scrcpy's --new-display
// takes it: '' (the main display's size and density), '1920x1080', '/240' or
// '1920x1080/240'. 'fit' or 'fit/<dpi>' is a flex display (--flex-display), resized
// to keep filling its pane.
const validDisplay = (d) => typeof d === 'string' && /^(fit|(\d{2,5}x\d{2,5})?)(\/\d{2,4})?$/.test(d);
const isFit = (d) => typeof d === 'string' && d.startsWith('fit');

// Android package names: "org.mozilla.firefox".
const validPackage = (p) => typeof p === 'string' && p.length <= 255 && /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/.test(p);

function run(bin, args, timeout = 10000) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()));
      else resolve(stdout);
    });
  });
}

// adb from config, $PATH or the Android SDK, which the systemd user service has no
// $PATH entry for.
function findAdb(configured) {
  const sdk = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT, path.join(os.homedir(), 'Android', 'Sdk')];
  for (const file of [mux.find('adb', configured), ...sdk.filter(Boolean).map((d) => path.join(d, 'platform-tools', 'adb'))]) {
    try {
      if (file) {
        fs.accessSync(file, fs.constants.X_OK);
        return file;
      }
    } catch {
      // not here
    }
  }
  return null;
}

// The installed scrcpy's version and server: { version: '5.0', server: '/usr/share/scrcpy/scrcpy-server' }.
// The server sits in <prefix>/share/scrcpy next to <prefix>/bin/scrcpy, or where
// SCRCPY_SERVER_PATH says, as for scrcpy itself.
async function findScrcpy(configured) {
  const bin = mux.find('scrcpy', configured);
  if (!bin) throw new Error('scrcpy is not installed');
  const version = (await run(bin, ['--version'])).match(/^scrcpy (\S+)/m)?.[1];
  if (!version) throw new Error('could not read the scrcpy version');
  const server = process.env.SCRCPY_SERVER_PATH || path.join(path.dirname(path.dirname(fs.realpathSync(bin))), 'share', 'scrcpy', 'scrcpy-server');
  if (!fs.existsSync(server)) throw new Error(`no scrcpy server at ${server}`);
  return { version, server };
}

// Connected devices as [{ serial, model }], from `adb devices -l`. Unauthorized and
// offline devices are left out.
async function devices(adb) {
  const out = await run(adb, ['devices', '-l'], 5000).catch(() => '');
  return out
    .split('\n')
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter(([serial, state]) => state === 'device' && validSerial(serial))
    .map(([serial, , ...props]) => {
      const model = props.find((p) => p.startsWith('model:'))?.slice(6).replace(/_/g, ' ');
      return { serial, model: model || serial };
    })
    .sort((a, b) => a.model.localeCompare(b.model) || a.serial.localeCompare(b.serial));
}

// The device's launchable apps as [{ name, package, system }], sorted by name, from
// the scrcpy server's list_apps (what `scrcpy --list-apps` prints): " * <name>
// <package>" for a system app, " - <name> <package>" for one the user installed.
// Reading the app names takes the device a few seconds.
async function apps({ adb, version, server }, serial) {
  const list = async () => {
    await run(adb, ['-s', serial, 'push', server, REMOTE_PATH], 30000);
    return run(adb, ['-s', serial, 'shell', `CLASSPATH=${REMOTE_PATH}`, 'app_process', '/', 'com.genymobile.scrcpy.Server', version, 'list_apps=true', 'log_level=info'], 60000);
  };
  // A mirror's server that exits removes the pushed server, so a listing that starts
  // just then finds nothing to run; push it again once.
  let out = await list();
  if (!out.includes('List of apps:')) out = await list();
  const found = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^ ([*-]) (.+?)\s+(\S+)\s*$/);
    if (m && validPackage(m[3])) found.push({ name: m[2], package: m[3], system: m[1] === '*' });
  }
  if (found.length === 0) throw new Error('could not list the apps');
  return found.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

// Control messages (client -> device), as scrcpy's app/src/control_msg.c writes them.
const TYPE = { keycode: 0, text: 1, touch: 2, scroll: 3, backOrScreenOn: 4, uhidCreate: 12, uhidInput: 13, uhidDestroy: 14, startApp: 16, resetVideo: 17, resizeDisplay: 21 };
const POINTER_FINGER = 0xfffffffffffffffen; // SC_POINTER_ID_GENERIC_FINGER
const u16fp = (f) => (f >= 1 ? 0xffff : Math.round(Math.max(0, f) * 0x10000));
const i16fp = (f) => (f >= 1 ? 0x7fff : Math.round(Math.max(-1, f) * 0x8000));

// msg: { type: 'touch', action, x, y, width, height, pressure }
//    | { type: 'scroll', x, y, width, height, h, v }   (h and v in [-16, 16])
//    | { type: 'keycode', action, keycode, metastate }
//    | { type: 'text', text } | { type: 'backOrScreenOn', action } | { type: 'resetVideo' }
//    | { type: 'resizeDisplay', width, height }   (a flex display's new size)
//    | { type: 'startApp', package }   (on the display the pane shows)
//    | { type: 'uhidCreate', id, desc } | { type: 'uhidInput', id, data } | { type: 'uhidDestroy', id }
// x, y are in video pixels; width, height the video size they refer to.
function encode(msg) {
  const position = (buf, at) => {
    buf.writeInt32BE(Math.round(msg.x), at);
    buf.writeInt32BE(Math.round(msg.y), at + 4);
    buf.writeUInt16BE(msg.width, at + 8);
    buf.writeUInt16BE(msg.height, at + 10);
  };
  switch (msg?.type) {
    case 'touch': {
      const buf = Buffer.alloc(32);
      buf[0] = TYPE.touch;
      buf[1] = msg.action; // AMOTION_EVENT_ACTION_DOWN 0, UP 1, MOVE 2
      buf.writeBigUInt64BE(POINTER_FINGER, 2);
      position(buf, 10);
      buf.writeUInt16BE(u16fp(msg.pressure), 22);
      return buf; // action button and buttons stay 0: a finger, not a mouse
    }
    case 'scroll': {
      const buf = Buffer.alloc(21);
      buf[0] = TYPE.scroll;
      position(buf, 1);
      buf.writeInt16BE(i16fp(msg.h / 16), 13);
      buf.writeInt16BE(i16fp(msg.v / 16), 15);
      return buf;
    }
    case 'keycode': {
      const buf = Buffer.alloc(14);
      buf[0] = TYPE.keycode;
      buf[1] = msg.action; // AKEY_EVENT_ACTION_DOWN 0, UP 1
      buf.writeUInt32BE(msg.keycode, 2);
      buf.writeUInt32BE(msg.metastate >>> 0, 10);
      return buf;
    }
    case 'text': {
      const text = Buffer.from(String(msg.text)).subarray(0, 300);
      const buf = Buffer.alloc(5 + text.length);
      buf[0] = TYPE.text;
      buf.writeUInt32BE(text.length, 1);
      text.copy(buf, 5);
      return buf;
    }
    case 'backOrScreenOn':
      return Buffer.from([TYPE.backOrScreenOn, msg.action]);
    case 'resetVideo':
      return Buffer.from([TYPE.resetVideo]);
    case 'startApp': {
      if (!validPackage(msg.package)) throw new Error('bad package name');
      return Buffer.concat([Buffer.from([TYPE.startApp, msg.package.length]), Buffer.from(msg.package)]);
    }
    case 'uhidCreate': {
      // id, vendor and product ids (0), an empty name (the server says "scrcpy"),
      // then the report descriptor.
      const buf = Buffer.alloc(10 + msg.desc.length);
      buf[0] = TYPE.uhidCreate;
      buf.writeUInt16BE(msg.id, 1);
      buf.writeUInt16BE(msg.desc.length, 8);
      Buffer.from(msg.desc).copy(buf, 10);
      return buf;
    }
    case 'uhidInput': {
      const buf = Buffer.alloc(5 + msg.data.length);
      buf[0] = TYPE.uhidInput;
      buf.writeUInt16BE(msg.id, 1);
      buf.writeUInt16BE(msg.data.length, 3);
      Buffer.from(msg.data).copy(buf, 5);
      return buf;
    }
    case 'uhidDestroy': {
      const buf = Buffer.alloc(3);
      buf[0] = TYPE.uhidDestroy;
      buf.writeUInt16BE(msg.id, 1);
      return buf;
    }
    case 'resizeDisplay': {
      const buf = Buffer.alloc(5);
      buf[0] = TYPE.resizeDisplay;
      buf.writeUInt16BE(msg.width, 1);
      buf.writeUInt16BE(msg.height, 3);
      return buf;
    }
    default:
      throw new Error('unknown control message');
  }
}

// A captured pane's mouse and keyboard reach the device as a USB mouse and keyboard
// (scrcpy's --mouse=uhid and --keyboard=uhid): the cursor shows on the device, and
// every key, shortcuts included, is a physical key press. The report descriptors and
// reports are those of scrcpy's app/src/hid/hid_keyboard.c and hid_mouse.c.
const HID_KEYBOARD = 1;
const HID_MOUSE = 2;
const HID_KEYBOARD_DESC = [
  0x05, 0x01, 0x09, 0x06, 0xa1, 0x01, // Generic Desktop, Keyboard, Application
  0x05, 0x07, 0x19, 0xe0, 0x29, 0xe7, 0x15, 0x00, 0x25, 0x01, 0x75, 0x01, 0x95, 0x08, 0x81, 0x02, // 8 modifier bits
  0x75, 0x08, 0x95, 0x01, 0x81, 0x01, // reserved byte
  0x05, 0x08, 0x19, 0x01, 0x29, 0x05, 0x75, 0x01, 0x95, 0x05, 0x91, 0x02, 0x75, 0x03, 0x95, 0x01, 0x91, 0x01, // LEDs
  0x05, 0x07, 0x19, 0x00, 0x29, 0x65, 0x15, 0x00, 0x25, 0x65, 0x75, 0x08, 0x95, 0x06, 0x81, 0x00, // 6 keys
  0xc0,
];
const HID_MOUSE_DESC = [
  0x05, 0x01, 0x09, 0x02, 0xa1, 0x01, 0x09, 0x01, 0xa1, 0x00, // Mouse, Pointer
  0x05, 0x09, 0x19, 0x01, 0x29, 0x05, 0x15, 0x00, 0x25, 0x01, 0x95, 0x05, 0x75, 0x01, 0x81, 0x02, // 5 buttons
  0x95, 0x01, 0x75, 0x03, 0x81, 0x01, // padding
  0x05, 0x01, 0x09, 0x30, 0x09, 0x31, 0x09, 0x38, 0x15, 0x81, 0x25, 0x7f, 0x75, 0x08, 0x95, 0x03, 0x81, 0x06, // x, y, wheel
  0x05, 0x0c, 0x0a, 0x38, 0x02, 0x15, 0x81, 0x25, 0x7f, 0x75, 0x08, 0x95, 0x01, 0x81, 0x06, // horizontal wheel
  0xc0, 0xc0,
];

// KeyboardEvent.code -> HID usage (HID Usage Tables, Keyboard page). Modifiers are
// 0xe0..0xe7 and go in the report's first byte.
const HID_USAGE = (() => {
  const map = {};
  for (let i = 0; i < 26; i++) map[`Key${String.fromCharCode(65 + i)}`] = 0x04 + i;
  for (let i = 1; i <= 9; i++) map[`Digit${i}`] = 0x1d + i;
  map.Digit0 = 0x27;
  for (let i = 1; i <= 12; i++) map[`F${i}`] = 0x39 + i;
  for (let i = 1; i <= 9; i++) map[`Numpad${i}`] = 0x58 + i;
  map.Numpad0 = 0x62;
  const named = [
    ['Enter', 0x28], ['Escape', 0x29], ['Backspace', 0x2a], ['Tab', 0x2b], ['Space', 0x2c], ['Minus', 0x2d],
    ['Equal', 0x2e], ['BracketLeft', 0x2f], ['BracketRight', 0x30], ['Backslash', 0x31], ['Semicolon', 0x33],
    ['Quote', 0x34], ['Backquote', 0x35], ['Comma', 0x36], ['Period', 0x37], ['Slash', 0x38], ['CapsLock', 0x39],
    ['PrintScreen', 0x46], ['ScrollLock', 0x47], ['Pause', 0x48], ['Insert', 0x49], ['Home', 0x4a], ['PageUp', 0x4b],
    ['Delete', 0x4c], ['End', 0x4d], ['PageDown', 0x4e], ['ArrowRight', 0x4f], ['ArrowLeft', 0x50],
    ['ArrowDown', 0x51], ['ArrowUp', 0x52], ['NumLock', 0x53], ['NumpadDivide', 0x54], ['NumpadMultiply', 0x55],
    ['NumpadSubtract', 0x56], ['NumpadAdd', 0x57], ['NumpadEnter', 0x58], ['NumpadDecimal', 0x63],
    ['IntlBackslash', 0x64], ['ContextMenu', 0x65],
    ['ControlLeft', 0xe0], ['ShiftLeft', 0xe1], ['AltLeft', 0xe2], ['MetaLeft', 0xe3],
    ['ControlRight', 0xe4], ['ShiftRight', 0xe5], ['AltRight', 0xe6], ['MetaRight', 0xe7],
  ];
  for (const [code, usage] of named) map[code] = usage;
  return map;
})();

// Resolves with the socket once the server answers on it. On a forward tunnel adb
// accepts the connection even before the server listens, then drops it; the server
// sends a dummy byte on the first socket so a real connection can be told apart.
function connect(port, deadline, cancelled) {
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect(port, '127.0.0.1');
      const retry = () => {
        socket.destroy();
        if (cancelled()) reject(new Error('stopped'));
        else if (Date.now() > deadline) reject(new Error('the scrcpy server did not answer'));
        else setTimeout(attempt, 100);
      };
      socket.once('error', retry);
      socket.once('close', retry);
      socket.once('data', (chunk) => {
        socket.removeListener('error', retry);
        socket.removeListener('close', retry);
        socket.pause();
        socket.unshift(chunk.subarray(1)); // past the dummy byte
        resolve(socket);
      });
    };
    attempt();
  });
}

// One device's screen, or with options.display a new virtual display on it (see
// validDisplay), and with options.audio its sound (options.audioDup keeps it playing
// on the device too); options.fitSize is a flex display's first size, options.keepApps
// moves the apps on a new display to the main screen when it closes, and
// options.imePolicy is 'local', 'fallback' or 'hide' (where the keyboard shows).
// Emits 'name' (device name), 'session' ({ width, height },
// again on every rotation), 'packet' ({ config, key, data }) and once 'end' (an
// Error, or null after stop()). With audio it also emits 'audio' ({ config, data },
// Opus packets, the first one the OpusHead) and 'audio-off' (a reason) if the device
// does not send its sound. A failed start() ends it too, so 'end' is the one
// place to learn that it stopped.
class Mirror extends EventEmitter {
  constructor({ adb, version, server }, serial, options = {}) {
    super();
    this.options = options;
    this.adb = adb;
    this.version = version;
    this.server = server;
    this.serial = serial;
    this.proc = null;
    this.video = null;
    this.audio = null;
    this.control = null;
    this.port = null;
    this.ended = false;
    this.hid = null; // the captured mouse and keyboard's state, while captured
    this.sdk = 0; // the device's Android API level
  }

  // Before Android 15 a USB mouse moves the pointer on the device's own screen only,
  // so a new display captures just the keyboard (as scrcpy, which can tie the mouse
  // to a new display only from Android 15 on).
  get capturesMouse() {
    return !validDisplay(this.options.display) || this.sdk >= 35;
  }

  start() {
    this.#start().catch((err) => this.#end(err));
  }

  async #start() {
    const adb = (...args) => run(this.adb, ['-s', this.serial, ...args], 30000);
    await adb('push', this.server, REMOTE_PATH);
    this.sdk = Number((await adb('shell', 'getprop', 'ro.build.version.sdk')).trim()) || 0;
    const scid = Math.floor(Math.random() * 0x7fffffff).toString(16).padStart(8, '0');
    this.port = Number((await adb('forward', 'tcp:0', `localabstract:scrcpy_${scid}`)).trim());
    if (this.ended) return this.#cleanup();

    this.proc = spawn(this.adb, [
      '-s', this.serial, 'shell', `CLASSPATH=${REMOTE_PATH}`, 'app_process', '/', 'com.genymobile.scrcpy.Server', this.version,
      `scid=${scid}`, 'log_level=info', 'tunnel_forward=true', 'video_codec=h264',
      ...(this.options.audio ? ['audio_codec=opus'] : ['audio=false']),
      ...(this.options.audio && this.options.audioDup ? ['audio_source=playback', 'audio_dup=true'] : []),
      ...this.#displayArgs(),
    ]);
    // The last line the server printed explains why it stopped.
    let last = '';
    const log = (data) => {
      const lines = String(data).split('\n').map((l) => l.trim()).filter(Boolean);
      if (lines.length) last = lines[lines.length - 1].replace(/^\[server\] /, '');
    };
    this.proc.stdout.on('data', log);
    this.proc.stderr.on('data', log);
    this.proc.on('exit', () => this.#end(new Error(last || 'the scrcpy server stopped')));

    // The video socket first, then the audio socket, then the control socket.
    this.video = await connect(this.port, Date.now() + 10000, () => this.ended);
    if (this.options.audio) {
      this.audio = net.connect(this.port, '127.0.0.1');
      this.audio.on('error', () => {});
    }
    this.control = net.connect(this.port, '127.0.0.1');
    this.control.on('error', () => {});
    this.control.on('data', () => {}); // device messages (clipboard, ...) are not used
    this.video.on('error', () => {});
    this.video.on('close', () => this.#end(new Error('the video stream ended')));
    if (this.ended) return this.#cleanup();
    this.#read(this.video, {
      name: true,
      codec: (codec) => codec === 'h264' || this.#end(new Error(`unexpected video codec ${codec}`)),
      session: (size) => this.emit('session', size),
      packet: (packet) => this.emit('packet', packet),
    });
    this.video.resume();
    // Sound is extra: without it (Android 10 or older, or another capture holding it)
    // the screen still mirrors.
    if (this.audio) {
      this.#read(this.audio, {
        codec: (codec) => {
          if (codec === 'opus') return true;
          this.emit('audio-off', codec === '\0\0\0\0' ? 'the device does not share its sound' : 'the device could not capture its sound');
          return false;
        },
        packet: ({ config, data }) => this.emit('audio', { config, data }),
      });
    }
  }

  #displayArgs() {
    const { display, fitSize, keepApps, imePolicy } = this.options;
    if (!validDisplay(display)) return [];
    const args = [];
    if (isFit(display)) {
      args.push(`new_display=${fitSize ? `${fitSize.width}x${fitSize.height}` : ''}${display.slice(3)}`, 'flex_display=true');
    } else {
      args.push(`new_display=${display}`);
    }
    if (keepApps) args.push('vd_destroy_content=false');
    if (['local', 'fallback', 'hide'].includes(imePolicy)) args.push(`display_ime_policy=${imePolicy}`);
    return args;
  }

  // The device name (on the first socket only), the codec id ("h264", "opus", or 0
  // for a stream the device turned off and 1 for one that failed), then session
  // packets (video only) and media packets (scrcpy's doc/develop.md). codec returns
  // whether to go on reading.
  #read(socket, { name = false, codec, session, packet }) {
    let buf = Buffer.alloc(0);
    let stage = name ? 'name' : 'codec';
    socket.on('data', (chunk) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      for (;;) {
        if (stage === 'name') {
          if (buf.length < DEVICE_NAME_LENGTH) return;
          this.emit('name', buf.subarray(0, DEVICE_NAME_LENGTH).toString('utf8').replace(/\0[\s\S]*$/, ''));
          buf = buf.subarray(DEVICE_NAME_LENGTH);
          stage = 'codec';
        } else if (stage === 'codec') {
          if (buf.length < 4) return;
          if (!codec(buf.subarray(0, 4).toString('latin1'))) {
            stage = 'off';
            return;
          }
          buf = buf.subarray(4);
          stage = 'packets';
        } else if (stage === 'off') {
          return;
        } else {
          if (buf.length < HEADER) return;
          if (buf[0] & 0x80) {
            session?.({ width: buf.readUInt32BE(4), height: buf.readUInt32BE(8) });
            buf = buf.subarray(HEADER);
            continue;
          }
          const size = buf.readUInt32BE(8);
          if (buf.length < HEADER + size) return;
          const flags = buf[0];
          // A copy, so the packet does not keep the whole read buffer alive.
          const data = Buffer.from(buf.subarray(HEADER, HEADER + size));
          packet({ config: Boolean(flags & 0x40), key: Boolean(flags & 0x20), data });
          buf = buf.subarray(HEADER + size);
        }
      }
    });
  }

  send(msg) {
    if (this.control && !this.control.destroyed) this.control.write(encode(msg));
  }

  // Captures (adds a USB keyboard to the device, and a mouse if capturesMouse) or
  // releases (lets go of every key and button, and removes them, so the on-screen
  // keyboard comes back).
  capture(on) {
    if (on && !this.hid) {
      const mouse = this.capturesMouse;
      this.send({ type: 'uhidCreate', id: HID_KEYBOARD, desc: HID_KEYBOARD_DESC });
      if (mouse) this.send({ type: 'uhidCreate', id: HID_MOUSE, desc: HID_MOUSE_DESC });
      this.hid = { mouse, keys: new Set(), mods: 0, buttons: 0, wheel: 0, hwheel: 0 };
    } else if (!on && this.hid) {
      this.send({ type: 'uhidInput', id: HID_KEYBOARD, data: new Array(8).fill(0) });
      this.send({ type: 'uhidDestroy', id: HID_KEYBOARD });
      if (this.hid.mouse) {
        this.send({ type: 'uhidInput', id: HID_MOUSE, data: new Array(5).fill(0) });
        this.send({ type: 'uhidDestroy', id: HID_MOUSE });
      }
      this.hid = null;
    }
  }

  // A key (KeyboardEvent.code) going down or up on the captured keyboard.
  hidKey(code, down) {
    const usage = HID_USAGE[code];
    if (!this.hid || usage === undefined) return;
    if (usage >= 0xe0) {
      const bit = 1 << (usage - 0xe0);
      this.hid.mods = down ? this.hid.mods | bit : this.hid.mods & ~bit;
    } else if (down) {
      this.hid.keys.add(usage);
    } else {
      this.hid.keys.delete(usage);
    }
    // More than 6 keys at once reports the rollover error, as a real keyboard does.
    const keys = [...this.hid.keys];
    const slots = keys.length > 6 ? new Array(6).fill(1) : [...keys, 0, 0, 0, 0, 0, 0].slice(0, 6);
    this.send({ type: 'uhidInput', id: HID_KEYBOARD, data: [this.hid.mods, 0, ...slots] });
  }

  // The captured mouse: buttons as MouseEvent.buttons (whose bits match HID's),
  // movement in pixels, wheel and hwheel in notches (up and right are positive).
  hidMouse({ buttons = this.hid?.buttons ?? 0, dx = 0, dy = 0, wheel = 0, hwheel = 0 }) {
    if (!this.hid?.mouse) return;
    this.hid.buttons = buttons & 0x1f;
    // Fractions of a notch add up until they make a whole one.
    this.hid.wheel += wheel;
    this.hid.hwheel += hwheel;
    const notch = (v) => Math.trunc(Math.max(-127, Math.min(127, v)));
    const v = notch(this.hid.wheel);
    const h = notch(this.hid.hwheel);
    this.hid.wheel -= v;
    this.hid.hwheel -= h;
    // A report moves at most 127 pixels each way; longer moves take several.
    let x = Math.round(dx);
    let y = Math.round(dy);
    let first = true;
    while (first || x || y) {
      const sx = Math.max(-127, Math.min(127, x));
      const sy = Math.max(-127, Math.min(127, y));
      const data = [this.hid.buttons, sx & 0xff, sy & 0xff, first ? v & 0xff : 0, first ? h & 0xff : 0];
      this.send({ type: 'uhidInput', id: HID_MOUSE, data });
      x -= sx;
      y -= sy;
      first = false;
    }
  }

  stop() {
    this.#end(null);
  }

  #end(err) {
    if (this.ended) return;
    this.ended = true;
    this.#cleanup();
    this.emit('end', err);
  }

  // Closing the sockets stops the server on the device.
  #cleanup() {
    this.video?.destroy();
    this.audio?.destroy();
    this.control?.destroy();
    if (this.proc && this.proc.exitCode === null) this.proc.kill();
    if (this.port) run(this.adb, ['-s', this.serial, 'forward', '--remove', `tcp:${this.port}`]).catch(() => {});
    this.port = null;
  }
}

module.exports = { validSerial, validDisplay, isFit, validPackage, findAdb, findScrcpy, devices, apps, encode, Mirror };
