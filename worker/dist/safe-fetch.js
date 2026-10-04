"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.isPublicAddress = isPublicAddress;
exports.downloadPublicFile = downloadPublicFile;
exports.postPublicJson = postPublicJson;
const node_dns_1 = __importDefault(require("node:dns"));
const node_https_1 = __importDefault(require("node:https"));
const node_net_1 = __importDefault(require("node:net"));
// Attachment URLs in HighLevel delivery webhooks are user-controlled (anyone sending through the GHL API can set them),
// so they are only fetched from public addresses. The check runs inside the socket's DNS lookup, which also defeats
// DNS rebinding, and redirects are re-validated hop by hop.
const blocked = new node_net_1.default.BlockList();
for (const [network, prefix] of [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4]
]) {
    blocked.addSubnet(network, prefix, 'ipv4');
}
// No ::ffff:0:0/96 entry: BlockList matches IPv4-mapped IPv6 against the IPv4 rules above (and vice versa).
for (const [network, prefix] of [
    ['::', 128],
    ['::1', 128],
    ['64:ff9b::', 96],
    ['fc00::', 7],
    ['fe80::', 10],
    ['ff00::', 8],
    ['2001:db8::', 32]
]) {
    blocked.addSubnet(network, prefix, 'ipv6');
}
function isPublicAddress(address) {
    const family = node_net_1.default.isIP(address);
    if (family === 4)
        return !blocked.check(address, 'ipv4');
    if (family === 6)
        return !blocked.check(address, 'ipv6');
    return false;
}
function publicOnlyLookup(hostname, options, callback) {
    node_dns_1.default.lookup(hostname, { ...options, all: true }, (err, addresses) => {
        if (err)
            return callback(err, '');
        const list = addresses;
        if (!list.length || list.some(a => !isPublicAddress(a.address))) {
            return callback(Object.assign(new Error(`Refusing to fetch ${hostname}: it resolves to a private address`), { code: 'EPRIVATE' }), '');
        }
        if (options.all)
            return callback(null, list);
        callback(null, list[0].address, list[0].family);
    });
}
async function downloadPublicFile(rawUrl, maxBytes, redirectsLeft = 3) {
    let url;
    try {
        url = new URL(rawUrl);
    }
    catch {
        throw new Error('Invalid attachment URL');
    }
    if (url.protocol !== 'https:')
        throw new Error('Only https attachment URLs are allowed');
    const host = url.hostname.replace(/^\[|\]$/g, '');
    // IP literals never go through the lookup hook, so check them here.
    if (node_net_1.default.isIP(host) && !isPublicAddress(host))
        throw new Error(`Refusing to fetch ${host}: it is a private address`);
    return new Promise((resolve, reject) => {
        const req = node_https_1.default.get(url, { lookup: publicOnlyLookup, timeout: 20_000, headers: { 'user-agent': 'ghl-whatsapp-bridge' } }, res => {
            const status = res.statusCode || 0;
            if (status >= 300 && status < 400 && res.headers.location) {
                res.resume();
                if (redirectsLeft <= 0)
                    return reject(new Error('Too many redirects'));
                return resolve(downloadPublicFile(new URL(res.headers.location, url).toString(), maxBytes, redirectsLeft - 1));
            }
            if (status !== 200) {
                res.resume();
                return reject(new Error(`Attachment download failed with HTTP ${status}`));
            }
            const limitMb = Math.round(maxBytes / 1024 / 1024);
            if (Number(res.headers['content-length'] || 0) > maxBytes) {
                res.destroy();
                return reject(new Error(`Attachment is larger than ${limitMb} MB`));
            }
            const chunks = [];
            let size = 0;
            res.on('data', (chunk) => {
                size += chunk.length;
                if (size > maxBytes)
                    res.destroy(new Error(`Attachment is larger than ${limitMb} MB`));
                else
                    chunks.push(chunk);
            });
            res.on('end', () => resolve({ data: Buffer.concat(chunks), contentType: res.headers['content-type'] || null }));
            res.on('error', reject);
        });
        req.on('timeout', () => req.destroy(new Error('Attachment download timed out')));
        req.on('error', reject);
    });
}
// POST a small JSON body to a public HTTPS URL (the admin's alert webhook), with the same address checks as downloads.
function postPublicJson(rawUrl, body) {
    let url;
    try {
        url = new URL(rawUrl);
    }
    catch {
        return Promise.reject(new Error('Invalid webhook URL'));
    }
    if (url.protocol !== 'https:')
        return Promise.reject(new Error('Only https webhook URLs are allowed'));
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (node_net_1.default.isIP(host) && !isPublicAddress(host))
        return Promise.reject(new Error(`Refusing to call ${host}: it is a private address`));
    const data = Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
        const req = node_https_1.default.request(url, {
            method: 'POST',
            lookup: publicOnlyLookup,
            timeout: 15_000,
            headers: { 'content-type': 'application/json', 'content-length': data.length, 'user-agent': 'ghl-whatsapp-bridge' }
        }, res => {
            res.resume();
            const status = res.statusCode || 0;
            if (status >= 200 && status < 300)
                resolve(status);
            else
                reject(new Error(`Webhook answered HTTP ${status}`));
        });
        req.on('timeout', () => req.destroy(new Error('Webhook timed out')));
        req.on('error', reject);
        req.end(data);
    });
}
