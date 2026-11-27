// QQ 桥接（支持 QQ 官方机器人 + NapCat / OneBot v11 HTTP 与反向 WebSocket 直连单聊）
import { ImessageBridgeCore } from '../imessage/imessageCore.js';
import { now } from '../chatbridge/baseCore.js';
import { bytesToB64 } from '../wechat/ilinkClient.js';
import {
    fetchAccessToken, qqCall, qqVerify, qqValidationReply, parseC2c, isPassiveExpired,
    FileType, PASSIVE_WINDOW_MS, PASSIVE_MAX,
} from './qqApi.js';

const randomToken = () => Array.from(crypto.getRandomValues(new Uint8Array(18)), (b) => b.toString(16).padStart(2, '0')).join('');
const randomCode = () => String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000));

function parseOneBot(body) {
    const openid = String(body?.user_id || body?.sender?.user_id || '');
    const id = String(body?.message_id || Date.now());
    let text = '';
    const mediaUrls = [];
    if (Array.isArray(body?.message)) {
        for (const seg of body.message) {
            if (seg?.type === 'text') text += String(seg?.data?.text || '');
            else if ((seg?.type === 'image' || seg?.type === 'video' || seg?.type === 'record') && (seg?.data?.url || seg?.data?.file)) {
                const u = String(seg.data.url || seg.data.file || '');
                if (/^https?:\/\//i.test(u)) mediaUrls.push(u);
            }
        }
    }
    if (!text && typeof body?.raw_message === 'string') {
        text = body.raw_message.replace(/\[CQ:[^\]]+\]/g, '');
    }
    if (!text && typeof body?.message === 'string') {
        text = body.message.replace(/\[CQ:[^\]]+\]/g, '');
    }
    const ts = (Number(body?.time) ? Number(body.time) * 1000 : 0) || Date.now();
    return { id, openid, text: text.trim(), voiceText: '', mediaUrls, ts };
}

export class QqBridgeCore extends ImessageBridgeCore {
    constructor(storage, env, hooks) {
        super(storage, env, hooks, { prefix: '/qq', label: 'QQ', logPrefix: 'qq' });
        this._napcatCollector = [];
        this._napcatTurn = 0;
        this._wsClients = new Set();
    }

