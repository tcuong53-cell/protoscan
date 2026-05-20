/**
 * Debug: inspect Figma viewer DOM + click calibration
 */
import { chromium } from 'playwright';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const FILE_KEY = process.env.FIGMA_FILE_KEY ?? '';
const TOKEN = process.env.FIGMA_TOKEN ?? '';
if (!TOKEN || !FILE_KEY) { console.error('FIGMA_TOKEN and FIGMA_FILE_KEY required'); process.exit(1); }

const SESSION_PATH = resolve(import.meta.dirname, '../figma-session.json');
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 430, height: 932 } });

  if (existsSync(SESSION_PATH)) {
    const session = JSON.parse(readFileSync(SESSION_PATH, 'utf-8')) as any;
    await context.addCookies(session.cookies.map((c: any) => ({
      name: c.name, value: c.value, domain: c.domain,
      path: c.path, httpOnly: c.httpOnly, secure: true, sameSite: 'None' as const,
    })));
  }

  const page = await context.newPage();

  const url = `https://www.figma.com/proto/${FILE_KEY}/?node-id=212-3720&scaling=min-zoom&hide-ui=1&hotspot-hints=0&starting-point-node-id=89-2302`;
  console.log('Loading with scaling=min-zoom...');
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForSelector('canvas', { timeout: 15_000 });
  await sleep(15_000);

  // DOM inspection — flat, no named functions
  const elements = await page.evaluate(`
    (() => {
      const viewer = document.getElementById('viewerContainer');
      if (!viewer) return [];
      const result = [];
      const stack = [[viewer, 0]];
      while (stack.length > 0 && result.length < 30) {
        const [el, depth] = stack.pop();
        const r = el.getBoundingClientRect();
        const cs = window.getComputedStyle(el);
        result.push({
          tag: el.tagName, depth: depth,
          cls: (typeof el.className === 'string' ? el.className : '').substring(0, 60),
          x: Math.round(r.x), y: Math.round(r.y),
          w: Math.round(r.width), h: Math.round(r.height),
          transform: cs.transform !== 'none' ? cs.transform : '',
        });
        for (let i = el.children.length - 1; i >= 0; i--) {
          stack.push([el.children[i], depth + 1]);
        }
      }
      return result;
    })()
  `);

  console.log('\nViewer DOM tree:');
  for (const el of elements as any[]) {
    const indent = '  '.repeat(el.depth);
    const tf = el.transform ? ` tf="${el.transform}"` : '';
    console.log(`${indent}<${el.tag}> (${el.x},${el.y},${el.w}x${el.h})${tf} cls="${el.cls}"`);
  }

  // Click calibration — find where "Iniciar sesión" actually is
  console.log('\n--- Click calibration on Bienvenida-01 ---');
  console.log('Looking for "Iniciar sesión" (Login) button...');
  console.log('Expected: rel(195, 734) in 390x844 frame');

  const clickX = 215;
  for (const clickY of [620, 640, 660, 680, 700, 720, 740, 760, 780, 800]) {
    const currentNodeId = new URL(page.url()).searchParams.get('node-id');
    await page.mouse.click(clickX, clickY);
    await sleep(2000);
    const newNodeId = new URL(page.url()).searchParams.get('node-id');

    if (newNodeId !== currentNodeId) {
      console.log(`  click(${clickX}, ${clickY}) → NAVIGATED! ${currentNodeId} → ${newNodeId}`);
      await page.goBack();
      await sleep(3000);
    } else {
      console.log(`  click(${clickX}, ${clickY}) → no nav`);
    }
  }

  await browser.close();
}

main().catch(console.error);
