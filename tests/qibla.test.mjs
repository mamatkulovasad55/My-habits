// Кибла: азимут, расстояние, склонение WMM2025, курс телефона по датчику, сглаживание, солнце.
import assert from 'node:assert/strict';
import { qiblaBearing, distanceKm, delta, magneticField, declination, headingFromOrientation, smoothHeading, isTilted, isNoisy, nearKaaba, KAABA } from '../js/qibla.js';
import { sunAltAz } from '../js/prayer.js';

const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} ≠ ${b} ± ${eps}`);
const TASHKENT = [41.2995, 69.2401];

// 1. Азимут и расстояние
near(qiblaBearing(...TASHKENT), 240.3, 0.5, 'Ташкент');
near(qiblaBearing(39.6542, 66.9597), 239.8, 0.5, 'Самарканд');
near(qiblaBearing(55.7558, 37.6173), 176.4, 0.5, 'Москва');
near(distanceKm(...TASHKENT), 3531, 5, 'Ташкент, км');
assert.ok(nearKaaba(KAABA.lat + 0.005, KAABA.lon), 'в 500 м — рядом');
assert.ok(!nearKaaba(KAABA.lat + 0.02, KAABA.lon), 'в 2 км — нет');
console.log('✓ азимут: Ташкент 240.3°, Самарканд 239.8°, Москва 176.4°; Ташкент 3531 км; «рядом с Каабой» < 1 км');

// 2. Поворот через 0°/360°
assert.equal(delta(355, 5), 10);
assert.equal(delta(5, 355), -10);
assert.equal(delta(240, 240), 0);
assert.equal(delta(0, 180), 180);
near(delta(215, 240.3), 25.3, 1e-9, 'правее');
console.log('✓ delta: курс 355° → цель 5° = +10, обратно −10');

// 3. Склонение: официальная контрольная точка WMM2025 (NOAA/NCEI WMM2025_TEST_VALUES, 2025.0, 80° с. ш., 0°, 0 км)
{
  const f = magneticField(80, 0, 0, new Date(Date.UTC(2025, 0, 1)));
  near(f.x, 6521.6, 0.1, 'X');
  near(f.y, 145.9, 0.1, 'Y');
  near(f.z, 54791.5, 0.1, 'Z');
  near(f.declination, 1.28, 0.01, 'D');
  // Ташкент: модель NOAA на 17.11.2026 — 5.69° к востоку (калькулятор NOAA считает по этой же модели)
  near(declination(...TASHKENT, new Date('2026-11-17T00:00:00Z')), 5.69, 0.05, 'Ташкент');
  near(declination(...TASHKENT, new Date('2026-11-17T00:00:00Z')), 5.7, 1, 'Ташкент ±1° (требование ТЗ)');
  console.log('✓ WMM2025: контрольная точка NOAA (X, Y, Z, D) совпала; Ташкент +5.69°');
}

// 4. Курс телефона
{
  const rad = (d) => (d * Math.PI) / 180;
  const dec = 5.69;
  // Android: alpha = −азимут от магнитного севера → истинный курс = −alpha + склонение
  near(headingFromOrientation({ source: 'telegram', platform: 'android', alpha: -rad(234.61), declination: dec }), 240.3, 1e-6, 'Android');
  // iOS: alpha = +курс; истинный север (есть доступ к геопозиции) — без поправки, магнитный — с поправкой
  near(headingFromOrientation({ source: 'telegram', platform: 'ios', alpha: rad(240.3) - 2 * Math.PI, trueNorth: true, declination: dec }), 240.3, 1e-6, 'iOS, истинный север');
  near(headingFromOrientation({ source: 'telegram', platform: 'ios', alpha: rad(234.61), trueNorth: false, declination: dec }), 240.3, 1e-6, 'iOS, магнитный север');
  // iOS-браузер: webkitCompassHeading — по часовой от магнитного севера
  near(headingFromOrientation({ source: 'webkit', compassHeading: 234.61, declination: dec }), 240.3, 1e-6, 'webkitCompassHeading');
  // deviceorientationabsolute: alpha против часовой от магнитного севера
  near(headingFromOrientation({ source: 'absolute', alpha: 360 - 234.61, declination: dec }), 240.3, 1e-6, 'deviceorientationabsolute');
  console.log('✓ курс: Telegram Android (−alpha), Telegram iOS (+alpha, истинный/магнитный север), webkitCompassHeading, absolute');
}

// 5. Сглаживание, наклон, дрожание
{
  let h = null;
  for (let i = 0; i < 40; i++) h = smoothHeading(h, i % 2 ? 359 : 1);
  assert.ok(delta(h, 0) < 2 && delta(h, 0) > -2, `через 0°/360° — около 0°, а не 180°: ${h}`);
  h = 350;
  for (let i = 0; i < 30; i++) h = smoothHeading(h, 10);
  near(delta(h, 10), 0, 0.1, 'сходится к 10° через 0°');
  assert.ok(isTilted(40, 0) && isTilted(0, -35) && !isTilted(10, -20));
  const t0 = 1000;
  const smooth = Array.from({ length: 10 }, (_, i) => ({ t: t0 + i * 100, h: 200 + i * 5 })); // поворот на 45° за секунду
  assert.equal(isNoisy(smooth, t0 + 900), false, 'плавный поворот — не помеха');
  const shaky = Array.from({ length: 10 }, (_, i) => ({ t: t0 + i * 100, h: i % 2 ? 248 : 236 }));
  assert.equal(isNoisy(shaky, t0 + 900), true, 'скачки ±6° — помеха');
  const calm = Array.from({ length: 10 }, (_, i) => ({ t: t0 + i * 100, h: i % 2 ? 240.5 : 239.5 }));
  assert.equal(isNoisy(calm, t0 + 900), false, 'дрожание ±0.5° — норма');
  console.log('✓ сглаживание через 0°/360°, наклон > 30°, дрожание отличается от поворота');
}

// 6. Солнце (та же астрономия, что у времени намаза)
{
  const noon = sunAltAz(new Date('2026-11-17T07:10:00Z'), ...TASHKENT); // местный полдень ≈ 12:10
  near(noon.az, 180, 3, 'полдень — юг');
  near(noon.alt, 90 - 41.3 - 18.9, 1.5, 'высота в полдень');
  const set = sunAltAz(new Date('2026-11-17T12:00:00Z'), ...TASHKENT);
  near(set.alt, 0, 1.5, 'закат ≈ 17:00');
  assert.ok(set.az > 235 && set.az < 250, `закат на юго-западе: ${set.az}`);
  assert.ok(sunAltAz(new Date('2026-11-17T20:00:00Z'), ...TASHKENT).alt < 0, 'ночью ниже горизонта');
  console.log('✓ солнце: полдень на юге, закат на юго-западе, ночью под горизонтом');
}
