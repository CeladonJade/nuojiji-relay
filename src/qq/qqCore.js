// QQ 橋接（支援 QQ 官方機器人 + NapCat / OneBot v11 直連單聊）
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
    if (!mediaUrls.length && typeof body?.raw_message === 'string') {
        const matches = body.raw_message.matchAll(/\[CQ:(?:image|video|record)[^\]]*?,url=([^,\]]+)/g);
        for (const m of matches) {
            if (m[1]) mediaUrls.push(m[1].replace(/&amp;/g, '&'));
        }
    }
    const ts = (Number(body?.time) ? Number(body.time) * 1000 : 0) || Date.now();
    return { id, openid, text: text.trim(), voiceText: '', mediaUrls, ts };
}

export class QqBridgeCore extends ImessageBridgeCore {
    constructor(storage, env, hooks) {
        super(storage, env, hooks, { prefix: '/qq', label: 'QQ', logPrefix: 'qq' });
        this._napcatCollector = [];
        this._napcatLastAt = 0;
        this._napcatTurn = 0;
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