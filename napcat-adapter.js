// NapCat (OneBot v11) ⇄ 糯叽叽 QQ官方API 转换插头 (Cloudflare Worker)

const hexOf = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const bytesOfHex = (hex) => {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
};
const utf8 = (s) => new TextEncoder().encode(s);
const concat = (a, b) => { const o = new Uint8Array(a.length + b.length); o.set(a, 0); o.set(b, a.length); return o; };
const PKCS8_PREFIX = bytesOfHex('302e020100300506032b657004220420');

// 手机本地无公网IP时的回复暂存队列（通过OneBot快速操作直接带回）
const pendingReplies = new Map();

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

    // 1. 伪装成 QQ 官方获取 Token 接口（供 qqApi.js 调用）
    if (url.pathname === '/app/getAppAccessToken' && request.method === 'POST') {
      return Response.json({ access_token: 'napcat_bridge_token', expires_in: 7200 });
    }

    // 2. 拦截糯叽叽发出的 C2C 单聊回复
    const msgMatch = url.pathname.match(/^\/v2\/users\/([^/]+)\/messages$/);
    if (msgMatch && request.method === 'POST') {
      const userId = String(msgMatch[1]);
      const body = await request.json().catch(() => ({}));

      if (env.NAPCAT_HTTP_URL) {
        const headers = { 'Content-Type': 'application/json' };
        if (env.NAPCAT_TOKEN) headers['Authorization'] = `Bearer ${env.NAPCAT_TOKEN}`;
        const messageChain = [];
        if (body.content) messageChain.push({ type: 'text', data: { text: body.content } });
        if (body.media?.file_info) messageChain.push({ type: 'image', data: { file: body.media.file_info } });

        const resp = await fetch(`${env.NAPCAT_HTTP_URL.replace(/\/$/, '')}/send_private_msg`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ user_id: Number(userId) || userId, message: messageChain })
        }).catch(() => null);
        const resData = resp ? await resp.json().catch(() => ({})) : {};
        return Response.json({ id: String(resData?.data?.message_id || Date.now()), code: 0 });
      }

      // 手机本地模式：暂存回复内容，由上报接口直接带回给 NapCat
      const list = pendingReplies.get(userId) || [];
      if (body.content) list.push(String(body.content));
      if (body.media?.file_info) list.push(`[CQ:image,file=${body.media.file_info}]`);
      pendingReplies.set(userId, list);
      return Response.json({ id: String(Date.now()), code: 0 });
    }

    // 3. 伪装富媒体上传接口，直接把图片/语音 URL 透传进 file_info
    const fileMatch = url.pathname.match(/^\/v2\/users\/([^/]+)\/files$/);
    if (fileMatch && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      return Response.json({ file_info: body.url || '', ttl: 3600, code: 0 });
    }

    // 4. 接收 NapCat (OneBot 11 HTTP POST) 上报的私聊消息（兼容 /napcat 与 /onebot）
    if ((url.pathname === '/napcat' || url.pathname === '/onebot') && request.method === 'POST') {
      const event = await request.json().catch(() => ({}));
      if (event.post_type !== 'message' || event.message_type !== 'private') {
        return Response.json({});
      }
      const userId = String(event.user_id || '');
      const officialPayload = JSON.stringify({
        id: String(event.message_id || Date.now()),
        op: 0,
        t: 'C2C_MESSAGE_CREATE',
        d: {
          id: String(event.message_id || Date.now()),
          content: String(event.raw_message || ''),
          timestamp: new Date((event.time || Date.now() / 1000) * 1000).toISOString(),
          author: { id: userId, user_openid: userId },
          attachments: []
        }
      });
      const secret = env.QQ_BOT_SECRET || env.QQ_APP_SECRET || env.BOT_SECRET || '';
      const webhookUrl = env.RELAY_WEBHOOK_URL || env.NUOJIJI_WEBHOOK_URL || `${url.origin}/qq/webhook`;
      const ts = String(Math.floor(Date.now() / 1000));
      const sig = await signEd25519(secret, ts + officialPayload);

      pendingReplies.delete(userId);
      await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Signature-Timestamp': ts,
          'X-Signature-Ed25519': sig
        },
        body: officialPayload
      }).catch(() => null);

      const replies = pendingReplies.get(userId);
      if (replies && replies.length > 0) {
        pendingReplies.delete(userId);
        return Response.json({ reply: replies.join('\n'), auto_escape: false });
      }
      return Response.json({});
    }

    return Response.json({ status: 'ok', message: 'NapCat Bridge Worker Running' });
  }
};