const express = require('express');
const { chromium } = require('playwright-core');
const path = require('path');
const { execSync } = require('child_process');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;

const TUCANO_USER = process.env.TUCANO_USER;
const TUCANO_PASS = process.env.TUCANO_PASS;
const TRAVELGEA_USER = process.env.TRAVELGEA_USER;
const TRAVELGEA_PASS = process.env.TRAVELGEA_PASS;

// Detectar Chromium del sistema
function getChromiumPath() {
  const paths = [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/nix/store',
  ];
  for (const p of paths) {
    try {
      if (p === '/nix/store') {
        const result = execSync('find /nix/store -name "chromium" -type f 2>/dev/null | head -1').toString().trim();
        if (result) return result;
      } else {
        execSync(`test -f ${p}`);
        return p;
      }
    } catch {}
  }
  // Último recurso
  try {
    return execSync('which chromium || which chromium-browser || which google-chrome').toString().trim();
  } catch {}
  return null;
}

const CHROMIUM_PATH = getChromiumPath();
console.log('Chromium path:', CHROMIUM_PATH);

function getBrowser() {
  return chromium.launch({
    executablePath: CHROMIUM_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--single-process']
  });
}

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/health', (req, res) => {
  const { execSync } = require('child_process');
  const diag = {};
  ['which chromium', 'which chromium-browser', 'find /nix/store -name chromium -type f 2>/dev/null | head -3', 'find /usr/bin -name chromium* 2>/dev/null | head -3'].forEach(cmd => {
    try { diag[cmd] = execSync(cmd, {timeout:3000}).toString().trim(); } catch(e) { diag[cmd] = 'not found'; }
  });
  res.json({ ok: true, chromium: CHROMIUM_PATH, diag });
});

app.post('/buscar', async (req, res) => {
  const { destino, entrada, noches, adultos } = req.body;
  console.log(`[Búsqueda] destino="${destino}" entrada="${entrada}" noches=${noches} adultos=${adultos}`);

  const [resTucano, resTravelgea] = await Promise.allSettled([
    buscarTucano(destino, entrada, parseInt(noches), parseInt(adultos)),
    buscarTravelgea(destino, entrada, parseInt(noches), parseInt(adultos))
  ]);

  const tucano = resTucano.status === 'fulfilled' ? resTucano.value : [];
  const travelgea = resTravelgea.status === 'fulfilled' ? resTravelgea.value : [];

  if (resTucano.status === 'rejected') console.error('[Tucano] Falló:', resTucano.reason?.message);
  if (resTravelgea.status === 'rejected') console.error('[Travelgea] Falló:', resTravelgea.reason?.message);

  console.log(`[Resultados] Tucano: ${tucano.length}, Travelgea: ${travelgea.length}`);
  res.json({ ok: true, resultados: combinarResultados(tucano, travelgea) });
});

async function buscarTucano(destino, entrada, noches, adultos) {
  console.log('[Tucano] Iniciando...');
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await page.goto('https://www.tucanotours.com.ar/index.php', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);
    await page.fill('input[name="usuario"]', TUCANO_USER);
    await page.fill('input[name="password"]', TUCANO_PASS);
    await Promise.all([
      page.waitForNavigation({ timeout: 15000 }).catch(() => {}),
      page.click('button[type="submit"], input[type="submit"]')
    ]);
    await page.waitForTimeout(2000);
    console.log('[Tucano] Post-login:', page.url());

    await page.goto('https://tucanotours.app.pricenavigator.net/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);
    console.log('[Tucano] PriceNavigator:', page.url());

    if (page.url().includes('login')) {
      await page.fill('input[name="username"], input[type="email"]', TUCANO_USER);
      await page.fill('input[type="password"]', TUCANO_PASS);
      await page.click('button[type="submit"]');
      await page.waitForTimeout(3000);
    }

    await page.click('a[href*="hotel"]').catch(() => {});
    await page.waitForTimeout(1500);

    const inputDestino = page.locator('input.ui-autocomplete-input').first();
    await inputDestino.click();
    await inputDestino.type(destino, { delay: 100 });
    await page.waitForSelector('ul.ui-autocomplete li.ui-menu-item', { timeout: 8000 });
    await page.waitForTimeout(500);
    await page.locator('ul.ui-autocomplete li.ui-menu-item').first().click();
    await page.waitForTimeout(800);

    const [yyyy, mm, dd] = entrada.split('-');
    await page.fill('input[placeholder="Entrada"]', `${dd}/${mm}/${yyyy}`).catch(() => {});
    await page.waitForTimeout(300);
    await page.fill('input[placeholder="Noches"]', String(noches)).catch(() => {});
    await page.waitForTimeout(300);

    await page.click('button:has-text("Buscar")');
    await page.waitForTimeout(7000);
    console.log('[Tucano] URL resultados:', page.url());

    const resultados = await extraerTucano(page);
    console.log('[Tucano] Hoteles:', resultados.length);
    await browser.close();
    return resultados;
  } catch (err) {
    console.error('[Tucano] Error:', err.message);
    await browser.close();
    return [];
  }
}

