import fs from 'node:fs';

export const PRODUCTION_UPDATER_FEED = Object.freeze({
  provider: 'github',
  owner: 'AlanIWBFT',
  repo: 'openchamber',
});

// Accept legacy selections at the IPC boundary, but this fork publishes only
// Stable. A stored Canary selection must never select the official feed.
export const isUpdateChannel = (value) => value === 'stable' || value === 'canary';
export const normalizeUpdateChannel = () => 'stable';

// A Canary build's version is the release it leads to with a `canary`
// pre-release part: 2.5.4-canary.20261030.123.
export const isCanaryVersion = (version) => /-canary\./.test(String(version ?? ''));

const isLoopbackHostname = (hostname) => {
  if (hostname === '::1' || hostname === '[::1]') return true;
  const octets = hostname.split('.');
  if (octets.length !== 4 || octets.some((octet) => !/^\d{1,3}$/.test(octet))) return false;
  const values = octets.map(Number);
  return values[0] === 127 && values.every((value) => value <= 255);
};

export const parseLoopbackUpdaterUrl = (value) => {
  if (!value) return null;
  try {
    const url = new URL(value);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:')
      || !isLoopbackHostname(url.hostname)
      || url.username
      || url.password
      || url.search
      || url.hash) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
};

export const resolveUpdaterFeed = ({
  environment = process.env,
  testBuild = false,
} = {}) => {
  const productionFeed = PRODUCTION_UPDATER_FEED;
  if (environment.OPENCHAMBER_E2E !== '1'
    || testBuild !== true) {
    return productionFeed;
  }

  const url = parseLoopbackUpdaterUrl(environment.OPENCHAMBER_UPDATER_E2E_URL);
  if (!url) return productionFeed;
  return { provider: 'generic', url };
};
