// Кибла: азимут и расстояние до Каабы, магнитное склонение (WMM2025), курс телефона по датчику.
// Чистые функции без DOM (приложение и тесты).

export const KAABA = { lat: 21.4225, lon: 39.8262 };
const EARTH_KM = 6371.0088;
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;
/** Угол в 0…360. */
export const norm360 = (a) => ((a % 360) + 360) % 360;

/** Азимут на Каабу от истинного севера, 0–360° (начальный азимут по большому кругу). */
export function qiblaBearing(lat, lon) {
  const f1 = rad(lat);
  const f2 = rad(KAABA.lat);
  const dl = rad(KAABA.lon - lon);
  const y = Math.sin(dl) * Math.cos(f2);
  const x = Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl);
  return norm360(deg(Math.atan2(y, x)));
}

/** Расстояние до Каабы, км (гаверсинус). */
export function distanceKm(lat, lon) {
  const f1 = rad(lat);
  const f2 = rad(KAABA.lat);
  const a = Math.sin((f2 - f1) / 2) ** 2 + Math.cos(f1) * Math.cos(f2) * Math.sin(rad(KAABA.lon - lon) / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Поворот от курса heading к цели bearing: −180…+180 (минус — левее, плюс — правее). */
export function delta(heading, bearing) {
  const d = norm360(bearing - heading);
  return d > 180 ? d - 360 : d;
}

// ---------- Магнитное склонение: World Magnetic Model 2025 (NOAA/NCEI, 2025.0–2030.0) ----------
// Коэффициенты Гаусса (нТл) и их вековые изменения (нТл/год), по степени n = 1…12:
// [[g(n,0…n)], [h(n,0…n)], [ġ(n,0…n)], [ḣ(n,0…n)]]. Данные модели — общественное достояние (NOAA).
const WMM_EPOCH = 2025.0;
const WMM = [
  [[-29351.8, -1410.8], [0, 4545.4], [12, 9.7], [0, -21.5]],
  [[-2556.6, 2951.1, 1649.3], [0, -3133.6, -815.1], [-11.6, -5.2, -8], [0, -27.7, -12.1]],
  [[1361, -2404.1, 1243.8, 453.6], [0, -56.6, 237.5, -549.5], [-1.3, -4.2, 0.4, -15.6], [0, 4, -0.3, -4.1]],
  [[895, 799.5, 55.7, -281.1, 12.1], [0, 278.6, -133.9, 212, -375.6], [-1.6, -2.4, -6, 5.6, -7], [0, -1.1, 4.1, 1.6, -4.4]],
  [[-233.2, 368.9, 187.2, -138.7, -142, 20.9], [0, 45.4, 220.2, -122.9, 43, 106.1], [0.6, 1.4, 0, 0.6, 2.2, 0.9], [0, -0.5, 2.2, 0.4, 1.7, 1.9]],
  [[64.4, 63.8, 76.9, -115.7, -40.9, 14.9, -60.7], [0, -18.4, 16.8, 48.8, -59.8, 10.9, 72.7], [-0.2, -0.4, 0.9, 1.2, -0.9, 0.3, 0.9], [0, 0.3, -1.6, -0.4, 0.9, 0.7, 0.9]],
  [[79.5, -77, -8.8, 59.3, 15.8, 2.5, -11.1, 14.2], [0, -48.9, -14.4, -1, 23.4, -7.4, -25.1, -2.3], [0, -0.1, -0.1, 0.5, -0.1, -0.8, -0.8, 0.8], [0, 0.6, 0.5, -0.8, 0, -1, 0.6, -0.2]],
  [[23.2, 10.8, -17.5, 2, -21.7, 16.9, 15, -16.8, 0.9], [0, 7.1, -12.6, 11.4, -9.7, 12.7, 0.7, -5.2, 3.9], [-0.1, 0.2, 0, 0.5, -0.1, 0.3, 0.2, 0, 0.2], [0, -0.2, 0.5, -0.4, 0.4, -0.5, -0.6, 0.3, 0.2]],
  [[4.6, 7.8, 3, -0.2, -2.5, -13.1, 2.4, 8.6, -8.7, -12.9], [0, -24.8, 12.2, 8.3, -3.3, -5.2, 7.2, -0.6, 0.8, 10], [0, -0.1, 0.1, 0.3, -0.3, 0, 0.3, -0.1, 0.1, -0.1], [0, -0.3, 0.3, -0.3, 0.3, 0.2, -0.1, -0.2, 0.4, 0.1]],
  [[-1.3, -6.4, 0.2, 2, -1, -0.6, -0.9, 1.5, 0.9, -2.7, -3.9], [0, 3.3, 0, 2.4, 5.3, -9.1, 0.4, -4.2, -3.8, 0.9, -9.1], [0.1, 0, 0.1, 0.1, 0, -0.3, 0, -0.1, -0.1, 0, 0], [0, 0, 0, -0.2, 0.1, -0.1, 0.1, 0, -0.1, 0.2, 0]],
  [[2.9, -1.5, -2.5, 2.4, -0.6, -0.1, -0.6, -0.1, 1.1, -1, -0.2, 2.6], [0, 0, 2.9, -0.6, 0.2, 0.5, -0.3, -1.2, -1.7, -2.9, -1.8, -2.3], [0, 0, 0, 0, 0, -0.1, 0, 0, -0.1, -0.1, -0.1, -0.1], [0, 0, 0.1, 0, 0.1, 0, 0, 0.1, 0, 0, 0, 0]],
  [[-2, -0.2, 0.3, 1.2, -1.3, 0.6, 0.6, 0.5, -0.1, -0.4, -0.2, -1.3, -0.7], [0, -1.3, 0.7, 1, -1.4, 0, 0.6, -0.1, 0.8, 0.1, -1, 0.1, 0.2], [0, 0, 0, 0, 0, 0, 0.1, 0, 0, 0, -0.1, 0, -0.1], [0, 0, 0, -0.1, 0.1, 0, 0, 0, 0, 0, 0, 0, -0.1]],
];
const WGS_A = 6378.137; // большая полуось WGS84, км
const WGS_F = 1 / 298.257223563;
const WGS_E2 = WGS_F * (2 - WGS_F);
const WMM_R = 6371.2; // радиус модели, км
const N = WMM.length;

// множители Шмидта: коэффициенты модели (полунормированные) → функции Лежандра в нормировке Гаусса
const SCHMIDT = (() => {
  const s = [[1]];
  for (let n = 1; n <= N; n++) {
    s[n] = [s[n - 1][0] * (2 * n - 1) / n];
    for (let m = 1; m <= n; m++) s[n][m] = s[n][m - 1] * Math.sqrt(((n - m + 1) * (m === 1 ? 2 : 1)) / (n + m));
  }
  return s;
})();

/** Десятичный год (UTC) для даты. */
export function decimalYear(date) {
  const y = date.getUTCFullYear();
  const start = Date.UTC(y, 0, 1);
  return y + (date.getTime() - start) / (Date.UTC(y + 1, 0, 1) - start);
}

/**
 * Поле Земли по WMM2025 в точке (геодезические lat, lon в градусах, высота h км) на дату.
 * → { x, y, z } нТл (север, восток, вниз), declination — склонение в градусах (восточное +).
 */
export function magneticField(lat, lon, h = 0, date = new Date()) {
  const dt = decimalYear(date) - WMM_EPOCH;
  // геодезические координаты → геоцентрические (сфера)
  const phi = rad(lat);
  const rc = WGS_A / Math.sqrt(1 - WGS_E2 * Math.sin(phi) ** 2);
  const p = (rc + h) * Math.cos(phi);
  const zc = (rc * (1 - WGS_E2) + h) * Math.sin(phi);
  const r = Math.hypot(p, zc);
  const phiC = Math.asin(zc / r);
  const ct = Math.sin(phiC); // cos(колатитуды)
  const st = Math.cos(phiC);
  const lam = rad(lon);
  // функции Лежандра (нормировка Гаусса) и их производные по колатитуде
  const P = [[1]];
  const dP = [[0]];
  for (let n = 1; n <= N; n++) {
    P[n] = [];
    dP[n] = [];
    for (let m = 0; m <= n; m++) {
      if (m === n) {
        P[n][m] = st * P[n - 1][m - 1];
        dP[n][m] = st * dP[n - 1][m - 1] + ct * P[n - 1][m - 1];
      } else {
        const k = n > 1 ? ((n - 1) ** 2 - m * m) / ((2 * n - 1) * (2 * n - 3)) : 0;
        const p2 = n > 1 && m <= n - 2 ? P[n - 2][m] : 0;
        const d2 = n > 1 && m <= n - 2 ? dP[n - 2][m] : 0;
        P[n][m] = ct * P[n - 1][m] - k * p2;
        dP[n][m] = ct * dP[n - 1][m] - st * P[n - 1][m] - k * d2;
      }
    }
  }
  let br = 0;
  let bt = 0;
  let bp = 0;
  for (let n = 1; n <= N; n++) {
    const [g, hh, gt, ht] = WMM[n - 1];
    const ar = (WMM_R / r) ** (n + 2);
    for (let m = 0; m <= n; m++) {
      const gnm = (g[m] + gt[m] * dt) * SCHMIDT[n][m];
      const hnm = (hh[m] + ht[m] * dt) * SCHMIDT[n][m];
      const c = Math.cos(m * lam);
      const s = Math.sin(m * lam);
      const t = gnm * c + hnm * s;
      br += (n + 1) * ar * t * P[n][m];
      bt -= ar * t * dP[n][m];
      bp += ar * m * (gnm * s - hnm * c) * P[n][m];
    }
  }
  // у полюса st → 0: компонента по долготе — предел
  bp = st > 1e-10 ? bp / st : 0;
  // геоцентрические север/восток/вниз → геодезические
  const xc = -bt;
  const zc2 = -br;
  const psi = phiC - phi;
  const x = xc * Math.cos(psi) - zc2 * Math.sin(psi);
  const z = xc * Math.sin(psi) + zc2 * Math.cos(psi);
  return { x, y: bp, z, declination: deg(Math.atan2(bp, x)) };
}

/** Магнитное склонение, градусы (восточное +): истинный курс = магнитный + склонение. */
export const declination = (lat, lon, date = new Date()) => magneticField(lat, lon, 0, date).declination;

// ---------- Курс телефона ----------

/**
 * Курс телефона от истинного севера, 0–360°.
 *  • source 'telegram': alpha (радианы) из WebApp.DeviceOrientation в абсолютном режиме.
 *    Android: alpha = −азимут от магнитного севера. iOS: alpha = +курс; север истинный, если у Telegram есть
 *    доступ к геопозиции (trueNorth), иначе магнитный.
 *  • source 'webkit': webkitCompassHeading (градусы по часовой от магнитного севера, iOS-браузер).
 *  • source 'absolute': событие deviceorientationabsolute, alpha в градусах против часовой (стандарт W3C).
 * declination — магнитное склонение (восточное +), прибавляется к магнитному курсу.
 */
export function headingFromOrientation({ source, alpha = 0, compassHeading = 0, platform = '', trueNorth = false, declination: dec = 0 }) {
  let h;
  let magnetic = true;
  if (source === 'telegram') {
    const a = deg(Number(alpha) || 0);
    if (platform === 'ios') {
      h = a;
      magnetic = !trueNorth;
    } else h = -a;
  } else if (source === 'webkit') h = Number(compassHeading) || 0;
  else h = 360 - (Number(alpha) || 0);
  return norm360(h + (magnetic ? dec : 0));
}

/** Сглаживание курса (экспоненциальное, с переходом через 0°/360°). k — доля нового значения. */
export function smoothHeading(prev, next, k = 0.25) {
  if (prev == null || !Number.isFinite(prev)) return norm360(next);
  return norm360(prev + delta(prev, next) * k);
}

/** Наклон телефона от горизонтали больше limit градусов (beta, gamma — по модулю, в градусах). */
export const isTilted = (beta, gamma, limit = 30) => Math.max(Math.abs(Number(beta) || 0), Math.abs(Number(gamma) || 0)) > limit;

/**
 * Показания скачут: за последние windowMs курс «дрожит» больше чем на spread градусов.
 * Дрожание = пройденный путь минус чистый поворот: плавный поворот телефона его не даёт,
 * метания туда-обратно (помехи магнитометра) — дают. samples — [{ t, h }] (время мс, курс градусы).
 */
export function isNoisy(samples, now, windowMs = 1000, spread = 10) {
  const recent = samples.filter((s) => now - s.t <= windowMs);
  if (recent.length < 3) return false;
  let path = 0;
  let net = 0;
  for (let i = 1; i < recent.length; i++) {
    const d = delta(recent[i - 1].h, recent[i].h);
    path += Math.abs(d);
    net += d;
  }
  return path - Math.abs(net) > spread;
}

/** Ближе 1 км к Каабе — компас не нужен. */
export const nearKaaba = (lat, lon) => distanceKm(lat, lon) < 1;