async function extraerTucano(page) {
  return await page.evaluate(() => {
    const hoteles = [];
    const cards = document.querySelectorAll('[class*="hotel-card"], [class*="hotel-item"], [class*="property"], [class*="result-item"]');
    cards.forEach(card => {
      const nombre = card.querySelector('h2, h3, [class*="hotel-name"]')?.textContent?.trim();
      const habitaciones = [];
      card.querySelectorAll('[class*="room"], [class*="tariff"], [class*="rate"]').forEach(row => {
        const nombreHab = row.querySelector('[class*="name"], [class*="type"]')?.textContent?.trim();
        const regimen = row.querySelector('[class*="regime"], a')?.textContent?.trim() || 'Todo incluido';
        const precio = parseFloat((row.querySelector('[class*="price"]')?.textContent || '').replace(/[^0-9.,]/g, '').replace(',', '.'));
        if (nombreHab && !isNaN(precio) && precio > 0) habitaciones.push({ nombre: nombreHab, regimen, precioTotal: precio, reembolsable: row.textContent.includes('eembolsable') });
      });
      if (!habitaciones.length) {
        const precio = parseFloat((card.querySelector('[class*="price"]')?.textContent || '').replace(/[^0-9.,]/g, '').replace(',', '.'));
        if (precio > 0) habitaciones.push({ nombre: 'Habitación disponible', regimen: 'Consultar', precioTotal: precio, reembolsable: false });
      }
      if (nombre && habitaciones.length) hoteles.push({ hotel: nombre, estrellas: 5, habitaciones });
    });
    return hoteles;
  });
}

async function buscarTravelgea(destino, entrada, noches, adultos) {
  console.log('[Travelgea] Iniciando...');
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await page.goto('https://intranet.grupogea.la/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);
    await page.fill('input[type="email"], input[name="email"]', TRAVELGEA_USER);
    await page.fill('input[type="password"]', TRAVELGEA_PASS);
    await page.click('button[type="submit"]');
    await page.waitForTimeout(4000);
    console.log('[Travelgea] Post-login:', page.url());

    await page.goto('https://online.travelgea.com.ar/es', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    const inputDestino = page.locator('input.ui-autocomplete-input, input[placeholder*="Destino"]').first();
    await inputDestino.click();
    await inputDestino.type(destino, { delay: 100 });
    await page.waitForSelector('ul.ui-autocomplete li.ui-menu-item', { timeout: 8000 });
    await page.waitForTimeout(500);
    await page.locator('ul.ui-autocomplete li.ui-menu-item').first().click();
    await page.waitForTimeout(800);

    const [yyyy, mm, dd] = entrada.split('-');
    await page.fill('input[placeholder*="Llegada"]', `${dd}-${mm}-${yyyy}`).catch(() => {});
    await page.waitForTimeout(300);
    await page.selectOption('select', String(noches)).catch(() => {});

    await page.click('button:has-text("Buscar")');
    await page.waitForTimeout(7000);
    console.log('[Travelgea] URL resultados:', page.url());

    const resultados = await extraerTravelgea(page);
    console.log('[Travelgea] Hoteles:', resultados.length);
    await browser.close();
    return resultados;
  } catch (err) {
    console.error('[Travelgea] Error:', err.message);
    await browser.close();
    return [];
  }
}

async function extraerTravelgea(page) {
  return await page.evaluate(() => {
    const hoteles = [];
    const cards = document.querySelectorAll('[class*="hotel"], [class*="property"]');
    cards.forEach(card => {
      const nombre = card.querySelector('h2, h3, [class*="name"]')?.textContent?.trim();
      const habitaciones = [];
      card.querySelectorAll('[class*="room"], [class*="option"], [class*="tarif"]').forEach(row => {
        const texto = row.textContent || '';
        const tipoMatch = texto.match(/\d+\s*x\s*(.+?)(?:,|Todo|Refund)/);
        const tipo = tipoMatch ? tipoMatch[1].trim() : null;
        const regimen = row.querySelector('a')?.textContent?.trim() || 'Todo incluido';
        const precioMatch = texto.match(/Precio\s+USD\s*([\d,. ]+)/i);
        const precio = precioMatch ? parseFloat(precioMatch[1].replace(/[, ]/g, '')) : null;
        if (tipo && precio && precio > 0) habitaciones.push({ nombre: tipo, regimen, precioTotal: precio, reembolsable: texto.toLowerCase().includes('reembolsable') });
      });
      if (!habitaciones.length) {
        const precioMatch = card.textContent?.match(/USD\s*([\d,. ]+)/);
        const precio = precioMatch ? parseFloat(precioMatch[1].replace(/[, ]/g, '')) : null;
        if (precio && precio > 0) habitaciones.push({ nombre: 'Habitación disponible', regimen: 'Consultar', precioTotal: precio, reembolsable: false });
      }
      if (nombre && habitaciones.length) hoteles.push({ hotel: nombre, estrellas: 5, habitaciones });
    });
    return hoteles;
  });
}

function combinarResultados(tucano, travelgea) {
  const mapa = {};
  tucano.forEach(h => {
    const key = h.hotel.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!mapa[key]) mapa[key] = { hotel: h.hotel, estrellas: h.estrellas, habitaciones: [] };
    h.habitaciones.forEach(r => mapa[key].habitaciones.push({ ...r, proveedor: 'tucano', precioNeto: +(r.precioTotal * 0.83).toFixed(2) }));
  });
  travelgea.forEach(h => {
    const key = h.hotel.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!mapa[key]) mapa[key] = { hotel: h.hotel, estrellas: h.estrellas, habitaciones: [] };
    h.habitaciones.forEach(r => mapa[key].habitaciones.push({ ...r, proveedor: 'travelgea', precioNeto: +(r.precioTotal * 0.88).toFixed(2) }));
  });
  Object.values(mapa).forEach(h => h.habitaciones.sort((a, b) => a.precioNeto - b.precioNeto));
  return Object.values(mapa);
}

app.listen(PORT, () => console.log(`✅ Servidor corriendo en puerto ${PORT}`));
