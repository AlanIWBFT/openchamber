import { readFileSync } from 'node:fs';
import path from 'node:path';

export const createWebIconScript = (directory) => {
  const filenames = [
    'favicon.svg',
    'favicon-32.png',
    'favicon-16.png',
    'apple-touch-icon-180x180.png',
    'apple-touch-icon-167x167.png',
    'apple-touch-icon-152x152.png',
    'pwa-192.png',
    'pwa-512.png',
    'pwa-maskable-192.png',
    'pwa-maskable-512.png',
  ];
  const icons = filenames.map((filename) => {
    const type = filename.endsWith('.svg') ? 'image/svg+xml' : 'image/png';
    return [`/${filename}`, `data:${type};base64,${readFileSync(path.join(directory, filename)).toString('base64')}`];
  });
  return `const openChamberWebIcons = new Map(${JSON.stringify(icons)});\n`;
};
