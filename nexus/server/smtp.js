'use strict';
/**
 * 极简 SMTP 客户端 —— 仅使用 Node 内置模块，零第三方依赖。
 * 用于把用户的功能建议直接发送到指定邮箱。
 * 支持 SSL(465，默认) 与 STARTTLS(587) 两种常见发信方式。
 */
const net = require('node:net');
const tls = require('node:tls');

const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');

function wrapBase64(text, width = 76) {
  const raw = b64(text);
  return raw.match(new RegExp(`.{1,${width}}`, 'g')) || [''];
}

/**
 * @param {object} opt { host, port, secure, user, pass, from, to, subject, text }
 * @param {number} timeoutMs
 */
function sendMail(opt, timeoutMs = 20000) {
  const host = opt.host || 'smtp.sina.com';
  const port = Number(opt.port) || (opt.secure === false ? 587 : 465);
  const secure = opt.secure !== false; // 默认 SSL 直连 465
  const user = opt.user;
  const pass = opt.pass;
  const from = opt.from || user;
  const to = opt.to;

  return new Promise((resolve, reject) => {
    let socket = null;
    let settled = false;
    let buf = '';
    let waiter = null;
    const timer = setTimeout(() => finish(new Error('SMTP 连接超时')), timeoutMs);

    function finish(err, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket && socket.destroy(); } catch { /* ignore */ }
      err ? reject(err) : resolve(value);
    }

    function onLine(line) {
      const lines = waiter ? waiter.lines : [];
      lines.push(line);
      const code = parseInt(line.slice(0, 3), 10);
      const isLast = line[3] !== '-'; // 以 "250-" 开头表示多行未结束
      if (!isLast) { if (waiter) waiter.lines = lines; return; }
      const w = waiter;
      waiter = null;
      if (!w) return;
      if (w.codes && !w.codes.includes(code)) {
        return finish(new Error(`SMTP ${w.label || '命令'} 失败 (${code}): ${lines.join(' | ')}`));
      }
      w.resolve({ code, lines });
    }

    function feed(chunk) {
      buf += chunk.toString('utf8');
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        onLine(line);
      }
    }

    function send(cmd, codes, label) {
      return new Promise((resolve, reject) => {
        waiter = { codes, label, resolve, reject, lines: [] };
        if (cmd !== null) socket.write(cmd + '\r\n', 'utf8');
      });
    }

    function attach(sock) {
      socket = sock;
      socket.setEncoding('utf8');
      socket.on('data', feed);
      socket.on('error', (e) => finish(e));
      socket.on('close', () => { if (!settled) finish(new Error('SMTP 连接被关闭')); });
    }

    function buildMessage() {
      const subject = `=?UTF-8?B?${b64(opt.subject || 'NEXUS 用户反馈')}?=`;
      const body = wrapBase64(opt.text || '').join('\r\n');
      const head = [
        `From: =?UTF-8?B?${b64('NEXUS 用户反馈')}?= <${from}>`,
        `To: ${to}`,
        `Subject: ${subject}`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=UTF-8',
        'Content-Transfer-Encoding: base64',
        '',
        ''
      ].join('\r\n');
      return head + body + '\r\n.\r\n';
    }

    async function dialogue() {
      await send(null, [220], '连接');
      await send('EHLO nexus.local', [250], 'EHLO');
      if (!secure) {
        await send('STARTTLS', [220], 'STARTTLS');
        await new Promise((resolve) => {
          const plain = socket;
          plain.removeAllListeners('data');
          const tlsSock = tls.connect({ socket: plain, servername: host }, () => resolve());
          attach(tlsSock);
        });
        await send('EHLO nexus.local', [250], 'EHLO(TLS)');
      }
      if (user && pass) {
        await send('AUTH LOGIN', [334], 'AUTH');
        await send(b64(user), [334], '用户名');
        await send(b64(pass), [235], '密码');
      }
      await send(`MAIL FROM:<${from}>`, [250], 'MAIL FROM');
      await send(`RCPT TO:<${to}>`, [250, 251], 'RCPT TO');
      await send('DATA', [354], 'DATA');
      socket.write(buildMessage(), 'utf8');
      await send(null, [250], '提交邮件');
      await send('QUIT', [221], 'QUIT');
      finish(null, { ok: true });
    }

    try {
      if (secure) attach(tls.connect({ host, port, servername: host }));
      else attach(net.connect({ host, port }));
      dialogue().catch((e) => finish(e));
    } catch (e) {
      finish(e);
    }
  });
}

module.exports = { sendMail };
