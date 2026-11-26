// NapCat (OneBot v11) <-> 糯叽叽 QQ官方API 转换插头 (Cloudflare Worker)

const hexOf = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const bytesOfHex = (hex) => {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
};
const utf8 = (s) => new TextEncoder().encode(s);
const concat = (a, b) => { const o = new Uint8Array(a.length + b.length); o.set(a, 0); o.set(b, a.length); return o; };
const PKCS8_PREFIX = bytesOfHex('302e020100300506032b657004220420');

function seedOf(secret) {
  let s = utf8(String(secret || ''));
  while (s.length < 32) s = concat(s, s);
  return s.slice(0, 32);
}

async function signEd25519(secret, message) {
  const priv = await crypto.subtle.importKey('pkcs8', concat(PKCS8_PREFIX, seedOf(secret)), { name: 'Ed25519' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'Ed25519' }, priv, utf8(message));
  return hexOf(new Uint8Array(sig));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 1. 伪装成 QQ 官方获取 Token 接口（供 qqApi.js 第 14 行调用）
    if (url.pathname === '/app/getAppAccessToken' && request.method === 'POST') {
      return Response.json({ access_token: 'napcat_bridge_token', expires_in: 7200 });
    }

    // 2. 拦截糯叽叽发出的 C2C 单聊回复，转成 OneBot /send_private_msg 发给 NapCat
    const msgMatch = url.pathname.match(/^\/v2\/users\/([^/]+)\/messages$/);
    if (msgMatch && request.method === 'POST') {
      const userId = msgMatch[1];
      const body = await request.json();
      const headers = { 'Content-Type': 'application/json' };
      if (env.NAPCAT_TOKEN) headers['Authorization'] = `Bearer ${env.NAPCAT_TOKEN}`;

      const messageChain = [];
      if (body.content) messageChain.push({ type: 'text', data: { text: body.content } });
      if (body.media?.file_info) messageChain.push({ type: 'image', data: { file: body.media.file_info } });

      const resp = await fetch(`${env.NAPCAT_HTTP_URL.replace(/\/$/, '')}/send_private_msg`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ user_id: Number(userId) || userId, message: messageChain })
      });
      const resData = await resp.json().catch(() => ({}));
      return Response.json({ id: String(resData?.data?.message_id || Date.now()), code: 0 });
    }

    // 3. 伪装富媒体上传接口，直接把图片/语音 URL 透传进 file_info
    const fileMatch = url.pathname.match(/^\/v2\/users\/([^/]+)\/files$/);
    if (fileMatch && request.method === 'POST') {
      const body = await request.json();
      return Response.json({ file_info: body.url || '', ttl: 3600, code: 0 });
    }

    // 4. 接收 NapCat (OneBot 11 HTTP POST) 上报的私聊消息，签名后转发给糯叽叽中继
    if (url.pathname === '/onebot' && request.method === 'POST') {
      const event = await request.json();
      if (event.post_type !== 'message' || event.message_type !== 'private') {
        return Response.json({ status: 'ignored' });
      }
      const officialPayload = JSON.stringify({
        id: String(event.message_id || Date.now()),
        op: 0,
        t: 'C2C_MESSAGE_CREATE',
        d: {
          id: String(event.message_id || Date.now()),
          content: String(event.raw_message || ''),
          timestamp: new Date((event.time || Date.now() / 1000) * 1000).toISOString(),
          author: { id: String(event.user_id), user_openid: String(event.user_id) },
          attachments: []
        }
      });
      const ts = String(Math.floor(Date.now() / 1000));
      const sig = await signEd25519(env.BOT_SECRET, ts + officialPayload);
      await fetch(env.NUOJIJI_WEBHOOK_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Signature-Timestamp': ts,
          'X-Signature-Ed25519': sig
        },
        body: officialPayload
      });
      return Response.json({ status: 'ok' });
    }

    return new Response('NapCat Bridge Worker Running', { status: 200 });
  }
};