    async attachWs(token, ws) {
        const acc = await this.s.get('acc');
        if (!acc || token !== acc.hookToken) {
            try { ws.close(1008, 'invalid token'); } catch {}
            return;
        }
        this._wsClients.add(ws);
        ws.addEventListener('message', async (ev) => {
            try {
                const raw = typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data);
                const data = JSON.parse(raw);
                if (!data?.post_type || data.post_type === 'meta_event') return;
                const r = await this.webhook(token, {}, raw);
                if (r?.json?.reply) {
                    const uid = data?.user_id || data?.sender?.user_id || (await this.s.get('acc'))?.userOpenid;
                    if (uid) this._sendWs(uid, r.json.reply);
                }
            } catch {}
        });
        const clean = () => this._wsClients.delete(ws);
        ws.addEventListener('close', clean);
        ws.addEventListener('error', clean);
    }

    _sendWs(userId, message) {
        if (!this._wsClients || !this._wsClients.size || !userId || !message) return false;
        const payload = JSON.stringify({
            action: 'send_private_msg',
            params: {
                user_id: Number(userId) || userId,
                message: String(message),
            },
            echo: `qq_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        });
        let sent = false;
        for (const ws of [...this._wsClients]) {
            try {
                ws.send(payload);
                sent = true;
            } catch {
                this._wsClients.delete(ws);
            }
        }
        return sent;
    }

    async handleChannel(method, path, query, body) {
        switch (`${method} ${path}`) {
            case 'POST /qq/setup': return this.setup(body || {});
            case 'POST /qq/unbind': return this.unbind();
            case 'POST /qq/test': return this.sendTest();
            case 'POST /qq/rebind': return this.rebind();
            default: return null;
        }
    }

    _webhookUrl(acc, inboxId) {
        return `${acc.publicBase}/qq/hook/${encodeURIComponent(inboxId)}/${acc.hookToken}`;
    }

    async channelStatus() {
        const [acc, inboxId, lastUserAt] = await Promise.all([this.s.get('acc'), this.s.get('inbox'), this.s.get('lastUserAt')]);
        return {
            bound: !!acc,
            appId: acc?.appId || '',
            linked: !!acc?.userOpenid,
            bindCode: acc && !acc.userOpenid ? acc.bindCode : '',
            webhookUrl: acc && inboxId ? this._webhookUrl(acc, inboxId) : '',
            verifiedAt: acc?.verifiedAt || 0,
            lastUserAt: lastUserAt || 0,
        };
    }

    async setup(body) {
        const appId = String(body.appId || '').trim();
        const appSecret = String(body.appSecret || '').trim();
        if (!appId || !appSecret) return { status: 400, json: { error: 'appId / appSecret required' } };
        if (!body.publicBase) return { status: 400, json: { error: 'publicBase required' } };
        let tok;
        try {
            tok = await fetchAccessToken(appId, appSecret);
        } catch {
            tok = { token: 'napcat_local_token', expiresAt: now() + 86400000 * 365 };
        }
        const prev = (await this.s.get('acc')) || {};
        const same = prev.appId === appId;
        const acc = {
            appId, appSecret,
            hookToken: same && prev.hookToken ? prev.hookToken : randomToken(),
            publicBase: String(body.publicBase).replace(/\/+$/, ''),
            userOpenid: same ? (prev.userOpenid || '') : '',
            bindCode: same && prev.bindCode ? prev.bindCode : randomCode(),
            verifiedAt: same ? (prev.verifiedAt || 0) : 0,
            createdAt: prev.createdAt || now(),
            isNapcat: prev.isNapcat || false,
        };
        await this.s.put('acc', acc);
        await this.s.put('qqToken', tok);
        const inboxId = await this.s.get('inbox');
        return { json: { ok: true, webhookUrl: this._webhookUrl(acc, inboxId), bindCode: acc.userOpenid ? '' : acc.bindCode, linked: !!acc.userOpenid } };
    }

    async rebind() {
        const acc = await this.s.get('acc');
        if (!acc) return { status: 400, json: { error: 'not set up' } };
        acc.userOpenid = '';
        acc.bindCode = randomCode();
        await this.s.put('acc', acc);
        await this.s.delete('qqReply');
        return { json: { ok: true, bindCode: acc.bindCode } };
    }

    async unbind() {
        await Promise.all(['acc', 'qqToken', 'qqReply', 'pending', 'pendingSince', 'seen'].map((k) => this.s.delete(k)));
        await this.hooks.schedule(null);
        return { json: { ok: true } };
    }

    async sendTest() {
        const acc = await this.s.get('acc');
        if (acc?.isNapcat && acc?.userOpenid) {
            this._sendWs(acc.userOpenid, '糯叽机已连接 QQ。直接回这条消息就能和角色聊天，发「/切换」换角色。');
            return { json: { ok: true } };
        }
        const opened = await this.openChannel();
        if (!opened?.chan) return { status: 400, json: { ok: false, error: opened?.reason || 'not set up' } };
        try {
            await opened.chan.sendText('糯叽机已连接 QQ。直接回这条消息就能和角色聊天，发「/切换」换角色。');
            return { json: { ok: true } };
        } catch (e) {
            return { status: 502, json: { ok: false, error: String(e?.message || e) } };
        }
    }

    async _token(acc) {
        const t = await this.s.get('qqToken');
        if (t?.token && t.expiresAt - now() > 120000) return t.token;
        try {
            const fresh = await fetchAccessToken(acc.appId, acc.appSecret);
            await this.s.put('qqToken', fresh);
            return fresh.token;
        } catch {
            return 'napcat_local_token';
        }
    }

    _chanFor(acc) {
        const base = super._chanFor({ ...acc, provider: null });
        const self = this;

        if (acc.isNapcat) {
            const pushNapcat = async (text) => {
                if (!text) return { ok: true };
                const sentByWs = self._sendWs(acc.userOpenid, String(text));
                if (!sentByWs) {
                    self._napcatCollector.push(String(text));
                    const httpUrl = self.env?.NAPCAT_HTTP_URL;
                    if (httpUrl && !/127\.0\.0\.1|localhost/i.test(httpUrl)) {
                        const headers = { 'Content-Type': 'application/json' };
                        if (self.env?.NAPCAT_TOKEN) headers['Authorization'] = `Bearer ${self.env.NAPCAT_TOKEN}`;
                        await fetch(`${String(httpUrl).replace(/\/+$/, '')}/send_private_msg`, {
                            method: 'POST',
                            headers,
                            body: JSON.stringify({ user_id: Number(acc.userOpenid) || acc.userOpenid, message: String(text) }),
                        }).catch(() => {});
                    }
                }
                return { ok: true };
            };
            return {
                budget: Infinity,
                takeNew: base.takeNew,
                sendText: (text) => pushNapcat(text),
                sendSticker: async (url) => pushNapcat(`[CQ:image,file=${await self._mediaUrl(acc, url)}]`),
                sendVideo: async (url) => pushNapcat(`[CQ:video,file=${await self._mediaUrl(acc, url)}]`),
                sendVoice: async (mp3) => {
                    const id = await self._putPublic(mp3, 'audio/mpeg', 'mp3');
                    const u = self._pubUrl(acc, await self.s.get('inbox'), id);
                    return pushNapcat(`[CQ:record,file=${u}]`);
                },
                typing: async () => {},
            };
        }

        const path = `/v2/users/${encodeURIComponent(acc.userOpenid)}`;
        async function send(body) {
            const token = await self._token(acc);
            const ctx = await self.s.get('qqReply');
            if (ctx?.msgId && now() - ctx.at < PASSIVE_WINDOW_MS && (ctx.used || 0) < PASSIVE_MAX) {
                const seq = (ctx.used || 0) + 1;
                try {
                    const r = await qqCall(token, 'POST', `${path}/messages`, { ...body, msg_id: ctx.msgId, msg_seq: seq });
                    await self.s.put('qqReply', { ...ctx, used: seq });
                    return r;
                } catch (e) {
                    if (!isPassiveExpired(e)) throw e;
                    await self.s.put('qqReply', { ...ctx, used: PASSIVE_MAX });
                }
            }
            return qqCall(token, 'POST', `${path}/messages`, { ...body, msg_seq: Math.floor(Math.random() * 1e6) + 1 });
        }

        async function upload(fileType, extra) {
            const token = await self._token(acc);
            const up = await qqCall(token, 'POST', `${path}/files`, { file_type: fileType, srv_send_msg: false, ...extra });
            if (!up?.file_info) throw new Error('QQ upload: no file_info');
            return up.file_info;
        }

        async function sendMedia(fileType, url, bytes) {
            let fileInfo = null;
            let firstErr = null;
            if (bytes?.length) {
                try { fileInfo = await upload(fileType, { file_data: bytesToB64(bytes) }); } catch (e) { firstErr = e; }
            }
            if (!fileInfo) {
                try { fileInfo = await upload(fileType, { url }); } catch (e) { throw firstErr || e; }
            }
            return send({ msg_type: 7, media: { file_info: fileInfo } });
        }

        async function bytesOf(ref) {
            const local = await self.loadSticker(ref);
            if (local) return local.bytes;
            if (!/^https?:\/\//i.test(String(ref || ''))) return null;
            try {
                const res = await fetch(ref);
                if (!res.ok) return null;
                const b = new Uint8Array(await res.arrayBuffer());
                return b.length && b.length <= 20 * 1024 * 1024 ? b : null;
            } catch { return null; }
        }

        return {
            budget: Infinity,
            takeNew: base.takeNew,
            sendText: (text) => send({ msg_type: 0, content: text }),
            sendSticker: async (url) => sendMedia(FileType.IMAGE, await self._mediaUrl(acc, url), await bytesOf(url)),
            sendVideo: async (url) => sendMedia(FileType.VIDEO, await self._mediaUrl(acc, url), await bytesOf(url)),
            async sendVoice(mp3, label) {
                const id = await self._putPublic(mp3, 'audio/mpeg', 'mp3');
                const url = self._pubUrl(acc, await self.s.get('inbox'), id);
                try {
                    await sendMedia(FileType.VOICE, url, mp3);
                } catch {
                    await sendMedia(FileType.FILE, `${url}?name=${encodeURIComponent(`${label || 'voice'}.mp3`)}`, mp3);
                }
            },
            async typing(on) {
                if (!on || this._typed) return;
                this._typed = true;
                try {
                    const ctx = await self.s.get('qqReply');
                    if (ctx?.msgId && now() - ctx.at < PASSIVE_WINDOW_MS && (ctx.used || 0) < PASSIVE_MAX - 1) {
                        await send({ msg_type: 6, input_notify: { input_type: 1, input_second: 60 } });
                    }
                } catch {}
            },
        };
    }

    async openChannel() {
        const acc = await this.s.get('acc');
        if (!acc) return { reason: 'not set up' };
        if (!acc.userOpenid) return { reason: 'not linked' };
        return { chan: this._chanFor(acc) };
    }

    async webhook(token, headers, raw) {
        const acc = await this.s.get('acc');
        if (!acc || token !== acc.hookToken) return { status: 404, json: { error: 'not found' } };
        let body;
        try { body = JSON.parse(raw); } catch { return { status: 400, json: { error: 'invalid json' } }; }

        if (body?.post_type) {
            if (body.post_type !== 'message' || body.message_type !== 'private') return { json: {} };
            const m = parseOneBot(body);
            if (!m.openid) return { json: {} };

            if (!acc.userOpenid) {
                if (m.text.replace(/\s+/g, '') !== String(acc.bindCode || '').trim()) return { json: {} };
                const next = { ...acc, userOpenid: m.openid, bindCode: '', isNapcat: true, verifiedAt: now() };
                await this.s.put('acc', next);
                await this.s.put('qqReply', { msgId: m.id, at: now(), used: 0 });
                return { json: { reply: '绑定成功。现在可以直接和角色聊天了，发「/切换」换角色。' } };
            }
            if (m.openid !== acc.userOpenid) return { json: {} };
            if (!acc.isNapcat) {
                acc.isNapcat = true;
                await this.s.put('acc', acc);
            }

            this._napcatCollector = [];
            await this.s.put('qqReply', { msgId: m.id, at: now(), used: 0 });
            await this._enqueue([m]);

            // 已連上反向 WebSocket 時交給後台排程器慢慢生成並逐條推送，不卡 webhook
            if (this._wsClients && this._wsClients.size > 0) {
                return { json: {} };
            }

            if (!this._napcatCollector.length) {
                const turn = ++this._napcatTurn;
                await new Promise((r) => setTimeout(r, 2200));
                if (turn === this._napcatTurn && !this._napcatCollector.length) {
                    await this.s.put('lastUserAt', 0);
                    await this.s.put('pendingSince', 0);
                    try { await this.runOnce(); } catch {}
                }
            }
            if (this._napcatCollector.length) {
                const replyText = this._napcatCollector.splice(0).join('\n');
                return { json: { reply: replyText, auto_escape: false } };
            }
            return { json: {} };
        }

        if (body?.op === 13) {
            await this.s.put('acc', { ...acc, verifiedAt: now() });
            return { json: await qqValidationReply(acc.appSecret, body.d) };
        }
        if (!(await qqVerify(acc.appSecret, headers, raw))) return { status: 401, json: { error: 'bad signature' } };
        const ack = { json: { op: 12 } };
        if (body?.op !== 0 || body?.t !== 'C2C_MESSAGE_CREATE') return ack;
        const m = parseC2c(body.d);
        if (!m.openid) return ack;

        if (!acc.userOpenid) {
            if (m.text.replace(/\s+/g, '') !== acc.bindCode) return ack;
            const next = { ...acc, userOpenid: m.openid, bindCode: '' };
            await this.s.put('acc', next);
            await this.s.put('qqReply', { msgId: m.id, at: now(), used: 0 });
            await this._chanFor(next).sendText('绑定成功。现在可以直接和角色聊天了，发「/切换」换角色。').catch((e) => { this.lastWarn = { at: now(), text: `QQ 发送失败：${e?.message || e}` }; });
            return ack;
        }
        if (m.openid !== acc.userOpenid) return ack;
        await this.s.put('qqReply', { msgId: m.id, at: now(), used: 0 });
        await this._enqueue([m]);
        return ack;
    }
}