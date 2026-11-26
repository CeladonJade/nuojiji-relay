// Cloudflare Workers 入口（已内置 NapCat 内部直通转换插头）
import { createApp } from './src/app.js';
import { runProactiveTick, shouldRunTickNow } from './src/proactive/tick.js';
import { runMomentsTick } from './src/moments/momentsTick.js';
import { runJobsTick } from './src/jobs/jobsTick.js';

export { WechatBridge } from './src/wechat/wechatDO.js';

const app = createApp();

const hexOf = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const bytesOfHex = (hex) => {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return out;
};
const utf8 = (s) => new TextEncoder().encode(s);
const concat = (a, b) => {
    const o = new Uint8Array(a.length + b.length);
    o.set(a, 0);
    o.set(b, a.length);
    return o;
};
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
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        // 接收手机 NapCat HTTP 客户端上报 (/napcat 或 /onebot 均兼容)
        if ((url.pathname === '/napcat' || url.pathname === '/onebot') && request.method === 'POST') {
            const event = await request.json().catch(() => ({}));
            if (event.post_type !== 'message' || event.message_type !== 'private') {
                return Response.json({});
            }
            const officialPayload = JSON.stringify({
                id: String(event.message_id || Date.now()),
                op: 0,
                t: 'C2C_MESSAGE_CREATE',
                d: {
                    id: String(event.message_id || Date.now()),
                    content: String(event.raw_message || '').trim(),
                    timestamp: new Date((event.time || Date.now() / 1000) * 1000).toISOString(),
                    author: { id: String(event.user_id), user_openid: String(event.user_id) },
                    attachments: []
                }
            });
            const secret = env.QQ_BOT_SECRET || env.QQ_APP_SECRET || env.BOT_SECRET || '';
            const ts = String(Math.floor(Date.now() / 1000));
            const sig = await signEd25519(secret, ts + officialPayload);

            // 内部直递给糯叽叽 /qq/webhook，绕开 Cloudflare 同域名外网拦截
            const internalUrl = new URL('/qq/webhook', request.url).toString();
            const webhookReq = new Request(internalUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Signature-Timestamp': ts,
                    'X-Signature-Ed25519': sig
                },
                body: officialPayload
            });
            ctx.waitUntil(app.fetch(webhookReq, env, ctx));
            return Response.json({});
        }

        return app.fetch(request, env, ctx);
    },

    async scheduled(event, env, ctx) {
        ctx.waitUntil((async () => {
            if (!(await shouldRunTickNow(env, event?.scheduledTime))) return;
            await runProactiveTick(env);
        })().catch((e) => console.error('[scheduled] proactive tick failed:', e?.message)));
        ctx.waitUntil((async () => {
            if (!(await shouldRunTickNow(env, event?.scheduledTime))) return;
            await runMomentsTick(env);
        })().catch((e) => console.error('[scheduled] moments tick failed:', e?.message)));
        ctx.waitUntil((async () => {
            if (!(await shouldRunTickNow(env, event?.scheduledTime))) return;
            await runJobsTick(env);
        })().catch((e) => console.error('[scheduled] jobs tick failed:', e?.message)));
    },
};