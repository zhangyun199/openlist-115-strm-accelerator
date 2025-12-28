export class Logger {
  constructor(debug = false) {
    this.debug = !!debug;
  }

  // 生成本地时间：YYYY-MM-DD HH:mm:ss.SSS
  ts() {
    const d = new Date();
    const pad = (n, w = 2) => String(n).padStart(w, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
           `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.` +
           `${pad(d.getMilliseconds(), 3)}`;
  }

  fmt(level, msg) {
    return `[${this.ts()}] [${level}] ${msg}`;
  }

  log(msg) {
    if (!this.debug) return;
    console.log(this.fmt('DEBUG', msg));
  }

  info(msg) {
    console.log(this.fmt('INFO', msg));
  }

  warn(msg) {
    console.warn(this.fmt('WARN', msg));
  }

  error(msg, err) {
    if (err) console.error(this.fmt('ERROR', msg), err);
    else console.error(this.fmt('ERROR', msg));
  }
}
