// Preload that moves the process clock ~20 years ahead, to prove identity never
// reads wall-clock time.
const offset = 20 * 365 * 24 * 3600 * 1000;
const RealDate = Date;
const realNow = RealDate.now.bind(RealDate);
class SkewedDate extends RealDate {
  constructor(...args) { super(...(args.length ? args : [realNow() + offset])); }
  static now() { return realNow() + offset; }
}
globalThis.Date = SkewedDate;
