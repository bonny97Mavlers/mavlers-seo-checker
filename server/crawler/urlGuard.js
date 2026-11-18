'use strict';
/**
 * URL validation + SSRF protection.
 * - only http/https, no embedded credentials, standard ports
 * - every hostname is DNS-resolved and private / loopback / link-local /
 *   metadata ranges are refused (set ALLOW_PRIVATE_HOSTS=true for local dev)
 */
const dns = require('dns').promises;
const net = require('net');

const ALLOW_PRIVATE = String(process.env.ALLOW_PRIVATE_HOSTS || '').toLowerCase() === 'true';

function normaliseInput(raw) {
  let s = String(raw || '').trim();
  if (!s) throw new Error('Please enter a website URL.');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s;
  let u;
  try { u = new URL(s); } catch { throw new Error('That does not look like a valid URL.'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Only http and https URLs can be audited.');
  if (u.username || u.password) throw new Error('URLs with embedded credentials are not allowed.');
  if (!u.hostname.includes('.') && !ALLOW_PRIVATE) throw new Error('Please enter a full domain name (e.g. example.com).');
  u.hash = '';
  return u;
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 ||
      (a === 169 && b === 254) ||                 // link-local + cloud metadata
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||       // CGNAT
      a >= 224;                                   // multicast / reserved
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivateIp(v.slice(7));
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
}

const dnsCache = new Map();
async function assertPublicHost(u) {
  const port = u.port ? Number(u.port) : null;
  if (port && ![80, 443, 8080, 8443].includes(port) && !ALLOW_PRIVATE) {
    throw new Error(`Port ${port} is not allowed.`);
  }
  if (ALLOW_PRIVATE) return;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('Local and internal hostnames cannot be audited.');
  }
  let addrs = dnsCache.get(host);
  if (!addrs) {
    if (net.isIP(host)) addrs = [host];
    else {
      try { addrs = (await dns.lookup(host, { all: true })).map(a => a.address); }
      catch { throw new Error(`Could not resolve ${host}. Check the domain name.`); }
    }
    dnsCache.set(host, addrs);
  }
  if (addrs.some(isPrivateIp)) throw new Error(`${host} resolves to a private network address and cannot be audited.`);
}

/** Registrable-ish site key: strips a leading www. so www/non-www count as the same site. */
function siteKey(hostname) { return hostname.toLowerCase().replace(/^www\./, ''); }

module.exports = { normaliseInput, assertPublicHost, isPrivateIp, siteKey, ALLOW_PRIVATE };
