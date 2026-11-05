/* The OpenDrop over Web Serial (Chrome and Edge on a computer): picking the port, opening it at the
 * original's 115200 baud, reading and writing, and finding the same device again when the page
 * opens or it is plugged back in. A port is a transport for device.js. */
(function (root) {
  'use strict';

  const { BAUD } = root.OD.device;
  const supported = () => Boolean(root.navigator && root.navigator.serial);

  class SerialTransport {
    constructor(port) {
      this.port = port;
      this.reader = null;
      this.writer = null;
      this.reading = null;
      this.closing = false;
      this.onData = null;
      this.onClose = null;
    }

    async open() {
      await this.port.open({ baudRate: BAUD });
      this.writer = this.port.writable.getWriter();
      this.reading = this.readLoop();
    }

    // Reads until the port is closed. A read error gives a new stream unless the device is gone;
    // then onClose says so (not when the page closed it).
    async readLoop() {
      while (this.port.readable && !this.closing) {
        const reader = this.port.readable.getReader();
        this.reader = reader;
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value && value.length && this.onData) this.onData(value);
          }
        } catch {
          // a read error: carry on with the next stream, if there is one
        } finally {
          reader.releaseLock();
          this.reader = null;
        }
      }
      if (!this.closing && this.onClose) this.onClose();
    }

    write(bytes) {
      if (!this.writer) return Promise.reject(new Error('the port is not open'));
      return this.writer.write(bytes);
    }

    async close() {
      this.closing = true;
      try {
        if (this.reader) await this.reader.cancel();
      } catch {
        // already cancelled
      }
      try {
        await this.reading;
      } catch {
        // the read loop ended
      }
      try {
        if (this.writer) this.writer.releaseLock();
      } catch {
        // already released
      }
      try {
        await this.port.close();
      } catch {
        // already closed, or the device is gone
      }
    }
  }

  const infoOf = (port) => {
    const i = port && port.getInfo ? port.getInfo() : {};
    return { usbVendorId: i.usbVendorId, usbProductId: i.usbProductId };
  };
  const sameInfo = (a, b) => Boolean(a && b) && a.usbVendorId !== undefined && a.usbVendorId === b.usbVendorId && a.usbProductId === b.usbProductId;
  const hex = (n) => n.toString(16).padStart(4, '0');

  // How a port is named in the Device tab: its USB vendor and product IDs.
  function label(port) {
    const i = infoOf(port);
    return i.usbVendorId === undefined ? 'a serial port' : `USB ${hex(i.usbVendorId)}:${hex(i.usbProductId)}`;
  }

  // The browser's port picker (only from a click). Null if it was closed without a choice.
  async function pick() {
    try {
      return await root.navigator.serial.requestPort();
    } catch (err) {
      if (err && err.name === 'NotFoundError') return null;
      throw err;
    }
  }

  // A port this page may already use: the remembered one, or the only one if none is remembered.
  async function remembered(info) {
    if (!supported()) return null;
    const ports = await root.navigator.serial.getPorts();
    return ports.find((p) => sameInfo(infoOf(p), info)) || (!info && ports.length === 1 ? ports[0] : null);
  }

  // Calls plugged(port) when a device this page may use is plugged in.
  function watch(plugged) {
    if (supported()) root.navigator.serial.addEventListener('connect', (evt) => plugged(evt.target));
  }

  // Opens a port as a transport. Errors get a sentence saying what to do.
  async function openPort(port) {
    const t = new SerialTransport(port);
    try {
      await t.open();
    } catch (err) {
      const busy = err && (err.name === 'NetworkError' || err.name === 'InvalidStateError');
      throw new Error(busy ? 'the port is in use by another program (close OpenDropController or a serial monitor)' : (err && err.message) || 'it could not be opened');
    }
    return t;
  }

  (root.OD = root.OD || {}).serial = { supported, SerialTransport, infoOf, sameInfo, label, pick, remembered, watch, openPort };
})(globalThis);
